// 离线测试：用假 AI 跑三个样本预设，检查宏/标签/正则命中数完全不变
// 用法: node test/offline_test.mjs <预设目录>
import fs from 'node:fs';
import path from 'node:path';
import { buildUnits, assemblePreset, diffStructure, collectProtected, fillerScore, maskText, buildLiteralRe, validateRewrite, FILLER_NAME_HINT, parseNameMap, nameMapConflicts, sanitizeNameMap } from '../lib/core.js';
import { runReskin } from '../lib/pipeline.js';

const dir = process.argv[2] || 'D:/worker/RI';
const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
const booksDir = path.join(here, '..', 'books');
const books = JSON.parse(fs.readFileSync(path.join(booksDir, 'index.json'), 'utf8'))
    .map(b => ({ ...b, paragraphs: fs.readFileSync(path.join(booksDir, b.file), 'utf8').split(/\n\n+/) }));

let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// 假 AI：自由文本每个字后插“~”，占位符原样
let calls = 0;
const mangle = (src) => src.split(/(⟦\d+⟧|<\/?unit[^>]*>)/).map(s => /^⟦\d+⟧$|^<\/?unit/.test(s) ? s : s.replace(/([一-鿿])/g, '$1·').replace(/\b([A-Za-z]{3,})\b/g, '$1x')).join('');
const goodLLM = async (_sys, user) => {
    calls++;
    const src = user.match(/<src>\n([\s\S]*?)\n<\/src>/)[1];
    return `<out>\n${mangle(src)}\n</out>`;
};
// 坏 AI：丢掉第一个占位符
const badLLM = async (sys, user) => (await goodLLM(sys, user)).replace(/⟦\d+⟧/g, '');
// 打包时随机丢一个 unit：应在重发中补回
const flakyLLM = async (sys, user) => {
    const r = await goodLLM(sys, user);
    return /<unit/.test(r) ? r.replace(/<unit id="\d+">[\s\S]*?<\/unit>/, '') : r;
};

const macros = s => (s.match(/\{\{[\s\S]*?\}\}/g) || []).join('\u0001');
const tags = s => (s.match(/<\/?[A-Za-z_][^<>\n]*>/g) || []).join('\u0001');

function regexHits(preset) {
    const all = [...(preset.prompts || []).map(p => p.content || '')].join('\n\u0002\n');
    const rs = preset.extensions?.regex_scripts || [];
    return rs.map(r => {
        const m = r.findRegex.match(/^\/([\s\S]*)\/([a-z]*)$/);
        try {
            const re = m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : new RegExp(r.findRegex, 'g');
            return (all.match(re) || []).length;
        } catch { return 'ERR'; }
    });
}

let failed = 0;
const check = (cond, msg) => { if (!cond) { failed++; console.log('  ✗', msg); } };

for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const preset = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log('=====', f);
    const prot = collectProtected(preset);
    console.log(`  正则 ${prot.regexCount} 条，锁定字面量 ${prot.literals.length} 个，杀词 ${prot.killWords.join('、') || '无'}`);
    const units = buildUnits(preset);
    const re = buildLiteralRe(prot.literals);
    const cands = units.filter(u => !u.skip).map(u => ({ u, s: fillerScore(maskText(u.original, re).masked) })).filter(x => x.s.candidate);
    console.log('  填充候选:', cands.map(x => `${x.u.label}(${x.s.chars}${FILLER_NAME_HINT.test(x.u.label) ? ",建议" : ""})`).join(' | ') || '无');

    // 掩码往返必须无损
    for (const u of units) {
        const { masked, tokens } = maskText(u.original, re);
        const back = masked.replace(/⟦(\d+)⟧/g, (_, i) => tokens[i]);
        check(back === u.original, `掩码往返不一致：${u.label}`);
    }

    const t0 = Date.now();
    calls = 0;
    const flaky = await runReskin({ preset, units, callLLM: flakyLLM, options: { mode: 'neutral', concurrency: 8 } });
    check(flaky.every(r => r.status !== 'failed' && r.status !== 'partial'), '丢 unit 后重发没补回');
    console.log(`  丢unit模拟: ${calls} 次请求, 失败 ${flaky.filter(r => r.status === 'failed' || r.status === 'partial').length}`);
    // 长块一律丢一行：只有拆小以后才能通过
    calls = 0;
    const longBad = async (sys, user) => {
        const src = user.match(/<src>\n([\s\S]*?)\n<\/src>/)[1];
        const r = await goodLLM(sys, user);
        return src.length > 1500 ? r.replace(/\n[^\n]*\n<\/out>/, '\n</out>').replace(/(<unit[^>]*>\n[^\n]*)\n[^\n]*/, '$1') : r;
    };
    const split = await runReskin({ preset, units, callLLM: longBad, options: { mode: 'neutral', concurrency: 8, chunkSize: 6000, batchSize: 6000 } });
    const splitBad = split.filter(r => r.status === 'failed' || r.status === 'partial');
    check(diffStructure(preset, assemblePreset(preset, split)), '拆块后结构变化');
    split.forEach(r => check(tags(r.original) === tags(r.output), `拆块后标签变化：${r.label}`));
    console.log(`  长块必错模拟: ${calls} 次请求, 部分/失败 ${splitBad.length}（${splitBad.map(r => r.label).slice(0, 4).join('、')}）`);
    calls = 0;
    const results = await runReskin({
        preset, units, callLLM: goodLLM, rand,
        options: { mode: 'persona', styleCard: '测试', nameMapText: '泉此方=秦谷美铃\n小此=小秦\nmaster=制作人|producer', books, fillerUids: new Set(cands.filter(x => FILLER_NAME_HINT.test(x.u.label)).map(x => x.u.uid)), concurrency: 8 },
    });
    const stat = {};
    results.forEach(r => { stat[r.status] = (stat[r.status] || 0) + 1; });
    console.log('  结果:', JSON.stringify(stat), `请求 ${calls} 次`, `${Date.now() - t0}ms`);
    results.filter(r => r.status !== 'ok' && r.status !== 'unchanged' && r.status !== 'mapped').slice(0, 5).forEach(r => console.log('   ', r.status, r.label, r.notes.join(' / ').slice(0, 200)));

    const out = assemblePreset(preset, results);
    check(diffStructure(preset, out), '除 content 外结构有变化');
    const filled = new Set(cands.filter(x => FILLER_NAME_HINT.test(x.u.label)).map(x => x.u.uid));
    results.forEach(r => {
        if (filled.has(r.uid)) return; // 填充过的单元宏数量相同但文本位置会变，单独看
        check(tags(r.original) === tags(r.output), `标签变化：${r.label}`);
        // 宏内的自然语言会被改写，比较宏的“骨架”
        const skel = s => macros(s).replace(/[^{}:]/g, '');
        check(skel(r.original) === skel(r.output), `宏骨架变化：${r.label}`);
    });
    const ha = regexHits(preset); const hb = regexHits(out);
    ha.forEach((x, i) => check(x === hb[i] || filled.size, `正则命中数变化：${preset.extensions.regex_scripts[i].scriptName} ${x}→${hb[i]}`));
    console.log('  正则命中(前→后):', ha.map((x, i) => x === hb[i] ? x : `${x}→${hb[i]}`).join(','));
    const sample = results.find(r => r.status === 'ok' && r.original.includes('{{setvar'));
    if (sample) console.log('  样例:', sample.label, '\n   原:', sample.original.slice(0, 120).replace(/\n/g, '⏎'), '\n   新:', sample.output.slice(0, 160).replace(/\n/g, '⏎'));
    if (process.env.KEEP_OUT) { fs.mkdirSync(path.join(here, 'out'), { recursive: true });
    fs.writeFileSync(path.join(here, 'out', f.replace('.json', '_mock.json')), JSON.stringify(out, null, 4)); }

    // 坏 AI：全部应回退原文
    const bad = await runReskin({ preset, units: units.slice(0, 40), callLLM: badLLM, options: { mode: 'neutral', retries: 1, concurrency: 8 } });
    check(bad.every(r => r.status !== 'ok' || !/⟦/.test(r.output)), '坏 AI 结果被采用');
    const badOk = bad.filter(r => r.status === 'ok').length;
    console.log(`  坏AI: ${bad.filter(r => r.status === 'failed').length} 个回退原文, ${badOk} 个 ok（应只有无占位符的单元）`);
}

// 校验器单测
const v = validateRewrite('第一行⟦0⟧\n- 第二行⟦1⟧', '一行改⟦1⟧\n- 二行⟦0⟧');
check(!v.ok, '顺序调换应报错');
check(validateRewrite('一二三四五六七八九十⟦0⟧', '一二三四五六七八九十十⟦0⟧').ok, '正常改写应通过');
// 宏边界：文字从宏值里挪到 }} 后面应报错
{
    const toks = ['{{setvar::zn::', '}}\n<sese_guide>'];
    const hard = { size: 1, has: (id) => /\{\{|\}\}/.test(toks[id]) };
    check(!validateRewrite('⟦0⟧并同时对照⟦1⟧', '⟦0⟧，同时拿⟦1⟧作对照', { hard }).ok, '跨宏边界挪动文字应报错');
    check(validateRewrite('⟦0⟧并同时对照一下⟦1⟧', '⟦0⟧也一并比对一下⟦1⟧', { hard }).ok, '宏内正常改写应通过');
}
// 代词不进名称表；名字被换成代词要报错
{
    const { map, dropped } = sanitizeNameMap(parseNameMap('泉此方=伊蕾娜\n小此=伊蕾娜|我\n咱=我\nMaster=用户'));
    check(dropped.length === 2 && map.find(x => x.from === '小此').to.join() === '伊蕾娜' && !map.find(x => x.from === '咱'), `代词过滤不对：${JSON.stringify(dropped)}`);
    const names = ['伊蕾娜', '用户'];
    check(!validateRewrite('用户把权限交给伊蕾娜，伊蕾娜要回报用户的信任。', '我把权限交给你，你也要回报我的信任呢。', { names }).ok, '名字换成代词应报错');
    check(validateRewrite('用户把权限交给伊蕾娜，伊蕾娜要回报用户的信任。', '用户把这份权限托付给伊蕾娜，伊蕾娜也得对得起用户的信任呢。', { names }).ok, '保留名字的改写应通过');
    const withGeneric = [...names, '主人', '旅伴'];
    check(validateRewrite('用户把权限交给伊蕾娜，伊蕾娜要回报用户的信任。', '旅伴把这份权限托付给伊蕾娜，伊蕾娜也得对得起主人的信任呢。', { names: withGeneric }).ok, '换成泛称应通过');
}
console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
process.exit(failed ? 1 : 0);
