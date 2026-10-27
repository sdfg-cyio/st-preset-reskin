// AI 调用：当前主 API（酒馆 generateRaw）或独立 OpenAI 兼容接口

/** 规范化 base url：支持 https://x、https://x/v1、https://x/v1/chat/completions */
export function normalizeBase(url) {
    let b = String(url || '').trim().replace(/\/+$/, '');
    b = b.replace(/\/chat\/completions$/, '').replace(/\/models$/, '');
    if (!/\/v\d+[a-z]*$/.test(b)) b += '/v1';
    return b;
}

// 不支持关思考参数的接口地址
const thinkUnsupported = new Set();

/**
 * 生成调用函数
 * @param {object} cfg {source:'main'|'custom', url, key, model, temperature, maxTokens, timeoutSec}
 * @param {() => any} getContext 酒馆的 getContext
 * @returns {(system:string, user:string)=>Promise<string>}
 */
export function makeCaller(cfg, getContext) {
    if (cfg.source === 'custom') {
        const base = normalizeBase(cfg.url);
        return async (system, user) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), (cfg.timeoutSec || 180) * 1000);
            const body = {
                model: cfg.model,
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                temperature: Number(cfg.temperature ?? 0.9),
            };
            if (Number(cfg.maxTokens) > 0) body.max_tokens = Number(cfg.maxTokens);
            // 改写不需要推理，思维链会让请求慢好几倍
            const thinkExtra = cfg.thinking === 'off' && !thinkUnsupported.has(base) ? { thinking: { type: 'disabled' } }
                : cfg.thinking === 'low' && !thinkUnsupported.has(base) ? { reasoning_effort: 'low' } : {};
            const send = (extra) => fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
                body: JSON.stringify({ ...body, ...extra }),
                signal: ctrl.signal,
            });
            let res;
            try {
                res = await send(thinkExtra);
                // 不认识思考参数的接口：去掉参数重发，并记住
                if (res.status === 400 && Object.keys(thinkExtra).length) {
                    const t = await res.clone().text();
                    if (/thinking|reasoning|unrecognized|unknown|extra/i.test(t)) { thinkUnsupported.add(base); res = await send({}); }
                }
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? '请求超时' : `网络错误（可能是跨域被拦截）：${e.message}`);
            } finally { clearTimeout(timer); }
            if (!res.ok) {
                let t = await res.text();
                try { t = JSON.parse(t).error?.message || t; } catch { /* 原文 */ }
                throw new Error(`API ${res.status}: ${String(t).slice(0, 200)}`);
            }
            const j = await res.json();
            const c = j.choices?.[0]?.message?.content;
            if (typeof c === 'string') return c;
            if (Array.isArray(c)) return c.map(x => x.text || '').join('');
            throw new Error('无法解析返回内容');
        };
    }
    // 当前主 API：走酒馆自身的连接，不带聊天上下文
    return async (system, user) => {
        const ctx = getContext();
        if (typeof ctx.generateRaw !== 'function') throw new Error('酒馆版本过旧，没有 generateRaw');
        const r = await ctx.generateRaw({
            systemPrompt: system,
            prompt: user,
            responseLength: Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : null,
        });
        if (!r) throw new Error('主 API 返回为空');
        return r;
    };
}

export async function listModels(url, key) {
    const res = await fetch(`${normalizeBase(url)}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`获取模型失败 ${res.status}`);
    const j = await res.json();
    return (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean).sort();
}
