// 切块字数基准：只取长模块，比较不同块大小的请求数、耗时、一次通过率、最终失败、相似度、含义偏移
// 用法: LIVE_URL=... LIVE_KEY=... LIVE_MODEL=... SIZES=1500,2500,4000 node test/bench_chunk.mjs
import fs from 'node:fs';
import path from 'node:path';
import { buildUnits, collectProtected, buildLiteralRe, maskText, hasRewritable, similarity } from '../lib/core.js';
import { runReskin } from '../lib/pipeline.js';
import { makeCaller } from '../lib/llm.js';

const { LIVE_URL, LIVE_KEY, LIVE_MODEL } = process.env;
if (!LIVE_URL || !LIVE_KEY || !LIVE_MODEL) { console.error('缺少 LIVE_URL / LIVE_KEY / LIVE_MODEL'); process.exit(2); }
const SIZES = (process.env.SIZES || '1500,2500,4000,6000,9000').split(',').map(Number);
const MIN = Number(process.env.MIN || 1500);
const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1');

const CASES = [
    { file: 'Izumi_0923.json', mode: 'persona', nameMap: '泉此方=伊蕾娜\n小此=伊蕾娜\nKonata=伊蕾娜\nMaster=旅伴|旅人', style: '伊蕾娜（《魔女之旅》）：自称“我”，偶尔自恋地说“本魔女”；句尾常带“呢”“哦”；聪明、爱钱、有点毒舌，对用户是平等的旅伴，不讨好。' },
    { file: 'Kemini_Dramatron_v3.1.json', mode: 'neutral', nameMap: '', style: '' },
];
const sets = CASES.map(c => {
    const preset = JSON.parse(fs.readFileSync(path.join('D:/worker/RI', c.file), 'utf8'));
    const re = buildLiteralRe(collectProtected(preset).literals);
    const units = buildUnits(preset).map(u => ({ ...u, selected: !u.skip && hasRewritable(maskText(u.original, re).masked) && maskText(u.original, re).masked.length > MIN }));
    return { ...c, preset, units };
});
console.log('测试模块', sets.map(s => `${s.file} ${s.units.filter(u => u.selected).length} 个`).join('，'));

const judge = makeCaller({ source: 'custom', url: LIVE_URL, key: LIVE_KEY, model: LIVE_MODEL, temperature: 0, timeoutSec: 300, thinking: 'off' });
async function judgeOne(r) {
    const usr = `下面是 SillyTavern 预设一个模块的原文和改写。改写允许：换说法、把原人格口吻换成新口吻、按名称表换名字。判断改写对模型的指令含义是否偏移：none 功能等价；minor 措辞强弱或细节略变、不影响功能；major 丢了约束、改了条件或数值、加了新要求、含义反了、格式结构被破坏。只输出 JSON：{"drift":"none|minor|major","note":"一句话"}\n<原文>\n${r.original}\n</原文>\n<改写>\n${r.output}\n</改写>`;
    for (let i = 0; i < 2; i++) {
        try { return JSON.parse((await judge('你是提示词审校员。只输出 JSON。', usr)).match(/\{[\s\S]*\}/)[0]); } catch { /* 重试 */ }
    }
    return { drift: 'error', note: '评审失败' };
}
async function pool(items, n, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
    return out;
}

const rows = [];
for (const size of SIZES) {
    let calls = 0; let jobs = 0; let firstFail = 0; let finalFail = 0; let maxReq = 0;
    const t0 = Date.now();
    const all = [];
    for (const s of sets) {
        const base = makeCaller({ source: 'custom', url: LIVE_URL, key: LIVE_KEY, model: LIVE_MODEL, temperature: 0.9, timeoutSec: 600, thinking: 'off' });
        const callLLM = async (sy, u) => { calls++; const t = Date.now(); const r = await base(sy, u); maxReq = Math.max(maxReq, Date.now() - t); return r; };
        const results = await runReskin({
            preset: s.preset, units: s.units, callLLM,
            options: { mode: s.mode, intensity: 'normal', styleCard: s.style, nameMapText: s.nameMap, concurrency: 6, chunkSize: size, batchSize: size },
            onProgress: (e) => {
                if (!e.stage) return;
                let m = e.stage.match(/^共 (\d+) 块/); if (m) jobs += Number(m[1]);
                m = e.stage.match(/^首轮通过 (\d+)\/(\d+)/); if (m) firstFail += Number(m[2]) - Number(m[1]);
            },
        });
        results.forEach(r => { finalFail += r.chunksFailed || 0; });
        all.push(...results.filter(r => r.status === 'ok' || r.status === 'partial'));
    }
    const secs = (Date.now() - t0) / 1000;
    const sims = all.map(r => similarity(r.original.replace(/\s/g, ''), r.output.replace(/\s/g, '')));
    const v = await pool(all, 6, judgeOne);
    const d = { none: 0, minor: 0, major: 0, error: 0 };
    v.forEach(x => { d[x.drift] = (d[x.drift] || 0) + 1; });
    const row = { size, jobs, calls, secs: Math.round(secs), maxReqSec: Math.round(maxReq / 1000), firstPass: `${Math.round((1 - firstFail / Math.max(1, jobs)) * 100)}%`, finalFail, sim: `${Math.round(sims.reduce((a, b) => a + b, 0) / Math.max(1, sims.length) * 100)}%`, ...d };
    rows.push(row);
    console.log(JSON.stringify(row));
    v.forEach((x, i) => { if (x.drift === 'major') console.log(`   [major] ${all[i].label}: ${x.note}`); });
}
fs.mkdirSync(path.join(here, 'out'), { recursive: true });
fs.writeFileSync(path.join(here, 'out', `bench_chunk_${SIZES.join('_')}.json`), JSON.stringify(rows, null, 2));
