/**
 * NodeSeek Cookie 抓包脚本
 *
 * 触发条件：访问 NodeSeek /setting 页面时自动执行
 * 功能：从请求头提取 Cookie，与 Gist 已有值对比，有变化则写入 Gist
 *
 * 注意：NodeSeek 目前有 Cloudflare 防护，Cookie 中需包含 cf_clearance 字段。
 * 建议在手机浏览器中正常访问 NodeSeek 个人设置页，Egern 会自动捕获完整 Cookie。
 *
 */

export default async function (ctx) {

  // ── 从 Egern 模块环境变量读取配置 ──────────────────────────────────
  const GIST_ID    = ctx.env.GIST_ID    || '';
  const GIST_TOKEN = ctx.env.GIST_TOKEN || '';
  const GIST_FILE  = ctx.env.GIST_FILE  || '';
  const SITE_KEY   = ctx.env.SITE_KEY   || '';

  if (!GIST_ID)    { ctx.notify({ title: 'NodeSeek Cookie 抓包', body: '⚠️ 未配置 GIST_ID，请在模块设置中填写' });      return; }
  if (!GIST_TOKEN) { ctx.notify({ title: 'NodeSeek Cookie 抓包', body: '⚠️ 未配置 GIST_TOKEN，请在模块设置中填写' }); return; }
  if (!GIST_FILE)    { ctx.notify({ title: 'NodeSeek Cookie 抓包', body: '⚠️ 未配置 GIST_FILE，请在模块设置中填写' });      return; }
  if (!SITE_KEY) { ctx.notify({ title: 'NodeSeek Cookie 抓包', body: '⚠️ 未配置 SITE_KEY，请在模块设置中填写' }); return; }

  // ── 从请求头提取 Cookie ─────────────────────────────────────────────
  const reqHeaders = ctx.request?.headers || {};
  const cookieKey  = Object.keys(reqHeaders).find(k => k.toLowerCase() === 'cookie');
  const cookie     = cookieKey ? String(reqHeaders[cookieKey]).trim() : null;

  if (!cookie) {
    console.log('[NodeSeek] 请求头中未找到 Cookie，跳过');
    return;
  }

  if (cookie.length < 20) {
    console.log('[NodeSeek] Cookie 过短，疑似无效，跳过');
    return;
  }

  // NodeSeek 登录态必须包含 session 或 cf_clearance
  const hasSession     = cookie.includes('session');
  const hasCfClearance = cookie.includes('cf_clearance');
  if (!hasSession && !hasCfClearance) {
    console.log('[NodeSeek] Cookie 中未发现 session / cf_clearance，可能未登录，跳过');
    return;
  }

  console.log('[NodeSeek] 捕获到有效 Cookie，正在与 Gist 比对...');

  // ── 读取 Gist 现有内容 ──────────────────────────────────────────────
  const GH_HEADERS = {
    'Authorization': `Bearer ${GIST_TOKEN}`,
    'User-Agent':    'NodeSeek-Capture/1.0',
    'Accept':        'application/vnd.github+json',
  };

  let existing        = {};
  let gistCookieValue = null;

  try {
    const getResp = await ctx.http.get(
      `https://api.github.com/gists/${GIST_ID}`,
      { headers: GH_HEADERS, timeout: 15000 }
    );

    if (getResp.status === 200) {
      const gistData    = await getResp.json();
      const fileContent = gistData?.files?.[GIST_FILE]?.content;
      if (fileContent) {
        try {
          existing        = JSON.parse(fileContent);
          gistCookieValue = existing?.[SITE_KEY]?.cookie ?? null;
        } catch {
          console.log('[NodeSeek] Gist 文件 JSON 解析失败，将重新写入');
          existing = {};
        }
      }
    } else if (getResp.status === 404) {
      console.log('[NodeSeek] Gist 不存在或无权访问');
      ctx.notify({ title: 'NodeSeek 抓包失败', body: 'Gist 不存在或 Token 无权限，请检查配置' });
      return;
    }
  } catch (e) {
    console.log('[NodeSeek] 读取 Gist 失败：' + e.message);
  }

  // ── Cookie 未变化则跳过 ─────────────────────────────────────────────
  if (gistCookieValue && gistCookieValue === cookie) {
    console.log('[NodeSeek] Cookie 与 Gist 一致，无需更新');
    return;
  }

  // ── 写入 Gist ───────────────────────────────────────────────────────
  console.log('[NodeSeek] 检测到新 Cookie，正在写入 Gist...');

  // 提取关键字段用于日志（不暴露完整 Cookie）
  const cfMatch   = cookie.match(/cf_clearance=([^;]{8})/);
  const sessionMatch = cookie.match(/session=([^;]{8})/);
  const keyFields = [
    cfMatch  ? `cf_clearance=${cfMatch[1]}…`  : null,
    sessionMatch ? `session=${sessionMatch[1]}…`    : null,
  ].filter(Boolean).join(', ');
  console.log(`[NodeSeek] 关键字段：${keyFields || '(无法识别)'}`);

  existing[SITE_KEY] = {
    cookie:     cookie,
    updated_at: Math.floor(Date.now() / 1000),
    source_url: ctx.request?.url ?? '',
  };

  try {
    const patchResp = await ctx.http.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      {
        headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
        body: {
          files: {
            [GIST_FILE]: {
              content: JSON.stringify(existing, null, 2),
            },
          },
        },
        timeout: 15000,
      }
    );

    if (patchResp.status === 200) {
      console.log('[NodeSeek] Cookie 同步成功 ✅');
      ctx.notify({
        title: 'NodeSeek Cookie 已更新',
        body:  '已同步到 Gist，签到脚本将使用新 Cookie',
        sound: false,
      });
    } else {
      const body = await patchResp.text().catch(() => '');
      console.log(`[NodeSeek] Gist 写入失败 HTTP ${patchResp.status}：${body}`);
      ctx.notify({
        title: 'NodeSeek Cookie 同步失败',
        body:  `HTTP ${patchResp.status}，请检查 Token 权限（需要 Gist Write）`,
      });
    }
  } catch (e) {
    console.log('[NodeSeek] 写入 Gist 异常：' + e.message);
    ctx.notify({ title: 'NodeSeek Cookie 同步异常', body: e.message });
  }
}
