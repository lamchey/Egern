/**
 * airport_sync.js —— 机场 Token 抓包脚本
 *
 */

export default async function (ctx) {

    // ─── 从环境变量读取配置 ────────────────────────────────────────
    const GIST_ID    = ctx.env.GIST_ID    || '';
    const GIST_TOKEN = ctx.env.GIST_TOKEN || '';
    const GIST_FILE  = ctx.env.GIST_FILE  || '';
    const AIRPORT_ID = ctx.env.AIRPORT_ID || '';

    // ─── 基础校验 ─────────────────────────────────────────────────
    if (!GIST_ID) {
        ctx.notify({
            title: '机场 Token 抓包',
            body:  '⚠️ 未配置 Gist ID，请在模块设置中填写',
        });
        return;
    }
    if (!GIST_TOKEN) {
        ctx.notify({
            title: '机场 Token 抓包',
            body:  '⚠️ 未配置 GitHub Token，请在模块设置中填写',
        });
        return;
    }
    if (!GIST_FILE) {
        ctx.notify({
            title: '机场 Token 抓包',
            body:  '⚠️ 未配置 GIST_FILE，请在模块设置中填写',
        });
        return;
    }
    if (!AIRPORT_ID) {
        ctx.notify({
            title: '机场 Token 抓包',
            body:  '⚠️ 未配置 AIRPORT_ID，请在模块设置中填写',
        });
        return;
    }
    

    // ─── 从请求头提取 Authorization ───────────────────────────────
    const reqHeaders    = ctx.request?.headers || {};
    const authHeaderKey = Object.keys(reqHeaders).find(
        k => k.toLowerCase() === 'authorization'
    );
    const authData = authHeaderKey
        ? String(reqHeaders[authHeaderKey]).trim()
        : null;

    if (!authData) {
        console.log('[Airport Sync] 请求头中未找到 Authorization，跳过');
        return;
    }

    console.log('[Airport Sync] 捕获到 Authorization，准备比对...');

    // ─── 读取 Gist 现有内容（作为去重的权威来源）─────────────────
    // Gist 是状态的唯一真相，本地缓存仅作加速用途，不单独用于去重判断
    let existing       = {};
    let gistTokenValue = null;

    try {
        const getResp = await ctx.http.get(
            `https://api.github.com/gists/${GIST_ID}`,
            {
                headers: {
                    'Authorization': `Bearer ${GIST_TOKEN}`,
                    'User-Agent':    'AirportSync/1.0',
                    'Accept':        'application/vnd.github+json',
                },
                timeout: 15000,
            }
        );

        if (getResp.status === 200) {
            const gistData    = await getResp.json();
            const fileContent = gistData?.files?.[GIST_FILE]?.content;
            if (fileContent) {
                try {
                    existing = JSON.parse(fileContent);
                    // 读取 Gist 中当前机场已存储的 Token，用于去重
                    gistTokenValue = existing?.[AIRPORT_ID]?.auth_data ?? null;
                } catch {
                    console.log('[Airport Sync] Gist 文件内容损坏，将覆盖写入');
                    existing = {};
                }
            }
        } else {
            console.log(`[Airport Sync] Gist 读取返回 ${getResp.status}`);
        }
    } catch (e) {
        console.log('[Airport Sync] Gist 读取异常：' + e.message);
        // 读取失败时不跳过，继续尝试写入（宁可重复写也不能漏写）
    }

    // ─── 去重判断：以 Gist 中的值为准 ────────────────────────────
    // 只有 Gist 中已有相同 Token 时才跳过，本地缓存不参与此判断
    // 这样即使本地缓存与 Gist 不同步，也能正确写入
    if (gistTokenValue && gistTokenValue === authData) {
        console.log('[Airport Sync] Gist 中 Token 未变化，跳过本次同步');
        // 顺手同步本地缓存，修正可能的不一致
        ctx.storage.setJSON(`airport_token_${AIRPORT_ID}`, existing[AIRPORT_ID]);
        return;
    }

    console.log('[Airport Sync] 检测到新 Token，正在写入 Gist...');

    // ─── 更新当前机场条目 ──────────────────────────────────────────
    const nowUnix = Math.floor(Date.now() / 1000);
    existing[AIRPORT_ID] = {
        auth_data:  authData,
        updated_at: nowUnix,
        login_url:  ctx.request?.url ?? '',
    };

    // ─── 写回 Gist ────────────────────────────────────────────────
    try {
        const patchResp = await ctx.http.patch(
            `https://api.github.com/gists/${GIST_ID}`,
            {
                headers: {
                    'Authorization': `Bearer ${GIST_TOKEN}`,
                    'Content-Type':  'application/json',
                    'User-Agent':    'AirportSync/1.0',
                    'Accept':        'application/vnd.github+json',
                },
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
            console.log(`[Airport Sync] ${AIRPORT_ID} Token 同步成功 ✅`);

            // 写入成功后同步本地缓存
            ctx.storage.setJSON(
                `airport_token_${AIRPORT_ID}`,
                existing[AIRPORT_ID]
            );

            ctx.notify({
                title: '机场 Token 同步成功',
                body:  `${AIRPORT_ID} 的 Token 已更新到 Gist`,
                sound: false,
            });

        } else {
            const errBody = await patchResp.text();
            console.log(`[Airport Sync] Gist 写入失败 ${patchResp.status}：${errBody}`);
            ctx.notify({
                title: '机场 Token 同步失败',
                body:  `HTTP ${patchResp.status}，请检查 GitHub Token 权限`,
            });
        }
    } catch (e) {
        console.log('[Airport Sync] Gist 写入异常：' + e.message);
        ctx.notify({
            title: '机场 Token 同步异常',
            body:  e.message,
        });
    }
}
