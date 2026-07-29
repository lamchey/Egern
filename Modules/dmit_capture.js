const STORAGE = {
  snapshot: "dmit.traffic.snapshot.v1",
  request: "dmit.traffic.request.v1",
  probe: "dmit.traffic.probe.v1",
  notified: "dmit.traffic.notified.v1",
  error: "dmit.traffic.error.v1",
};

const BYTE_UNITS = {
  B: 1,
  BYTE: 1,
  BYTES: 1,
  KB: 1000,
  KIB: 1024,
  MB: 1000 ** 2,
  MIB: 1024 ** 2,
  GB: 1000 ** 3,
  GIB: 1024 ** 3,
  TB: 1000 ** 4,
  TIB: 1024 ** 4,
  PB: 1000 ** 5,
  PIB: 1024 ** 5,
};

const AUTH_HEADER_NAMES = [
  "accept",
  "authorization",
  "content-type",
  "cookie",
  "origin",
  "referer",
  "user-agent",
  "x-csrf-token",
  "x-requested-with",
  "x-xsrf-token",
];

function env(ctx, name, fallback = "") {
  const value = ctx.env && ctx.env[name];
  return value == null || value === "" ? fallback : String(value);
}

function normalizeKey(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  const number = typeof value === "number"
    ? value
    : Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function multiplierFromKey(key) {
  const normalized = normalizeKey(key).toUpperCase();
  for (const unit of ["PIB", "PB", "TIB", "TB", "GIB", "GB", "MIB", "MB", "KIB", "KB"]) {
    if (
      normalized === unit ||
      normalized.endsWith(`_${unit}`) ||
      normalized.includes(`_${unit}_`)
    ) {
      return BYTE_UNITS[unit];
    }
  }
  if (normalized.includes("BYTE")) return 1;
  return null;
}

function parseAmount(value, key, numericUnit) {
  if (value == null || typeof value === "boolean") return null;
  const normalizedKey = normalizeKey(key);
  if (/(?:percent|percentage|ratio|rate)/.test(normalizedKey)) return null;

  if (typeof value === "string") {
    const match = value
      .replace(/,/g, "")
      .match(/(-?\d+(?:\.\d+)?)\s*(bytes?|[kmgtp](?:i)?b)\b/i);
    if (match) {
      const unit = match[2].toUpperCase();
      const multiplier = BYTE_UNITS[unit] || BYTE_UNITS[unit.replace(/S$/, "")];
      if (multiplier) {
        return {
          bytes: Number(match[1]) * multiplier,
          explicitUnit: true,
          raw: value,
        };
      }
    }
  }

  const number = finiteNumber(value);
  if (number == null || number < 0) return null;

  const keyMultiplier = multiplierFromKey(key);
  if (keyMultiplier) {
    return { bytes: number * keyMultiplier, explicitUnit: true, raw: value };
  }

  const configured = String(numericUnit || "auto").toUpperCase();
  if (configured !== "AUTO") {
    const multiplier = configured === "BYTES" ? 1 : BYTE_UNITS[configured];
    if (multiplier) {
      return { bytes: number * multiplier, explicitUnit: true, raw: value };
    }
  }

  return { bytes: number, explicitUnit: false, raw: value };
}

function parsePercent(value) {
  if (value == null) return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  let number = Number(match[0]);
  if (!Number.isFinite(number)) return null;
  if (number >= 0 && number <= 1 && !String(value).includes("%")) number *= 100;
  return Math.max(0, Math.min(100, number));
}

function normalizeDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    let timestamp = Number(value);
    if (timestamp < 10_000_000_000) timestamp *= 1000;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 80) : date.toISOString();
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

function scaleImplicitAmounts(amounts, numericUnit) {
  if (String(numericUnit).toLowerCase() !== "auto") return;
  const limit = amounts.limit;
  if (!limit || limit.explicitUnit) return;

  // DMIT 套餐配额通常以数百或数千 GB 表示。若接口返回小型纯数字，
  // 自动按 GB 解释；字节数通常会大于 1e9。
  const scale = limit.bytes >= 10 && limit.bytes < 10_000_000
    ? BYTE_UNITS.GB
    : 1;
  if (scale === 1) return;

  for (const amount of Object.values(amounts)) {
    if (amount && !amount.explicitUnit) amount.bytes *= scale;
  }
}

function candidateFromObject(object, path, numericUnit, billingMode) {
  const entries = primitiveEntries(object);
  if (!entries.length) return null;

  const context = normalizeKey(`${path}_${entries.map((item) => item.key).join("_")}`);
  const trafficContext = /(?:traffic|bandwidth|transfer|monthly_data|data_usage)/.test(context);

  const usedEntry = entries.find((entry) => (
    /(?:^|_)(?:used|usage|consumed|consume|spent|transferred)(?:_|$)/.test(entry.normalized) &&
    !/(?:percent|percentage|ratio|rate)/.test(entry.normalized)
  )) || null;
  const limitEntry = pick(
    entries,
    /(?:^|_)(?:limit|quota|allowance|allocation|capacity|total)(?:_|$)/,
  );
  const remainingEntry = pick(
    entries,
    /(?:^|_)(?:remaining|remain|left|available)(?:_|$)/,
  );
  const inboundEntry = pick(
    entries,
    /(?:^|_)(?:inbound|incoming|download|received|receive|rx|in)(?:_|$)/,
  );
  const outboundEntry = pick(
    entries,
    /(?:^|_)(?:outbound|outgoing|upload|sent|send|tx|out)(?:_|$)/,
  );
  const percentEntry = pick(entries, /(?:percent|percentage|usage_rate|ratio)/);
  const resetEntry = pick(
    entries,
    /(?:reset|renew|cycle_end|period_end|next_due|due_date)/,
  );

  let fallbackUsedEntry = usedEntry;
  if (!fallbackUsedEntry && limitEntry) {
    fallbackUsedEntry = pick(entries, /^(?:traffic|bandwidth|transfer)$/);
  }

  const amounts = {
    used: fallbackUsedEntry
      ? parseAmount(fallbackUsedEntry.value, fallbackUsedEntry.key, numericUnit)
      : null,
    limit: limitEntry
      ? parseAmount(limitEntry.value, limitEntry.key, numericUnit)
      : null,
    remaining: remainingEntry
      ? parseAmount(remainingEntry.value, remainingEntry.key, numericUnit)
      : null,
    inbound: inboundEntry
      ? parseAmount(inboundEntry.value, inboundEntry.key, numericUnit)
      : null,
    outbound: outboundEntry
      ? parseAmount(outboundEntry.value, outboundEntry.key, numericUnit)
      : null,
  };

  scaleImplicitAmounts(amounts, numericUnit);

  let used = amounts.used && amounts.used.bytes;
  let limit = amounts.limit && amounts.limit.bytes;
  let remaining = amounts.remaining && amounts.remaining.bytes;
  const inbound = amounts.inbound && amounts.inbound.bytes;
  const outbound = amounts.outbound && amounts.outbound.bytes;

  if (used == null && inbound != null && outbound != null) {
    used = String(billingMode).toLowerCase() === "sum"
      ? inbound + outbound
      : Math.max(inbound, outbound);
  }
  if (limit == null && used != null && remaining != null) {
    limit = used + remaining;
  }
  if (used == null && limit != null && remaining != null) {
    used = Math.max(0, limit - remaining);
  }
  if (remaining == null && limit != null && used != null) {
    remaining = Math.max(0, limit - used);
  }

  let score = trafficContext ? 5 : 0;
  if (used != null) score += 4;
  if (limit != null) score += 4;
  if (remaining != null) score += 2;
  if (inbound != null || outbound != null) score += 2;
  if (percentEntry) score += 1;
  if (resetEntry) score += 1;

  if (!trafficContext || score < 11 || used == null || limit == null || limit <= 0) {
    return null;
  }

  const serviceEntry = pick(
    entries,
    /^(?:service_name|product_name|package_name|hostname|label|name|service_id|id)$/,
  );
  const calculatedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
  const suppliedPercent = percentEntry ? parsePercent(percentEntry.value) : null;

  return {
    score,
    service: serviceEntry ? String(serviceEntry.value).slice(0, 100) : "DMIT VPS",
    usedBytes: Math.max(0, used),
    limitBytes: Math.max(0, limit),
    remainingBytes: Math.max(0, remaining == null ? limit - used : remaining),
    usagePercent: suppliedPercent == null ? calculatedPercent : suppliedPercent,
    inboundBytes: inbound,
    outboundBytes: outbound,
    resetAt: resetEntry ? normalizeDate(resetEntry.value) : null,
    sourcePath: path || "$",
  };
}

function findJsonCandidate(root, numericUnit, billingMode) {
  const candidates = [];
  const seen = new Set();

  function visit(value, path, depth) {
    if (value == null || depth > 10 || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (isObject(value)) {
      const candidate = candidateFromObject(value, path, numericUnit, billingMode);
      if (candidate) candidates.push(candidate);
      for (const [key, child] of Object.entries(value)) {
        visit(child, `${path}.${key}`, depth + 1);
      }
      return;
    }

    for (let index = 0; index < Math.min(value.length, 100); index += 1) {
      visit(value[index], `${path}[${index}]`, depth + 1);
    }
  }

  visit(root, "$", 0);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function extractHtmlAmount(text, labels) {
  const amount = "(-?\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:bytes?|[kmgtp](?:i)?b))";
  const regex = new RegExp(`(?:${labels})[\\s\\S]{0,160}?${amount}`, "i");
  const match = text.match(regex);
  return match ? match[1] : null;
}

function findHtmlCandidate(text, numericUnit) {
  const usedRaw = extractHtmlAmount(
    text,
    "traffic\\s*(?:used|usage)|used\\s*(?:traffic|bandwidth)|bandwidth\\s*usage|已用流量|流量使用",
  );
  const limitRaw = extractHtmlAmount(
    text,
    "traffic\\s*(?:limit|quota)|bandwidth\\s*(?:limit|quota)|total\\s*(?:traffic|bandwidth)|总流量|流量额度",
  );
  if (!usedRaw || !limitRaw) return null;

  const used = parseAmount(usedRaw, "used", numericUnit);
  const limit = parseAmount(limitRaw, "limit", numericUnit);
  if (!used || !limit || limit.bytes <= 0) return null;

  const resetMatch = text.match(
    /(?:reset|renew|next due|重置时间|下次重置)[\s\S]{0,100}?(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)/i,
  );
  const usagePercent = Math.max(0, Math.min(100, (used.bytes / limit.bytes) * 100));
  return {
    score: 12,
    service: "DMIT VPS",
    usedBytes: used.bytes,
    limitBytes: limit.bytes,
    remainingBytes: Math.max(0, limit.bytes - used.bytes),
    usagePercent,
    inboundBytes: null,
    outboundBytes: null,
    resetAt: resetMatch ? normalizeDate(resetMatch[1]) : null,
    sourcePath: "html",
  };
}

function parsePayload(text, numericUnit, billingMode) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  try {
    const json = JSON.parse(trimmed);
    const candidate = findJsonCandidate(json, numericUnit, billingMode);
    if (candidate) return candidate;
  } catch (_) {
    // HTML responses are handled below.
  }

  const nextData = trimmed.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextData) {
    try {
      const candidate = findJsonCandidate(JSON.parse(nextData[1]), numericUnit, billingMode);
      if (candidate) return candidate;
    } catch (_) {
      // Continue with the label-based HTML parser.
    }
  }

  return findHtmlCandidate(trimmed, numericUnit);
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return String(url || "").split("?")[0].slice(0, 500);
  }
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || null;
}

function selectedHeaders(headers) {
  const result = {};
  for (const name of AUTH_HEADER_NAMES) {
    const value = getHeader(headers, name);
    if (value != null && String(value) !== "") result[name] = String(value);
  }
  return result;
}

function matchesFilter(ctx, candidate, url) {
  const filter = env(ctx, "DMIT_SERVICE_FILTER", "").trim().toLowerCase();
  if (!filter) return true;
  return `${candidate.service} ${candidate.sourcePath} ${url}`
    .toLowerCase()
    .includes(filter);
}

function enrichCandidate(candidate, url, source) {
  return {
    ...candidate,
    endpoint: sanitizeUrl(url),
    source,
    updatedAt: new Date().toISOString(),
  };
}

async function requestBodyText(request) {
  if (!request || !request.body || request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  try {
    return await request.text();
  } catch (_) {
    return null;
  }
}

async function saveRequestTemplate(ctx) {
  const request = ctx.request;
  const headers = selectedHeaders(request.headers);
  const template = {
    url: request.url,
    method: String(request.method || "GET").toUpperCase(),
    headers,
    body: await requestBodyText(request),
    savedAt: new Date().toISOString(),
  };
  ctx.storage.setJSON(STORAGE.request, template);
}

async function handleResponse(ctx) {
  let text = "";
  try {
    text = await ctx.response.text();
    const contentType = getHeader(ctx.response.headers, "content-type") || "";
    const probe = {
      url: sanitizeUrl(ctx.request.url),
      status: ctx.response.status,
      contentType: String(contentType).slice(0, 120),
      observedAt: new Date().toISOString(),
    };
    ctx.storage.setJSON(STORAGE.probe, probe);

    if (ctx.response.status >= 200 && ctx.response.status < 300) {
      const numericUnit = env(ctx, "DMIT_NUMERIC_UNIT", "auto");
      const billingMode = env(ctx, "DMIT_BILLING_MODE", "max");
      const candidate = parsePayload(text, numericUnit, billingMode);
      if (candidate && matchesFilter(ctx, candidate, ctx.request.url)) {
        const snapshot = enrichCandidate(candidate, ctx.request.url, "capture");
        ctx.storage.setJSON(STORAGE.snapshot, snapshot);
        ctx.storage.delete(STORAGE.error);
        await saveRequestTemplate(ctx);

        const notified = ctx.storage.get(STORAGE.notified);
        const notificationKey = `${snapshot.endpoint}|${snapshot.service}`;
        if (notified !== notificationKey) {
          ctx.storage.set(STORAGE.notified, notificationKey);
          ctx.notify({
            title: "DMIT 流量捕获成功",
            body: `${snapshot.service}：${formatBytes(snapshot.usedBytes)} / ${formatBytes(snapshot.limitBytes)}`,
            sound: false,
          });
        }
      }
    }
  } catch (error) {
    ctx.storage.setJSON(STORAGE.error, {
      message: `捕获失败：${error && error.message ? error.message : String(error)}`,
      updatedAt: new Date().toISOString(),
    });
  }

  // 读取响应流后必须把正文放回，避免影响 Safari 中的 DMIT 页面。
  return { body: text };
}

async function refreshFromSavedRequest(ctx) {
  const template = ctx.storage.getJSON(STORAGE.request);
  if (!template || !template.url) return null;

  const method = String(template.method || "GET").toLowerCase();
  const sender = ctx.http[method];
  if (typeof sender !== "function") throw new Error(`暂不支持 ${template.method} 请求`);

  const options = {
    headers: template.headers || {},
    timeout: 15000,
    redirect: "manual",
    credentials: "include",
  };
  if (template.body != null && method !== "get" && method !== "head") {
    options.body = template.body;
  }

  const response = await sender.call(ctx.http, template.url, options);
  const text = await response.text();
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error("DMIT 登录会话已过期，请重新登录并打开 VPS 详情页");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`DMIT 返回 HTTP ${response.status}`);
  }

  const numericUnit = env(ctx, "DMIT_NUMERIC_UNIT", "auto");
  const billingMode = env(ctx, "DMIT_BILLING_MODE", "max");
  const candidate = parsePayload(text, numericUnit, billingMode);
  if (!candidate || !matchesFilter(ctx, candidate, template.url)) {
    if (/<(?:title|form)[^>]*>[\s\S]{0,200}(?:login|sign in)/i.test(text)) {
      throw new Error("DMIT 登录会话已过期，请重新登录并打开 VPS 详情页");
    }
    throw new Error("未能识别流量字段，DMIT 接口结构可能已变化");
  }

  const snapshot = enrichCandidate(candidate, template.url, "live");
  ctx.storage.setJSON(STORAGE.snapshot, snapshot);
  ctx.storage.delete(STORAGE.error);
  return snapshot;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

async function handleSchedule(ctx) {
  try {
    const snapshot = await refreshFromSavedRequest(ctx);
    if (!snapshot) throw new Error("尚未捕获 DMIT 流量请求，请先登录并打开 VPS 详情页");
    ctx.storage.delete(STORAGE.error);
  } catch (error) {
    const currentError = {
      message: error && error.message ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    };
    const previousError = ctx.storage.getJSON(STORAGE.error);
    ctx.storage.setJSON(STORAGE.error, currentError);
    if (!previousError || previousError.message !== currentError.message) {
      ctx.notify({
        title: "DMIT 流量刷新失败",
        body: currentError.message,
        sound: false,
      });
    }
  }
}

export default async function main(ctx) {
  if (ctx.request && ctx.response) return handleResponse(ctx);
  return handleSchedule(ctx);
}
