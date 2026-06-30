/**
 * 机场订阅流量监控小组件
 * by@lamchey
 *
 * 功能说明：
 * 1. 从 Sub-Store 读取订阅列表及流量信息
 * 2. 解析已用流量、总流量、到期时间、重置日期
 * 3. 支持缓存，避免频繁请求
 * 4. 根据使用率显示不同颜色
 * 5. 自动适配系统深色/浅色模式
 *
 * 📝 使用说明
 * 1️⃣ 添加环境变量（在 Egern 中进入小组件"编辑环境变量"）：
 *
 * SUB_STORE_URL=http://192.168.1.100:3000/<安全口令>    # Sub-Store 地址（必填）
 *
 * INEXCLUDE_SUB=1,3                          # 指定显示第几个订阅（从1开始，不填则显示全部，支持 1,3 或 1-4）
 * RESET=1,3                                  # 指定第几个显示重置日倒数（从1开始，不填则不显示，支持 1,3 或 1-4）
 *
 * TIMEOUT_MS=8000                            # 请求超时毫秒数（默认 8000）
 * FLOW_USER_AGENT=clash.meta/v1.19.23        # 流量查询 User-Agent
 * INSECURE_TLS=false                         # 允许不安全的 HTTPS（默认 false）
 */

// ─── 常量 ────────────────────────────────────────────────────────────────────

const CACHE_TIME = 60 * 60 * 1000;
const CACHE_KEY = "substore_widget_cache_v1";

const UA_LIST = [
  { "User-Agent": "Quantumult%20X/1.5.2" },
  {
    "User-Agent": "clash-verge-rev/2.3.1",
    Accept: "application/x-yaml,text/plain,*/*",
  },
  {
    "User-Agent": "mihomo/1.19.3",
    Accept: "application/x-yaml,text/plain,*/*",
  },
];

// 左中右区域比例
const LEFT_FLEX = 1.28;
const CENTER_FLEX = 1.28;
const RIGHT_FLEX = 1.0;

// ─── 入口 ────────────────────────────────────────────────────────────────────

export default async function (ctx) {
  const cfg = getConfig(ctx);
  const refreshTime = new Date(Date.now() + CACHE_TIME).toISOString();

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;

  const colors = makeColors();
  const bgGradient = makeBgGradient();

  if (!cfg.baseUrl) {
    return noConfigWidget(bgGradient, refreshTime, colors);
  }

  const cached = readCache(ctx, cfg);

  let results;
  try {
    results = await loadResults(ctx, cfg);
    writeCache(ctx, cfg, results);
  } catch (e) {
    if (cached && cached.length) {
      results = cached;
    } else {
      return errorWidget(bgGradient, refreshTime, colors, shortError(e));
    }
  }

  if (!results.length) {
    return errorWidget(
      bgGradient,
      refreshTime,
      colors,
      "未找到订阅\n所有订阅均被过滤，或 Sub-Store 中没有远程订阅"
    );
  }

  const isLarge = ctx.widgetFamily === "systemLarge";
  const maxDisplay = isLarge ? 5 : 2;

  return {
    type: "widget",
    backgroundGradient: bgGradient,
    padding: 8,
    gap: 5,
    refreshAfter: refreshTime,
    children: [
      headerRow(timeStr, colors),
      {
        type: "stack",
        direction: "column",
        gap: 6,
        children: results
          .slice(0, maxDisplay)
          .map((r) => buildCard(r, colors, ctx)),
      },
    ],
  };
}

// ─── 配置 ────────────────────────────────────────────────────────────────────

function getConfig(ctx) {
  const env = ctx.env || {};

  const baseUrls = unique(
    [env.SUB_STORE_URL, env.SUB_STORE_BASE_URL, env.BASE_URL]
      .map((u) => normalizeUrl(u))
      .filter(Boolean)
  );

  return {
    baseUrl: baseUrls[0] || "",
    baseUrls,
    includeIndexes: parseRangeList(env.INEXCLUDE_SUB || ""),
    resetIndexes: parseRangeList(env.RESET || ""),
    timeout: clampInt(env.TIMEOUT_MS, 8000, 1000, 60000),
    flowUserAgent: env.FLOW_USER_AGENT || "clash.meta/v1.19.23",
    insecureTls: bool(env.INSECURE_TLS, false),
    cacheKey: CACHE_KEY,
  };
}

// ─── 数据加载 ────────────────────────────────────────────────────────────────

async function loadResults(ctx, cfg) {
  const subs = await fetchSubscriptions(ctx, cfg);

  const remoteSubsWithIndex = subs
    .filter(isRemoteSub)
    .map((sub, i) => ({ sub, originalIndex: i + 1 }));

  const selected = selectSubscriptions(remoteSubsWithIndex, cfg);
  const items = new Array(selected.length);

  await Promise.all(
    selected.map(async (item, i) => {
      items[i] = await fetchFlowItem(ctx, cfg, item.sub, item.originalIndex);
    })
  );

  return items.filter(Boolean);
}

async function fetchSubscriptions(ctx, cfg) {
  const urls = cfg.baseUrls.length ? cfg.baseUrls : [cfg.baseUrl];
  let lastError;

  for (const base of urls) {
    try {
      const json = await requestJson(ctx, apiUrl(base, "/api/subs"), cfg);
      const data = unwrap(json);

      let subs = null;

      if (Array.isArray(data)) {
        subs = data.filter(Boolean);
      } else if (data && typeof data === "object") {
        subs = Object.values(data).filter(Boolean);
      }

      if (subs) {
        cfg.baseUrl = base;
        return subs;
      }

      throw new Error("订阅列表格式异常");
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("无法连接 Sub-Store");
}

function selectSubscriptions(remoteSubsWithIndex, cfg) {
  if (!cfg.includeIndexes || cfg.includeIndexes.length === 0) {
    return remoteSubsWithIndex;
  }

  const allowed = new Set(cfg.includeIndexes);
  return remoteSubsWithIndex.filter((item) => allowed.has(item.originalIndex));
}

function isRemoteSub(sub) {
  if (!sub || typeof sub !== "object") return false;
  if (sub.subUserinfo) return true;
  if (sub.source === "remote") return true;
  if (sub.url && /^https?:\/\//i.test(String(sub.url).trim())) return true;
  return false;
}

async function fetchFlowItem(ctx, cfg, sub, originalIndex) {
  const name = String(sub?.name || "未命名订阅");

  if (sub.missing) {
    return {
      name,
      error: "订阅不存在",
    };
  }

  try {
    const json = await requestJson(
      ctx,
      apiUrl(cfg.baseUrl, "/api/sub/flow/" + encodeURIComponent(name)),
      cfg
    );

    const flow = normalizeFlow(unwrap(json));

    if (hasUsableFlow(flow)) {
      return decorateItem(sub, flow, cfg, originalIndex);
    }
  } catch (_) {}

  try {
    const flow = await fetchDirectFlow(ctx, cfg, sub);

    if (hasUsableFlow(flow)) {
      return decorateItem(sub, flow, cfg, originalIndex);
    }
  } catch (_) {}

  return {
    name,
    error: "无法获取流量信息",
  };
}

async function fetchDirectFlow(ctx, cfg, sub) {
  const rawUrl = firstHttpUrl(sub.url || sub.subUserinfo || "");

  if (!rawUrl) {
    throw new Error("订阅链接不可用");
  }

  const variants = buildVariants(rawUrl);

  for (const method of ["head", "get"]) {
    for (const url of variants) {
      for (const headers of UA_LIST) {
        try {
          const resp = await ctx.http[method](url, {
            headers: {
              ...headers,
              "User-Agent": headers["User-Agent"] || cfg.flowUserAgent,
            },
            timeout: cfg.timeout,
            redirect: "follow",
            insecureTls: cfg.insecureTls,
          });

          const raw = getHeader(resp.headers, "subscription-userinfo");
          const flow = parseFlowString(raw);

          if (hasUsableFlow(flow)) {
            return flow;
          }
        } catch (_) {}
      }
    }
  }

  throw new Error("响应头未包含流量信息");
}

// ─── 流量数据处理 ─────────────────────────────────────────────────────────────

function normalizeFlow(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const usage = d.usage && typeof d.usage === "object" ? d.usage : {};

  return {
    total: toNum(d.total),
    upload: toNum(usage.upload ?? d.upload),
    download: toNum(usage.download ?? d.download),
    expires: toNum(d.expires ?? d.expire),
    remainingDays: toNum(d.remainingDays),
    resetDay: toNum(d.reset_day),
    planName: String(d.planName || d.plan_name || ""),
  };
}

function hasUsableFlow(flow) {
  return (
    flow &&
    Number.isFinite(flow.total) &&
    flow.total > 0 &&
    Number.isFinite(flow.upload) &&
    Number.isFinite(flow.download)
  );
}

function parseFlowString(raw) {
  const s = String(raw || "");

  const field = (key) => {
    const m = s.match(
      new RegExp(key + "=([-+]?)([0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)")
    );
    return m ? Number(m[1] + m[2]) : NaN;
  };

  return normalizeFlow({
    upload: field("upload"),
    download: field("download"),
    total: field("total"),
    expire: field("expire"),
    reset_day: field("reset_day"),
  });
}

function decorateItem(sub, flow, cfg, originalIndex) {
  const total = finiteOr(flow.total, 0);
  const upload = finiteOr(flow.upload, 0);
  const download = finiteOr(flow.download, 0);
  const used = upload + download;
  const percent = total > 0 ? (used / total) * 100 : 0;

  let expire = null;

  if (Number.isFinite(flow.expires) && flow.expires > 0) {
    expire = flow.expires < 1e12 ? flow.expires * 1000 : flow.expires;
  }

  const name = String(sub.name || "订阅");

  const isShowReset =
    cfg &&
    Array.isArray(cfg.resetIndexes) &&
    cfg.resetIndexes.includes(originalIndex);

  let resetDays = null;

  if (isShowReset) {
    if (Number.isFinite(flow.remainingDays) && flow.remainingDays >= 0) {
      resetDays = Math.max(0, Math.floor(flow.remainingDays));
    } else if (
      Number.isFinite(flow.resetDay) &&
      flow.resetDay >= 1 &&
      flow.resetDay <= 31
    ) {
      resetDays = getDaysUntilReset(flow.resetDay);
    } else if (expire) {
      resetDays = getDaysUntilReset(new Date(expire).getDate());
    }
  }

  return {
    name: String(sub.displayName || flow.planName || name),
    error: null,
    used,
    totalBytes: total,
    percent,
    expire,
    resetDays,
  };
}

// ─── 缓存 ─────────────────────────────────────────────────────────────────────

function readCache(ctx, cfg) {
  if (!ctx.storage?.getJSON) return null;

  try {
    const cached = ctx.storage.getJSON(cfg.cacheKey);

    if (
      cached &&
      Date.now() - cached.time < CACHE_TIME &&
      Array.isArray(cached.items)
    ) {
      return cached.items;
    }
  } catch (_) {}

  return null;
}

function writeCache(ctx, cfg, items) {
  if (!ctx.storage?.setJSON) return;

  try {
    ctx.storage.setJSON(cfg.cacheKey, {
      time: Date.now(),
      items,
    });
  } catch (_) {}
}

// ─── UI 组件 ─────────────────────────────────────────────────────────────────

function makeColors() {
  return {
    textPrimary: {
      light: "#000000",
      dark: "#FFFFFF",
    },
    textSecondary: {
      light: "#555555",
      dark: "#EBEBF5",
    },
    textTertiary: {
      light: "#888888",
      dark: "#8E8E93",
    },
    accentBlue: {
      light: "#007AFF",
      dark: "#0A84FF",
    },
    accentGreen: {
      light: "#34C759",
      dark: "#30D158",
    },
    accentSoftBlue: {
      light: "#8ED6FF",
      dark: "#60BFFF",
    },
    accentSoftYellow: {
      light: "#EBCB8B",
      dark: "#D6A94A",
    },
    accentRed: {
      light: "#FF3B30",
      dark: "#FF453A",
    },
    divider: {
      light: "#E5E5EA",
      dark: "#48484A",
    },
    progressTrack: {
      light: "#E8E8EA",
      dark: "#48484A",
    },
  };
}

function makeBgGradient() {
  return {
    type: "linear",
    colors: [
      {
        light: "#FFFFFF",
        dark: "#2C2C2E",
      },
      {
        light: "#FFFFFF",
        dark: "#2C2C2E",
      },
    ],
    stops: [0, 1],
    startPoint: {
      x: 0,
      y: 0,
    },
    endPoint: {
      x: 0,
      y: 1,
    },
  };
}

function headerRow(timeStr, colors) {
  return {
    type: "stack",
    direction: "row",
    alignItems: "center",
    gap: 6,
    children: [
      {
        type: "stack",
        width: 2,
      },
      {
        type: "image",
        src: "sf-symbol:network",
        width: 12,
        height: 12,
        color: colors.accentBlue,
      },
      {
        type: "text",
        text: "机场订阅",
        font: {
          size: "subheadline",
          weight: "bold",
        },
        textColor: colors.textPrimary,
      },
      {
        type: "spacer",
      },
      {
        type: "image",
        src: "sf-symbol:arrow.clockwise",
        width: 12,
        height: 12,
        color: colors.textTertiary,
      },
      {
        type: "text",
        text: timeStr,
        font: {
          size: "caption2",
          weight: "medium",
        },
        textColor: colors.textTertiary,
      },
      {
        type: "stack",
        width: 0.5,
      },
    ],
  };
}

function buildCard(result, colors, ctx) {
  const { name, error, used, totalBytes, percent, expire, resetDays } = result;

  let statusColor = colors.accentGreen;

  if (error) {
    statusColor = colors.accentRed;
  } else if (percent >= 95) {
    statusColor = colors.accentRed;
  } else if (percent >= 80) {
    statusColor = colors.accentSoftYellow;
  } else if (percent >= 50) {
    statusColor = colors.accentSoftBlue;
  }

  if (error) {
    return {
      type: "stack",
      direction: "row",
      gap: 8,
      padding: [9, 10],
      backgroundColor: {
        light: "#FFF5F5",
        dark: "#3B1F1F",
      },
      borderRadius: 12,
      children: [
        {
          type: "stack",
          width: 3,
          backgroundColor: colors.accentRed,
          borderRadius: 2,
        },
        {
          type: "stack",
          direction: "row",
          flex: 1,
          alignItems: "center",
          children: [
            {
              type: "text",
              text: name,
              font: {
                size: "subheadline",
                weight: "semibold",
              },
              textColor: colors.textPrimary,
              flex: 1,
            },
            {
              type: "text",
              text: typeof error === "string" ? error : "失败",
              font: {
                size: "caption2",
                weight: "semibold",
              },
              textColor: colors.accentRed,
            },
          ],
        },
      ],
    };
  }

  const progressPercent = Math.min(Math.max(percent, 0), 100);

  const usedStr = formatGB(used);
  const totalStr = formatGB(totalBytes);
  const remainStr = formatGB(Math.max(totalBytes - used, 0));

  let expireText = "长期有效";

  if (expire && Number(expire) > 0) {
    const d = new Date(Number(expire));
    expireText = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")} 到期`;
  }

  const resetText = resetDays !== null ? `${resetDays}天后 重置` : "";
  const isSmall = ctx.widgetFamily === "systemSmall";

  return {
    type: "stack",
    direction: "column",
    gap: 6,
    padding: [9, 10],
    backgroundColor: {
      light: "#FFFFFF",
      dark: "#2B2B2D",
    },
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.divider,
    children: [
      // 第一行：名称 + 重置倒数 + 百分比
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        children: isSmall
          ? [
              {
                type: "image",
                src: "sf-symbol:circle.fill",
                width: 6,
                height: 6,
                color: statusColor,
              },
              {
                type: "stack",
                width: 5,
              },
              {
                type: "text",
                text: name,
                font: {
                  size: "caption2",
                  weight: "semibold",
                },
                textColor: colors.textPrimary,
                flex: 1,
                lineLimit: 1,
              },
              {
                type: "text",
                text: `${Math.round(progressPercent)}%`,
                font: {
                  size: "caption2",
                  weight: "bold",
                },
                textColor: statusColor,
                lineLimit: 1,
              },
            ]
          : [
              {
                type: "stack",
                direction: "row",
                flex: LEFT_FLEX,
                alignItems: "center",
                children: [
                  {
                    type: "image",
                    src: "sf-symbol:circle.fill",
                    width: 6,
                    height: 6,
                    color: statusColor,
                  },
                  {
                    type: "stack",
                    width: 6,
                  },
                  {
                    type: "text",
                    text: name,
                    font: {
                      size: "caption1",
                      weight: "semibold",
                    },
                    textColor: colors.textPrimary,
                    lineLimit: 1,
                  },
                  {
                    type: "spacer",
                  },
                ],
              },
              {
                type: "stack",
                direction: "row",
                flex: CENTER_FLEX,
                alignItems: "center",
                children: [
                  {
                    type: "spacer",
                  },
                  {
                    type: "text",
                    text: resetText,
                    font: {
                      size: "caption2",
                      weight: "medium",
                    },
                    textColor: colors.textTertiary,
                    lineLimit: 1,
                  },
                  {
                    type: "spacer",
                  },
                ],
              },
              {
                type: "stack",
                direction: "row",
                flex: RIGHT_FLEX,
                alignItems: "center",
                children: [
                  {
                    type: "spacer",
                  },
                  {
                    type: "text",
                    text: `${Math.round(progressPercent)}%`,
                    font: {
                      size: "caption1",
                      weight: "bold",
                    },
                    textColor: statusColor,
                    lineLimit: 1,
                    minimumScaleFactor: 0.75,
                  },
                ],
              },
            ],
      },

      // 小尺寸时单独显示重置倒数
      ...(
        isSmall
          ? [
              {
                type: "stack",
                direction: "row",
                alignItems: "center",
                children: [
                  {
                    type: "spacer",
                  },
                  {
                    type: "text",
                    text: resetText,
                    font: {
                      size: "caption2",
                      weight: "medium",
                    },
                    textColor: colors.textTertiary,
                    lineLimit: 1,
                  },
                  {
                    type: "spacer",
                  },
                ],
              },
            ]
          : []
      ),

      // 第二行：非分段式进度条
      buildProgressBar(progressPercent, statusColor, colors),

      // 第三行：已用/总量 + 到期时间/长期有效 + 剩余流量
      {
        type: "stack",
        direction: "row",
        alignItems: "center",
        children: isSmall
          ? [
              {
                type: "text",
                text: `${usedStr}/${totalStr}`,
                font: {
                  size: "caption2",
                  weight: "medium",
                },
                textColor: colors.textSecondary,
                lineLimit: 1,
                minimumScaleFactor: 0.75,
              },
              {
                type: "spacer",
              },
              {
                type: "text",
                text: `剩${remainStr}`,
                font: {
                  size: "caption2",
                  weight: "semibold",
                },
                textColor: colors.accentGreen,
                lineLimit: 1,
                minimumScaleFactor: 0.7,
              },
            ]
          : [
              {
                type: "stack",
                direction: "row",
                flex: LEFT_FLEX,
                alignItems: "center",
                children: [
                  {
                    type: "text",
                    text: `${usedStr}/${totalStr}`,
                    font: {
                      size: "caption2",
                      weight: "medium",
                    },
                    textColor: colors.textSecondary,
                    lineLimit: 1,
                    minimumScaleFactor: 0.75,
                  },
                  {
                    type: "spacer",
                  },
                ],
              },
              {
                type: "stack",
                direction: "row",
                flex: CENTER_FLEX,
                alignItems: "center",
                children: [
                  {
                    type: "spacer",
                  },
                  {
                    type: "text",
                    text: expireText,
                    font: {
                      size: "caption2",
                      weight: "medium",
                    },
                    textColor: colors.textTertiary,
                    lineLimit: 1,
                    minimumScaleFactor: 0.75,
                  },
                  {
                    type: "spacer",
                  },
                ],
              },
              {
                type: "stack",
                direction: "row",
                flex: RIGHT_FLEX,
                alignItems: "center",
                children: [
                  {
                    type: "spacer",
                  },
                  {
                    type: "text",
                    text: `剩${remainStr}`,
                    font: {
                      size: "caption2",
                      weight: "semibold",
                    },
                    textColor: colors.accentGreen,
                    lineLimit: 1,
                    minimumScaleFactor: 0.7,
                  },
                ],
              },
            ],
      },
    ],
  };
}

/**
 * 非分段式进度条：
 * 灰色轨道是父容器背景，绿色只是左侧填充。
 * 不再使用绿色段 + 灰色段两个可见分段。
 */
function buildProgressBar(progressPercent, statusColor, colors) {
  const p = Math.min(Math.max(progressPercent, 0), 100);

  return {
    type: "stack",
    direction: "row",
    height: 6,
    borderRadius: 4,
    backgroundColor: colors.progressTrack,
    children: [
      {
        type: "stack",
        flex: Math.max(p, 0.8),
        height: 6,
        borderRadius: 4,
        backgroundColor: statusColor,
      },
      {
        type: "spacer",
        flex: Math.max(100 - p, 0.1),
      },
    ],
  };
}

function noConfigWidget(bgGradient, refreshTime, colors) {
  return {
    type: "widget",
    backgroundGradient: bgGradient,
    padding: 16,
    gap: 12,
    refreshAfter: refreshTime,
    children: [
      {
        type: "stack",
        direction: "column",
        gap: 10,
        alignItems: "center",
        children: [
          {
            type: "image",
            src: "sf-symbol:wifi.slash",
            width: 32,
            height: 32,
            color: colors.accentRed,
          },
          {
            type: "text",
            text: "请配置 SUB_STORE_URL",
            font: {
              size: "headline",
              weight: "semibold",
            },
            textColor: colors.textPrimary,
          },
        ],
      },
    ],
  };
}

function errorWidget(bgGradient, refreshTime, colors, msg) {
  return {
    type: "widget",
    backgroundGradient: bgGradient,
    padding: 16,
    gap: 12,
    refreshAfter: refreshTime,
    children: [
      {
        type: "stack",
        direction: "column",
        gap: 10,
        alignItems: "center",
        children: [
          {
            type: "image",
            src: "sf-symbol:exclamationmark.triangle.fill",
            width: 28,
            height: 28,
            color: colors.accentRed,
          },
          {
            type: "text",
            text: msg,
            font: {
              size: "caption1",
              weight: "medium",
            },
            textColor: colors.accentRed,
            maxLines: 4,
          },
        ],
      },
    ],
  };
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

async function requestJson(ctx, url, cfg) {
  const resp = await ctx.http.get(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Egern-SubStore-Widget",
    },
    timeout: cfg.timeout,
    redirect: "follow",
    insecureTls: cfg.insecureTls,
  });

  const text = await safeText(resp);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HTTP ${resp.status} ${preview(text, 80)}`);
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error("JSON 解析失败，请检查 SUB_STORE_URL");
  }
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch (_) {
    return "";
  }
}

function unwrap(json) {
  if (json && typeof json === "object" && "data" in json) {
    return json.data;
  }

  return json;
}

function apiUrl(base, path) {
  const b = normalizeUrl(base);
  const p = String(path || "").startsWith("/") ? path : "/" + path;

  if (/\/api$/i.test(b) && p.startsWith("/api/")) {
    return b + p.slice(4);
  }

  return b + p;
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function unique(arr) {
  const out = [];

  for (const item of arr) {
    if (item && !out.includes(item)) {
      out.push(item);
    }
  }

  return out;
}

function firstHttpUrl(raw) {
  return (
    String(raw || "")
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .find((s) => /^https?:\/\//i.test(s)) || ""
  );
}

function buildVariants(url) {
  const seen = new Set();
  const out = [];

  const add = (u) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };

  add(url);
  add(withParam(url, "flag", "clash"));
  add(withParam(url, "flag", "meta"));

  return out;
}

function withParam(url, key, value) {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(
    value
  )}`;
}

function getHeader(headers, name) {
  if (!headers) return "";

  try {
    if (typeof headers.get === "function") {
      return headers.get(name) || "";
    }
  } catch (_) {}

  const lower = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      return Array.isArray(v) ? v.join(", ") : String(v || "");
    }
  }

  return "";
}

function parseRangeList(v) {
  const s = String(v || "").trim();

  if (!s) {
    return [];
  }

  const segments = s
    .split(/[\n,|]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const result = [];

  for (const segment of segments) {
    if (segment.includes("-")) {
      const parts = segment.split("-").map((x) => parseInt(x.trim(), 10));

      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        const start = Math.min(parts[0], parts[1]);
        const end = Math.max(parts[0], parts[1]);

        for (let i = start; i <= end; i++) {
          if (i >= 1) {
            result.push(i);
          }
        }
      }
    } else {
      const n = parseInt(segment, 10);

      if (Number.isFinite(n) && n >= 1) {
        result.push(n);
      }
    }
  }

  return [...new Set(result)].sort((a, b) => a - b);
}

function bool(v, def) {
  if (v == null || v === "") {
    return !!def;
  }

  return ["1", "true", "yes", "on", "y"].includes(
    String(v).trim().toLowerCase()
  );
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  const x = Number.isFinite(n) ? n : def;

  return Math.min(max, Math.max(min, x));
}

function toNum(v) {
  const n = Number(v);

  return Number.isFinite(n) ? n : NaN;
}

function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function shortError(err) {
  const msg = err?.message ? err.message : String(err || "未知错误");

  if (/JSON 解析失败/.test(msg)) {
    return "不是 Sub-Store API\n请检查 SUB_STORE_URL";
  }

  if (/HTTP 401|HTTP 403/.test(msg)) {
    return "接口拒绝访问";
  }

  if (/HTTP 404/.test(msg)) {
    return "接口不存在";
  }

  if (/timeout|timed out/i.test(msg)) {
    return "请求超时";
  }

  return preview(msg, 80);
}

function preview(s, len) {
  s = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

  return s.length > len ? s.slice(0, len - 1) + "…" : s;
}

function getDaysUntilReset(resetDay) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const currentMonthMax = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0
  ).getDate();

  const safeDay = Math.min(resetDay, currentMonthMax);

  let target = new Date(now.getFullYear(), now.getMonth(), safeDay);

  if (today >= target) {
    const nextMonth = now.getMonth() + 1;
    const nextMonthMax = new Date(
      now.getFullYear(),
      nextMonth + 1,
      0
    ).getDate();

    target = new Date(
      now.getFullYear(),
      nextMonth,
      Math.min(resetDay, nextMonthMax)
    );
  }

  return Math.ceil(
    (target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );
}

/**
 * 统一 GB 显示
 *
 * 示例：
 * 202MB      -> 0.2GB
 * 11GB       -> 11GB
 * 62GB       -> 62GB
 * 989.4GB    -> 989GB
 * 0B         -> 0GB
 */
function formatGB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0GB";
  }

  const gb = bytes / 1024 / 1024 / 1024;

  let text;

  if (gb >= 10) {
    text = String(Math.round(gb));
  } else if (gb >= 0.1) {
    text = gb.toFixed(1);
  } else {
    text = gb.toFixed(2);
  }

  text = text.replace(/\.0$/, "");

  return `${text}GB`;
}