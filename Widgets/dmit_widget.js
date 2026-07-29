const STORAGE = {
  cookie: "dmit.cookie.v1",
  cache: "dmit.traffic.widget.cache.v2",
  error: "dmit.traffic.widget.error.v2",
};

const DMIT = {
  origin: "https://www.dmit.io",
  servicesUrl: "https://www.dmit.io/clientarea.php?action=services",
  dashboardUrl: "https://www.dmit.io/clientarea.php",
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 " +
    "Mobile/15E148 Safari/604.1",
};

const DECIMAL_UNITS = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  PB: 1000 ** 5,
};

const BINARY_UNITS = {
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
  PIB: 1024 ** 5,
};

const NUMBER_PATTERN = "\\d[\\d,]*(?:\\.\\d+)?";
const UNIT_PATTERN = "(?:B|KB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|PiB)";
const AMOUNT_PATTERN = `${NUMBER_PATTERN}\\s*${UNIT_PATTERN}`;

function adaptive(light, dark) {
  return { light, dark };
}

const COLORS = {
  root: adaptive("#FFFFFF", "#0D1117"),
  panel: adaptive("#F9FBFD", "#171C24"),
  panelBorder: adaptive("#F4F6FA", "#29313B"),
  primary: adaptive("#202839", "#F2F5FA"),
  date: adaptive("#35404F", "#DDE3EC"),
  headline: adaptive("#4B5467", "#C7D0DE"),
  secondary: adaptive("#6A7385", "#A8B3C4"),
  subtle: adaptive("#9AA2B6", "#7F8B9D"),
  track: adaptive("#E2E9EF", "#303946"),
  divider: adaptive("#EAEBF0", "#29313A"),
  progressStart: adaptive("#4384FB", "#63A8FF"),
  progressEnd: adaptive("#236BEF", "#3D86FF"),
  icon: adaptive("#78ADEF", "#77B4FF"),
  blueChip: adaptive("#DCEAFF", "#193A67"),
  blueChipBorder: adaptive("#CAD8F6", "#2C5687"),
  blueChipText: adaptive("#2C51C2", "#8CB9FA"),
  grayChip: adaptive("#F3F5F7", "#252B34"),
  grayChipBorder: adaptive("#E5E6E9", "#3B434F"),
  grayChipText: adaptive("#3A3F4C", "#D9E0EA"),
  danger: adaptive("#C53D4A", "#FF7B86"),
};

function env(ctx, name, fallback = "") {
  const value = ctx.env && ctx.env[name];
  return value == null || value === "" ? fallback : String(value);
}

function isDmitUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.dmit.io";
  } catch (_) {
    return false;
  }
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || null;
}

function toDmitUrl(value, base = DMIT.origin) {
  const url = new URL(value, base);
  if (!isDmitUrl(url.href)) throw new Error("只允許請求 dmit.io 官方域名");
  return url.href;
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
}

function visibleText(html, keepScripts = false) {
  let text = String(html || "");
  if (!keepScripts) {
    text = text
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  }
  return decodeHtmlEntities(
    text
      .replace(/<(?:br|\/p|\/div|\/li|\/section|\/article|hr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function normalizeAmountText(value) {
  const match = String(value || "")
    .replace(/,/g, "")
    .match(new RegExp(`(${NUMBER_PATTERN})\\s*(${UNIT_PATTERN})`, "i"));
  if (!match) return null;
  const unit = match[2].toUpperCase().replace(/^([KMGTPI])IB$/, "$1iB");
  return `${match[1]} ${unit}`;
}

function parseAmount(value, key = "") {
  if (value == null || typeof value === "boolean") return null;
  const text = String(value).replace(/,/g, "").trim();
  const explicit = text.match(
    /(-?\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|PiB)\b/i,
  );
  if (explicit) {
    const unit = explicit[2].toUpperCase();
    const multiplier = DECIMAL_UNITS[unit] || BINARY_UNITS[unit];
    if (!multiplier) return null;
    return {
      bytes: Number(explicit[1]) * multiplier,
      explicit: true,
      display: normalizeAmountText(explicit[0]),
    };
  }

  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) return null;
  const normalizedKey = normalizeKey(key).toUpperCase();
  const units = { ...DECIMAL_UNITS, ...BINARY_UNITS };
  for (const [unit, multiplier] of Object.entries(units)) {
    if (
      normalizedKey === unit ||
      normalizedKey.endsWith(`_${unit}`) ||
      normalizedKey.includes(`_${unit}_`)
    ) {
      return { bytes: number * multiplier, explicit: true, display: null };
    }
  }
  if (normalizedKey.includes("BYTE")) {
    return { bytes: number, explicit: true, display: null };
  }
  return { bytes: number, explicit: false, display: null };
}

function formatBytes(bytes, forceDecimals = null) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  const digits = forceDecimals == null
    ? value >= 100 ? 0 : 2
    : forceDecimals;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function normalizeDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    let timestamp = Number(value);
    if (timestamp < 10_000_000_000) timestamp *= 1000;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const match = String(value).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function daysUntil(dateString) {
  if (!dateString) return null;
  const target = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.max(0, Math.ceil((target.getTime() - Date.now()) / 86_400_000));
}

function normalizeBillingLabel(text) {
  const value = String(text || "");
  if (/(?:雙向計費|双向计费|bidi|bidirectional)/i.test(value)) return "雙向計費";
  if (/(?:出\s*\/\s*入取高值|max\s*\(\s*in\s*,\s*out\s*\))/i.test(value)) {
    return "出入取高";
  }
  if (/(?:單向計費|单向计费|unidirectional)/i.test(value)) return "單向計費";
  return "計費方式";
}

function normalizeOverageLabel(text) {
  const value = String(text || "");
  if (/(?:超量降速|降速|throttl|rate.?limit)/i.test(value)) return "超量降速";
  if (/(?:超量暫停|超量暂停|suspend|paused?)/i.test(value)) return "超量暫停";
  if (/(?:不限流量|unlimited)/i.test(value)) return "不限流量";
  return "超量規則";
}

function trafficBlocks(text) {
  const source = String(text || "");
  const matches = [...source.matchAll(/每月\s*流量|monthly\s+traffic/gi)];
  return matches.map((match, index) => {
    const start = Math.max(0, match.index - 40);
    const next = matches[index + 1];
    const end = next ? Math.min(next.index, match.index + 2500) : match.index + 2500;
    return source.slice(start, end);
  });
}

function finishTrafficData(data, source) {
  if (!data || !Number.isFinite(data.usedBytes) || !Number.isFinite(data.limitBytes)) {
    return null;
  }
  if (data.limitBytes <= 0) return null;

  const remainingBytes = Number.isFinite(data.remainingBytes)
    ? Math.max(0, data.remainingBytes)
    : Math.max(0, data.limitBytes - data.usedBytes);
  if (Number.isFinite(data.remainingBytes) && data.usedBytes < data.limitBytes) {
    const mismatch = Math.abs((data.usedBytes + remainingBytes) - data.limitBytes);
    const tolerance = Math.max(1_000_000, data.limitBytes * 0.005);
    if (mismatch > tolerance) return null;
  }
  const resetDate = normalizeDate(data.resetDate);
  const days = Number.isFinite(data.daysRemaining)
    ? Math.max(0, Math.round(data.daysRemaining))
    : daysUntil(resetDate);

  return {
    usedBytes: Math.max(0, data.usedBytes),
    limitBytes: Math.max(0, data.limitBytes),
    remainingBytes,
    usedText: data.usedText || formatBytes(data.usedBytes, 2),
    limitText: data.limitText || formatBytes(data.limitBytes, 2),
    remainingText: data.remainingText || formatBytes(remainingBytes, 2),
    usagePercent: Math.max(0, Math.min(100, (data.usedBytes / data.limitBytes) * 100)),
    billingMode: normalizeBillingLabel(data.billingMode),
    overagePolicy: normalizeOverageLabel(data.overagePolicy),
    resetDate,
    daysRemaining: days,
    source,
    updatedAt: new Date().toISOString(),
  };
}

function parseTrafficText(text, source) {
  const candidates = [];
  for (const block of trafficBlocks(text)) {
    const pair = block.match(
      new RegExp(`(${AMOUNT_PATTERN})\\s*(?:\\/|／)\\s*(${AMOUNT_PATTERN})`, "i"),
    );
    if (!pair) continue;

    const used = parseAmount(pair[1], "used");
    const limit = parseAmount(pair[2], "limit");
    if (!used || !limit) continue;

    const remainingMatch = block.match(
      new RegExp(`(?:剩餘|剩余|remaining)\\s*[:：]?\\s*(${AMOUNT_PATTERN})`, "i"),
    );
    const remaining = remainingMatch ? parseAmount(remainingMatch[1], "remaining") : null;
    const resetMatch = block.match(
      /(?:下次重置|next\s*reset)[^0-9]{0,80}(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
    );
    const daysMatch = block.match(/(\d+)\s*(?:天後|天后|days?\s*(?:later|remaining)?)/i);

    const candidate = finishTrafficData({
      usedBytes: used.bytes,
      limitBytes: limit.bytes,
      remainingBytes: remaining && remaining.bytes,
      usedText: normalizeAmountText(pair[1]),
      limitText: normalizeAmountText(pair[2]),
      remainingText: remainingMatch ? normalizeAmountText(remainingMatch[1]) : null,
      billingMode: block,
      overagePolicy: block,
      resetDate: resetMatch && resetMatch[1],
      daysRemaining: daysMatch ? Number(daysMatch[1]) : null,
    }, source);
    if (candidate) candidates.push(candidate);
  }

  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.usedBytes}|${candidate.limitBytes}|${candidate.resetDate || ""}`;
    unique.set(key, candidate);
  }
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function primitiveEntries(object) {
  return Object.entries(object)
    .filter(([, value]) => (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ))
    .map(([key, value]) => ({ key, normalized: normalizeKey(key), value }));
}

function pick(entries, regex) {
  return entries.find((entry) => regex.test(entry.normalized)) || null;
}

function jsonCandidate(object, path) {
  const entries = primitiveEntries(object);
  if (!entries.length) return null;
  const context = normalizeKey(`${path}_${entries.map((entry) => entry.key).join("_")}`);
  if (!/(?:traffic|bandwidth|transfer|monthly_data|data_usage)/.test(context)) return null;

  const usedEntry = entries.find((entry) => (
    /(?:^|_)(?:used|usage|consumed|spent|transferred)(?:_|$)/.test(entry.normalized) &&
    !/(?:percent|ratio|rate)/.test(entry.normalized)
  )) || null;
  const limitEntry = pick(
    entries,
    /(?:^|_)(?:limit|quota|allowance|allocation|capacity|total)(?:_|$)/,
  );
  const remainingEntry = pick(
    entries,
    /(?:^|_)(?:remaining|remain|left|available)(?:_|$)/,
  );
  if (!usedEntry || !limitEntry) return null;

  const amounts = {
    used: parseAmount(usedEntry.value, usedEntry.key),
    limit: parseAmount(limitEntry.value, limitEntry.key),
    remaining: remainingEntry ? parseAmount(remainingEntry.value, remainingEntry.key) : null,
  };
  if (!amounts.used || !amounts.limit) return null;

  // 未声明单位的纯数字不可安全推断，避免把百分比或磁盘容量误当流量。
  if (!amounts.used.explicit || !amounts.limit.explicit) return null;

  const resetEntry = pick(
    entries,
    /(?:reset|renew|cycle_end|period_end|next_due|due_date)/,
  );
  const billingEntry = pick(entries, /(?:billing|direction|accounting|bidi)/);
  const overageEntry = pick(entries, /(?:overage|exceed|throttle|suspend)/);

  return finishTrafficData({
    usedBytes: amounts.used.bytes,
    limitBytes: amounts.limit.bytes,
    remainingBytes: amounts.remaining && amounts.remaining.bytes,
    usedText: amounts.used.display,
    limitText: amounts.limit.display,
    remainingText: amounts.remaining && amounts.remaining.display,
    billingMode: billingEntry && billingEntry.value,
    overagePolicy: overageEntry && overageEntry.value,
    resetDate: resetEntry && resetEntry.value,
  }, "json");
}

function findJsonTraffic(root) {
  const candidates = [];
  const seen = new Set();

  function visit(value, path, depth) {
    if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(value.length, 100); index += 1) {
        visit(value[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }

    const candidate = jsonCandidate(value, path);
    if (candidate) candidates.push(candidate);
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${path}.${key}`, depth + 1);
    }
  }

  visit(root, "$", 0);
  const unique = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.usedBytes}|${candidate.limitBytes}|${candidate.resetDate || ""}`;
    unique.set(key, candidate);
  }
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function parseEmbeddedJson(html) {
  const scripts = String(html || "").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const body = decodeHtmlEntities(match[1]).trim();
    if (!body || (!body.startsWith("{") && !body.startsWith("["))) continue;
    try {
      const candidate = findJsonTraffic(JSON.parse(body));
      if (candidate) return candidate;
    } catch (_) {
      // Ignore application scripts and continue with other embedded JSON blocks.
    }
  }
  return null;
}

function parseDmitTraffic(html) {
  const visible = visibleText(html, false);
  const fromVisible = parseTrafficText(visible, "html");
  if (fromVisible) return fromVisible;

  const fromJson = parseEmbeddedJson(html);
  if (fromJson) return fromJson;

  // Some frameworks serialize the rendered labels inside script strings.
  const withScripts = visibleText(html, true);
  return parseTrafficText(withScripts, "serialized-html");
}

function looksLoggedOut(html) {
  const text = String(html || "");
  return (
    /<input[^>]+type=["']password["']/i.test(text) ||
    /name=["']loginform["']/i.test(text) ||
    /(?:sign\s*in|log\s*in|登入|登录).{0,80}(?:password|密碼|密码)/i.test(visibleText(text))
  );
}

function looksLikeChallenge(html) {
  return /(?:just a moment|cf-chl-|cloudflare ray id|enable javascript and cookies)/i.test(
    String(html || ""),
  );
}

function setCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getAll === "function") {
    return headers.getAll("set-cookie").filter(Boolean);
  }
  const value = readHeader(headers, "set-cookie");
  if (!value) return [];
  return String(value).split(/,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
}

function mergeCookieHeader(current, setCookies) {
  const pairs = new Map();
  for (const part of String(current || "").split(";")) {
    const pair = part.trim();
    const equals = pair.indexOf("=");
    if (equals > 0) pairs.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  const validName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  for (const line of setCookies) {
    const first = String(line).split(";", 1)[0].trim();
    const equals = first.indexOf("=");
    if (equals <= 0) continue;
    const name = first.slice(0, equals).trim();
    const value = first.slice(equals + 1);
    if (!validName.test(name) || /[\u0000-\u001F\u007F]/.test(value)) continue;
    if (
      value === "" ||
      /;\s*max-age=0(?:;|$)/i.test(line) ||
      /;\s*expires=Thu,\s*01\s*Jan\s*1970/i.test(line)
    ) {
      pairs.delete(name);
    } else {
      pairs.set(name, value);
    }
  }
  return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function requestDmit(ctx, url, cookie, referer = DMIT.dashboardUrl) {
  let currentUrl = toDmitUrl(url);
  let currentReferer = toDmitUrl(referer);
  let activeCookie = ctx.storage.get(STORAGE.cookie) || cookie;
  const userAgent = env(ctx, "DMIT_USER_AGENT", DMIT.userAgent);

  for (let hop = 0; hop < 3; hop += 1) {
    const response = await ctx.http.get(currentUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh-CN;q=0.9,en;q=0.7",
        Cookie: activeCookie,
        Referer: currentReferer,
        "User-Agent": userAgent,
      },
      timeout: 15000,
      redirect: "manual",
      credentials: "omit",
    });

    const rotatedCookie = mergeCookieHeader(activeCookie, setCookieHeaders(response.headers));
    if (rotatedCookie && rotatedCookie !== activeCookie) {
      activeCookie = rotatedCookie;
      ctx.storage.set(STORAGE.cookie, activeCookie);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = readHeader(response.headers, "location");
      if (!location) throw new Error(`DMIT 返回 HTTP ${response.status}，但沒有跳轉地址`);
      const nextUrl = toDmitUrl(location, currentUrl);
      if (/(?:login|logout)/i.test(nextUrl)) {
        throw new Error("DMIT Cookie 已失效，請重新登入並觸發抓包");
      }
      currentReferer = currentUrl;
      currentUrl = nextUrl;
      continue;
    }

    const html = await response.text();
    if (readHeader(response.headers, "cf-mitigated")) {
      throw new Error("DMIT 觸發了 Cloudflare 驗證，請先在 Safari 完成驗證");
    }
    if (response.status === 401 || response.status === 403 || looksLoggedOut(html)) {
      throw new Error("DMIT Cookie 已失效，請重新登入並觸發抓包");
    }
    if (looksLikeChallenge(html)) {
      throw new Error("DMIT 觸發了 Cloudflare 驗證，請先在 Safari 完成驗證");
    }
    if (response.status === 429) {
      throw new Error("DMIT 請求過於頻繁，請稍後再試");
    }
    if (response.status >= 500) {
      throw new Error(`DMIT 服務暫時異常（HTTP ${response.status}）`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`DMIT 返回 HTTP ${response.status}`);
    }
    return html;
  }

  throw new Error("DMIT 頁面跳轉次數過多");
}

function productLinks(html) {
  const links = [];
  const source = decodeHtmlEntities(String(html || ""));
  const patterns = [
    /href=["']([^"']*clientarea\.php\?action=productdetails&id=\d+[^"']*)["']/gi,
    /href=["']([^"']*\/clientarea\/services\/\d+[^"']*)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      try {
        const url = toDmitUrl(match[1], DMIT.origin);
        if (!links.includes(url)) links.push(url);
      } catch (_) {
        // Ignore malformed or non-DMIT links.
      }
    }
  }
  return links;
}

async function resolveProductUrl(ctx, cookie) {
  const serviceId = env(ctx, "DMIT_SERVICE_ID", "").trim();
  if (serviceId) {
    if (!/^\d+$/.test(serviceId)) throw new Error("DMIT_SERVICE_ID 必須是純數字");
    return `${DMIT.origin}/clientarea.php?action=productdetails&id=${serviceId}`;
  }

  for (const indexUrl of [DMIT.servicesUrl, DMIT.dashboardUrl]) {
    const html = await requestDmit(ctx, indexUrl, cookie);
    const links = productLinks(html);
    if (links.length === 1) return links[0];
    if (links.length > 1) {
      throw new Error("檢測到多台 VPS，請在腳本 Env 設定 DMIT_SERVICE_ID");
    }

    const traffic = parseDmitTraffic(html);
    if (traffic) return indexUrl;
  }

  throw new Error("未找到 VPS；多台服務時請在腳本 Env 設定 DMIT_SERVICE_ID");
}

async function loadTraffic(ctx) {
  const cookie = ctx.storage.get(STORAGE.cookie);
  if (!cookie) throw new Error("尚未抓到 Cookie，請先登入 DMIT 並打開客戶中心");

  const productUrl = await resolveProductUrl(ctx, cookie);
  const html = await requestDmit(ctx, productUrl, cookie, DMIT.servicesUrl);
  const traffic = parseDmitTraffic(html);
  if (!traffic) {
    throw new Error("未能解析「每月流量」卡片，DMIT 頁面結構可能已更新");
  }

  const data = { ...traffic, productUrl };
  ctx.storage.setJSON(STORAGE.cache, data);
  ctx.storage.delete(STORAGE.error);
  return data;
}

function refreshAfter(ctx) {
  const minutes = Math.max(15, Number(env(ctx, "DMIT_REFRESH_MINUTES", "30")) || 30);
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function chip(text, style, icon = null) {
  const blue = style === "blue";
  const children = [];
  if (icon) {
    children.push({
      type: "image",
      src: `sf-symbol:${icon}`,
      width: 12,
      height: 12,
      color: blue ? COLORS.blueChipText : COLORS.grayChipText,
    });
  }
  children.push({
    type: "text",
    text,
    font: { size: 11, weight: "semibold" },
    textColor: blue ? COLORS.blueChipText : COLORS.grayChipText,
    maxLines: 1,
    minScale: 0.78,
  });
  return {
    type: "stack",
    direction: "row",
    alignItems: "center",
    gap: icon ? 4 : 0,
    padding: [3, 7, 3, 7],
    backgroundColor: blue ? COLORS.blueChip : COLORS.grayChip,
    borderColor: blue ? COLORS.blueChipBorder : COLORS.grayChipBorder,
    borderWidth: 1,
    borderRadius: 7,
    children,
  };
}

function progressBar(percent, width) {
  const safe = Math.max(0, Math.min(100, percent));
  const fillWidth = safe <= 0 ? 0 : Math.max(6, (width * safe) / 100);
  return {
    type: "stack",
    direction: "row",
    width,
    height: 10,
    padding: 0,
    backgroundColor: COLORS.track,
    borderRadius: 5,
    children: [
      {
        type: "stack",
        width: fillWidth,
        height: 10,
        backgroundGradient: {
          type: "linear",
          colors: [COLORS.progressStart, COLORS.progressEnd],
          stops: [0, 1],
          startPoint: { x: 0, y: 0.5 },
          endPoint: { x: 1, y: 0.5 },
        },
        borderRadius: 5,
        children: [],
      },
      { type: "spacer" },
    ],
  };
}

function headerRow(data, compact = false) {
  const children = [
    {
      type: "image",
      src: "sf-symbol:circle.slash",
      width: compact ? 14 : 14,
      height: compact ? 14 : 14,
      color: COLORS.icon,
    },
    {
      type: "text",
      text: "每月流量",
      font: { size: compact ? 13 : 11, weight: "semibold" },
      textColor: COLORS.headline,
      maxLines: 1,
    },
  ];
  if (compact) {
    children.push({ type: "spacer" });
  } else {
    children.push(
      chip(data.billingMode, "blue"),
      chip(data.overagePolicy, "gray", "arrow.down.right"),
    );
  }
  return {
    type: "stack",
    direction: "row",
    alignItems: "center",
    width: compact ? 128 : 274,
    height: compact ? 18 : 20,
    gap: 6,
    children,
  };
}

function valuesRow(data, compact = false) {
  return {
    type: "stack",
    direction: "row",
    alignItems: "center",
    children: [
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        gap: 5,
        children: [
          {
            type: "text",
            text: data.usedText,
            font: { size: compact ? 18 : 13, weight: compact ? "semibold" : "bold" },
            textColor: COLORS.primary,
            maxLines: 1,
            minScale: 0.72,
          },
          {
            type: "text",
            text: "/",
            font: { size: compact ? 17 : 13, weight: "regular" },
            textColor: COLORS.subtle,
          },
          {
            type: "text",
            text: data.limitText,
            font: { size: compact ? 17 : 13, weight: "regular" },
            textColor: COLORS.subtle,
            maxLines: 1,
            minScale: 0.72,
          },
        ],
      },
      { type: "spacer" },
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        gap: 5,
        children: [
          {
            type: "text",
            text: "剩餘",
            font: { size: compact ? 14 : 12, weight: "regular" },
            textColor: COLORS.secondary,
          },
          {
            type: "text",
            text: data.remainingText,
            font: { size: compact ? 16 : 13, weight: compact ? "semibold" : "bold" },
            textColor: COLORS.primary,
            maxLines: 1,
            minScale: 0.68,
          },
        ],
      },
    ],
    width: compact ? 128 : 274,
    height: compact ? 22 : 16,
  };
}

function resetRow(data) {
  const children = [
    {
      type: "image",
      src: "sf-symbol:clock",
      width: 14,
      height: 14,
      color: COLORS.subtle,
    },
    {
      type: "text",
      text: "下次重置",
      font: { size: 12, weight: "regular" },
      textColor: COLORS.secondary,
    },
  ];

  if (data.resetDate) {
    children.push({
      type: "text",
      text: data.resetDate,
      font: { size: 13, weight: "semibold" },
      textColor: COLORS.date,
    });
  }
  if (Number.isFinite(data.daysRemaining)) {
    children.push(
      {
        type: "text",
        text: "·",
        font: { size: 12, weight: "regular" },
        textColor: COLORS.subtle,
      },
      {
        type: "text",
        text: `${data.daysRemaining} 天後`,
        font: { size: 12, weight: "regular" },
        textColor: COLORS.secondary,
      },
    );
  }

  return {
    type: "stack",
    direction: "row",
    alignItems: "center",
    width: 274,
    height: 16,
    gap: 6,
    children,
  };
}

function mediumWidget(ctx, data) {
  const width = 274;
  return {
    type: "widget",
    url: data.productUrl || DMIT.dashboardUrl,
    refreshAfter: refreshAfter(ctx),
    padding: [10, 16, 18, 16],
    gap: 0,
    backgroundColor: COLORS.root,
    children: [{
      type: "stack",
      direction: "column",
      width: 306,
      height: 130,
      padding: [14, 16, 13, 16],
      gap: 0,
      backgroundColor: COLORS.panel,
      borderColor: COLORS.panelBorder,
      borderWidth: 1,
      borderRadius: 7,
      children: [
        headerRow(data, false),
        { type: "spacer", length: 12 },
        valuesRow(data, false),
        { type: "spacer", length: 7 },
        progressBar(data.usagePercent, width),
        { type: "spacer", length: 11 },
        {
          type: "stack",
          width,
          height: 1,
          backgroundColor: COLORS.divider,
          children: [],
        },
        { type: "spacer", length: 10 },
        resetRow(data),
      ],
    }],
  };
}

function smallWidget(ctx, data) {
  const width = 128;
  return {
    type: "widget",
    url: data.productUrl || DMIT.dashboardUrl,
    refreshAfter: refreshAfter(ctx),
    padding: 14,
    gap: 9,
    backgroundColor: COLORS.panel,
    children: [
      headerRow(data, true),
      {
        type: "text",
        text: data.usedText,
        font: { size: 24, weight: "semibold" },
        textColor: COLORS.primary,
        maxLines: 1,
        minScale: 0.7,
      },
      {
        type: "text",
        text: `/ ${data.limitText} · 剩餘 ${data.remainingText}`,
        font: { size: 12, weight: "regular" },
        textColor: COLORS.secondary,
        maxLines: 1,
        minScale: 0.58,
      },
      progressBar(data.usagePercent, width),
      { type: "spacer" },
      {
        type: "text",
        text: data.resetDate ? `下次重置 ${data.resetDate}` : "下次重置以官網為準",
        font: { size: 11, weight: "medium" },
        textColor: COLORS.secondary,
        maxLines: 1,
        minScale: 0.72,
      },
    ],
  };
}

function accessoryWidget(ctx, data) {
  const family = ctx.widgetFamily;
  if (family === "accessoryInline") {
    return {
      type: "widget",
      url: data.productUrl || DMIT.dashboardUrl,
      refreshAfter: refreshAfter(ctx),
      children: [{
        type: "text",
        text: `DMIT ${data.usedText} / ${data.limitText}`,
      }],
    };
  }
  return {
    type: "widget",
    url: data.productUrl || DMIT.dashboardUrl,
    refreshAfter: refreshAfter(ctx),
    padding: 5,
    gap: 2,
    children: [
      {
        type: "text",
        text: `${Math.round(data.usagePercent)}%`,
        font: { size: family === "accessoryCircular" ? 18 : 14, weight: "bold" },
        textAlign: "center",
        minScale: 0.7,
      },
      {
        type: "text",
        text: "DMIT",
        font: { size: "caption2", weight: "medium" },
        textAlign: "center",
      },
    ],
  };
}

function errorWidget(ctx, message) {
  return {
    type: "widget",
    url: DMIT.dashboardUrl,
    refreshAfter: refreshAfter(ctx),
    padding: 16,
    gap: 9,
    backgroundColor: COLORS.root,
    children: [
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        gap: 7,
        children: [
          {
            type: "image",
            src: "sf-symbol:exclamationmark.circle",
            width: 18,
            height: 18,
            color: COLORS.danger,
          },
          {
            type: "text",
            text: "DMIT 每月流量",
            font: { size: 16, weight: "semibold" },
            textColor: COLORS.primary,
          },
        ],
      },
      {
        type: "text",
        text: message,
        font: { size: 13, weight: "regular" },
        textColor: COLORS.secondary,
        maxLines: 5,
        minScale: 0.78,
      },
      { type: "spacer" },
      {
        type: "text",
        text: "輕點開啟 DMIT",
        font: { size: 12, weight: "semibold" },
        textColor: COLORS.blue,
      },
    ],
  };
}

function renderTraffic(ctx, data) {
  const family = ctx.widgetFamily || "systemMedium";
  if (family.startsWith("accessory")) return accessoryWidget(ctx, data);
  if (family === "systemSmall") return smallWidget(ctx, data);
  return mediumWidget(ctx, data);
}

export default async function main(ctx) {
  let data = null;
  try {
    data = await loadTraffic(ctx);
  } catch (error) {
    const problem = {
      message: error && error.message ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    };
    ctx.storage.setJSON(STORAGE.error, problem);
    data = ctx.storage.getJSON(STORAGE.cache);
    if (!data) return errorWidget(ctx, problem.message);
  }
  return renderTraffic(ctx, data);
}
