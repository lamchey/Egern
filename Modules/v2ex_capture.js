/**
 * V2EX Cookie 抓包脚本 (强制全量加密 - 兼容初始空状态版)
 */
import CryptoJS from 'https://esm.sh/crypto-js';

export default async function (ctx) {
  const GIST_ID     = ctx.env.GIST_ID     || '';
  const GIST_TOKEN  = ctx.env.GIST_TOKEN  || '';
  const GIST_FILE   = ctx.env.GIST_FILE   || '';
  const SITE_KEY    = ctx.env.SITE_KEY    || '';
  const GIST_SECRET = ctx.env.GIST_SECRET || '';

  if (!GIST_ID)     { ctx.notify({ title: 'V2EX 抓包', body: '⚠️ 未配置 GIST_ID' }); return; }
  if (!GIST_TOKEN)  { ctx.notify({ title: 'V2EX 抓包', body: '⚠️ 未配置 GIST_TOKEN' }); return; }
  if (!GIST_FILE)   { ctx.notify({ title: 'V2EX 抓包', body: '⚠️ 未配置 GIST_FILE' }); return; }
  if (!SITE_KEY)    { ctx.notify({ title: 'NodeSeek 抓包', body: '⚠️ 未配置 SITE_KEY' }); return; }
  if (!GIST_SECRET) { ctx.notify({ title: 'V2EX 抓包', body: '⚠️ 未配置 GIST_SECRET 加密密钥' }); return; }

  const reqHeaders = ctx.request?.headers || {};
  const cookieKey  = Object.keys(reqHeaders).find(k => k.toLowerCase() === 'cookie');
  const cookie     = cookieKey ? String(reqHeaders[cookieKey]).trim() : null;

  if (!cookie || cookie.length < 20) return;

  console.log('[V2EX] 捕获到有效 Cookie，准备加密写入 Gist...');

  const GH_HEADERS = {
    'Authorization': `Bearer ${GIST_TOKEN}`,
    'User-Agent':    'V2EX-Capture/1.0',
    'Accept':        'application/vnd.github+json',
  };

  let existing = {};
  try {
    const getResp = await ctx.http.get(`https://api.github.com/gists/${GIST_ID}`, { headers: GH_HEADERS, timeout: 15000 });
    if (getResp.status === 200) {
      const gistData = await getResp.json();
      const fileContent = gistData?.files?.[GIST_FILE]?.content;
      if (fileContent) {
        const text = fileContent.trim();
        if (text === '' || text === '{}') {
          existing = {};
        } else {
          try {
            const bytes = CryptoJS.AES.decrypt(text, GIST_SECRET);
            const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
            if (!decryptedStr) throw new Error('解密结果为空，可能密钥不正确');
            existing = JSON.parse(decryptedStr);
          } catch (e) {
            console.log('[V2EX] 解密历史密文失败，终止同步以保护数据: ' + e.message);
            ctx.notify({ title: '同步被拦截', body: '⚠️ Gist 解密历史密文失败！' });
            return;
          }
        }
      }
    }
  } catch (e) {
    console.log('[V2EX] 读取历史 Gist 失败，将作为全新文件加密写入');
  }

  existing[SITE_KEY] = {
    cookie:     cookie,
    updated_at: Math.floor(Date.now() / 1000),
    source_url: ctx.request?.url ?? '',
  };

  const fullJsonStr = JSON.stringify(existing, null, 2);
  const encryptedContent = CryptoJS.AES.encrypt(fullJsonStr, GIST_SECRET).toString();

  try {
    const patchResp = await ctx.http.patch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
        body: { files: { [GIST_FILE]: { content: encryptedContent } } },
        timeout: 15000,
    });

    if (patchResp.status === 200) {
      console.log('[V2EX] 加密同步成功 ✅');
      ctx.notify({ title: 'V2EX Cookie 已更新', body: '已加密同步到 Gist', sound: false });
    } else {
      ctx.notify({ title: 'V2EX 同步失败', body: `HTTP ${patchResp.status}` });
    }
  } catch (e) {
    ctx.notify({ title: 'V2EX 同步异常', body: e.message });
  }
}
