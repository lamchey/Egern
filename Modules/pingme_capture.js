/**
 * PingMe 抓包脚本
 *
 * 触发条件：手机上打开 PingMe App（首页会请求 queryBalanceAndBonus）时自动执行
 * 功能：提取该请求的 URL 参数与请求头，按参数指纹区分账号，
 *       多账号汇总后整文件加密写入 Gist
 *
 * 多账号抓包：抓包多账号需卸载 PingMe 软件重新下载登录新的账号再执行抓包
 */
import CryptoJS from 'https://esm.sh/crypto-js';

const DROP_KEYS = { sign: 1, signDate: 1, timestamp: 1, ts: 1, nonce: 1, random: 1, reqTime: 1, reqId: 1, requestId: 1 };

function parseRawQuery(url) {
  const query = (String(url).split('?')[1] || '').split('#')[0];
  const rawMap = {};
  query.split('&').forEach(pair => {
    if (!pair) return;
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    rawMap[pair.slice(0, idx)] = pair.slice(idx + 1);
  });
  return rawMap;
}

async function fingerprintOf(paramsRaw) {
  const base = Object.keys(paramsRaw || {})
    .filter(k => !DROP_KEYS[k])
    .sort()
    .map(k => `${k}=${paramsRaw[k]}`)
    .join('&');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

export default async function (ctx) {
  const GIST_ID     = ctx.env.GIST_ID     || '';
  const GIST_TOKEN  = ctx.env.GIST_TOKEN  || '';
  const GIST_FILE   = ctx.env.GIST_FILE   || '';
  const SITE_KEY    = ctx.env.SITE_KEY    || '';
  const GIST_SECRET = ctx.env.GIST_SECRET || '';

  if (!GIST_ID)     { ctx.notify({ title: 'PingMe 抓包', body: '⚠️ 未配置 GIST_ID' }); return; }
  if (!GIST_TOKEN)  { ctx.notify({ title: 'PingMe 抓包', body: '⚠️ 未配置 GIST_TOKEN' }); return; }
  if (!GIST_FILE)   { ctx.notify({ title: 'PingMe 抓包', body: '⚠️ 未配置 GIST_FILE' }); return; }
  if (!GIST_SECRET) { ctx.notify({ title: 'PingMe 抓包', body: '⚠️ 未配置 GIST_SECRET' }); return; }

  const url = ctx.request?.url || '';
  const paramsRaw = parseRawQuery(url);
  if (!Object.keys(paramsRaw).length) {
    console.log('[PingMe] 未解析到请求参数，跳过');
    return;
  }

  const reqHeaders = ctx.request?.headers || {};
  const headersMap = {};
  Object.keys(reqHeaders).forEach(k => { headersMap[k] = reqHeaders[k]; });

  let baseUA = '';
  Object.keys(headersMap).forEach(k => { if (k.toLowerCase() === 'user-agent') baseUA = headersMap[k]; });

  const fp = await fingerprintOf(paramsRaw);

  console.log('[PingMe] 捕获到请求，准备加密写入 Gist...');

  const GH_HEADERS = {
    'Authorization': `Bearer ${GIST_TOKEN}`,
    'User-Agent':    'PingMe-Capture/1.0',
    'Accept':        'application/vnd.github+json',
  };

  let existing = {};
  try {
    const getResp = await ctx.http.get(`https://api.github.com/gists/${GIST_ID}`, { headers: GH_HEADERS, timeout: 15000 });
    if (getResp.status === 200) {
      const gistData = await getResp.json();
      const fileContent = gistData?.files?.[GIST_FILE]?.content;
      if (fileContent) {
        const text = fileContent.trim();
        if (text === '' || text === '{}') {
          existing = {};
        } else {
          try {
            const bytes = CryptoJS.AES.decrypt(text, GIST_SECRET);
            const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
            if (!decryptedStr) throw new Error('解密结果为空，可能密钥不正确');
            existing = JSON.parse(decryptedStr);
          } catch (e) {
            console.log('[PingMe] 解密历史密文失败，终止同步以保护数据: ' + e.message);
            ctx.notify({ title: '同步被拦截', body: '⚠️ Gist 解密历史密文失败！' });
            return;
          }
        }
      }
    } else if (getResp.status === 404) {
      console.log('[PingMe] Gist 不存在或无权访问');
      ctx.notify({ title: 'PingMe 抓包失败', body: 'Gist 不存在或 Token 无权限，请检查配置' });
      return;
    }
  } catch (e) {
    console.log('[PingMe] 读取历史 Gist 失败，将作为全新文件加密写入');
  }

  const node = existing[SITE_KEY] && typeof existing[SITE_KEY] === 'object' ? existing[SITE_KEY] : {};
  let store = { accounts: {}, order: [] };
  if (typeof node.cookie === 'string' && node.cookie) {
    try {
      const parsed = JSON.parse(node.cookie);
      if (parsed && typeof parsed === 'object') {
        store.accounts = parsed.accounts || {};
        store.order = Array.isArray(parsed.order) ? parsed.order : Object.keys(store.accounts);
      }
    } catch {
      console.log('[PingMe] 现有账号存储解析失败，将重新创建');
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const existed = !!store.accounts[fp];
  const uaSeed = existed ? store.accounts[fp].uaSeed : store.order.length;
  const alias  = existed ? store.accounts[fp].alias  : `账号${store.order.length + 1}`;

  store.accounts[fp] = {
    id: fp,
    alias,
    uaSeed,
    baseUA,
    capture: { url, paramsRaw, headers: headersMap },
    createdAt: existed ? store.accounts[fp].createdAt : now,
    updatedAt: now,
  };
  if (!existed) store.order.push(fp);

  existing[SITE_KEY] = {
    cookie: JSON.stringify(store),
    updated_at: now,
    source_url: url,
  };

  const fullJsonStr = JSON.stringify(existing, null, 2);
  const encryptedContent = CryptoJS.AES.encrypt(fullJsonStr, GIST_SECRET).toString();

  try {
    const patchResp = await ctx.http.patch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
      body: { files: { [GIST_FILE]: { content: encryptedContent } } },
      timeout: 15000,
    });

    if (patchResp.status === 200) {
      console.log('[PingMe] 加密同步成功 ✅');
      ctx.notify({
        title: existed ? '🔄 PingMe 账号已更新' : '✅ PingMe 新账号已入库',
        body:  `${alias}（共 ${store.order.length} 个账号）已加密同步到 Gist`,
        sound: false,
      });
    } else {
      const body = await patchResp.text().catch(() => '');
      console.log(`[PingMe] Gist 写入失败 HTTP ${patchResp.status}：${body}`);
      ctx.notify({ title: 'PingMe 同步失败', body: `HTTP ${patchResp.status}，请检查 Token 权限（需要 Gist Write）` });
    }
  } catch (e) {
    console.log('[PingMe] 写入 Gist 异常：' + e.message);
    ctx.notify({ title: 'PingMe 同步异常', body: e.message });
  }
}
