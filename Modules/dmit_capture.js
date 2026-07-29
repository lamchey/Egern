const COOKIE_KEY = "dmit.cookie.v1";

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const expected = String(name).toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === expected,
  );
  return key ? headers[key] : null;
}

function isCaptureTarget(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.dmit.io") return false;
    if (
      url.pathname === "/clientarea.php" ||
      url.pathname === "/clientarea" ||
      url.pathname.startsWith("/clientarea/")
    ) {
      return true;
    }
    return (
      url.pathname === "/index.php" &&
      /^\/client-area(?:\/|$)/i.test(url.searchParams.get("rp") || "")
    );
  } catch (_) {
    return false;
  }
}

function isValidCookieHeader(cookie) {
  if (
    !cookie ||
    cookie.length > 16_384 ||
    /[\u0000-\u001F\u007F]/.test(cookie)
  ) {
    return false;
  }
  const namePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const pairs = cookie.split(";").map((part) => part.trim()).filter(Boolean);
  return (
    pairs.length > 0 &&
    pairs.every((pair) => {
      const equals = pair.indexOf("=");
      return equals > 0 && namePattern.test(pair.slice(0, equals).trim());
    })
  );
}

export default async function main(ctx) {
  if (!ctx.request || !isCaptureTarget(ctx.request.url)) return;

  const cookie = readHeader(ctx.request.headers, "cookie");
  if (!isValidCookieHeader(cookie)) return;

  const previous = ctx.storage.get(COOKIE_KEY);
  if (previous === cookie) return;

  // 只保存 Cookie 字符串，不保存 URL、请求体、服务 ID 或页面数据。
  ctx.storage.set(COOKIE_KEY, cookie);
  ctx.notify({
    title: "DMIT Cookie 已更新",
    body: "现在可以运行 DMIT 流量小组件。",
    sound: false,
  });
}
