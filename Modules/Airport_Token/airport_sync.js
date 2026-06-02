/**
 * airport_sync.js —— Egern 机场 Token 同步脚本
 *
 * 作用：
 * 1. 优先从请求头 (Request Headers) 提取 Authorization Token
 * 2. 兜底从响应体 (Response Body) 中按路径提取 Token
 * 3. 引入本地缓存比对与 10s 并发锁，彻底解决 GitHub Gist HTTP 409 冲突问题
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

  // ========= 智能双模提取 Token =========
  let authData = null;
  let matchedPath = null;

  // 1. 优先法：从请求头 (Request Headers) 中提取 Authorization
  const reqHeaders = ctx.request?.headers || {};
  const authHeaderKey = Object.keys(reqHeaders).find(k => k.toLowerCase() === 'authorization');
  if (authHeaderKey && reqHeaders[authHeaderKey]) {
    authData = String(reqHeaders[authHeaderKey]).trim();
    matchedPath = `request.headers.${authHeaderKey}`;
  }

  // 2. 兜底法：从响应体 (Response Body) JSON 中提取
  if (!authData) {
    let body;
    try {
      body = await ctx.response.json();
      const extracted = extractToken(body, TOKEN_PATHS);
      authData = extracted.token;
      matchedPath = extracted.matchedPath;
    } catch (e) {
      return;
    }
  }

  if (!authData) {
    console.log('[Airport Sync] 未能从请求头或响应体中找到任何有效 Token');
    return;
  }

  // ========= 智能节流与并发锁 (核心防 409 逻辑) =========
  const localCache = ctx.storage.getJSON(`airport_token_${AIRPORT_ID}`);
  const nowUnix = Math.floor(Date.now() / 1000);

  // 锁判定 1：相同 Token 去重过滤。如果 Token 未变，且距离上次同步不足 30 分钟，直接拦截
  if (localCache && localCache.auth_data === authData) {
    const elapsed = nowUnix - (localCache.updated_at || 0);
    if (elapsed < 1800) { 
      console.log(`[Airport Sync] 🔄 Token 未改变，且距离上次同步仅过去 ${elapsed} 秒，跳过上传。`);
      return;
    }
  }

  // 锁判定 2：严格时间并发锁。防止多个不同接口同时返回时，引发 Gist 异步写入冲突
  const lastLockTime = ctx.storage.get(`sync_lock_${AIRPORT_ID}`);
  if (lastLockTime && (Date.now() - Number(lastLockTime) < 10000)) { 
    console.log(`[Airport Sync] ⚠️ 检测到高频并发请求，为防止 Gist 409 冲突，本次同步已静默跳过。`);
    return;
  }
  
  // 满足同步条件，立刻占线加锁
  ctx.storage.set(`sync_lock_${AIRPORT_ID}`, String(Date.now()));

  console.log(`[Airport Sync] Token 确定（来源：${matchedPath}），正在同步到 Gist...`);

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
          console.log('[Airport Sync] Gist 文件内容不是合法 JSON，将覆盖写入');
          existing = {};
        }
      }
    }
  } catch (e) {
    console.log('[Airport Sync] Gist 读取异常，尝试继续写入：' + e.message);
  }

  // ========= 更新当前机场条目 =========
  existing[AIRPORT_ID] = {
    auth_data: authData,
    updated_at: nowUnix,
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
      // 写入本地持久化缓存，供下次去重比对
      ctx.storage.setJSON(`airport_token_${AIRPORT_ID}`, existing[AIRPORT_ID]);
      
      ctx.notify({
        title: '机场 Token 同步成功',
        body: `${AIRPORT_ID} 的登录 Token 已更新到 Gist`,
        sound: false,
      });
    } else {
      const errBody = await patchResp.text();
      console.log(`[Airport Sync] Gist 写入失败，状态码：${patchResp.status}，响应：${errBody}`);
    }
  } catch (e) {
    console.log('[Airport Sync] Gist 写入异常：' + e.message);
  }
}

function safeGetHost(urlStr) {
  try { return new URL(urlStr).hostname || ''; } catch { return ''; }
}

function safeRegExp(pattern, flags = 'i') {
  try { return new RegExp(pattern, flags); } catch { return null; }
}

function getByPath(obj, path) {
  return path.reduce((cur, key) => (cur != null ? cur[key] : null), obj);
}

function extractToken(body, paths) {
  for (const path of paths) {
    const val = getByPath(body, path);
    if (typeof val === 'string' && val.length > 10) {
      return { token: val, matchedPath: path.join('.') };
    }
    if (val && typeof val === 'object') {
      for (const key of ['token', 'auth_data', 'access_token']) {
        if (typeof val[key] === 'string' && val[key].length > 10) {
          return { token: val[key], matchedPath: `${path.join('.')}.${key}` };
        }
      }
    }
  }
  return { token: null, matchedPath: null };
}
