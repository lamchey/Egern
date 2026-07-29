const COOKIE_KEY = "dmit.cookie.v1";

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || null;
}

function isCaptureTarget(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.dmit.io" &&
      (
        url.pathname === "/clientarea.php" ||
        url.pathname === "/clientarea" ||
        url.pathname.startsWith("/clientarea/")
      )
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

  ctx.storage.set(COOKIE_KEY, cookie);
  ctx.notify({
    title: "DMIT Cookie 已更新",
    body: "现在可以运行 DMIT 流量小组件。",
    sound: false,
  });
}
