const STORAGE = {
  snapshot: "dmit.traffic.snapshot.v1",
  probe: "dmit.traffic.probe.v1",
  error: "dmit.traffic.error.v1",
};

function env(ctx, name, fallback = "") {
  const value = ctx.env && ctx.env[name];
  return value == null || value === "" ? fallback : String(value);
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

function formatReset(value) {
  if (!value) return "以面板为准";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function refreshAfter(ctx) {
  const minutes = Math.max(15, Number(env(ctx, "DMIT_REFRESH_MINUTES", "30")) || 30);
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function colorForPercent(percent) {
  if (percent >= 90) return "#FF5C5C";
  if (percent >= 75) return "#FFB547";
  return "#59E1A7";
}

function progressBar(percent, width) {
  const safe = Math.max(0, Math.min(100, percent));
  const fill = safe <= 0 ? 0 : Math.max(4, (width * safe) / 100);
  return {
    type: "stack",
    direction: "row",
    width,
    height: 8,
    padding: 0,
    backgroundColor: "#FFFFFF22",
    borderRadius: 4,
    children: [
      {
        type: "stack",
        width: fill,
        height: 8,
        backgroundColor: colorForPercent(safe),
        borderRadius: 4,
        children: [],
      },
      { type: "spacer" },
    ],
  };
}

function waitingWidget(ctx, error, probe) {
  const detail = error && error.message
    ? error.message
    : probe
      ? "抓包模块尚未识别到流量，请重新打开 VPS 详情页"
      : "请先安装并运行 DMIT 流量抓包模块";
  return {
    type: "widget",
    url: "https://www.dmit.io/clientarea.php",
    refreshAfter: refreshAfter(ctx),
    padding: 16,
    gap: 8,
    backgroundGradient: {
      type: "linear",
      colors: ["#151A2D", "#242B48"],
      stops: [0, 1],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    children: [
      {
        type: "text",
        text: "DMIT Traffic",
        font: { size: "headline", weight: "bold" },
        textColor: "#FFFFFF",
      },
      {
        type: "text",
        text: detail,
        font: { size: "caption1", weight: "medium" },
        textColor: "#FFFFFFBB",
        maxLines: 4,
        minScale: 0.75,
      },
      { type: "spacer" },
      {
        type: "text",
        text: "轻点打开 DMIT",
        font: { size: "caption2", weight: "semibold" },
        textColor: "#59E1A7",
      },
    ],
  };
}

function accessoryWidget(ctx, snapshot) {
  const percent = Math.round(snapshot.usagePercent);
  const family = ctx.widgetFamily;
  if (family === "accessoryInline") {
    return {
      type: "widget",
      url: "https://www.dmit.io/clientarea.php",
      refreshAfter: refreshAfter(ctx),
      children: [{
        type: "text",
        text: `DMIT ${percent}% · ${formatBytes(snapshot.usedBytes)}`,
      }],
    };
  }

  return {
    type: "widget",
    url: "https://www.dmit.io/clientarea.php",
    refreshAfter: refreshAfter(ctx),
    padding: 6,
    gap: 2,
    children: [
      {
        type: "text",
        text: `${percent}%`,
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

function trafficWidget(ctx, snapshot, refreshError) {
  const family = ctx.widgetFamily || "systemSmall";
  if (family.startsWith("accessory")) return accessoryWidget(ctx, snapshot);

  const medium = family === "systemMedium" || family === "systemLarge" || family === "systemExtraLarge";
  const width = medium ? 280 : 122;
  const percent = Math.max(0, Math.min(100, snapshot.usagePercent));
  const status = refreshError
    ? "缓存"
    : snapshot.source === "live"
      ? "实时"
      : "已捕获";

  const children = [
    {
      type: "stack",
      direction: "row",
      alignItems: "center",
      children: [
        {
          type: "text",
          text: "DMIT Traffic",
          font: { size: "headline", weight: "bold" },
          textColor: "#FFFFFF",
          minScale: 0.8,
        },
        { type: "spacer" },
        {
          type: "text",
          text: status,
          font: { size: "caption2", weight: "semibold" },
          textColor: refreshError ? "#FFB547" : "#59E1A7",
        },
      ],
    },
    {
      type: "text",
      text: `${Math.round(percent)}%`,
      font: { size: medium ? 34 : 30, weight: "bold" },
      textColor: colorForPercent(percent),
    },
    progressBar(percent, width),
    {
      type: "text",
      text: `${formatBytes(snapshot.usedBytes)} / ${formatBytes(snapshot.limitBytes)}`,
      font: { size: "caption1", weight: "semibold" },
      textColor: "#FFFFFFDD",
      minScale: 0.72,
      maxLines: 1,
    },
  ];

  if (medium) {
    children.push({
      type: "stack",
      direction: "row",
      gap: 16,
      children: [
        {
          type: "stack",
          direction: "column",
          gap: 2,
          flex: 1,
          children: [
            { type: "text", text: "剩余", font: { size: "caption2" }, textColor: "#FFFFFF88" },
            {
              type: "text",
              text: formatBytes(snapshot.remainingBytes),
              font: { size: "caption1", weight: "semibold" },
              textColor: "#FFFFFF",
            },
          ],
        },
        {
          type: "stack",
          direction: "column",
          gap: 2,
          flex: 1,
          children: [
            { type: "text", text: "重置", font: { size: "caption2" }, textColor: "#FFFFFF88" },
            {
              type: "text",
              text: formatReset(snapshot.resetAt),
              font: { size: "caption1", weight: "semibold" },
              textColor: "#FFFFFF",
              minScale: 0.75,
              maxLines: 1,
            },
          ],
        },
      ],
    });
  }

  children.push(
    { type: "spacer" },
    {
      type: "stack",
      direction: "row",
      alignItems: "center",
      children: [
        {
          type: "text",
          text: String(snapshot.service || "DMIT VPS"),
          font: { size: "caption2", weight: "medium" },
          textColor: "#FFFFFF88",
          maxLines: 1,
          minScale: 0.65,
          flex: 1,
        },
        {
          type: "date",
          date: snapshot.updatedAt,
          format: "relative",
          font: { size: "caption2", weight: "medium" },
          textColor: "#FFFFFF66",
        },
      ],
    },
  );

  return {
    type: "widget",
    url: "https://www.dmit.io/clientarea.php",
    refreshAfter: refreshAfter(ctx),
    padding: 14,
    gap: medium ? 8 : 7,
    backgroundGradient: {
      type: "linear",
      colors: ["#12182B", "#232B4B", "#183D48"],
      stops: [0, 0.55, 1],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    children,
  };
}

export default async function main(ctx) {
  const snapshot = ctx.storage.getJSON(STORAGE.snapshot);
  const refreshError = ctx.storage.getJSON(STORAGE.error);
  if (!snapshot) {
    return waitingWidget(
      ctx,
      refreshError,
      ctx.storage.getJSON(STORAGE.probe),
    );
  }
  return trafficWidget(ctx, snapshot, refreshError);
}
