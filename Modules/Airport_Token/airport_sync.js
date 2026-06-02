/**
 * airport_sync.js —— Egern 机场 Token 同步脚本
 *
 * 作用：
 * 1. 优先从请求头 (Request Headers) 提取 Authorization Token
 * 2. 兜底从响应体 (Response Body) 中按路径提取 Token
 * 3. 自动写入 GitHub Gist
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

  // ========= 智能双模提取 Token =========
  let authData = null;
  let matchedPath = null;

  // 1. 优先法：从请求头 (Request Headers) 中提取 Authorization (完美匹配 checkLogin 场景)
  const reqHeaders = ctx.request?.headers || {};
  const authHeaderKey = Object.keys(reqHeaders).find(k => k.toLowerCase() === 'authorization');
  if (authHeaderKey && reqHeaders[authHeaderKey]) {
    authData = String(reqHeaders[authHeaderKey]).trim();
    matchedPath = `request.headers.${authHeaderKey}`;
    console.log(`[Airport Sync] ✨ 成功从请求头 [${authHeaderKey}] 中捕获 Token`);
  }

  // 2. 兜底法：如果请求头没有，再尝试从响应体 (Response Body) JSON 中提取 (匹配刚登录场景)
  if (!authData) {
    let body;
    try {
      body = await ctx.response.json();
      const extracted = extractToken(body, TOKEN_PATHS);
      authData = extracted.token;
      matchedPath = extracted.matchedPath;
    } catch (e) {
      console.log('[Airport Sync] 无法从响应体提取 Token (非 JSON 或解析失败)，且请求头无 Authorization');
      return;
    }
  }

  // 如果两种方法都完蛋了，才退出
  if (!authData) {
    console.log('[Airport Sync] 未能从请求头或响应体中找到任何有效 Token');
    return;
  }

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
