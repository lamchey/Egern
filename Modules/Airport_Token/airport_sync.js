/**
 * airport_sync.js —— Egern 机场 Token 同步脚本
 *
 * 作用：
 * 1. 监听机场面板相关响应
 * 2. 从响应体中提取 Token
 * 3. 写入 GitHub Gist
 *
 * 说明：
 * - PROFILE_URL 仅作为配置项与日志参考
 *   真正是否触发，仍然依赖 TOKEN_API_MATCH 命中实际接口
 */

export default async function (ctx) {
  // ========= 读取环境变量 =========
  const PROFILE_URL = ctx.env.PROFILE_URL || 'https://panel.meslcloud.com/#/profile';
  const TOKEN_API_MATCH = ctx.env.TOKEN_API_MATCH || '(?:api/v1/user|getSubscribe|passport/auth/login|user/info|profile)';

  const GIST_ID = ctx.env.GIST_ID || '';
  const GIST_TOKEN = ctx.env.GIST_TOKEN || '';
  const GIST_FILE = ctx.env.GIST_FILE || 'airport_token.json';
  const AIRPORT_ID = ctx.env.AIRPORT_ID || 'airport';

  const TOKEN_PATHS = (ctx.env.TOKEN_PATHS || 'data.auth_data,data.token,token,data.access_token')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => p.split('.'));

  const requestUrl = ctx.request?.url || '';
  const requestMethod = ctx.request?.method || '';
  const profileHost = safeGetHost(PROFILE_URL);
  const requestHost = safeGetHost(requestUrl);

  // ========= 基础日志 =========
  console.log(`[Airport Sync] method=${requestMethod} url=${requestUrl}`);
  console.log(`[Airport Sync] profile=${PROFILE_URL}`);
  console.log(`[Airport Sync] token_api_match=${TOKEN_API_MATCH}`);

  // ========= 只处理目标机场 =========
  if (profileHost && requestHost && profileHost !== requestHost) {
    return;
  }

  // ========= 只处理命中的真实接口 =========
  const apiRegex = safeRegExp(TOKEN_API_MATCH, 'i');
  if (apiRegex && !apiRegex.test(requestUrl)) {
    return;
  }

  // ========= 配置校验 =========
  if (!GIST_ID || !GIST_TOKEN) {
    ctx.notify({
      title: '机场 Token 同步',
      body: '⚠️ 未配置 Gist ID 或 GitHub Token，请在模块设置中填写',
    });
    return;
  }

  // ========= 解析响应体 =========
  let body;
  try {
    body = await ctx.response.json();
  } catch (e) {
    console.log('[Airport Sync] 响应体不是 JSON，已跳过：' + (e?.message || e));
    return;
  }

  // ========= 提取 Token =========
  const { token: authData, matchedPath } = extractToken(body, TOKEN_PATHS);

  if (!authData) {
    console.log('[Airport Sync] 未找到 Token，响应顶层字段：' + JSON.stringify(Object.keys(body || {})));
    console.log('[Airport Sync] 请检查 TOKEN_PATHS 是否与该机场响应结构匹配');
    return;
  }

  console.log(`[Airport Sync] Token 提取成功（路径：${matchedPath}），正在同步到 Gist...`);

  // ========= 读取已有 Gist 内容 =========
  let existing = {};
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
      const fileContent = gistData?.files?.[GIST_FILE]?.content;
      if (fileContent) {
        try {
          existing = JSON.parse(fileContent);
        } catch (parseErr) {
          console.log('[Airport Sync] Gist 文件内容不是合法 JSON，将覆盖写入：' + (parseErr?.message || parseErr));
          existing = {};
        }
      }
    } else {
      console.log(`[Airport Sync] Gist 读取返回 ${getResp.status}，将直接覆盖写入`);
    }
  } catch (e) {
    console.log('[Airport Sync] Gist 读取异常，继续写入：' + (e?.message || e));
  }

  // ========= 更新当前机场条目 =========
  const now = Math.floor(Date.now() / 1000);
  existing[AIRPORT_ID] = {
    auth_data: authData,
    updated_at: now,
    source: 'egern',
    profile_url: PROFILE_URL,
    login_url: requestUrl,
  };

  // ========= 写回 Gist =========
  try {
    const patchResp = await ctx.http.patch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        'Authorization': `Bearer ${GIST_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'AirportSync/1.0',
        'Accept': 'application/vnd.github+json',
      },
      body: {
        files: {
          [GIST_FILE]: {
            content: JSON.stringify(existing, null, 2),
          },
        },
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
    } else {
      const errBody = await patchResp.text();
      console.log(`[Airport Sync] Gist 写入失败，状态码：${patchResp.status}，响应：${errBody}`);
      ctx.notify({
        title: '机场 Token 同步失败',
        body: `HTTP ${patchResp.status}，请检查 GitHub Token 权限`,
      });
    }
  } catch (e) {
    console.log('[Airport Sync] Gist 写入异常：' + (e?.message || e));
    ctx.notify({
      title: '机场 Token 同步异常',
      body: e?.message || String(e),
    });
  }

  // 不修改响应体，透传给 App
}

/**
 * 安全获取 URL 主机名
 */
function safeGetHost(urlStr) {
  try {
    return new URL(urlStr).hostname || '';
  } catch {
    return '';
  }
}

/**
 * 安全创建正则
 */
function safeRegExp(pattern, flags = 'i') {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    console.log('[Airport Sync] TOKEN_API_MATCH 正则无效：' + (e?.message || e));
    return null;
  }
}

/**
 * 按路径数组从对象中安全取值
 */
function getByPath(obj, path) {
  return path.reduce((cur, key) => (cur != null ? cur[key] : null), obj);
}

/**
 * 依次尝试多个路径提取 Token
 */
function extractToken(body, paths) {
  for (const path of paths) {
    const val = getByPath(body, path);

    if (typeof val === 'string' && val.length > 10) {
      return {
        token: val,
        matchedPath: path.join('.'),
      };
    }

    if (val && typeof val === 'object') {
      for (const key of ['token', 'auth_data', 'access_token']) {
        if (typeof val[key] === 'string' && val[key].length > 10) {
          return {
            token: val[key],
            matchedPath: `${path.join('.')}.${key}`,
          };
        }
      }
    }
  }

  return {
    token: null,
    matchedPath: null,
  };
}
