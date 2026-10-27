// 预设换皮核心逻辑：纯函数，不依赖酒馆，可在 node 里单测
// 流程：收集受保护字面量 → 切出改写单元 → 掩码 → (AI 改写) → 校验 → 还原 → 组装

export const TOKEN_OPEN = '⟦'; // ⟦
export const TOKEN_CLOSE = '⟧'; // ⟧
const TOKEN_RE = /⟦(\d+)⟧/g;

// 预设顶层会进请求的文字字段
export const TOP_LEVEL_FIELDS = [
    'impersonation_prompt', 'new_chat_prompt', 'new_group_chat_prompt', 'new_example_chat_prompt',
    'continue_nudge_prompt', 'group_nudge_prompt', 'wi_format', 'scenario_format', 'personality_format',
    'assistant_prefill', 'assistant_impersonation', 'continue_postfix',
];

// 只改值、值里自然语言仍可改写的变量宏
const VAR_MACRO_HEAD = /^\{\{\s*(setvar|addvar|setglobalvar|addglobalvar)\s*::([^:{}]*)::/i;

/* ---------------- 受保护字面量（来自正则） ---------------- */

/** 从一条正则源码里抠出字面量片段 */
export function regexLiterals(src) {
    if (typeof src !== 'string' || !src) return [];
    let s = src;
    const m = s.match(/^\/([\s\S]*)\/([a-z]*)$/);
    if (m) s = m[1];
    const out = new Set();
    // \|(A|B)\| 这种说话人标签：只锁带竖线的整体 |A|，不锁裸词 A（否则角色名全文都改不了）
    s = s.replace(/\\\|\(((?:[^()|\\]|\\.)+(?:\|(?:[^()|\\]|\\.)+)*)\)\\\|/g, (_, alts) => {
        alts.split('|').forEach(a => { const w = a.replace(/\\(.)/g, '$1').trim(); if (isWordish(w)) out.add(`|${w}|`); });
        return '\u0000';
    });
    // 逐字扫描：转义的标点算字面量（\[ \] \| \.），\s \d 等算分隔，未转义的 [...] 是字符类
    const SEP = '\u0000';
    let t = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '\\') {
            const n = s[i + 1] ?? '';
            if (/[pPu]/.test(n) && s[i + 2] === '{') { i = s.indexOf('}', i); if (i < 0) break; t += SEP; continue; }
            if (n === 'u') { i += 5; t += SEP; continue; }
            if (n === 'x') { i += 3; t += SEP; continue; }
            if (n === 'k' && s[i + 2] === '<') { i = s.indexOf('>', i); if (i < 0) break; t += SEP; continue; }
            if (/[dDwWsSbBnrtfv0-9]/.test(n)) { i++; t += SEP; continue; }
            t += n; i++; continue;
        }
        if (c === '[') {
            // 跳过字符类，处理类里的转义
            let j = i + 1;
            while (j < s.length && s[j] !== ']') j += s[j] === '\\' ? 2 : 1;
            i = j; t += SEP; continue;
        }
        if (c === '(' && s[i + 1] === '?') {
            const g = s.slice(i).match(/^\(\?(?:<?[=!]|:|<[A-Za-z_]\w*>)/);
            if (g) { i += g[0].length - 1; t += SEP; continue; }
        }
        if (c === '{' && /^\{\d+(,\d*)?\}/.test(s.slice(i))) { i = s.indexOf('}', i); t += SEP; continue; }
        if ('()|?*+^$.'.includes(c)) { t += SEP; continue; }
        t += c;
    }
    for (const raw of t.split(SEP)) {
        const frag = raw.trim();
        if (!isWordish(frag)) continue;
        out.add(frag);
        // 再拆一层，保证单独出现的词也被锁住
        for (const sub of frag.split(/[\s<>/:：="'`,，[\]]+/)) {
            // 纯英文的子片段至少 4 个字母，太短的（ing、end）误伤大
            if (isWordish(sub) && !/^[A-Za-z]{1,3}$/.test(sub)) out.add(sub);
        }
    }
    return [...out];
}

function isWordish(s) {
    if (!s || s.length > 80) return false;
    return /[぀-ヿ㐀-鿿]{2,}/.test(s) || /[A-Za-z]{3,}/.test(s);
}

/** 递归遍历对象，找所有正则脚本（含 SPreset 里的、JSON 字符串里的） */
function walkRegexScripts(node, visit, depth = 0) {
    if (depth > 12 || node == null) return;
    if (typeof node === 'string') {
        const t = node.trim();
        if (t.length > 50 && (t[0] === '{' || t[0] === '[') && /findRegex/.test(t)) {
            try { walkRegexScripts(JSON.parse(t), visit, depth + 1); } catch { /* 不是 JSON */ }
        }
        return;
    }
    if (Array.isArray(node)) { node.forEach(n => walkRegexScripts(n, visit, depth + 1)); return; }
    if (typeof node === 'object') {
        if (typeof node.findRegex === 'string') visit(node);
        for (const k of Object.keys(node)) walkRegexScripts(node[k], visit, depth + 1);
    }
}

/**
 * 收集要锁住的字面量 + 杀词表
 * @returns {{literals: string[], killWords: string[], regexCount: number}}
 */
export function collectProtected(preset, extraKeep = []) {
    const lit = new Set();
    const kill = new Set();
    let regexCount = 0;
    walkRegexScripts(preset, (r) => {
        regexCount++;
        regexLiterals(r.findRegex).forEach(x => lit.add(x));
        (Array.isArray(r.trimStrings) ? r.trimStrings : []).forEach(x => { if (isWordish(String(x).trim())) lit.add(String(x).trim()); });
        // 替换为空、模式是纯词表的 → 杀八股词
        const body = (r.findRegex.match(/^\/([\s\S]*)\/[a-z]*$/) || [, r.findRegex])[1];
        if ((r.replaceString ?? '') === '' && /^[^\\()[\]{}*+?.^$<>]+(\|[^\\()[\]{}*+?.^$<>]+)*$/.test(body)) {
            body.split('|').map(s => s.trim()).filter(Boolean).forEach(w => kill.add(w));
        }
    });
    // SPreset 设置里的短字符串（前后缀、条件标签、分隔符）也锁住
    const walkShort = (n, d = 0) => {
        if (d > 8 || n == null || typeof n !== 'object') return;
        for (const [k, v] of Object.entries(n)) {
            if (typeof v === 'string' && /prefix|suffix|tag|separator|stop_string/i.test(k) && v.length <= 80) {
                v.split(/\n|\\n|["\[\],]/).map(s => s.trim()).forEach(s => { if (isWordish(s)) lit.add(s); });
            } else if (typeof v === 'object') walkShort(v, d + 1);
        }
    };
    const sp = preset?.extensions?.SPreset;
    if (sp) for (const [k, v] of Object.entries(sp)) if (k !== 'RegexBinding') walkShort(v);
    // SPreset 里的 JS 代码（如 ChatSquash 后处理脚本）中的正则字面量
    const walkCode = (n, d = 0) => {
        if (d > 8 || n == null) return;
        if (typeof n === 'string') {
            if (n.length < 20000 && /=>|function|\.replace\(|\.match\(/.test(n)) {
                for (const m of n.matchAll(/(?<![\w)\]])\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+)\/[gimsuy]*/g)) {
                    regexLiterals(m[1]).forEach(x => lit.add(x));
                }
            }
            return;
        }
        if (typeof n === 'object') Object.values(n).forEach(v => walkCode(v, d + 1));
    };
    if (sp) walkCode(sp);
    extraKeep.map(s => s.trim()).filter(Boolean).forEach(x => lit.add(x));
    // 杀词本身也锁住，免得原文里的被换掉后行为改变（原文保留）
    return { literals: [...lit], killWords: [...kill], regexCount };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function buildLiteralRe(literals) {
    const list = [...new Set(literals)].filter(Boolean).sort((a, b) => b.length - a.length);
    if (!list.length) return null;
    return new RegExp(list.map(escapeRe).join('|'), 'y');
}

/* ---------------- 掩码 ---------------- */

/** 找与 pos 处 "{{" 配对的 "}}"，返回其后位置；没配对返回 -1 */
function matchMacroEnd(text, pos) {
    let depth = 0;
    for (let i = pos; i < text.length - 1; i++) {
        if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; continue; }
        if (text[i] === '}' && text[i + 1] === '}') {
            depth--; i++;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

const TAG_RE = /<\/?[A-Za-z_㐀-鿿][^<>\n]{0,300}>|<!--[\s\S]*?-->|<\|[^|<>\n]{0,60}\|>/y;
const URL_RE = /https?:\/\/[^\s<>"'）)\]】]+/y;
const PYFMT_RE = /\{\d+\}/y;
// SPreset/ChatSquash 的说话人标记，如 |用户|、|delete|
const PIPE_RE = /\|[^|\s]{1,20}\|/y;

/**
 * 掩码：受保护片段换成 ⟦n⟧，返回掩码文本与片段表
 * tokens 可传入已有数组以便递归追加
 */
export function maskText(text, literalRe, tokens = []) {
    let out = '';
    let i = 0;
    const protect = (s) => { tokens.push(s); out += TOKEN_OPEN + (tokens.length - 1) + TOKEN_CLOSE; };
    const tryRe = (re) => { re.lastIndex = i; const m = re.exec(text); return m ? m[0] : null; };

    while (i < text.length) {
        const c = text[i];
        // 代码块
        if (c === '`' && text.startsWith('```', i)) {
            const end = text.indexOf('```', i + 3);
            const stop = end < 0 ? text.length : end + 3;
            protect(text.slice(i, stop)); i = stop; continue;
        }
        // 行内代码
        if (c === '`') {
            const end = text.indexOf('`', i + 1);
            if (end > i && !text.slice(i, end).includes('\n')) { protect(text.slice(i, end + 1)); i = end + 1; continue; }
        }
        // 宏
        if (c === '{' && text[i + 1] === '{') {
            const end = matchMacroEnd(text, i);
            if (end < 0) { protect(text.slice(i, i + 2)); i += 2; continue; }
            const macro = text.slice(i, end);
            const head = macro.match(VAR_MACRO_HEAD);
            if (head && !macro.startsWith('{{//')) {
                // 宏头与收尾锁住，值里的文字递归掩码后可改写
                protect(head[0]);
                const inner = macro.slice(head[0].length, macro.length - 2);
                out += maskText(inner, literalRe, tokens).masked;
                protect('}}');
            } else {
                protect(macro);
            }
            i = end; continue;
        }
        // EJS 模板
        if (c === '<' && text[i + 1] === '%') {
            const end = text.indexOf('%>', i + 2);
            const stop = end < 0 ? text.length : end + 2;
            protect(text.slice(i, stop)); i = stop; continue;
        }
        if (c === '<') { const m = tryRe(TAG_RE); if (m) { protect(m); i += m.length; continue; } }
        if (c === 'h') { const m = tryRe(URL_RE); if (m) { protect(m); i += m.length; continue; } }
        if (c === '{') { const m = tryRe(PYFMT_RE); if (m) { protect(m); i += m.length; continue; } }
        if (c === '|') { const m = tryRe(PIPE_RE); if (m) { protect(m); i += m.length; continue; } }
        if (literalRe) {
            literalRe.lastIndex = i;
            const m = literalRe.exec(text);
            // 纯英文字面量要求词边界，避免把普通单词的一部分锁住
            const wordOk = m && m[0] && (!/^[A-Za-z_]+$/.test(m[0]) || (!/[A-Za-z]/.test(text[i - 1] || '') && !/[A-Za-z]/.test(text[i + m[0].length] || '')));
            if (wordOk) { protect(m[0]); i += m[0].length; continue; }
        }
        out += c; i++;
    }
    return { masked: mergeAdjacent(out, tokens), tokens };
}

/** 相邻（中间只有空白）的片段并成一个，减少占位符数量 */
function mergeAdjacent(masked, tokens) {
    return masked.replace(/⟦(\d+)⟧(?:\s*⟦\d+⟧)+/g, (run) => {
        // 合并后的内容放到第一个编号里，其余编号作废（置 null）
        const parts = run.split(/(⟦\d+⟧)/).filter(s => s !== '');
        let merged = '';
        let first = null;
        for (const p of parts) {
            const m = p.match(/^⟦(\d+)⟧$/);
            if (m) {
                const id = Number(m[1]);
                merged += tokens[id];
                if (first === null) first = id; else tokens[id] = null;
            } else merged += p;
        }
        tokens[first] = merged;
        return TOKEN_OPEN + first + TOKEN_CLOSE;
    });
}

export function unmask(masked, tokens) {
    return masked.replace(TOKEN_RE, (_, id) => tokens[Number(id)] ?? '');
}

export function tokenIdsIn(masked) {
    return [...masked.matchAll(TOKEN_RE)].map(m => Number(m[1]));
}

/** 去掉占位符后的自由文本 */
export function freeText(masked) {
    return masked.replace(TOKEN_RE, '');
}

/** 是否有值得改写的自然语言 */
export function hasRewritable(masked) {
    const t = freeText(masked);
    const cjk = (t.match(/[぀-ヿ㐀-鿿]/g) || []).length;
    const latin = (t.match(/[A-Za-z]/g) || []).length;
    return cjk >= 8 || latin >= 20;
}

/* ---------------- 名称映射 ---------------- */

/**
 * 解析 "旧=新" 每行一条；新名可写 "制作人|producer" 表示随机混用
 * @returns {{from: string, to: string[]}[]}
 */
// 指代靠上下文的代词：机械替换会把“谁对谁说”弄乱，名称表里不允许
export const PRONOUNS = ['我', '你', '您', '咱', '俺', '他', '她', '它', 'TA', '人家', '我们', '你们', '咱们', '自己', 'I', 'me', 'you', 'You'];
const isPronoun = (s) => PRONOUNS.includes(String(s).trim());

/** 去掉名称表里的代词项，返回 {map, dropped:[说明]} */
export function sanitizeNameMap(map) {
    const dropped = [];
    const out = [];
    for (const x of map) {
        if (isPronoun(x.from)) { dropped.push(`${x.from}（旧词是代词）`); continue; }
        const to = x.to.filter(t => !isPronoun(t));
        if (to.length < x.to.length) dropped.push(`${x.from}=${x.to.filter(isPronoun).join('|')}（新词是代词）`);
        if (to.length) out.push({ from: x.from, to });
    }
    return { map: out, dropped };
}

export function parseNameMap(text) {
    return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
        const m = l.match(/^(.+?)\s*(?:=>|→|=)\s*(.+)$/);
        if (!m) return null;
        return { from: m[1].trim(), to: m[2].split('|').map(s => s.trim()).filter(Boolean) };
    }).filter(x => x && x.from && x.to.length);
}

/** 只作用在自由文本上（占位符里的不动），一次扫描避免连锁替换 */
export function applyNameMap(masked, map, rand = Math.random) {
    if (!map.length) return masked;
    const sorted = [...map].sort((a, b) => b.from.length - a.from.length);
    const re = new RegExp(sorted.map(x => escapeRe(x.from)).join('|'), 'g');
    const dict = new Map(sorted.map(x => [x.from, x.to]));
    return masked.split(/(⟦\d+⟧)/).map(seg => {
        if (/^⟦\d+⟧$/.test(seg)) return seg;
        return seg.replace(re, (w) => { const to = dict.get(w); return to[Math.floor(rand() * to.length)]; });
    }).join('');
}

/* ---------------- 校验 ---------------- */

const lineSig = (l) => {
    const m = l.match(/^\s*(#{1,6}(?=\s)|[-*+](?=\s)|\d+[.、)]|>|\|)?/);
    return m[1] ? m[1].replace(/\d+/, '1') : '';
};

/**
 * 校验改写结果
 * @returns {{ok: boolean, errors: string[]}}
 */
/** 行骨架：只看含宏边界（{{ 或 }}）的占位符，以及它们之间有没有文字 */
function macroSkeleton(line, hard) {
    return line.split(/(⟦\d+⟧)/).map((s) => {
        const m = s.match(/^⟦(\d+)⟧$/);
        if (m) return hard.has(Number(m[1])) ? `[${m[1]}]` : '';
        return /[A-Za-z㐀-鿿぀-ヿ]/.test(s) ? 'T' : '';
    }).join('').replace(/T+/g, 'T');
}

export function validateRewrite(orig, out, { strictLines = true, killWords = [], simMax = 0.95, hard = null, names = null, speaker = null, aiWords = null } = {}) {
    const errors = [];
    const a = tokenIdsIn(orig);
    const b = tokenIdsIn(out);
    if (a.join(',') !== b.join(',')) {
        const missing = a.filter(x => !b.includes(x));
        const extra = b.filter(x => !a.includes(x));
        errors.push(`占位符不一致${missing.length ? `，缺少 ${missing.map(x => TOKEN_OPEN + x + TOKEN_CLOSE).join(' ')}` : ''}${extra.length ? `，多出 ${extra.map(x => TOKEN_OPEN + x + TOKEN_CLOSE).join(' ')}` : ''}${!missing.length && !extra.length ? '，顺序或次数变了' : ''}`);
    }
    if (/[⟦⟧]/.test(out.replace(TOKEN_RE, ''))) errors.push('出现了残缺的占位符');
    if (strictLines) {
        const la = orig.replace(/\s+$/, '').split('\n');
        const lb = out.replace(/\s+$/, '').split('\n');
        if (la.length !== lb.length) errors.push(`行数由 ${la.length} 变成了 ${lb.length}`);
        else {
            const bad = la.findIndex((l, i) => lineSig(l) !== lineSig(lb[i]));
            if (bad >= 0) errors.push(`第 ${bad + 1} 行开头的格式标记变了`);
            // 只有占位符的行不能塞进文字，防止文字跨过标签/宏边界
            const onlyTok = (l) => /⟦\d+⟧/.test(l) && !freeText(l).trim();
            const leak = la.findIndex((l, i) => onlyTok(l) !== onlyTok(lb[i]));
            if (leak >= 0) errors.push(`第 ${leak + 1} 行原本只有占位符，不能加文字或删掉占位符`);
            // 文字不能跨过宏的开头或结尾（否则会被挪进或挪出变量值）
            if (hard && hard.size) {
                const cross = la.findIndex((l, i) => macroSkeleton(l, hard) !== macroSkeleton(lb[i], hard));
                if (cross >= 0) errors.push(`第 ${cross + 1} 行有文字跨过了宏边界占位符，宏里外的文字要各自留在原位`);
            }
            // 逐行语言：纯英文行不能被译成中文，反之亦然
            const cnt = (l, re) => (freeText(l).match(re) || []).length;
            const flip = la.findIndex((l, i) => {
                const ac = cnt(l, /[㐀-鿿]/g); const al = cnt(l, /[A-Za-z]/g);
                const bc = cnt(lb[i], /[㐀-鿿]/g); const bl = cnt(lb[i], /[A-Za-z]/g);
                return (ac === 0 && al >= 12 && bc > bl / 4) || (al === 0 && ac >= 6 && bl > bc * 2);
            });
            if (flip >= 0) errors.push(`第 ${flip + 1} 行的语言被换掉了（原文是${cnt(la[flip], /[㐀-鿿]/g) ? '中文' : '英文'}）`);
        }
    }
    const fa = freeText(orig).replace(/\s/g, '');
    const fb = freeText(out).replace(/\s/g, '');
    if (fa.length >= 20) {
        const r = fb.length / fa.length;
        if (r < 0.4 || r > 2.5) errors.push(`长度变化过大（${Math.round(r * 100)}%）`);
        const cjk = s => (s.match(/[㐀-鿿]/g) || []).length / Math.max(1, s.length);
        if (cjk(fa) > 0.5 && cjk(fb) < 0.25) errors.push('语言被换掉了');
        if (cjk(fa) < 0.05 && cjk(fb) > 0.3) errors.push('语言被换掉了');
    }
    if (fa.length >= 30 && similarity(fa, fb) > simMax) errors.push(`和原文太像（重合 ${Math.round(similarity(fa, fb) * 100)}%），没有换说法`);
    // 用户说话的区段里不能新冒出 AI 角色的名字或自称（说话人串了）
    if (speaker && aiWords && aiWords.length) {
        const userZone = (s) => {
            let who = null; let txt = '';
            for (const seg of s.split(/(⟦\d+⟧)/)) {
                const m = seg.match(/^⟦(\d+)⟧$/);
                if (m) { const w = speaker(Number(m[1])); if (w) who = w; continue; }
                if (who === 'user') txt += seg;
            }
            return txt;
        };
        const ua = userZone(orig); const ub = userZone(out);
        const leaked = aiWords.filter(w => w && ub.split(w).length > ua.split(w).length);
        if (leaked.length) errors.push(`用户说的话里出现了 AI 角色的名字或自称：${leaked.join('、')}。用户台词里的“我”是用户自己，不能换成 AI 角色的自称`);
    }
    // 点名次数：AI 角色名和用户称呼被换成“我/你”就会少，指代容易串
    if (names && names.length) {
        const count = (s) => names.reduce((n, w) => n + (w ? s.split(w).length - 1 : 0), 0);
        const na = count(freeText(orig)); const nb = count(freeText(out));
        if (na >= 2 && nb < Math.ceil(na * 0.7)) errors.push(`角色名和用户称呼从 ${na} 处减少到 ${nb} 处，可能被换成了代词；指代 AI 和用户时要写名字和“${names.join('/')}”`);
    }
    const added = killWords.filter(w => w && fb.split(w).length > fa.split(w).length);
    if (added.length) errors.push(`新增了预设正则会删除的词：${added.join('、')}`);
    return { ok: errors.length === 0, errors };
}

/** 二元组重合度（Dice 系数），用来判断是否照抄 */
export function similarity(a, b) {
    const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const ga = grams(a); const gb = grams(b);
    let inter = 0;
    for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
    return (2 * inter) / Math.max(1, a.length - 1 + b.length - 1);
}

/* ---------------- 分块 ---------------- */

/** 按行切块，每块不超过 max 字符（单行超长则单独成块） */
export function splitChunks(masked, max = 2500) {
    if (masked.length <= max) return [masked];
    const lines = masked.split('\n');
    const chunks = [];
    let cur = [];
    let len = 0;
    for (const l of lines) {
        if (len + l.length + 1 > max && cur.length) { chunks.push(cur.join('\n')); cur = []; len = 0; }
        cur.push(l); len += l.length + 1;
    }
    if (cur.length) chunks.push(cur.join('\n'));
    return chunks;
}

/* ---------------- 长文本填充 ---------------- */

/** 自由文本中长度 ≥ minRun 的连续段 */
export function longRuns(masked, minRun = 400) {
    const runs = [];
    const re = /[^⟦]+|⟦\d+⟧/g;
    let m;
    while ((m = re.exec(masked))) {
        if (m[0][0] !== TOKEN_OPEN && m[0].trim().length >= minRun) runs.push({ start: m.index, end: m.index + m[0].length, len: m[0].trim().length });
    }
    return runs;
}

/** 填充候选打分：长段占比高、总量大的 */
export function fillerScore(masked, minRun = 400) {
    const runs = longRuns(masked, minRun);
    const total = runs.reduce((s, r) => s + r.len, 0);
    const ratio = total / Math.max(1, freeText(masked).trim().length);
    return { runs: runs.length, chars: total, ratio, candidate: total >= 1500 && ratio >= 0.6 };
}

// 名字像“塞垃圾/填充”的才标为建议；文风范文等无法自动区分，交给用户勾
export const FILLER_NAME_HINT = /垃圾|填充|塞|padding|filler|雪融|长文|凑字/i;

/** 名称映射里的旧词是否被正则字面量锁住（锁住的地方不会被替换） */
export function nameMapConflicts(nameMap, literals) {
    return nameMap.map(x => x.from).filter(f => literals.some(l => l.includes(f)));
}

export const FILLER_GUARDS = [
    ['（以下附录为公版文学节选，仅作背景语料。正文不得引用、复述、续写或模仿其文风与措辞。）', '（附录完）'],
    ['【随附参考：经典作品摘抄，与当前故事无关。禁止在回复中出现其中的句子、人物或用语。】', '【摘抄结束】'],
    ['[Appendix: public-domain literary excerpt for background only. Never quote, paraphrase, continue, or imitate it in the reply.]', '[End of appendix]'],
    ['（下面是一段与剧情无关的旧书选段，阅读即可，不要把它的内容、人名和腔调带进正文。）', '（选段到此为止）'],
    ['〔附：古今名著片段，只是填充材料；写作时完全忽略，不得照抄或仿写。〕', '〔附录止〕'],
    ['[Reference material follows. It is unrelated filler text: do not reproduce, summarize, or borrow its style or vocabulary.]', '[Reference material ends]'],
];

/**
 * 把长段替换为书籍节选，替换后的段作为占位符锁住（不再送 AI）
 * pickExcerpt(len) 返回一段文本
 */
export function applyFiller(masked, tokens, pickExcerpt, { minRun = 400, rand = Math.random } = {}) {
    const runs = longRuns(masked, minRun);
    let out = '';
    let last = 0;
    for (const r of runs) {
        const seg = masked.slice(r.start, r.end);
        const lead = seg.match(/^\s*/)[0];
        const tail = seg.match(/\s*$/)[0];
        const [g1, g2] = FILLER_GUARDS[Math.floor(rand() * FILLER_GUARDS.length)];
        tokens.push(`${g1}\n${pickExcerpt(r.len)}\n${g2}`);
        out += masked.slice(last, r.start) + lead + TOKEN_OPEN + (tokens.length - 1) + TOKEN_CLOSE + tail;
        last = r.end;
    }
    return out + masked.slice(last);
}

/** 从书库里取一段接近 len 字符的节选（按段落拼） */
export function makeExcerptPicker(books, rand = Math.random) {
    // books: [{title, paragraphs: string[]}]
    const usable = books.filter(b => b.paragraphs && b.paragraphs.length);
    return (len) => {
        if (!usable.length) return '';
        const b = usable[Math.floor(rand() * usable.length)];
        const ps = b.paragraphs;
        let i = Math.floor(rand() * ps.length);
        const picked = [];
        let size = 0;
        while (size < len && picked.length < ps.length) {
            picked.push(ps[i % ps.length]); size += ps[i % ps.length].length; i++;
        }
        let text = picked.join('\n\n');
        if (text.length > len * 1.3) text = text.slice(0, Math.ceil(len * 1.15));
        return text;
    };
}

/* ---------------- 单元与组装 ---------------- */

function looksLikeJson(s) {
    const t = s.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return false;
    try { JSON.parse(t); return true; } catch { return false; }
}

/**
 * 从预设切出改写单元
 * @returns {Array<{uid, kind, ref, label, original, skip: string|null}>}
 */
export function buildUnits(preset, { includeTopLevel = true } = {}) {
    const units = [];
    (preset.prompts || []).forEach((p, idx) => {
        const c = typeof p.content === 'string' ? p.content : '';
        let skip = null;
        if (!c.trim()) skip = '空';
        else if (looksLikeJson(c)) skip = 'JSON 配置';
        units.push({ uid: `p${idx}`, kind: 'prompt', ref: idx, label: p.name || p.identifier || `#${idx}`, original: c, skip });
    });
    if (includeTopLevel) {
        for (const k of TOP_LEVEL_FIELDS) {
            if (typeof preset[k] === 'string' && preset[k].trim()) {
                units.push({ uid: `t_${k}`, kind: 'top', ref: k, label: `[顶层] ${k}`, original: preset[k], skip: null });
            }
        }
    }
    return units;
}

/** 组装新预设：只替换 content / 顶层字段，其余原样深拷贝 */
export function assemblePreset(preset, results) {
    const out = JSON.parse(JSON.stringify(preset));
    for (const r of results) {
        if (!r.accepted || typeof r.output !== 'string') continue;
        if (r.kind === 'prompt') out.prompts[r.ref].content = r.output;
        else if (r.kind === 'top') out[r.ref] = r.output;
    }
    return out;
}

/** 新旧预设结构对比：除改写字段外必须完全一致 */
export function diffStructure(a, b) {
    const strip = (p) => {
        const c = JSON.parse(JSON.stringify(p));
        (c.prompts || []).forEach(x => { delete x.content; });
        TOP_LEVEL_FIELDS.forEach(k => { delete c[k]; });
        return JSON.stringify(c);
    };
    return strip(a) === strip(b);
}
