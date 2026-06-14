/**
 * NodeSeek Cookie 抓包脚本
 */
import CryptoJS from 'https://esm.sh/crypto-js';

export default async function (ctx) {
  const GIST_ID     = ctx.env.GIST_ID     || '';
  const GIST_TOKEN  = ctx.env.GIST_TOKEN  || '';
  const GIST_FILE   = ctx.env.GIST_FILE   || '';
  const SITE_KEY    = ctx.env.SITE_KEY    || '';
  const GIST_SECRET = ctx.env.GIST_SECRET || '';

  if (!GIST_ID)     { ctx.notify({ title: 'NodeSeek 抓包', body: '⚠️ 未配置 GIST_ID' }); return; }
  if (!GIST_TOKEN)  { ctx.notify({ title: 'NodeSeek 抓包', body: '⚠️ 未配置 GIST_TOKEN' }); return; }
  if (!GIST_FILE)   { ctx.notify({ title: 'NodeSeek 抓包', body: '⚠️ 未配置 GIST_FILE' }); return; }
  if (!SITE_KEY)    { ctx.notify({ title: 'NodeSeek 抓包', body: '⚠️ 未配置 SITE_KEY' }); return; }
  if (!GIST_SECRET) { ctx.notify({ title: 'NodeSeek 抓包', body: '⚠️ 未配置 GIST_SECRET 加密密钥' }); return; }

  const reqHeaders = ctx.request?.headers || {};
  const cookieKey  = Object.keys(reqHeaders).find(k => k.toLowerCase() === 'cookie');
  const cookie     = cookieKey ? String(reqHeaders[cookieKey]).trim() : null;

  if (!cookie || cookie.length < 20) return;

  const hasSession     = cookie.includes('session');
  const hasCfClearance = cookie.includes('cf_clearance');
  if (!hasSession && !hasCfClearance) {
    console.log('[NodeSeek] Cookie 中未发现 session / cf_clearance，可能未登录，跳过');
    return;
  }

  console.log('[NodeSeek] 捕获到有效 Cookie，准备加密写入 Gist...');

  const GH_HEADERS = {
    'Authorization': `Bearer ${GIST_TOKEN}`,
    'User-Agent':    'NodeSeek-Capture/1.0',
    'Accept':        'application/vnd.github+json',
  };

  let existing = {};
  try {
    const getResp = await ctx.http.get(`https://api.github.com/gists/${GIST_ID}`, { headers: GH_HEADERS, timeout: 15000 });
    if (getResp.status === 200) {
      const gistData    = await getResp.json();
      const fileContent = gistData?.files?.[GIST_FILE]?.content;
      if (fileContent) {
        try { existing = JSON.parse(fileContent); } catch {}
      }
    }
  } catch (e) {
    console.log('[NodeSeek] 读取历史 Gist 失败，将覆盖写入');
  }

  // 执行 AES 加密
  const encryptedCookie = CryptoJS.AES.encrypt(cookie, GIST_SECRET).toString();

  existing[SITE_KEY] = {
    cookie:     encryptedCookie,
    updated_at: Math.floor(Date.now() / 1000),
    source_url: ctx.request?.url ?? '',
  };

  try {
    const patchResp = await ctx.http.patch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
        body: { files: { [GIST_FILE]: { content: JSON.stringify(existing, null, 2) } } },
        timeout: 15000,
    });

    if (patchResp.status === 200) {
      console.log('[NodeSeek] Cookie 加密同步成功 ✅');
      ctx.notify({ title: 'NodeSeek Cookie 已更新', body: '已加密同步到 Gist', sound: false });
    } else {
      ctx.notify({ title: 'NodeSeek Cookie 同步失败', body: `HTTP ${patchResp.status}` });
    }
  } catch (e) {
    ctx.notify({ title: 'NodeSeek Cookie 同步异常', body: e.message });
  }
}
