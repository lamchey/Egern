/**
 * airport_sync.js
 *
 * 功能：
 * 1. 仅监听 TARGET_URL
 * 2. 仅提取 Authorization 请求头
 * 3. Token 未变化则不上传
 * 4. 10秒并发锁防止重复写入
 * 5. 支持多个机场共存
 */

export default async function (ctx) {

  const TARGET_URL = ctx.env.TARGET_URL || '';

  const GIST_ID = ctx.env.GIST_ID || '';
  const GIST_TOKEN = ctx.env.GIST_TOKEN || '';
  const GIST_FILE = ctx.env.GIST_FILE || 'airport_token.json';
  const AIRPORT_ID = ctx.env.AIRPORT_ID || 'airport';

  if (!TARGET_URL) {
    console.log('[Airport Sync] TARGET_URL 未配置');
    return;
  }

  const requestUrl = ctx.request?.url || '';

  // 仅监听指定接口
  if (!requestUrl.startsWith(TARGET_URL)) {
    return;
  }

  console.log(`[Airport Sync] 捕获目标请求: ${requestUrl}`);

  if (!GIST_ID || !GIST_TOKEN) {
    console.log('[Airport Sync] GIST_ID 或 GIST_TOKEN 未配置');
    return;
  }

  // 获取 Authorization
  const headers = ctx.request?.headers || {};

  const authHeaderKey = Object.keys(headers).find(
    k => k.toLowerCase() === 'authorization'
  );

  if (!authHeaderKey) {
    console.log('[Airport Sync] 未发现 Authorization');
    return;
  }

  const authData = String(headers[authHeaderKey]).trim();

  if (!authData) {
    console.log('[Airport Sync] Authorization 为空');
    return;
  }

  const cacheKey = `airport_token_${AIRPORT_ID}`;

  const localCache = ctx.storage.getJSON(cacheKey);

  // Token没变化直接跳过
  if (
    localCache &&
    localCache.auth_data === authData
  ) {
    console.log('[Airport Sync] Token 未变化');
    return;
  }

  // 10秒并发锁
  const lockKey = `sync_lock_${AIRPORT_ID}`;

  const lastLockTime = ctx.storage.get(lockKey);

  if (
    lastLockTime &&
    Date.now() - Number(lastLockTime) < 10000
  ) {
    console.log('[Airport Sync] 并发锁生效，跳过');
    return;
  }

  ctx.storage.set(
    lockKey,
    String(Date.now())
  );

  const nowUnix = Math.floor(Date.now() / 1000);

  console.log('[Airport Sync] 开始同步 Gist');

  let existing = {};

  try {

    const getResp = await ctx.http.get(
      `https://api.github.com/gists/${GIST_ID}`,
      {
        headers: {
          Authorization: `Bearer ${GIST_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'AirportSync/2.0'
        },
        timeout: 15000
      }
    );

    if (getResp.status === 200) {

      const gistData = await getResp.json();

      const content =
        gistData?.files?.[GIST_FILE]?.content;

      if (content) {
        try {
          existing = JSON.parse(content);
        } catch {
          existing = {};
        }
      }
    }

  } catch (e) {

    console.log(
      '[Airport Sync] Gist读取失败: ' +
      e.message
    );

  }

  existing[AIRPORT_ID] = {
    auth_data: authData,
    updated_at: nowUnix,
    source: 'egern',
    login_url: TARGET_URL
  };

  try {

    const patchResp = await ctx.http.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      {
        headers: {
          Authorization: `Bearer ${GIST_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
          'User-Agent': 'AirportSync/2.0'
        },
        body: {
          files: {
            [GIST_FILE]: {
              content: JSON.stringify(
                existing,
                null,
                2
              )
            }
          }
        },
        timeout: 15000
      }
    );

    if (patchResp.status === 200) {

      ctx.storage.setJSON(
        cacheKey,
        existing[AIRPORT_ID]
      );

      console.log(
        `[Airport Sync] ${AIRPORT_ID} 同步成功`
      );

      ctx.notify({
        title: '机场Token同步成功',
        body: `${AIRPORT_ID} 已更新`,
        sound: false
      });

    } else {

      const err =
        await patchResp.text();

      console.log(
        `[Airport Sync] 上传失败 ${patchResp.status}: ${err}`
      );

    }

  } catch (e) {

    console.log(
      '[Airport Sync] 上传异常: ' +
      e.message
    );

  }

}
