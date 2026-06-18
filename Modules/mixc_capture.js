/**
 * 一点万象（MixC）抓包脚本
 *
 * 触发条件：手机上打开万象星 App，进入签到页，拦截 /mixc/gateway 的 H5 渠道请求体
 * 功能：从原 QX 一体脚本中分离出的抓包部分，提取签到所需参数，加密写入 Gist
 *
 * 说明：该 App 同一账号可能逛多个商场（mallNo 不同），抓包脚本只保留最近一次访问的商场参数，
 *       如需切换签到的商场，重新打开对应商场页面再次触发抓包即可。
 */
import CryptoJS from 'https://esm.sh/crypto-js';

const KEEP_FIELDS = ['X-Mixc-Swimlane', 'appId', 'appVersion', 'deviceParams', 'imei', 'mallNo', 'osVersion', 'params', 'platform', 'token'];
const CAPTURE_REQUIRED_FIELDS = ['token', 'deviceParams'];
const COMPLETE_FIELDS = ['token', 'deviceParams', 'mallNo'];
const COMPARE_FIELDS = [...KEEP_FIELDS, 'apiVersion', 'capturePlatform', 'captureAction', 'captureHasT', 'captureSignCheck'];
const SIGN_SECRET = 'P@Gkbu0shTNHjhM!7F';
const SIGN_ACTION = 'mixc.app.memberSign.sign';
const KEEP_FIELD_MAP = KEEP_FIELDS.reduce((m, k) => {
  m[k.toLowerCase()] = k;
  return m;
}, {});

function canonicalField(k) {
  return KEEP_FIELD_MAP[String(k || '').toLowerCase()] || k;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fieldSnapshot(obj) {
  const out = {};
  COMPARE_FIELDS.forEach(k => {
    if (obj && obj[k] !== undefined && obj[k] !== null) out[k] = String(obj[k]);
  });
  return JSON.stringify(out);
}

function calcSign(p) {
  const keys = Object.keys(p || {}).filter(k => k !== 'sign').sort();
  let t = '';
  for (const k of keys) {
    const v = p[k];
    if (v || v === 0 || v === '') t += `${k}=${v}&`;
  }
  return CryptoJS.MD5(t + SIGN_SECRET).toString();
}

function verifyCapturedSign(form) {
  if (!form || !form.sign) return { available: false };
  const expected = calcSign(form);
  return {
    available: true,
    ok: expected === String(form.sign),
  };
}

async function streamToString(stream) {
  if (!stream || typeof stream.getReader !== 'function') return '';
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (typeof value === 'string') {
      chunks.push(value);
    } else if (value) {
      chunks.push(new TextDecoder('utf-8').decode(value));
    }
  }
  return chunks.join('');
}

async function bodyToString(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (typeof body.getReader === 'function') return streamToString(body);

  try {
    if (body instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder('utf-8').decode(body);
  } catch (e) {}

  if (typeof body === 'object') {
    if (typeof body.text === 'string') return body.text;
    if (typeof body.raw === 'string') return body.raw;
    if (typeof body.body === 'string') return body.body;
    if (typeof body.value === 'string') return body.value;
    if (body.bytes) return await bodyToString(body.bytes);
    if (body.data) return await bodyToString(body.data);
    return '';
  }

  return String(body);
}

async function readRequestBodyText(ctx) {
  const req = ctx.request || {};
  let lastError = '';

  if (typeof req.text === 'function') {
    try {
      const text = await req.text();
      if (text) return { text, source: 'ctx.request.text()' };
    } catch (e) {
      lastError = `ctx.request.text(): ${e.message}`;
    }
  }

  const candidates = [
    ['ctx.request.body', req.body],
    ['ctx.request.bodyBytes', req.bodyBytes],
    ['ctx.request.rawBody', req.rawBody],
  ];
  for (const [source, value] of candidates) {
    try {
      const text = await bodyToString(value);
      if (text) return { text, source };
    } catch (e) {
      lastError = `${source}: ${e.message}`;
    }
  }

  return { text: '', source: lastError || 'empty' };
}

function headerValue(headers, name) {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return headers.get(name) || '';
  } catch (e) {}
  return headers[name] || headers[name.toLowerCase()] || '';
}

async function storageGet(ctx, key) {
  const store = ctx.store || ctx.storage;
  if (!store || typeof store.get !== 'function') return null;
  return await store.get(key);
}

async function storageSet(ctx, key, value) {
  const store = ctx.store || ctx.storage;
  if (!store || typeof store.set !== 'function') return;
  await store.set(key, value);
}

function mergeObject(out, obj) {
  Object.keys(obj || {}).forEach(k => {
    const v = obj[k];
    if (v === undefined || v === null) return;
    const key = canonicalField(k);
    if (typeof v === 'object') {
      if (k === 'body' || k === 'data' || k === 'params' || k === 'form') mergeObject(out, v);
      else out[key] = JSON.stringify(v);
      return;
    }
    out[key] = String(v);
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
    out[canonicalField(k)] = v;
  });
  return out;
}

export default async function (ctx) {
  const reqUrl = ctx.request?.url || '';
  const isGateway = reqUrl.indexOf('/mixc/gateway') >= 0;
  console.log(`[一点万象] 脚本已触发${isGateway ? '（gateway）' : ''}：${reqUrl || '无 URL'}`);

  const GIST_ID     = ctx.env.GIST_ID     || '';
  const GIST_TOKEN  = ctx.env.GIST_TOKEN  || '';
  const GIST_FILE   = ctx.env.GIST_FILE   || '';
  const SITE_KEY    = ctx.env.SITE_KEY    || '';
  const GIST_SECRET = ctx.env.GIST_SECRET || '';

  if (!GIST_ID || !GIST_TOKEN || !GIST_FILE || !SITE_KEY || !GIST_SECRET) {
    ctx.notify({ title: '一点万象抓包异常', body: '⚠️ 未配置完整的 Gist 环境变量或加密密钥' });
    return;
  }

  if (!reqUrl) return;
  if (!isGateway) {
    console.log(`[一点万象] 非 gateway 请求，跳过。url=${reqUrl}`);
    return;
  }

  const bodyRead = await readRequestBodyText(ctx);
  const form = parseKeyValueString(bodyRead.text);
  console.log(
    `[一点万象] gateway body 读取：source=${bodyRead.source} len=${bodyRead.text.length} ` +
    `content-type=${headerValue(ctx.request?.headers, 'content-type') || '-'} keys=${Object.keys(form).join(',') || '-'}`
  );

  const missingNow = CAPTURE_REQUIRED_FIELDS.filter(k => !form[k]);
  if (missingNow.length) {
    console.log(`[一点万象] gateway 请求体缺少抓包关键字段，跳过。platform=${form.platform || '-'} missing=${missingNow.join(',')} keys=${Object.keys(form).join(',')}`);
    return;
  }

  const capturePlatform = String(form.platform || '').trim();
  const signCheck = verifyCapturedSign(form);
  console.log(
    `[一点万象] gateway 候选：platform=${capturePlatform || '-'} action=${form.action || '-'} ` +
    `hasT=${form.t !== undefined ? 'yes' : 'no'} signCheck=${signCheck.available ? (signCheck.ok ? 'ok' : 'mismatch') : 'none'}`
  );

  if (capturePlatform.toLowerCase() !== 'h5' && form.action !== SIGN_ACTION) {
    console.log(`[一点万象] native gateway 非签到 action，跳过保存，避免污染 Gist。action=${form.action || '-'}`);
    return;
  }

  const now = Date.now();
  const lockKey = `lock_timestamp_${SITE_KEY}`;

  let lastRunTime = 0;
  try {
    const stored = await storageGet(ctx, lockKey);
    if (stored) lastRunTime = parseInt(stored, 10);
  } catch (e) {}

  if (now - lastRunTime < 15000) {
    console.log(`[一点万象] 拦截到高频连发请求，距离上次处理仅 ${now - lastRunTime}ms，跳过本次回写以防 409 冲突。`);
    return;
  }
  try { await storageSet(ctx, lockKey, String(now)); } catch (e) {}

  const captured = {};
  KEEP_FIELDS.forEach(k => { if (form[k] !== undefined) captured[k] = form[k]; });
  captured.platform = capturePlatform || 'h5';
  captured.capturePlatform = capturePlatform || captured.platform;
  if (form.action) captured.captureAction = form.action;
  captured.captureHasT = form.t !== undefined ? 'true' : 'false';
  if (signCheck.available) captured.captureSignCheck = signCheck.ok ? 'ok' : 'mismatch';
  if (!captured.apiVersion) captured.apiVersion = '1.0';
  console.log(`[一点万象] 捕获到候选参数：${Object.keys(captured).join(',')}`);

  console.log('[一点万象] 开始拉取并合并 Gist 数据...');

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
            try { await storageSet(ctx, lockKey, '0'); } catch (el) {}
            return;
          }
        }
      }
    } else {
      console.log(`[一点万象] 读取 Gist 失败，HTTP ${getResp.status}，终止同步`);
      ctx.notify({ title: '一点万象同步被中止', body: `⚠️ 读取 Gist 失败 HTTP ${getResp.status}` });
      try { await storageSet(ctx, lockKey, '0'); } catch (el) {}
      return;
    }
  } catch (e) {
    console.log('[一点万象] 网络异常，无法读取 Gist，终止同步: ' + e.message);
    ctx.notify({ title: '一点万象同步被中止', body: '⚠️ 网络异常，无法读取历史数据' });
    try { await storageSet(ctx, lockKey, '0'); } catch (el) {}
    return;
  }

  const prevNode = existing[SITE_KEY];
  let prevSaved = {};
  if (prevNode && prevNode.cookie) {
    try { prevSaved = JSON.parse(prevNode.cookie); } catch (e) {}
  }

  const saved = { ...prevSaved, ...captured };
  if (!saved.appId)      saved.appId = '68a91a5bac6a4f3e91bf4b42856785c6';
  if (!saved.platform)   saved.platform = 'h5';
  if (!saved.apiVersion) saved.apiVersion = '1.0';
  const missing = COMPLETE_FIELDS.filter(k => !saved[k]);
  const complete = missing.length === 0;
  const changed = fieldSnapshot(prevSaved) !== fieldSnapshot(saved);

  if (!changed) {
    console.log('[一点万象] 参数未变化，跳过 Gist 上传');
    return;
  }

  existing[SITE_KEY] = {
    cookie:     JSON.stringify(saved),
    updated_at: Math.floor(now / 1000),
    source_url: reqUrl,
  };

  let encryptedContent = CryptoJS.AES.encrypt(JSON.stringify(existing, null, 2), GIST_SECRET).toString();

  try {
    let patchResp;
    for (let i = 0; i < 3; i++) {
      patchResp = await ctx.http.patch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
        body: { files: { [GIST_FILE]: { content: encryptedContent } } },
        timeout: 15000,
      });
      if (patchResp.status !== 409) break;
      console.log(`[一点万象] Gist 写入冲突 HTTP 409，${i + 1}/3 重试`);
      await sleep(800 + i * 700);

      const retryGetResp = await ctx.http.get(`https://api.github.com/gists/${GIST_ID}`, { headers: GH_HEADERS, timeout: 15000 });
      if (retryGetResp.status === 200) {
        const retryGistData = await retryGetResp.json();
        const retryContent = retryGistData?.files?.[GIST_FILE]?.content || '';
        let retryExisting = {};
        if (retryContent.trim()) {
          const bytes = CryptoJS.AES.decrypt(retryContent.trim(), GIST_SECRET);
          const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
          if (decryptedStr) retryExisting = JSON.parse(decryptedStr);
        }
        retryExisting[SITE_KEY] = existing[SITE_KEY];
        encryptedContent = CryptoJS.AES.encrypt(JSON.stringify(retryExisting, null, 2), GIST_SECRET).toString();
      }
    }

    if (patchResp.status === 200) {
      console.log('[一点万象] 加密同步成功 ✅');
      ctx.notify({
        title: '万象星签到',
        body: complete
          ? `参数已更新 ✅\n商场 ${saved.mallNo || '-'} · 可用于签到`
          : `已保存部分参数 ⚠️\n缺少 ${missing.join(', ')}，继续进入签到页抓取`,
        sound: false,
      });
    } else {
      ctx.notify({ title: '一点万象同步失败', body: `HTTP ${patchResp.status}` });
    }
  } catch (e) {
    try { await storageSet(ctx, lockKey, '0'); } catch (el) {}
    console.log('[一点万象] 上传发生异常: ' + e.message);
    ctx.notify({ title: '一点万象同步异常', body: e.message });
  }
}
