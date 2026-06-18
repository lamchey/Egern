/**
 * 一点万象（MixC）抓包脚本
 *
 * 触发条件：手机上打开万象星 App，进入任意商场页面（请求会带上 token/deviceParams 等参数）
 * 功能：拦截 /mixc/gateway 的 H5 渠道请求体，提取签到所需参数，加密写入 Gist
 *
 * 说明：该 App 同一账号可能逛多个商场（mallNo 不同），抓包脚本只保留最近一次访问的商场参数，
 *       如需切换签到的商场，重新打开对应商场页面再次触发抓包即可。
 */
import CryptoJS from 'https://esm.sh/crypto-js';

const KEEP_FIELDS = ['X-Mixc-Swimlane', 'appId', 'appVersion', 'deviceParams', 'imei', 'mallNo', 'osVersion', 'params', 'platform', 'token'];

function bodyToString(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;

  try {
    if (body instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder('utf-8').decode(body);
  } catch (e) {}

  if (typeof body === 'object') {
    if (typeof body.text === 'string') return body.text;
    if (typeof body.raw === 'string') return body.raw;
    if (typeof body.body === 'string') return body.body;
    if (typeof body.value === 'string') return body.value;
    if (body.bytes) return bodyToString(body.bytes);
    if (body.data) return bodyToString(body.data);
    return '';
  }

  return String(body);
}

function mergeObject(out, obj) {
  Object.keys(obj || {}).forEach(k => {
    const v = obj[k];
    if (v === undefined || v === null) return;
    if (typeof v === 'object') {
      if (k === 'body' || k === 'data' || k === 'params' || k === 'form') mergeObject(out, v);
      else out[k] = JSON.stringify(v);
      return;
    }
    out[k] = String(v);
  });
}

function parseKeyValueString(str) {
  const out = {};
  if (!str) return out;
  const trimmed = str.trim();

  if (trimmed.startsWith('{')) {
    try {
      mergeObject(out, JSON.parse(trimmed));
      return out;
    } catch (e) {}
  }

  str.split('&').forEach(kv => {
    const i = kv.indexOf('=');
    if (i < 0) return;
    const rawK = kv.substring(0, i);
    const rawV = kv.substring(i + 1);
    let k = rawK;
    let v = rawV;
    try { k = decodeURIComponent(rawK.replace(/\+/g, ' ')); } catch (e) {}
    try { v = decodeURIComponent(rawV.replace(/\+/g, ' ')); } catch (e) {}
    out[k] = v;
  });
  return out;
}

function parseForm(input, reqUrl) {
  const out = {};
  if (input && typeof input === 'object' && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) {
    mergeObject(out, input);
  }

  const str = bodyToString(input);
  mergeObject(out, parseKeyValueString(str));

  const query = (reqUrl.split('?')[1] || '').split('#')[0];
  mergeObject(out, parseKeyValueString(query));
  return out;
}

export default async function (ctx) {
  const GIST_ID     = ctx.env.GIST_ID     || '';
  const GIST_TOKEN  = ctx.env.GIST_TOKEN  || '';
  const GIST_FILE   = ctx.env.GIST_FILE   || '';
  const SITE_KEY    = ctx.env.SITE_KEY    || '';
  const GIST_SECRET = ctx.env.GIST_SECRET || '';

  if (!GIST_ID || !GIST_TOKEN || !GIST_FILE || !SITE_KEY || !GIST_SECRET) {
    ctx.notify({ title: '一点万象抓包异常', body: '⚠️ 未配置完整的 Gist 环境变量或加密密钥' });
    return;
  }

  const reqUrl = ctx.request?.url || '';
  if (!reqUrl || reqUrl.indexOf('/mixc/gateway') < 0) return;

  const reqBody = ctx.request?.body ?? ctx.request?.bodyBytes ?? ctx.request?.rawBody ?? '';
  const form = parseForm(reqBody, reqUrl);
  if (form.platform !== 'h5' || !form.token || !form.deviceParams) {
    const bodyType = reqBody && reqBody.constructor ? reqBody.constructor.name : typeof reqBody;
    console.log(`[一点万象] 当前请求缺少关键字段，跳过。bodyType=${bodyType} keys=${Object.keys(form).slice(0, 12).join(',')}`);
    return;
  }

  const now = Date.now();
  const lockKey = `lock_timestamp_${SITE_KEY}`;

  let lastRunTime = 0;
  try {
    const stored = await ctx.store.get(lockKey);
    if (stored) lastRunTime = parseInt(stored, 10);
  } catch (e) {}

  if (now - lastRunTime < 15000) {
    console.log(`[一点万象] 拦截到高频连发请求，距离上次处理仅 ${now - lastRunTime}ms，跳过本次回写以防 409 冲突。`);
    return;
  }
  try { await ctx.store.set(lockKey, String(now)); } catch (e) {}

  const saved = {};
  KEEP_FIELDS.forEach(k => { if (form[k] !== undefined) saved[k] = form[k]; });
  if (!saved.appId)      saved.appId = '68a91a5bac6a4f3e91bf4b42856785c6';
  if (!saved.platform)   saved.platform = 'h5';
  if (!saved.apiVersion) saved.apiVersion = '1.0';

  console.log('[一点万象] 捕获到有效签到参数，开始拉取并合并 Gist 数据...');

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
            if (!decryptedStr) throw new Error('解密结果为空，可能密钥不正确');
            existing = JSON.parse(decryptedStr);
          } catch (e) {
            // 解密失败时中止，防止用空对象覆盖其他站点已有节点
            console.log('[一点万象] 解密历史密文失败，终止同步以保护数据: ' + e.message);
            ctx.notify({ title: '同步被拦截', body: '⚠️ Gist 解密历史密文失败！' });
            try { await ctx.store.set(lockKey, '0'); } catch (el) {}
            return;
          }
        }
      }
    } else {
      console.log(`[一点万象] 读取 Gist 失败，HTTP ${getResp.status}，终止同步`);
      ctx.notify({ title: '一点万象同步被中止', body: `⚠️ 读取 Gist 失败 HTTP ${getResp.status}` });
      try { await ctx.store.set(lockKey, '0'); } catch (el) {}
      return;
    }
  } catch (e) {
    console.log('[一点万象] 网络异常，无法读取 Gist，终止同步: ' + e.message);
    ctx.notify({ title: '一点万象同步被中止', body: '⚠️ 网络异常，无法读取历史数据' });
    try { await ctx.store.set(lockKey, '0'); } catch (el) {}
    return;
  }

  const prevNode = existing[SITE_KEY];
  let prevSaved = null;
  if (prevNode && prevNode.cookie) {
    try { prevSaved = JSON.parse(prevNode.cookie); } catch (e) {}
  }
  const changed = !prevSaved || prevSaved.token !== saved.token || prevSaved.mallNo !== saved.mallNo;

  existing[SITE_KEY] = {
    cookie:     JSON.stringify(saved),
    updated_at: Math.floor(now / 1000),
    source_url: reqUrl,
  };

  const encryptedContent = CryptoJS.AES.encrypt(JSON.stringify(existing, null, 2), GIST_SECRET).toString();

  try {
    const patchResp = await ctx.http.patch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
      body: { files: { [GIST_FILE]: { content: encryptedContent } } },
      timeout: 15000,
    });

    if (patchResp.status === 200) {
      console.log('[一点万象] 加密同步成功 ✅');
      ctx.notify({
        title: '万象星签到',
        body: (changed ? '参数已更新 ✅' : '参数已捕获 ✅') + `\n商场 ${saved.mallNo} · token 已加密同步`,
        sound: false,
      });
    } else {
      ctx.notify({ title: '一点万象同步失败', body: `HTTP ${patchResp.status}` });
    }
  } catch (e) {
    try { await ctx.store.set(lockKey, '0'); } catch (el) {}
    console.log('[一点万象] 上传发生异常: ' + e.message);
    ctx.notify({ title: '一点万象同步异常', body: e.message });
  }
}
