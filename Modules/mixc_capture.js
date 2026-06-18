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
const REQUIRED_FIELDS = ['token', 'deviceParams', 'mallNo'];
const COMPARE_FIELDS = [...KEEP_FIELDS, 'apiVersion', 'captureAction', 'captureSignCheck'];
const SIGN_SECRET = 'P@Gkbu0shTNHjhM!7F';
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
  const signInput = {};
  Object.keys(form).forEach(k => {
    if (k === 'sign') return;
    const v = form[k];
    if (v === undefined || v === null) return;
    signInput[k] = String(v);
  });
  const expected = calcSign(signInput);
  return {
    available: true,
    ok: expected === String(form.sign),
    expected,
    actual: String(form.sign),
  };
}

function fieldSnapshot(obj) {
  const out = {};
  COMPARE_FIELDS.forEach(k => {
    if (obj && obj[k] !== undefined && obj[k] !== null) out[k] = String(obj[k]);
  });
  return JSON.stringify(out);
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

function tryParseJson(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || (!s.startsWith('{') && !s.startsWith('['))) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function collectKeepFields(out, value, depth = 0) {
  if (depth > 6 || value === undefined || value === null) return;

  const parsed = tryParseJson(value);
  if (parsed) {
    collectKeepFields(out, parsed, depth + 1);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectKeepFields(out, item, depth + 1));
    return;
  }

  if (typeof value !== 'object') return;

  Object.keys(value).forEach(k => {
    const v = value[k];
    const key = canonicalField(k);
    if (KEEP_FIELDS.includes(key) && v !== undefined && v !== null && out[key] === undefined) {
      out[key] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    collectKeepFields(out, v, depth + 1);
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

async function parseForm(input, reqUrl) {
  const out = {};
  if (input && typeof input === 'object' && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) {
    mergeObject(out, input);
  }

  const str = await bodyToString(input);
  mergeObject(out, parseKeyValueString(str));

  const query = (reqUrl.split('?')[1] || '').split('#')[0];
  mergeObject(out, parseKeyValueString(query));
  collectKeepFields(out, out);
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

  const reqBody = ctx.request?.body ?? ctx.request?.bodyBytes ?? ctx.request?.rawBody ?? '';
  const bodyForm = await parseForm(reqBody, reqUrl);
  const form = { ...bodyForm };
  mergeObject(form, ctx.request?.headers || {});
  const hasAnyUsefulField = KEEP_FIELDS.some(k => form[k] !== undefined);
  if (!hasAnyUsefulField) return;

  const platform = String(form.platform || '').toLowerCase();
  if (platform !== 'h5') {
    console.log(`[一点万象] 非 h5 gateway 请求，跳过。platform=${form.platform || '-'} keys=${Object.keys(form).join(',')}`);
    return;
  }

  const missingNow = REQUIRED_FIELDS.filter(k => !form[k]);
  if (missingNow.length) {
    console.log(`[一点万象] h5 gateway 请求缺少关键字段，跳过。missing=${missingNow.join(',')} keys=${Object.keys(form).join(',')}`);
    return;
  }

  const signCheck = verifyCapturedSign(bodyForm);
  if (signCheck.available) {
    console.log(`[一点万象] 捕获请求签名自检：${signCheck.ok ? '通过' : '不匹配'} action=${form.action || '-'}`);
    if (!signCheck.ok) {
      ctx.notify({
        title: '一点万象抓包异常',
        body: '⚠️ 捕获请求签名自检失败，当前签名算法可能已变化，已跳过保存',
        sound: false,
      });
      return;
    }
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

  const captured = {};
  KEEP_FIELDS.forEach(k => { if (form[k] !== undefined) captured[k] = form[k]; });
  captured.platform = 'h5';
  if (!captured.apiVersion) captured.apiVersion = '1.0';
  if (form.action) captured.captureAction = form.action;
  if (signCheck.available) captured.captureSignCheck = signCheck.ok ? 'ok' : 'mismatch';
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
  let prevSaved = {};
  if (prevNode && prevNode.cookie) {
    try { prevSaved = JSON.parse(prevNode.cookie); } catch (e) {}
  }

  const saved = { ...prevSaved, ...captured };
  if (!saved.appId)      saved.appId = '68a91a5bac6a4f3e91bf4b42856785c6';
  if (!saved.platform)   saved.platform = 'h5';
  if (!saved.apiVersion) saved.apiVersion = '1.0';
  const missing = REQUIRED_FIELDS.filter(k => !saved[k]);
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
    try { await ctx.store.set(lockKey, '0'); } catch (el) {}
    console.log('[一点万象] 上传发生异常: ' + e.message);
    ctx.notify({ title: '一点万象同步异常', body: e.message });
  }
}
