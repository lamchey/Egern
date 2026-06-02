/**
 * airport_sync.js —— Egern 通用机场 Token 同步脚本
 *
 * 功能：拦截机场登录接口的响应，提取 Token 并写入 GitHub Gist，
 *       供电脑端油猴脚本读取，实现跨设备自动续期。
 *
 * 配置项均通过 ctx.env 读取，在 Egern 模块设置页面填写，无需改动此文件。
 */

export default async function (ctx) {

    // ─── 从环境变量读取配置 ────────────────────────────────────────
    const GIST_ID    = ctx.env.GIST_ID    || '';
    const GIST_TOKEN = ctx.env.GIST_TOKEN || '';
    const GIST_FILE  = ctx.env.GIST_FILE  || 'airport_token.json';
    const AIRPORT_ID = ctx.env.AIRPORT_ID || 'airport';

    // Token 提取路径：逗号分隔的多条路径，按顺序尝试
    // 例如 "data.auth_data,data.token,token" 会依次尝试三条路径
    const TOKEN_PATHS = (ctx.env.TOKEN_PATHS || 'data.auth_data,data.token,token')
        .split(',')
        .map(p => p.trim().split('.'));

    // ─── 基础校验 ─────────────────────────────────────────────────
    if (!GIST_ID || !GIST_TOKEN) {
        ctx.notify({
            title: '机场 Token 同步',
            body: '⚠️ 未配置 Gist ID 或 GitHub Token，请在模块设置中填写',
        });
        return; // 不修改响应，透传
    }

    // ─── 解析登录响应体 ────────────────────────────────────────────
    let body;
    try {
        body = await ctx.response.json();
    } catch (e) {
        console.log('[Airport Sync] 响应体解析失败：' + e.message);
        return;
    }

    // ─── 按路径提取 Token ──────────────────────────────────────────
    /**
     * 按路径数组从对象中安全取值
     * 例：getByPath(obj, ['data', 'auth_data']) → obj?.data?.auth_data
     * @param {object} obj
     * @param {string[]} path
     * @returns {any}
     */
    function getByPath(obj, path) {
        return path.reduce((cur, key) => (cur != null ? cur[key] : null), obj);
    }

    let authData     = null;
    let matchedPath  = null;

    for (const path of TOKEN_PATHS) {
        const val = getByPath(body, path);
        if (val && typeof val === 'string' && val.length > 10) {
            authData    = val;
            matchedPath = path.join('.');
            break;
        }
    }

    if (!authData) {
        console.log('[Airport Sync] 未找到 Token，响应顶层字段：'
            + JSON.stringify(Object.keys(body || {})));
        console.log('[Airport Sync] 请检查 TOKEN_PATHS 配置是否与该机场响应结构匹配');
        return;
    }

    console.log(`[Airport Sync] Token 提取成功（路径：${matchedPath}），正在同步到 Gist...`);

    // ─── 读取 Gist 现有内容 ────────────────────────────────────────
    // 多机场共用一个 Gist 文件，读取后合并当前机场的条目再写回
    let existing = {};
    try {
        const getResp = await ctx.http.get(
            `https://api.github.com/gists/${GIST_ID}`,
            {
                headers: {
                    'Authorization': `Bearer ${GIST_TOKEN}`,
                    'User-Agent':    'AirportSync/1.0',
                },
                timeout: 15000,
            }
        );

        if (getResp.status === 200) {
            const gistData    = await getResp.json();
            const fileContent = gistData?.files?.[GIST_FILE]?.content;
            if (fileContent) {
                existing = JSON.parse(fileContent);
            }
        } else {
            console.log(`[Airport Sync] Gist 读取返回 ${getResp.status}，将直接覆盖写入`);
        }
    } catch (e) {
        // 首次写入或网络抖动时，用空对象兜底，不影响后续写入
        console.log('[Airport Sync] Gist 读取异常（首次写入正常）：' + e.message);
    }

    // ─── 更新当前机场的 Token 条目 ────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    existing[AIRPORT_ID] = {
        auth_data:  authData,
        updated_at: now,                          // Unix 时间戳（秒），供油猴脚本比较新旧
        source:     'egern',
        login_url:  ctx.request?.url ?? '',       // 记录登录接口 URL，便于排查
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
                },
                body: {
                    files: {
                        [GIST_FILE]: {
                            // JSON.stringify 带缩进，方便人工查看 Gist 内容
                            content: JSON.stringify(existing, null, 2),
                        },
                    },
                },
                timeout: 15000,
            }
        );

        if (patchResp.status === 200) {
            console.log(`[Airport Sync] ${AIRPORT_ID} Token 同步成功 ✅`);

            // 同时写入 Egern 本地持久化存储，方便脚本内其他地方引用
            ctx.storage.setJSON(`airport_token_${AIRPORT_ID}`, existing[AIRPORT_ID]);

            // 发送系统通知，告知用户同步成功
            ctx.notify({
                title:  '机场 Token 同步成功',
                body:   `${AIRPORT_ID} 的登录 Token 已更新到 Gist`,
                sound:  false, // 静默通知，不打扰用户
            });
        } else {
            const errBody = await patchResp.text();
            console.log(`[Airport Sync] Gist 写入失败，状态码：${patchResp.status}，响应：${errBody}`);
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

    // 不修改响应体，透传给 App
}
