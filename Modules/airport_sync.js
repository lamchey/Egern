/**
 * airport_sync.js —— Egern 机场 Token 同步脚本
 *
 * 触发逻辑：
 *   - 若配置了 TRIGGER_PATH，则仅当请求的 Referer 包含该路径时触发
 *   - 若未配置 TRIGGER_PATH，则匹配到 checkLogin 请求即触发（不限来源页面）
 */

export default async function (ctx) {

    // ─── 从环境变量读取配置 ────────────────────────────────────────
    const GIST_ID      = (ctx.env.GIST_ID      || '').trim();
    const GIST_TOKEN   = (ctx.env.GIST_TOKEN   || '').trim();
    const GIST_FILE    = (ctx.env.GIST_FILE    || 'airport_token.json').trim();
    const AIRPORT_ID   = (ctx.env.AIRPORT_ID   || '').trim();
    // 触发页面路径关键词（可选）
    // 填写示例：/#/profile
    // 留空则：只要命中 checkLogin 接口即触发，不限来源页面
    const TRIGGER_PATH = (ctx.env.TRIGGER_PATH || '').trim();

    // ─── 基础校验 ─────────────────────────────────────────────────
    if (!GIST_ID) {
        ctx.notify({ title: '机场 Token 抓包', body: '⚠️ 未配置 Gist ID' });
        return;
    }
    if (!GIST_TOKEN) {
        ctx.notify({ title: '机场 Token 抓包', body: '⚠️ 未配置 GitHub Token' });
        return;
    }
    if (!AIRPORT_ID) {
        ctx.notify({ title: '机场 Token 抓包', body: '⚠️ 未配置机场标识 AIRPORT_ID' });
        return;
    }

    const reqHeaders = ctx.request?.headers || {};

    // ─── Referer 过滤（仅在配置了 TRIGGER_PATH 时生效）─────────────
    // TRIGGER_PATH 有值：只有来自该页面的请求才执行同步
    // TRIGGER_PATH 为空：跳过此过滤，命中 checkLogin 即触发
    if (TRIGGER_PATH) {
        const refererKey   = Object.keys(reqHeaders).find(
            k => k.toLowerCase() === 'referer'
        );
        const refererValue = refererKey
            ? String(reqHeaders[refererKey]).trim()
            : '';

        if (!refererValue.includes(TRIGGER_PATH)) {
            console.log(`[Airport Sync] Referer "${refererValue}" 不含 "${TRIGGER_PATH}"，跳过`);
            return;
        }
        console.log(`[Airport Sync] Referer 命中 "${TRIGGER_PATH}"，开始处理...`);
    } else {
        console.log('[Airport Sync] 未配置 TRIGGER_PATH，直接处理...');
    }

    // ─── 从请求头提取 Authorization ───────────────────────────────
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

    console.log('[Airport Sync] 捕获到 Authorization，准备与 Gist 比对...');

    // ─── 读取 Gist 现有内容（作为去重的权威来源）─────────────────
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
                    existing       = JSON.parse(fileContent);
                    gistTokenValue = existing?.[AIRPORT_ID]?.auth_data ?? null;
                    console.log(`[Airport Sync] Gist 中 ${AIRPORT_ID} 已有 Token：${gistTokenValue ? '是' : '否'}`);
                } catch {
                    console.log('[Airport Sync] Gist 文件内容损坏，将覆盖写入');
                    existing = {};
                }
            } else {
                console.log('[Airport Sync] Gist 文件为空，将首次写入');
            }
        } else {
            console.log(`[Airport Sync] Gist 读取返回 ${getResp.status}`);
        }
    } catch (e) {
        console.log('[Airport Sync] Gist 读取异常，继续写入：' + e.message);
    }

    // ─── 去重判断：以 Gist 中的值为准 ────────────────────────────
    if (gistTokenValue && gistTokenValue === authData) {
        console.log('[Airport Sync] Token 未变化，跳过本次同步');
        ctx.storage.setJSON(`airport_token_${AIRPORT_ID}`, existing[AIRPORT_ID]);
        return;
    }

    console.log('[Airport Sync] 检测到新 Token，正在写入 Gist...');

    // ─── 更新当前机场条目 ──────────────────────────────────────────
    const nowUnix = Math.floor(Date.now() / 1000);
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
        ctx.notify({
            title: '机场 Token 同步异常',
            body:  e.message,
        });
    }
}
