/**
 * PingMe 抓包脚本
 *
 * 触发条件：手机上打开 PingMe App（首页会请求 queryBalanceAndBonus）时自动执行
 * 功能：提取该请求的 URL 参数与请求头，按参数指纹区分账号，
 *       多账号汇总后整文件加密写入 Gist
 *
 * 多账号抓包：抓包多账号需卸载 PingMe 软件重新下载登录新的账号再执行抓包
 */
/**
 * PingMe Cookie 密码学加密抓包脚本 (全文件加密 - 多账号兼容版)
 */
import CryptoJS from 'https://esm.sh/crypto-js';

export default async function (ctx) {
  const GIST_ID     = ctx.env.GIST_ID     || '';
  const GIST_TOKEN  = ctx.env.GIST_TOKEN  || '';
  const GIST_FILE   = ctx.env.GIST_FILE   || '';
  const SITE_KEY    = ctx.env.SITE_KEY    || '';
  const GIST_SECRET = ctx.env.GIST_SECRET || '';

  if (!GIST_ID || !GIST_TOKEN || !GIST_FILE || !SITE_KEY || !GIST_SECRET) {
    ctx.notify({ title: 'PingMe 抓包异常', body: '⚠️ 未配置完整的 Gist 环境变量或加密密钥' });
    return;
  }

  const reqUrl = ctx.request?.url || '';
  if (!reqUrl) return;

  // ── 解析 URL 参数和 Headers ──────────────────────────────────────────
  function parseRawQuery(url) {
    const query = (url.split('?')[1] || '').split('#')[0];
    const rawMap = {};
    query.split('&').forEach(pair => {
      if (!pair) return;
      const idx = pair.indexOf('=');
      if (idx < 0) return;
      rawMap[pair.slice(0, idx)] = pair.slice(idx + 1);
    });
    return rawMap;
  }

  function normalizeHeaderNameMap(headers) {
    const out = {};
    Object.keys(headers || {}).forEach(k => out[k] = headers[k]);
    return out;
  }

  function fingerprintOf(paramsRaw) {
    const drop = { sign:1, signDate:1, timestamp:1, ts:1, nonce:1, random:1, reqTime:1, reqId:1, requestId:1 };
    const base = Object.keys(paramsRaw || {}).filter(k => !drop[k]).sort().map(k => `${k}=${paramsRaw[k]}`).join('&');
    return CryptoJS.MD5(base).toString().slice(0, 12); 
  }

  const paramsRaw = parseRawQuery(reqUrl);
  const headersMap = normalizeHeaderNameMap(ctx.request.headers || {});
  if (!paramsRaw.uniquedeviceid) {
    console.log('[PingMe] 参数不完整，忽略该请求');
    return;
  }

  let baseUA = '';
  Object.keys(headersMap).forEach(k => { if (k.toLowerCase() === 'user-agent') baseUA = headersMap[k]; });
  const fp = fingerprintOf(paramsRaw);
  const now = Date.now();

  console.log('[PingMe] 捕获到有效请求，准备下载并解密 Gist...');

  const GH_HEADERS = {
    'Authorization': `Bearer ${GIST_TOKEN}`,
    'User-Agent':    'Egern-Capture/1.0',
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
            if (!decryptedStr) throw new Error('解密结果为空');
            existing = JSON.parse(decryptedStr);
          } catch (e) {
            console.log('[PingMe] 解密历史密文失败，终止同步以保护数据: ' + e.message);
            ctx.notify({ title: 'PingMe 抓包被拦截', body: '⚠️ Gist 密文解密失败！' });
            return;
          }
        }
      }
    }
  } catch (e) {
    console.log('[PingMe] 读取历史失败，将作为新文件写入');
  }

  let store = { version: 1, accounts: {}, order: [] };
  if (existing[SITE_KEY] && existing[SITE_KEY].cookie) {
    try { store = JSON.parse(existing[SITE_KEY].cookie); } catch (e) {}
  }
  if (!store.accounts) store.accounts = {};
  if (!Array.isArray(store.order)) store.order = Object.keys(store.accounts);

  const existed = !!store.accounts[fp];
  const uaSeed = existed ? store.accounts[fp].uaSeed : store.order.length;
  const alias = existed ? store.accounts[fp].alias : `账号${store.order.length + 1}`;

  store.accounts[fp] = {
    id: fp,
    alias,
    uaSeed,
    baseUA,
    capture: { url: reqUrl, paramsRaw, headers: headersMap },
    createdAt: existed ? store.accounts[fp].createdAt : now,
    updatedAt: now
  };
  
  if (!existed) store.order.push(fp);

  existing[SITE_KEY] = {
    cookie:     JSON.stringify(store), 
    updated_at: Math.floor(now / 1000),
    source_url: 'api.pingmeapp.net'
  };

  const total = store.order.length;

  const fullJsonStr = JSON.stringify(existing, null, 2);
  const encryptedContent = CryptoJS.AES.encrypt(fullJsonStr, GIST_SECRET).toString();

  try {
    const patchResp = await ctx.http.patch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
        body: { files: { [GIST_FILE]: { content: encryptedContent } } },
        timeout: 15000,
    });

    if (patchResp.status === 200) {
      console.log(`[PingMe] 加密同步成功 ✅ (总账号数: ${total})`);
      ctx.notify({ title: existed ? '🔄 账号参数已更新' : '✅ 新账号已入库', body: `${alias}\n当前账号总数：${total}\n已安全同步至 Gist`, sound: false });
    } else {
      ctx.notify({ title: 'PingMe 同步失败', body: `HTTP ${patchResp.status}` });
    }
  } catch (e) {
    ctx.notify({ title: 'PingMe 同步异常', body: e.message });
  }
}
