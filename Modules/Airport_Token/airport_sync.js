/**
 * airport_sync.js —— Egern 机场 Token 同步脚本
 */

export default async function (ctx) {

    // ─── 从环境变量读取配置 ────────────────────────────────────────
    const GIST_ID    = ctx.env.GIST_ID    || '';
    const GIST_TOKEN = ctx.env.GIST_TOKEN || '';
    const GIST_FILE  = ctx.env.GIST_FILE  || 'airport_token.json';
    const AIRPORT_ID = ctx.env.AIRPORT_ID || 'airport';

    // ─── 基础校验 ─────────────────────────────────────────────────
    if (!GIST_ID || !GIST_TOKEN) {
        ctx.notify({
            title: '机场 Token 同步',
            body:  '⚠️ 未配置 Gist ID 或 GitHub Token，请在模块设置中填写',
        });
        return;
    }

    // ─── 从请求头提取 Authorization ───────────────────────────────
    // checkLogin 是已登录状态下的心跳接口，其请求头携带的就是当前有效 Token
    const reqHeaders   = ctx.request?.headers || {};
    const authHeaderKey = Object.keys(reqHeaders).find(
        k => k.toLowerCase() === 'authorization'
    );
    const authData = authHeaderKey ? String(reqHeaders[authHeaderKey]).trim() : null;

    if (!authData) {
        console.log('[Airport Sync] 请求头中未找到 Authorization，跳过');
        return;
    }

    // ─── 本地去重：Token 未变化则不写入 Gist ──────────────────────
    // 避免每次 checkLogin 心跳都触发 Gist 写入（一般每隔几十秒一次）
    const localCache = ctx.storage.getJSON(`airport_token_${AIRPORT_ID}`);
    if (localCache?.auth_data === authData) {
        console.log('[Airport Sync] Token 未变化，跳过本次同步');
        return;
    }

    console.log('[Airport Sync] 检测到新 Token，正在同步到 Gist...');

    const nowUnix = Math.floor(Date.now() / 1000);

    // ─── 读取 Gist 现有内容 ────────────────────────────────────────
    // 多机场共用一个文件，读取后合并当前机场条目再写回
    let existing = {};
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
                } catch {
                    // Gist 文件内容损坏，覆盖写入
                    existing = {};
                }
            }
        }
    } catch (e) {
        console.log('[Airport Sync] Gist 读取异常，继续覆盖写入：' + e.message);
    }

    // ─── 更新当前机场条目 ──────────────────────────────────────────
    existing[AIRPORT_ID] = {
        auth_data:  authData,
        updated_at: nowUnix,
        source:     'egern',
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

            // 写入本地缓存，供下次去重比对
            ctx.storage.setJSON(`airport_token_${AIRPORT_ID}`, existing[AIRPORT_ID]);

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
    }
}
