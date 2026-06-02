/**
 * airport_sync_checklogin.js
 *
 * - 仅匹配 /api/v1/user/checkLogin
 * - 只从请求头提取 Authorization
 * - 并发锁延长到 60s
 * - 写入 Gist 前读取文件 sha 并在 PATCH 时带上，遇到 409 做指数退避重试（最多 3 次）
 */

export default async function (ctx) {
  // ========= 配置 =========
  const PROFILE_URL = ctx.env.PROFILE_URL || 'https://panel.meslcloud.com/#/profile';
  const CHECK_LOGIN_PATH = ctx.env.CHECK_LOGIN_PATH || '/api/v1/user/checkLogin';

  const GIST_ID = ctx.env.GIST_ID || '';
  const GIST_TOKEN = ctx.env.GIST_TOKEN || '';
  const GIST_FILE = ctx.env.GIST_FILE || 'airport_token.json';
  const AIRPORT_ID = ctx.env.AIRPORT_ID || 'airport';

  // 并发锁与去重阈值
  const LOCK_TTL_MS = Number(ctx.env.LOCK_TTL_MS || 60000); // 60s
  const SAME_TOKEN_SKIP_SECONDS = Number(ctx.env.SAME_TOKEN_SKIP_SECONDS || 1800); // 30min

  const requestUrl = ctx.request?.url || '';
  const requestMethod = ctx.request?.method || '';
  const profileHost = safeGetHost(PROFILE_URL);
  const requestHost = safeGetHost(requestUrl);

  console.log(`[Airport Sync] method=${requestMethod} url=${requestUrl}`);

  // 只处理目标 host（可选）
  if (profileHost && requestHost && profileHost !== requestHost) {
    return;
  }

  // 只处理 checkLogin 接口
  if (!requestUrl.includes(CHECK_LOGIN_PATH)) {
    return;
  }

  // 校验 Gist 配置
  if (!GIST_ID || !GIST_TOKEN) {
    ctx.notify({
      title: '机场 Token 同步',
      body: '⚠️ 未配置 Gist ID 或 GitHub Token，请在模块设置中填写',
    });
    return;
  }

  // 只从请求头取 Authorization
  const reqHeaders = ctx.request?.headers || {};
  const authHeaderKey = Object.keys(reqHeaders).find(k => k.toLowerCase() === 'authorization');
  if (!authHeaderKey || !reqHeaders[authHeaderKey]) {
    console.log('[Airport Sync] 未在请求头中找到 Authorization，跳过。');
    return;
  }
  const authData = String(reqHeaders[authHeaderKey]).trim();
  if (!authData || authData.length < 10) {
    console.log('[Airport Sync] Authorization 内容过短，跳过。');
    return;
  }

  // 本地缓存去重与并发锁
  const localCache = ctx.storage.getJSON(`airport_token_${AIRPORT_ID}`);
  const nowUnix = Math.floor(Date.now() / 1000);

  if (localCache && localCache.auth_data === authData) {
    const elapsed = nowUnix - (localCache.updated_at || 0);
    if (elapsed < SAME_TOKEN_SKIP_SECONDS) {
      console.log(`[Airport Sync] 🔄 Token 未改变，且距离上次同步仅过去 ${elapsed} 秒，跳过上传。`);
      return;
    }
  }

  const lastLockTime = Number(ctx.storage.get(`sync_lock_${AIRPORT_ID}`) || 0);
  if (lastLockTime && (Date.now() - lastLockTime < LOCK_TTL_MS)) {
    console.log('[Airport Sync] ⚠️ 检测到高频并发请求，为防止 Gist 409 冲突，本次同步已静默跳过。');
    return;
  }

  // 占锁
  ctx.storage.set(`sync_lock_${AIRPORT_ID}`, String(Date.now()));

  console.log('[Airport Sync] Authorization 已捕获，准备同步到 Gist...');

  // ========= 读取现有 Gist 内容并获取文件 sha =========
  let existing = {};
  let fileSha = null;
  try {
    const getResp = await ctx.http.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'User-Agent': 'AirportSync/1.0',
        'Accept': 'application/vnd.github+json',
      },
      timeout: 15000,
    });

    if (getResp.status === 200) {
      const gistData = await getResp.json();
      const fileObj = gistData?.files?.[GIST_FILE];
      if (fileObj) {
        fileSha = fileObj.sha || null;
        const fileContent = fileObj.content;
        if (fileContent) {
          try {
            existing = JSON.parse(fileContent);
          } catch (parseErr) {
            console.log('[Airport Sync] Gist 文件内容不是合法 JSON，将覆盖写入');
            existing = {};
          }
        }
      } else {
        existing = {};
      }
    } else {
      console.log(`[Airport Sync] 读取 Gist 返回状态 ${getResp.status}，继续尝试写入`);
    }
  } catch (e) {
    console.log('[Airport Sync] Gist 读取异常，继续尝试写入：' + (e && e.message ? e.message : e));
  }

  // 更新条目
  existing[AIRPORT_ID] = {
    auth_data: authData,
    updated_at: nowUnix,
    source: 'egern',
    profile_url: PROFILE_URL,
    login_url: requestUrl,
  };

  const newContent = JSON.stringify(existing, null, 2);

  // ========= 写回 Gist 带重试与指数退避 =========
  const maxRetries = 3;
  let attempt = 0;
  let success = false;
  let lastError = null;

  while (attempt <= maxRetries && !success) {
    attempt++;
    try {
      // 构造 body，若有 fileSha 则带上以降低冲突
      const filesBody = {};
      filesBody[GIST_FILE] = { content: newContent };
      if (fileSha) filesBody[GIST_FILE].sha = fileSha;

      const patchResp = await ctx.http.patch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: {
          'Authorization': `Bearer ${GIST_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'AirportSync/1.0',
          'Accept': 'application/vnd.github+json',
        },
        body: {
          files: filesBody,
        },
        timeout: 15000,
      });

      if (patchResp.status === 200) {
        console.log(`[Airport Sync] ${AIRPORT_ID} Token 同步成功 ✅`);
        ctx.storage.setJSON(`airport_token_${AIRPORT_ID}`, existing[AIRPORT_ID]);
        ctx.notify({
          title: '机场 Token 同步成功',
          body: `${AIRPORT_ID} 的登录 Token 已更新到 Gist`,
          sound: false,
        });
        success = true;
        break;
      } else if (patchResp.status === 409) {
        lastError = `409 Conflict`;
        console.log(`[Airport Sync] Gist 写入冲突 409，第 ${attempt} 次尝试`);
        // 若冲突，先重新 GET 最新文件以更新 fileSha，再重试
        try {
          const refreshResp = await ctx.http.get(`https://api.github.com/gists/${GIST_ID}`, {
            headers: {
              'Authorization': `Bearer ${GIST_TOKEN}`,
              'User-Agent': 'AirportSync/1.0',
              'Accept': 'application/vnd.github+json',
            },
            timeout: 10000,
          });
          if (refreshResp.status === 200) {
            const refreshed = await refreshResp.json();
            const refreshedFile = refreshed?.files?.[GIST_FILE];
            if (refreshedFile) {
              fileSha = refreshedFile.sha || fileSha;
              // 如果文件内容发生变化，更新 existing 以避免覆盖他人更新
              try {
                const refreshedContent = refreshedFile.content;
                if (refreshedContent) {
                  const parsed = JSON.parse(refreshedContent);
                  // 合并策略：保留最新 updated_at 更大的条目
                  const remoteEntry = parsed?.[AIRPORT_ID];
                  if (remoteEntry && remoteEntry.updated_at && remoteEntry.updated_at > (existing[AIRPORT_ID].updated_at || 0)) {
                    console.log('[Airport Sync] 远端 Gist 中该机场条目更新更晚，放弃本次覆盖以避免回退');
                    // 释放锁并退出
                    ctx.storage.set(`sync_lock_${AIRPORT_ID}`, String(Date.now()));
                    return;
                  }
                }
              } catch (e) {
                // 解析失败则继续使用本地 existing
              }
            }
          }
        } catch (e) {
          console.log('[Airport Sync] 冲突后刷新 Gist 失败：' + (e && e.message ? e.message : e));
        }
        // 指数退避
        if (attempt <= maxRetries) {
          const backoff = 500 * Math.pow(2, attempt - 1);
          await sleep(backoff);
          continue;
        }
      } else {
        const errBody = await patchResp.text();
        lastError = `status ${patchResp.status} response ${errBody}`;
        console.log(`[Airport Sync] Gist 写入失败，状态码：${patchResp.status}，响应：${errBody}`);
        // 对于 5xx 可重试，对 4xx 直接放弃
        if (patchResp.status >= 500 && attempt <= maxRetries) {
          const backoff = 500 * Math.pow(2, attempt - 1);
          await sleep(backoff);
          continue;
        } else {
          break;
        }
      }
    } catch (e) {
      lastError = e && e.message ? e.message : e;
      console.log('[Airport Sync] Gist 写入异常：' + lastError);
      if (attempt <= maxRetries) {
        const backoff = 500 * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue;
      } else {
        break;
      }
    }
  }

  if (!success) {
    console.log(`[Airport Sync] 最终写入失败：${lastError}`);
  }

  // 释放锁（设置为当前时间，下一次会检查 TTL）
  ctx.storage.set(`sync_lock_${AIRPORT_ID}`, String(Date.now()));
}

// ======= 辅助函数 =======
function safeGetHost(urlStr) {
  try { return new URL(urlStr).hostname || ''; } catch { return ''; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
