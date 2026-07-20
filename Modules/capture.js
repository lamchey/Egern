import CryptoJS from 'https://esm.sh/crypto-js';

const GIST_API = 'https://api.github.com/gists';
const GIST_FILE_DEFAULT = 'checkin_token.json';
const SUPPORTED_SITES = [
  'mixc',
  'nodeseek',
  'pingme',
  'v2ex',
  'tuhu',
  'wanda',
  'youpin',
  'mishop',
  'dreame',
  'haidilao',
];

const CAPTURE_RULES = [
  { site: 'mixc', test: ctx => /^https:\/\/app\.mixcapp\.com\/mixc\/gateway/i.test(ctx.url), parse: parseMixc },
  { site: 'nodeseek', test: ctx => /^https:\/\/www\.nodeseek\.com\/setting(?:[/?#]|$)/i.test(ctx.url), parse: parseNodeSeek },
  { site: 'pingme', test: ctx => /^https:\/\/api\.pingmeapp\.net\/app\/queryBalanceAndBonus(?:[/?#]|$)/i.test(ctx.url), parse: parsePingMe },
  { site: 'v2ex', test: ctx => /^https:\/\/www\.v2ex\.com\/(?:member|mission)(?:[/?#]|$)/i.test(ctx.url), parse: parseV2EX },
  { site: 'tuhu', test: ctx => /^https:\/\/api\.tuhu\.cn\/User\/(?:GetMemberSignInInfoAsync|GetRightsList|GetUserCurrentAndNextGradeInfo)(?:[/?#]|$)/i.test(ctx.url), parse: parseTuhu },
  { site: 'wanda', test: ctx => /^https:\/\/user-api-prd-mx\.wandafilm\.com\/user\/user_info(?:[/?#]|$)/i.test(ctx.url), parse: parseWanda },
  { site: 'youpin', test: ctx => /^https:\/\/m\.xiaomiyoupin\.com\/mtop\/act\/redPacketSign\/getActInfo(?:[/?#]|$)/i.test(ctx.url), parse: parseYoupin },
  { site: 'mishop', test: ctx => /^https:\/\/shop-api\.retail\.mi\.com\/mtop\/mf\/act\/infinite\/(?:do|done)(?:[/?#]|$)/i.test(ctx.url), parse: parseMishop },
  { site: 'dreame', test: ctx => /^https:\/\/cn-wxmall\.dreame\.tech\/main\/my\/info(?:[/?#]|$)/i.test(ctx.url), parse: parseDreame },
  { site: 'haidilao', test: ctx => /^https:\/\/superapp-public\.kiwa-tech\.com\/activity\/wxapp\/signin\/(?:query|querySite|querySwitch|queryFragment|signin)(?:[/?#]|$)/i.test(ctx.url), parse: parseHaidilao },
];

let patchQueue = Promise.resolve();

export default async function capture(ctx) {
  const env = readEnv(ctx);
  ensureEnv(env);

  const requestCtx = await buildRequestContext(ctx);
  const rule = CAPTURE_RULES.find(item => item.test(requestCtx));
  if (!rule) return;

  const parsed = await rule.parse(requestCtx, env);
  if (!parsed) return;

  const accountKey = buildAccountKey(rule.site, env.accountId || parsed.accountId);
  const entry = {
    site: rule.site,
    cookie: parsed.cookie,
    updatedAt: new Date().toISOString(),
    source: 'egern-unified-capture',
  };

  patchQueue = patchQueue.then(() => saveToGist(ctx, env, accountKey, entry, parsed.summary));
  await patchQueue;
}

function readEnv(ctx) {
  return {
    gistId: String(ctx.env.GIST_ID || '').trim(),
    gistToken: String(ctx.env.GIST_TOKEN || '').trim(),
    gistFile: String(ctx.env.GIST_FILE || GIST_FILE_DEFAULT).trim() || GIST_FILE_DEFAULT,
    gistSecret: String(ctx.env.GIST_SECRET || '').trim(),
    accountId: sanitizeAccountId(ctx.env.ACCOUNT_ID || ''),
  };
}

function ensureEnv(env) {
  const missing = [];
  if (!env.gistId) missing.push('GIST_ID');
  if (!env.gistToken) missing.push('GIST_TOKEN');
  if (!env.gistSecret) missing.push('GIST_SECRET');
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
}

async function buildRequestContext(ctx) {
  const req = ctx.request || {};
  return {
    method: String(req.method || '').toUpperCase(),
    url: String(req.url || ''),
    headers: lowerCaseHeaders(req.headers || {}),
    bodyText: await readRequestBody(req),
  };
}

function lowerCaseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = String(value ?? '');
  return out;
}

async function readRequestBody(request) {
  if (!request || typeof request.text !== 'function') return '';
  try {
    const text = await request.text();
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

function parseMixc(ctx) {
  const body = parseMaybeJsonOrForm(ctx.bodyText);
  const token = stringOrEmpty(body.token || ctx.headers.token);
  const deviceParams = stringOrEmpty(body.deviceParams);
  const mallNo = stringOrEmpty(body.mallNo) || extractMallNo(body.params);
  if (!token || !deviceParams || !mallNo) throw new Error('mixc capture missing token/deviceParams/mallNo');

  const payload = {
    'X-Mixc-Swimlane': stringOrEmpty(ctx.headers['x-mixc-swimlane']) || 's1',
    action: stringOrEmpty(body.action),
    apiVersion: stringOrEmpty(body.apiVersion) || '1.0',
    appId: stringOrEmpty(body.appId),
    appVersion: stringOrEmpty(body.appVersion),
    captureAction: stringOrEmpty(body.action),
    captureHasT: Object.prototype.hasOwnProperty.call(body, 't'),
    capturePlatform: stringOrEmpty(body.platform),
    deviceParams,
    imei: stringOrEmpty(body.imei),
    mallNo,
    osVersion: stringOrEmpty(body.osVersion),
    params: stringOrEmpty(body.params),
    platform: stringOrEmpty(body.platform),
    token,
  };

  return {
    cookie: JSON.stringify(payload),
    summary: `site=mixc mallNo=${mallNo}`,
  };
}

function parseNodeSeek(ctx) {
  const cookie = normalizeCookieHeader(ctx.headers.cookie);
  if (!cookie || cookie.length < 20) throw new Error('nodeseek cookie missing');
  if (!/(?:^|;\s*)(session|cf_clearance)=/i.test(cookie)) throw new Error('nodeseek cookie incomplete');
  return {
    cookie,
    summary: 'site=nodeseek',
  };
}

function parsePingMe(ctx) {
  const url = new URL(ctx.url);
  const paramsRaw = {};
  url.searchParams.forEach((value, key) => {
    paramsRaw[key] = value;
  });
  const deviceId = stringOrEmpty(paramsRaw.uniquedeviceid);
  if (!deviceId) throw new Error('pingme uniquedeviceid missing');

  const fingerprintSeed = Object.keys(paramsRaw)
    .filter(key => !['sign', 'signdate', 'timestamp', 'ts', 'nonce', 'random', 'reqtime', 'reqid', 'requestid'].includes(key.toLowerCase()))
    .sort()
    .map(key => `${key}=${paramsRaw[key]}`)
    .join('&');
  const accountId = `d${CryptoJS.MD5(fingerprintSeed).toString().slice(0, 12)}`;

  const store = {
    version: 1,
    accounts: {
      [accountId]: {
        id: accountId,
        alias: accountId,
        uaSeed: randomSeed(deviceId),
        baseUA: ctx.headers['user-agent'] || '',
        capture: {
          paramsRaw,
          headers: filterHeaders(ctx.headers, ['authorization', 'accept-language', 'accept', 'user-agent', 'x-requested-with']),
        },
      },
    },
    order: [accountId],
  };

  return {
    cookie: JSON.stringify(store),
    accountId,
    summary: `site=pingme account=${accountId}`,
  };
}

function parseV2EX(ctx) {
  const cookie = normalizeCookieHeader(ctx.headers.cookie);
  if (!cookie || cookie.length < 20) throw new Error('v2ex cookie missing');
  return {
    cookie,
    summary: 'site=v2ex',
  };
}

function parseTuhu(ctx) {
  const token = stringOrEmpty(ctx.headers.authorization);
  if (!token) throw new Error('tuhu authorization missing');
  const blackbox = stringOrEmpty(ctx.headers.blackbox);
  const storage = {
    tuhu_token: JSON.stringify(uniqueValues([token])),
  };
  if (blackbox) storage.tuhu_blackbox = blackbox;
  return {
    cookie: JSON.stringify(storage),
    summary: `site=tuhu tokenCount=1${blackbox ? ' blackbox=1' : ''}`,
  };
}

function parseWanda(ctx) {
  const token = stringOrEmpty(ctx.headers['x-ry-token']);
  const user = stringOrEmpty(ctx.headers['x-ry-user']);
  if (!token || !user) throw new Error('wanda token/user missing');
  const shumei = stringOrEmpty(ctx.headers.shumeiboxid);
  const data = { token, user };
  if (shumei) data.shumei = shumei;
  return {
    cookie: JSON.stringify({ wanda_data: JSON.stringify(data) }),
    summary: `site=wanda user=${mask(user)}`,
  };
}

function parseYoupin(ctx) {
  const rawCookie = normalizeCookieHeader(ctx.headers.cookie);
  const serviceToken = getCookieField(rawCookie, 'serviceToken');
  if (!serviceToken) throw new Error('youpin serviceToken missing');
  const payload = {
    serviceToken,
    youpinSession: getCookieField(rawCookie, 'youpin_sessionid'),
    distinctId: getCookieField(rawCookie, 'youpindistinct_id'),
    userAgent: ctx.headers['user-agent'] || '',
  };
  return {
    cookie: JSON.stringify({ youpin_data: JSON.stringify(payload) }),
    summary: 'site=youpin',
  };
}

function parseMishop(ctx) {
  const rawCookie = normalizeCookieHeader(ctx.headers.cookie);
  if (!rawCookie) throw new Error('mishop cookie missing');
  const payload = {
    cookie: rawCookie,
    userId: getCookieField(rawCookie, 'userId') || getCookieField(rawCookie, 'cUserId') || '',
    ua: ctx.headers['user-agent'] || '',
    dId: stringOrEmpty(ctx.headers['d-id']),
    dModel: stringOrEmpty(ctx.headers['d-model']),
  };
  return {
    cookie: JSON.stringify({ mishop_data: JSON.stringify(payload) }),
    summary: `site=mishop${payload.userId ? ` user=${payload.userId}` : ''}`,
  };
}

function parseDreame(ctx) {
  const params = parseMaybeJsonOrForm(ctx.bodyText);
  const sessid = stringOrEmpty(params.sessid);
  const userId = stringOrEmpty(params.user_id || decodeJwtUserId(sessid));
  if (!sessid || !userId) throw new Error('dreame sessid/user_id missing');
  return {
    cookie: JSON.stringify({ dreame_data: JSON.stringify({ sessid, user_id: userId }) }),
    summary: `site=dreame user=${userId}`,
  };
}

function parseHaidilao(ctx) {
  if (ctx.method === 'OPTIONS') return null;
  const token = stringOrEmpty(ctx.headers._haidilao_app_token);
  if (!token) throw new Error('haidilao token missing');
  return {
    cookie: JSON.stringify({ hdl_data: token }),
    summary: 'site=haidilao',
  };
}

async function saveToGist(ctx, env, accountKey, entry, summary) {
  const gist = await loadGist(ctx, env);
  const current = gist.data[accountKey];
  gist.data[accountKey] = mergeEntry(current, entry);
  const encrypted = encrypt(JSON.stringify(gist.data), env.gistSecret);

  await requestJson(ctx, {
    method: 'PATCH',
    url: `${GIST_API}/${env.gistId}`,
    headers: gistHeaders(env.gistToken),
    body: {
      files: {
        [env.gistFile]: {
          content: encrypted,
        },
      },
    },
  });

  notify(ctx, 'Checkin 抓包成功', `${accountKey}\n${summary}`);
}

async function loadGist(ctx, env) {
  const result = await requestJson(ctx, {
    method: 'GET',
    url: `${GIST_API}/${env.gistId}`,
    headers: gistHeaders(env.gistToken),
  });
  const file = result.files && result.files[env.gistFile];
  const encrypted = file && typeof file.content === 'string' ? file.content : '';
  if (!encrypted) return { raw: result, data: {} };

  const decrypted = decrypt(encrypted, env.gistSecret);
  let data;
  try {
    data = JSON.parse(decrypted);
  } catch {
    throw new Error('gist decrypted content is not valid json');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('gist root must be object');
  return { raw: result, data };
}

function mergeEntry(current, entry) {
  const merged = current && typeof current === 'object' ? { ...current } : {};
  merged.site = entry.site;
  merged.cookie = entry.cookie;
  merged.updatedAt = entry.updatedAt;
  merged.source = entry.source;
  return merged;
}

function gistHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'checkin-egern-unified-capture',
  };
}

async function requestJson(ctx, options) {
  const method = String(options.method || 'GET').toUpperCase();
  const sender = method === 'GET' ? ctx.http.get.bind(ctx.http) : method === 'PATCH' ? ctx.http.patch.bind(ctx.http) : null;
  if (!sender) throw new Error(`unsupported method: ${method}`);
  const response = await sender({
    url: options.url,
    headers: options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await responseBodyAsText(response);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`gist ${method} failed: ${response.statusCode} ${text.slice(0, 160)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function responseBodyAsText(response) {
  if (!response) return '';
  if (typeof response.text === 'function') return String(await response.text());
  if (typeof response.json === 'function') return JSON.stringify(await response.json());
  if (typeof response.body === 'string') return response.body;
  return '';
}

function parseMaybeJsonOrForm(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {}
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function extractMallNo(paramsField) {
  const raw = stringOrEmpty(paramsField);
  if (!raw) return '';
  try {
    const decoded = JSON.parse(base64Decode(raw));
    return stringOrEmpty(decoded.mallNo);
  } catch {
    return '';
  }
}

function decodeJwtUserId(token) {
  const raw = stringOrEmpty(token);
  const parts = raw.split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    const sub = payload && typeof payload.sub === 'object' ? payload.sub : payload;
    return stringOrEmpty(sub.user_id || sub.uid);
  } catch {
    return '';
  }
}

function normalizeCookieHeader(raw) {
  return String(raw || '')
    .split('\n')
    .flatMap(line => line.replace(/^cookie:\s*/i, '').split(';'))
    .map(item => item.trim())
    .filter(Boolean)
    .join('; ');
}

function getCookieField(cookie, field) {
  const part = String(cookie || '')
    .split(';')
    .map(item => item.trim())
    .find(item => item.startsWith(`${field}=`));
  return part ? part.slice(field.length + 1) : '';
}

function filterHeaders(headers, keys) {
  const out = {};
  for (const key of keys) {
    const value = stringOrEmpty(headers[key]);
    if (value) out[key] = value;
  }
  return out;
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function randomSeed(text) {
  const hex = CryptoJS.MD5(String(text || '')).toString().slice(0, 8);
  return Number.parseInt(hex, 16) || 1;
}

function buildAccountKey(site, accountId) {
  if (!SUPPORTED_SITES.includes(site)) throw new Error(`unsupported site: ${site}`);
  const suffix = sanitizeAccountId(accountId);
  return suffix ? `${site}_${suffix}` : site;
}

function sanitizeAccountId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function stringOrEmpty(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function mask(value) {
  const text = stringOrEmpty(value);
  if (text.length <= 4) return text || 'unknown';
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function notify(ctx, title, body) {
  if (typeof ctx.notify === 'function') ctx.notify(title, body);
}

function base64Decode(raw) {
  return bytesToUtf8(CryptoJS.enc.Base64.parse(String(raw || '')));
}

function base64UrlDecode(raw) {
  const normalized = String(raw || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return bytesToUtf8(CryptoJS.enc.Base64.parse(normalized + pad));
}

function encrypt(plain, secret) {
  return CryptoJS.AES.encrypt(String(plain), String(secret)).toString();
}

function decrypt(cipherText, secret) {
  const bytes = CryptoJS.AES.decrypt(String(cipherText), String(secret));
  const plain = bytes.toString(CryptoJS.enc.Utf8);
  if (!plain) throw new Error('gist decrypt failed');
  return plain;
}

function bytesToUtf8(wordArray) {
  return CryptoJS.enc.Utf8.stringify(wordArray);
}
