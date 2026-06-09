/**
 * V2EX Cookie 抓包脚本
 *
 * 触发条件：访问 V2EX 个人主页 / 签到任务页时自动执行
 * 功能：从请求头提取 Cookie，与 Gist 已有值对比，有变化则写入 Gist
 *
 */

export default async function (ctx) {

  // ── 从 Egern 模块环境变量读取配置 ──────────────────────────────────
  const GIST_ID    = ctx.env.GIST_ID    || '';
  const GIST_TOKEN = ctx.env.GIST_TOKEN || '';
  const GIST_FILE  = ctx.env.GIST_FILE  || '';
  const SITE_KEY   = ctx.env.SITE_KEY  || '';

  if (!GIST_ID)    { ctx.notify({ title: 'V2EX Cookie 抓包', body: '⚠️ 未配置 GIST_ID，请在模块设置中填写' });      return; }
  if (!GIST_TOKEN) { ctx.notify({ title: 'V2EX Cookie 抓包', body: '⚠️ 未配置 GIST_TOKEN，请在模块设置中填写' }); return; }
  if (!GIST_FILE)    { ctx.notify({ title: 'V2EX Cookie 抓包', body: '⚠️ 未配置 GIST_FILE，请在模块设置中填写' });      return; }
  if (!SITE_KEY) { ctx.notify({ title: 'V2EX Cookie 抓包', body: '⚠️ 未配置 SITE_KEY，请在模块设置中填写' }); return; }

  // ── 从请求头提取 Cookie ─────────────────────────────────────────────
  const reqHeaders = ctx.request?.headers || {};
  const cookieKey  = Object.keys(reqHeaders).find(k => k.toLowerCase() === 'cookie');
  const cookie     = cookieKey ? String(reqHeaders[cookieKey]).trim() : null;

  if (!cookie) {
    console.log('[V2EX] 请求头中未找到 Cookie，跳过');
    return;
  }

  // 过滤掉明显无效的极短 Cookie（登录态 Cookie 通常很长）
  if (cookie.length < 20) {
    console.log('[V2EX] Cookie 过短，疑似无效，跳过');
    return;
  }

  console.log('[V2EX] 捕获到 Cookie，正在与 Gist 比对...');

  // ── 读取 Gist 现有内容 ──────────────────────────────────────────────
  const GH_HEADERS = {
    'Authorization': `Bearer ${GIST_TOKEN}`,
    'User-Agent':    'V2EX-Capture/1.0',
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
          console.log('[V2EX] Gist 文件 JSON 解析失败，将重新写入');
          existing = {};
        }
      }
    } else if (getResp.status === 404) {
      console.log('[V2EX] Gist 不存在或无权访问，请检查 GIST_ID 和 GIST_TOKEN');
      ctx.notify({ title: 'V2EX 抓包失败', body: 'Gist 不存在或 Token 无权限，请检查配置' });
      return;
    }
  } catch (e) {
    console.log('[V2EX] 读取 Gist 失败：' + e.message);
  }

  // ── Cookie 未变化则跳过 ─────────────────────────────────────────────
  if (gistCookieValue && gistCookieValue === cookie) {
    console.log('[V2EX] Cookie 与 Gist 一致，无需更新');
    return;
  }

  // ── 写入 Gist ───────────────────────────────────────────────────────
  console.log('[V2EX] 检测到新 Cookie，正在写入 Gist...');

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
      console.log('[V2EX] Cookie 同步成功 ✅');
      ctx.notify({
        title: 'V2EX Cookie 已更新',
        body:  '已同步到 Gist，签到脚本将使用新 Cookie',
        sound: false,
      });
    } else {
      const body = await patchResp.text().catch(() => '');
      console.log(`[V2EX] Gist 写入失败 HTTP ${patchResp.status}：${body}`);
      ctx.notify({
        title: 'V2EX Cookie 同步失败',
        body:  `HTTP ${patchResp.status}，请检查 Token 权限（需要 Gist Write）`,
      });
    }
  } catch (e) {
    console.log('[V2EX] 写入 Gist 异常：' + e.message);
    ctx.notify({ title: 'V2EX Cookie 同步异常', body: e.message });
  }
}
