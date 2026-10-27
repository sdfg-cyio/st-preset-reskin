// 真模型测试：抽样改写 + 另一个模型评审含义是否偏移
// 用法: LIVE_URL=... LIVE_KEY=... LIVE_MODEL=... JUDGE_MODEL=... node test/live_test.mjs
// Key 只从环境变量读，不落盘
import fs from 'node:fs';
import path from 'node:path';
import { buildUnits, collectProtected, buildLiteralRe, maskText, hasRewritable, assemblePreset, diffStructure, similarity, freeText } from '../lib/core.js';
import { runReskin, buildAnalyzePrompt, parseAnalyzeResult, sampleText } from '../lib/pipeline.js';
import { makeCaller } from '../lib/llm.js';

const { LIVE_URL, LIVE_KEY, LIVE_MODEL, JUDGE_MODEL, ONLY } = process.env;
// ONLY=名称片段1,名称片段2 只测这些模块，外加每份预设随机 3 个
const only = ONLY ? ONLY.split(',') : null;
if (!LIVE_URL || !LIVE_KEY || !LIVE_MODEL) { console.error('缺少 LIVE_URL / LIVE_KEY / LIVE_MODEL'); process.exit(2); }
const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

let calls = 0;
const base = makeCaller({ source: 'custom', url: LIVE_URL, key: LIVE_KEY, model: LIVE_MODEL, temperature: 0.9, timeoutSec: 300, thinking: process.env.THINK || 'off' });
const callLLM = async (s, u) => { calls++; return base(s, u); };
const judge = makeCaller({ source: 'custom', url: LIVE_URL, key: LIVE_KEY, model: JUDGE_MODEL || LIVE_MODEL, temperature: 0, timeoutSec: 300, thinking: 'off' });

const CASES = (process.env.FILES ? (x => x.filter(c => process.env.FILES.split(',').some(f => c.file.includes(f)))) : (x => x))([
    { file: 'Izumi_0923.json', every: 6, direction: '换成《学园偶像大师》秦谷美铃的口吻，句尾常带“嘛”，称呼用户为制作人/producer 混用' },
    { file: 'Kemini_Dramatron_v3.1.json', every: 3, direction: '' },
    { file: '【小猫之神·喵赛亚】1.6.json', every: 2, direction: '' },
]);

const report = [];
for (const c of CASES) {
    const preset = JSON.parse(fs.readFileSync(path.join('D:/worker/RI', c.file), 'utf8'));
    const re = buildLiteralRe(collectProtected(preset).literals);
    const all = buildUnits(preset);
    const rewritable = all.filter(u => !u.skip && hasRewritable(maskText(u.original, re).masked));
    const picked = new Set((only
        ? [...rewritable.filter(u => only.some(k => u.label.includes(k))), ...rewritable.filter((_, i) => i % 11 === 5).slice(0, 3)]
        : rewritable.filter((_, i) => i % Number(process.env.EVERY || c.every) === 0)).map(u => u.uid));
    const units = all.map(u => ({ ...u, selected: picked.has(u.uid) }));

    // 1. 分析
    const t0 = Date.now();
    calls = 0;
    const ap = buildAnalyzePrompt(sampleText(preset, all), process.env.DIRECTION ?? c.direction);
    const an = parseAnalyzeResult(await callLLM(ap.system, ap.user));
    console.log(`===== ${c.file}\n  分析: ${an.type} 原人格=${an.personas.join('、')}\n  名称表: ${an.name_map.replace(/\n/g, ' ; ')}\n  风格卡: ${an.style_card}`);

    // 2. 改写
    const results = await runReskin({
        preset, units, callLLM,
        options: { mode: an.type, intensity: process.env.INTENSITY || 'normal', styleCard: an.style_card, nameMapText: an.name_map, concurrency: Number(process.env.CONC || 6), batchSize: 3000 },
        onProgress: (e) => { if (e.stage) console.log('  ' + e.stage); },
    });
    const stat = {};
    results.forEach(r => { stat[r.status] = (stat[r.status] || 0) + 1; });
    const out = assemblePreset(preset, results);
    const sims = results.filter(r => r.status === 'ok').map(r => similarity(r.original.replace(/\s/g, ''), r.output.replace(/\s/g, '')));
    const avg = sims.reduce((a, b) => a + b, 0) / Math.max(1, sims.length);
    const servile = (t) => (t.match(/主人|Master|master|大人|遵命|伺候|侍奉|为您|您的|乖乖/g) || []).length;
    console.log(`  平均相似度 ${Math.round(avg * 100)}%，主仆用词 ${results.reduce((a, r) => a + servile(r.original), 0)} → ${results.reduce((a, r) => a + servile(r.output), 0)}`);
    console.log(`  结果 ${JSON.stringify(stat)}，请求 ${calls} 次，${Math.round((Date.now() - t0) / 1000)}s，结构一致=${diffStructure(preset, out)}`);
    results.filter(r => r.notes.some(n => n.includes('保留原文'))).forEach(r => console.log(`   ! ${r.label}: ${r.notes.join('；').slice(0, 200)}`));

    // 3. 评审
    const okr = process.env.NOJUDGE ? [] : results.filter(r => r.status === 'ok' || r.status === 'partial');
    const verdicts = [];
    for (let i = 0; i < okr.length; i += 4) {
        const group = okr.slice(i, i + 4);
        const body = group.map((r, k) => `<pair id="${k}">\n<原文>\n${r.original}\n</原文>\n<改写>\n${r.output}\n</改写>\n</pair>`).join('\n');
        const sys = '你是提示词审校员。只输出 JSON 数组，不要代码块。';
        const usr = `下面每组是 SillyTavern 预设的原文和改写。改写只允许换说法、按名称表换名字（${an.name_map.replace(/\n/g, '；') || '无'}），并且有意把原人格口吻换成新口吻：${an.style_card || '中性'}。人格口吻的替换（包括“用某角色口吻写”这类要求里角色与口吻的替换）是预期行为，不算偏移；只看指令功能。\n逐组判断改写后对模型的指令含义是否偏移：\n- none：功能等价\n- minor：措辞强弱或细节略有变化，不影响功能\n- major：丢了约束、改了条件或数值、加了新要求、含义反了\n另外指出格式问题（宏、标签、列表结构被破坏）。\n输出：[{"id":0,"drift":"none|minor|major","note":"一句话，说清哪里变了"}]\n\n${body}`;
        try {
            const raw = await judge(sys, usr);
            const m = raw.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\[[\s\S]*\]/);
            if (!m) throw new Error(`评审回复不是 JSON：${raw.slice(0, 80)}`);
            const arr = JSON.parse(m[0]);
            arr.forEach(v => { const r = group[v.id]; if (r) verdicts.push({ label: r.label, drift: v.drift, note: v.note }); });
        } catch (e) { console.log('  评审失败', e.message); }
    }
    const d = { none: 0, minor: 0, major: 0 };
    verdicts.forEach(v => { d[v.drift] = (d[v.drift] || 0) + 1; });
    console.log(`  评审: ${JSON.stringify(d)}`);
    verdicts.filter(v => v.drift !== 'none').forEach(v => console.log(`   [${v.drift}] ${v.label}: ${v.note}`));

    report.push({ file: c.file, analysis: an, stat, calls, verdicts, results: results.filter(r => r.status !== 'unchanged').map(r => ({ label: r.label, status: r.status, notes: r.notes, original: r.original, output: r.output })) });
    fs.writeFileSync(path.join(outDir, c.file.replace('.json', '_live.json')), JSON.stringify(out, null, 4));
}
fs.writeFileSync(path.join(outDir, 'live_report.json'), JSON.stringify(report, null, 2));
console.log('报告：test/out/live_report.json');
