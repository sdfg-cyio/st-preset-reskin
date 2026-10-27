// 改写流水线：提示词构造、风格分析、并发改写；AI 调用由外部注入，便于离线测试
import {
    collectProtected, buildLiteralRe, maskText, unmask, applyNameMap, hasRewritable,
    splitChunks, validateRewrite, applyFiller, makeExcerptPicker, freeText, parseNameMap,
} from './core.js';

// 改写时不要新写出来的常见八股词（原文已有的不算）
export const BUILTIN_CLICHES = [
    '不容置疑', '不易察觉', '一丝', '狡黠', '涟漪', '弧度', '投入石子', '指节泛白', '四肢百骸',
    '灭顶', '小兽', '呜咽', '喉结滚动', '共犯', '极其', '由于', '并不存在的', '宛如', '仿佛',
    '眼底闪过', '嘴角勾起', '心照不宣', '石破天惊', '炸弹',
];

const MODE_TEXT = {
    persona: '原文是以某个人格化角色的口吻写给模型的。改写时把这个角色整体换成【风格要求】里描述的新角色：自称、口癖、性格、说话节奏、标点和感叹习惯、对用户的称呼和态度都按新角色来。原角色和用户之间那种讨好、撒娇、仆从对主人式的关系不要照搬；新角色怎么看待用户，就按新角色的性格写（比如平等的搭档、旅伴、合作者），不必卑微顺从。只换口吻和态度，不换指令。',
    neutral: '原文是直接的指令文本。改写时做彻底的同义改写：换词、重组句式和语序，保持中性、简洁的指令口吻，不加入任何角色人设或口癖（除非【风格要求】另有说明）。',
};

// 改写力度：影响提示词和“照抄”判定阈值
export const INTENSITY = {
    light: { sim: 0.95, text: '以同义换词和调整语序为主，句子结构可以基本保留。' },
    normal: { sim: 0.85, text: '每句话都要换一种说法：换词、换句式、换语序，可以拆句并句（不跨行），整体读起来要像另一个人写的。' },
    bold: { sim: 0.75, text: '大胆重写：每行用完全不同的表达重新组织，可以换比喻、换举例方式、换修辞、调整列举顺序（同一行内），只要每条指令的含义还在。读起来要像完全不同的作者写的。' },
};

export function buildSystemPrompt({ mode, styleCard, nameMap, killWords, intensity = 'normal' }) {
    const names = [...new Set(nameMap.flatMap(x => x.to))];
    const lv = INTENSITY[intensity] || INTENSITY.normal;
    return [
        '你是提示词文本的改写员。任务：把 SillyTavern 预设里的一段文字换一种说法重写。目的是让措辞与原版明显不同，功能完全不变。',
        '',
        '硬性规则：',
        '1. 形如 ⟦数字⟧ 的占位符代表被锁定的代码、宏、标签或关键字。每个占位符都必须原样保留，数量和先后顺序不变，不能增删、改写、翻译或合并。占位符周围的句子要接得通顺。',
        '2. 每条指令、约束、数值、条件、列举项的含义都要保留，不得删减，不得新增要求。原文说“禁止”就还是禁止，说“必须”就还是必须；语气可以随新口吻变化，但约束不能因此变松或变紧。',
        '3. 行数不变，逐行对应改写。行首的 Markdown 标记（#、-、*、1.、>、|）原样保留，空行也保留。只有占位符的行原样照抄；文字不能从一行挪到另一行，也不能跨过占位符挪动。',
        '4. 保持原文的主体语言：中文写中文，英文写英文，混用就照样混用。',
        `5. 改写力度：${lv.text}不要连续照抄原文超过 6 个字（专有名词除外）。`,
        '5b. 输出格式模板、示例回答里给模型照抄的固定词（如 No.、OK、PASSED、Yes、字段名、状态码、判定词）原样保留，只改写其中的解释性文字。',
        '6. 如果这段是文风范文、示例对白、故事正文、资料设定这类“给模型看的样本”，而不是对模型说的话：保留它的文风特点、叙述人称、人物和情节，不套用下面的新口吻；但句子同样要重写，不能只换几个词。',
        '7. 只输出改写结果，用 <out> 和 </out> 包住，不要任何解释。',
        '8. 说话人和对象不能对调：原文是谁对谁说、谁给谁权限、谁向谁提要求，改写后仍是同一对关系，只换名字和口吻。原文里用户（我、Master 等）对 AI 角色说的话，改写后还是用户对新 AI 角色说；AI 角色的自述还是 AI 角色的自述。',
        '9. 占位符有的是不发给模型的注释，可能夹在句末。保持它在原来的相对位置，不要把它当成句子成分写进句子里（比如不要写成“收进⟦3⟧里”）。',
        '10. 如果 <src> 里有多个 <unit id="…">，它们是互不相关的独立段落：逐个改写，每个结果用同一个 id 的 <unit id="…"></unit> 包住，全部放进 <out>。不能漏掉、合并或调换 unit，也不能改 id。',
        '',
        `【模式】${MODE_TEXT[mode] || MODE_TEXT.neutral}`,
        '',
        `【风格要求】${styleCard?.trim() || '自行挑选一种与原文明显不同、全篇一致的说法；保持指令清晰。'}`,
        names.length ? `\n【名称】文中的角色名、称呼已经替换好：${names.join('、')}。原样使用，不要改回旧名，也不要另起新名。` : '',
        killWords.length ? `\n【禁用词】不要新写出这些词（原文里已有的保持不动）：${killWords.join('、')}` : '',
    ].filter(s => s !== '').join('\n');
}

export function buildUserPrompt(chunk, lastErrors) {
    const fix = lastErrors?.length ? `\n\n上一次改写没通过检查：${lastErrors.join('；')}。请严格按规则重新改写。` : '';
    return `<src>\n${chunk}\n</src>${fix}`;
}

/** 打包请求：多个 job 放进一个 <src> */
export function buildBatchPrompt(jobs) {
    // 英文段和中文段混在一包时模型容易把英文译成中文，标出语言
    const lang = (t) => { const f = freeText(t); const cjk = (f.match(/[㐀-鿿]/g) || []).length; const lat = (f.match(/[A-Za-z]/g) || []).length; return lat > cjk * 3 ? ' lang="English, keep English"' : ''; };
    const body = jobs.map(j => `<unit id="${j.id}"${lang(j.text)}>\n${j.text.trim()}\n</unit>`).join('\n');
    const errs = jobs.filter(j => j.errors?.length).map(j => `unit ${j.id}：${j.errors.join('；')}`);
    const fix = errs.length ? `\n\n以下 unit 上次没通过检查，请严格按规则重新改写：\n${errs.join('\n')}` : '';
    return `<src>\n${body}\n</src>${fix}`;
}

/** 去掉思维链与 <out> 外壳 */
function stripShell(resp) {
    let t = String(resp ?? '').replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, '');
    const m = t.match(/<out>([\s\S]*?)(<\/out>|$)/i);
    if (m) return m[1];
    return t.replace(/^\s*```[a-z]*\n?|```\s*$/g, '');
}

/** 按原块恢复首尾空白 */
function fitWhitespace(t, chunk) {
    t = String(t).replace(/^\n+|\s+$/g, '').replace(/^\s+/, '');
    return chunk.match(/^\s*/)[0] + t + chunk.match(/\s*$/)[0];
}

/** 从回复里取出 <out> 内容；保留原块首尾空白 */
export function extractOutput(resp, chunk) {
    return fitWhitespace(stripShell(resp), chunk);
}

/** 解析打包回复，返回 {id: 文本}；缺的 unit 不出现 */
export function parseBatch(resp) {
    const out = {};
    const t = stripShell(resp);
    for (const m of t.matchAll(/<unit\s+id\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/unit>/gi)) {
        if (!(m[1] in out)) out[m[1]] = m[2];
    }
    return out;
}

/** 按字数贪心打包；size<=0 时每个单独一包 */
export function packJobs(jobs, size) {
    if (size <= 0) return jobs.map(j => [j]);
    const batches = [];
    let cur = [];
    let len = 0;
    for (const j of jobs) {
        if (cur.length && len + j.text.length > size) { batches.push(cur); cur = []; len = 0; }
        cur.push(j); len += j.text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
}

/* ---------------- 风格分析 ---------------- */

export function buildAnalyzePrompt(sample, direction) {
    return {
        system: '你是 SillyTavern 预设分析员。只输出一个 JSON 对象，不要代码块，不要解释。',
        user: [
            '下面是一份预设的文字样本（⟦n⟧ 是被锁定的代码，忽略即可）。',
            '请判断：',
            '1. type：这份预设是 "persona"（以某个人格化角色口吻写给模型，比如自称、口癖、称呼用户为某某）还是 "neutral"（直接下指令、没有人设）。',
            '2. personas：原文里人格角色的名字、昵称、自称，以及对用户的称呼（比如 master），列成数组。',
            '3. name_map：按【用户要求】给出替换表，每行“旧=新”，一个旧词想混用多个新词时用 | 分隔；用户没指定就自己选一个合适的新角色，保证新旧明显不同。AI 角色的名字、昵称、自称只能映射到新 AI 角色的名字、昵称、自称；对用户的称呼只能映射到新的用户称呼，两类不能交叉。“我、你、咱”这类普通代词不要放进表里。neutral 类型可以留空。',
            '4. style_card：给改写员看的风格卡，200 字以内。写清新角色的自称、口癖、句尾习惯、性格、对用户的称呼，以及新角色和用户是什么关系、用什么态度对待用户（按新角色本来的性格定，不要沿用原预设那种讨好主人的关系）；neutral 类型就写同义改写的措辞方向。',
            '',
            `【用户要求】${direction?.trim() || '（没有指定，你自己发挥）'}`,
            '',
            '输出格式：{"type":"persona","personas":["..."],"name_map":"旧=新\\n旧=新","style_card":"..."}',
            '',
            '<sample>',
            sample,
            '</sample>',
        ].join('\n'),
    };
}

export function parseAnalyzeResult(resp) {
    const t = String(resp ?? '').replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, '');
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('分析结果不是 JSON');
    const j = JSON.parse(m[0]);
    return {
        type: j.type === 'persona' ? 'persona' : 'neutral',
        personas: Array.isArray(j.personas) ? j.personas.map(String) : [],
        name_map: typeof j.name_map === 'string' ? j.name_map : '',
        style_card: typeof j.style_card === 'string' ? j.style_card : '',
    };
}

/** 抽样：取每个可改写单元前若干字，总长不超过 max */
export function sampleText(preset, units, max = 5000) {
    const { literals } = collectProtected(preset);
    const re = buildLiteralRe(literals);
    let out = '';
    for (const u of units) {
        if (u.skip) continue;
        const { masked } = maskText(u.original, re);
        if (!hasRewritable(masked)) continue;
        const piece = freeText(masked).replace(/\n{3,}/g, '\n\n').trim().slice(0, 300);
        out += `\n--- ${u.label}\n${piece}`;
        if (out.length > max) break;
    }
    return out.slice(0, max);
}

/* ---------------- 注释占位符 ---------------- */

const isCommentTok = (s) => typeof s === 'string' && /^\s*(\{\{\/\/[\s\S]*\}\}\s*)+$/.test(s);

/** 把行尾的注释占位符摘下来，不给 AI 看，改写后原样接回 */
export function detachComments(text, tokens) {
    const suffixes = [];
    const lines = text.split('\n').map((l) => {
        const m = l.match(/((?:\s*⟦\d+⟧)+)\s*$/);
        if (m && m.index > 0 && l.slice(0, m.index).trim()) {
            const ids = [...m[1].matchAll(/⟦(\d+)⟧/g)].map(x => Number(x[1]));
            if (ids.every(id => isCommentTok(tokens[id]))) { suffixes.push(l.slice(m.index)); return l.slice(0, m.index); }
        }
        suffixes.push('');
        return l;
    });
    return { text: lines.join('\n'), suffixes };
}

export function attachComments(text, suffixes) {
    if (!suffixes || suffixes.every(s => !s)) return text;
    const lines = text.split('\n');
    return lines.map((l, i) => (suffixes[i] ? l.replace(/\s+$/, '') + suffixes[i] : l)).join('\n');
}

/* ---------------- 主流程 ---------------- */

/**
 * 打包改写：短块拼成一包发，按块单独校验；不合格的缩小包重发，最后一轮逐条发
 * @param {object} p
 * @param {object} p.preset 源预设
 * @param {Array} p.units buildUnits 的结果（只处理 selected!==false 的）
 * @param {object} p.options {mode, styleCard, nameMapText, extraKeep[], extraKill[], fillerUids:Set, books, retries, concurrency, chunkSize, batchSize, strictLines}
 * @param {(system:string, user:string)=>Promise<string>} p.callLLM
 * @param {(ev:object)=>void} [p.onProgress] 每个模块完成时回调 {done,total,result}；另有 {stage} 事件
 * @param {{aborted:boolean}} [p.signal]
 * @returns {Promise<Array>} results（按 units 原顺序）
 */
export async function runReskin({ preset, units, options, callLLM, onProgress = () => {}, signal = { aborted: false }, rand = Math.random }) {
    const o = { retries: 2, concurrency: 3, chunkSize: 4000, batchSize: 4000, splitMin: 1200, strictLines: true, ...options };
    const prot = collectProtected(preset, o.extraKeep || []);
    const literalRe = buildLiteralRe(prot.literals);
    const nameMap = parseNameMap(o.nameMapText);
    const killWords = [...new Set([...prot.killWords, ...BUILTIN_CLICHES, ...(o.extraKill || [])])].filter(Boolean);
    const lv = INTENSITY[o.intensity] || INTENSITY.normal;
    const system = buildSystemPrompt({ mode: o.mode, styleCard: o.styleCard, nameMap, killWords, intensity: o.intensity });
    const picker = makeExcerptPicker(o.books || [], rand);
    const fillerUids = o.fillerUids || new Set();

    // 全局共享占位符表，不同模块编号不会撞
    const tokens = [];
    const records = [];
    const jobs = [];
    let jobSeq = 0;
    // 只含宏开头或只含宏结尾的占位符（如 {{setvar::x:: 和 }}）：文字不能跨过它们；{{user}} 这类完整宏可以随句子挪
    const unbalanced = (t) => (String(t || '').match(/\{\{/g) || []).length !== (String(t || '').match(/\}\}/g) || []).length;
    const hardTokens = { size: 1, has: (id) => unbalanced(tokens[id]) };
    // write(out) 把通过校验的结果写回所在位置
    const newJob = (rec, text, suffixes, write) => ({ id: jobSeq++, rec, text, suffixes, write, errors: null });

    /** 失败的大块对半拆开重发：已经对的半边不用再错一次，错的半边越拆越小 */
    const splitJob = (j) => {
        const lines = j.text.split('\n');
        if (lines.length < 4 || j.text.length < o.splitMin) return null;
        // 在中点附近找空行切，尽量不切断段落
        const mid = Math.floor(lines.length / 2);
        let cut = mid;
        for (let k = 0; k <= Math.floor(lines.length / 4); k++) {
            if (!lines[mid + k]?.trim()) { cut = mid + k; break; }
            if (!lines[mid - k]?.trim()) { cut = mid - k; break; }
        }
        cut = Math.min(Math.max(cut, 1), lines.length - 1);
        const halves = [[0, cut], [cut, lines.length]].map(([a, b]) => ({ text: lines.slice(a, b).join('\n'), suffixes: (j.suffixes || []).slice(a, b) }));
        // 两半先放原文（带注释），子块通过后替换，再整体写回父位置
        const sub = halves.map(h => attachComments(h.text, h.suffixes));
        const kids = [];
        halves.forEach((h, k) => {
            if (!hasRewritable(h.text)) return;
            kids.push(newJob(j.rec, h.text, h.suffixes, (out) => { sub[k] = out; j.write(sub.join('\n')); }));
        });
        if (!kids.length) return null;
        j.rec.pending += kids.length - 1;
        return kids;
    };
    for (const u of units.filter(x => x.selected !== false && !x.skip)) {
        let { masked } = maskText(u.original, literalRe, tokens);
        const notes = [];
        if (fillerUids.has(u.uid) && (o.books || []).length) {
            const before = masked;
            masked = applyFiller(masked, tokens, picker, { rand });
            if (masked !== before) notes.push('已填充书籍节选');
        }
        masked = applyNameMap(masked, nameMap, rand);
        const rec = { u, notes, chunks: [], outs: [], pending: 0, failed: 0, okCount: 0, finished: false };
        records.push(rec);
        if (hasRewritable(masked)) {
            splitChunks(masked, o.chunkSize).forEach((c, i) => {
                rec.chunks.push(c);
                rec.outs.push(c);
                if (hasRewritable(c)) {
                    const d = detachComments(c, tokens);
                    jobs.push(newJob(rec, d.text, d.suffixes, (out) => { rec.outs[i] = out; }));
                    rec.pending++;
                }
            });
        } else {
            rec.chunks.push(masked);
            rec.outs.push(masked);
        }
    }

    let done = 0;
    const total = records.length;
    const finish = (rec) => {
        if (rec.finished) return;
        rec.finished = true;
        done++;
        onProgress({ done, total, result: toResult(rec) });
    };
    const toResult = (rec) => {
        const u = rec.u;
        const output = unmask(rec.outs.join('\n'), tokens);
        const n = rec.chunks.filter(hasRewritable).length;
        let status = 'ok';
        if (!n) status = output === u.original ? 'unchanged' : 'mapped';
        else if (rec.failed && !rec.okCount) status = 'failed';
        else if (rec.failed) status = 'partial';
        return { uid: u.uid, kind: u.kind, ref: u.ref, label: u.label, original: u.original, output, status, notes: rec.notes, accepted: status !== 'failed', chunks: n, chunksFailed: rec.failed };
    };
    records.filter(r => !r.pending).forEach(finish);

    // 发一包，返回没通过的 job
    const runBatch = async (batch) => {
        if (signal.aborted) return batch;
        const single = batch.length === 1;
        let resp;
        try {
            resp = await callLLM(system, single ? buildUserPrompt(batch[0].text, batch[0].errors) : buildBatchPrompt(batch));
        } catch (e) {
            const msg = String(e.message || e);
            batch.forEach(j => { j.errors = [`请求失败：${msg}`]; });
            if (/\b(429|5\d\d)\b|超时|timeout/i.test(msg)) await new Promise(res => setTimeout(res, 4000));
            return batch;
        }
        const parsed = single ? null : parseBatch(resp);
        const failed = [];
        for (const j of batch) {
            let raw = single ? stripShell(resp) : parsed[j.id];
            // 单条请求时模型偶尔仍套 unit 壳，剥掉
            if (single) { const pu = parseBatch(resp); if (pu[j.id] != null) raw = pu[j.id]; }
            if (raw == null) { j.errors = ['回复里缺少这个 unit']; failed.push(j); continue; }
            const out = fitWhitespace(raw, j.text);
            const v = validateRewrite(j.text, out, { strictLines: o.strictLines, killWords, simMax: lv.sim, hard: hardTokens });
            if (!v.ok) {
                // 只是“和原文太像”：格式都对，先留着，重发都失败时用它（总比原文强）
                if (v.errors.every(e => e.startsWith('和原文太像'))) j.soft = out;
                j.errors = v.errors; failed.push(j); continue;
            }
            j.write(attachComments(out, j.suffixes));
            j.rec.okCount++;
            j.rec.pending--;
            if (!j.rec.pending) finish(j.rec);
        }
        return failed;
    };

    // 第 0 轮按 batchSize 打包；之后每轮包缩小一半、失败的大块对半拆，最后一轮逐条
    let queue = jobs;
    for (let round = 0; round <= o.retries && queue.length && !signal.aborted; round++) {
        const size = round === o.retries || o.batchSize <= 0 ? 0 : Math.floor(o.batchSize / 2 ** round);
        const batches = packJobs(queue, size);
        onProgress({ stage: round ? `第 ${round} 次重发：${queue.length} 块，${batches.length} 个请求` : `共 ${jobs.length} 块，打包成 ${batches.length} 个请求` });
        const failed = [];
        let next = 0;
        await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, async () => {
            while (next < batches.length) failed.push(...await runBatch(batches[next++]));
        }));
        if (!round) onProgress({ stage: `首轮通过 ${queue.length - failed.length}/${queue.length} 块` });
        // 还有重发机会时，大块拆开；拆不动的原样重发
        // 只是“太像”的不拆（拆了也不会更不像，还会丢掉已有的备用版本）
        const splittable = (j) => round < o.retries && j.soft == null;
        queue = failed.flatMap(j => (splittable(j) && splitJob(j)?.map(k => ({ ...k, errors: j.errors }))) || [j]);
    }
    // 仍失败的块：有格式正确的“改动较小”版本就用它，否则保留原文
    for (const j of queue) {
        if (j.soft != null) {
            j.write(attachComments(j.soft, j.suffixes));
            j.rec.okCount++;
            if (!j.rec.notes.includes('有一块改动较小')) j.rec.notes.push('有一块改动较小');
        } else {
            j.rec.failed++;
            j.rec.notes.push(`有一块保留原文：${(j.errors || ['已中止']).join('；')}`);
        }
        j.rec.pending--;
        if (!j.rec.pending) finish(j.rec);
    }
    records.forEach(finish);

    const order = new Map(units.map((u, i) => [u.uid, i]));
    return records.map(toResult).sort((a, b) => order.get(a.uid) - order.get(b.uid));
}

