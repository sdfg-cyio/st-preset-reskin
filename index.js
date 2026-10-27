// 预设换皮（Preset Reskin）：让 AI 把聊天补全预设的文字换一种说法，功能、宏、标签、正则全部保留
import {
    buildUnits, assemblePreset, diffStructure, collectProtected, buildLiteralRe, maskText,
    fillerScore, FILLER_NAME_HINT, parseNameMap, nameMapConflicts, sanitizeNameMap, TOP_LEVEL_FIELDS,
} from './lib/core.js';
import { runReskin, buildAnalyzePrompt, parseAnalyzeResult, sampleText } from './lib/pipeline.js';
import { makeCaller, listModels } from './lib/llm.js';

const MODULE = 'presetReskin';
const BASE = new URL('.', import.meta.url).href;
const ctx = () => SillyTavern.getContext();

const DEFAULTS = {
    source: 'main', url: '', key: '', saveKey: false, model: '', temperature: 0.9,
    thinking: 'off', concurrency: 6, retries: 2, chunkSize: 4000, batchSize: 4000,
    direction: '', userCall: '', mode: 'persona', intensity: 'normal', nameMap: '', styleCard: '', extraKeep: '', extraKill: '',
};

// 本次会话状态
const state = {
    preset: null, presetName: '', units: [], filler: new Set(), results: null,
    books: null, signal: { aborted: false }, running: false,
};

function settings() {
    const es = ctx().extensionSettings;
    es[MODULE] = Object.assign({}, DEFAULTS, es[MODULE] || {});
    return es[MODULE];
}

function save() {
    const s = settings();
    if (!s.saveKey) s.key = '';
    ctx().saveSettingsDebounced();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $p = (sel) => $(`.prs-root ${sel}`);

function log(msg, cls = '') {
    const t = new Date().toLocaleTimeString();
    $p('#prs-log').append(`<div class="${cls}">[${t}] ${esc(msg)}</div>`);
    const el = $p('#prs-log')[0];
    if (el) el.scrollTop = el.scrollHeight;
}

/* ---------------- 书库 ---------------- */

async function loadBooks() {
    if (state.books) return state.books;
    const get = async (f) => {
        const r = await fetch(`${BASE}books/${f}`, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`${f} 返回 ${r.status}`);
        return r;
    };
    const idx = await (await get('index.json')).json();
    if (!Array.isArray(idx) || !idx.length) throw new Error('index.json 为空');
    state.books = await Promise.all(idx.map(async (b) => {
        const txt = await (await get(b.file)).text();
        return { ...b, paragraphs: txt.split(/\n\n+/).filter(Boolean), enabled: true };
    }));
    return state.books;
}

function renderBooks() {
    const html = (state.books || []).map((b, i) =>
        `<label class="prs-chip" title="${b.chars} 字"><input type="checkbox" data-book="${i}" ${b.enabled ? 'checked' : ''}> ${esc(b.title)}</label>`).join('');
    $p('#prs-books').html(html || '<span class="prs-warn">书库加载失败</span>');
}

/* ---------------- 预设读取 ---------------- */

function openaiPresets() {
    const pm = ctx().getPresetManager('openai');
    const { presets, preset_names } = pm.getPresetList();
    const names = Array.isArray(preset_names) ? preset_names : Object.keys(preset_names);
    return { pm, presets, preset_names, names };
}

function getPresetByName(name) {
    const { presets, preset_names } = openaiPresets();
    const idx = Array.isArray(preset_names) ? preset_names.indexOf(name) : preset_names[name];
    const p = presets[idx];
    if (!p) throw new Error(`找不到预设：${name}`);
    return JSON.parse(JSON.stringify(p));
}

function fillPresetSelect() {
    const { names, pm } = openaiPresets();
    const cur = pm.getSelectedPresetName();
    $p('#prs-src').html(names.map(n => `<option value="${esc(n)}" ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join(''));
}

/**
 * 读取要换皮的预设。选的是当前正在用的预设时，取界面上的实时状态（包括没点保存的开关、顺序和内容），
 * 否则读已保存的版本。
 */
async function loadPresetForReskin(name) {
    const saved = getPresetByName(name);
    const { pm } = openaiPresets();
    if (name !== pm.getSelectedPresetName()) return { preset: saved, note: `读取的是「${name}」已保存的版本（它不是当前正在用的预设）。` };
    let live = null;
    try {
        // 酒馆自己“保存预设”时用的同一个函数，字段最全
        const mod = await import(new URL('../../../openai.js', BASE).href);
        if (typeof mod.getChatCompletionPreset === 'function') live = mod.getChatCompletionPreset();
    } catch (e) { console.warn('[预设换皮] 取实时预设失败，改用手动合并', e); }
    if (!live) {
        // 退路：只合并会被用户在界面上改动的字段
        const cs = ctx().chatCompletionSettings || {};
        live = { ...saved };
        for (const k of ['prompts', 'prompt_order', 'extensions', ...TOP_LEVEL_FIELDS]) if (cs[k] !== undefined) live[k] = JSON.parse(JSON.stringify(cs[k]));
    }
    live = JSON.parse(JSON.stringify(live));
    if (!Array.isArray(live.prompts)) return { preset: saved, note: '没取到实时状态，读取的是已保存的版本。' };
    // 统计没保存的改动，告诉用户
    const diff = [];
    const sOrder = JSON.stringify(saved.prompt_order ?? null); const lOrder = JSON.stringify(live.prompt_order ?? null);
    if (sOrder !== lOrder) diff.push('模块开关或顺序');
    const sp = new Map((saved.prompts || []).map(p => [p.identifier, p.content]));
    const changed = live.prompts.filter(p => sp.has(p.identifier) && sp.get(p.identifier) !== p.content).length;
    const added = live.prompts.filter(p => !sp.has(p.identifier)).length;
    if (changed) diff.push(`${changed} 个模块的内容`);
    if (added) diff.push(`${added} 个新模块`);
    if (JSON.stringify(saved.extensions?.regex_scripts ?? null) !== JSON.stringify(live.extensions?.regex_scripts ?? null)) diff.push('预设正则');
    return { preset: live, note: diff.length ? `「${name}」是当前正在用的预设，已按界面上的实时状态读取：包含没保存的${diff.join('、')}。` : `「${name}」是当前正在用的预设，界面状态和已保存的一致。` };
}

function setPreset(preset, name) {
    if (!preset || !Array.isArray(preset.prompts)) throw new Error('不是聊天补全预设（缺少 prompts）');
    state.preset = preset;
    state.presetName = name;
    state.results = null;
    state.units = buildUnits(preset).map(u => ({ ...u, selected: !u.skip }));
    const prot = collectProtected(preset);
    const re = buildLiteralRe(prot.literals);
    state.filler = new Set();
    for (const u of state.units) {
        if (u.skip) continue;
        u.fill = fillerScore(maskText(u.original, re).masked);
        if (u.fill.candidate && FILLER_NAME_HINT.test(u.label)) state.filler.add(u.uid);
    }
    state.protected = prot;
    const scripts = preset.extensions?.tavern_helper?.scripts?.length || 0;
    $p('#prs-stats').html(`模块 ${preset.prompts.length} 个，可改写 ${state.units.filter(u => !u.skip).length} 个；正则 ${prot.regexCount} 条，`
        + `从正则里锁定字面量 ${prot.literals.length} 个；酒馆助手脚本 ${scripts} 个（原样保留）`
        + (prot.killWords.length ? `；预设自带杀词：${esc(prot.killWords.join('、'))}` : ''));
    $p('#prs-outname').val(`${name}_reskin`);
    renderUnits();
    renderResults();
    checkConflicts();
    log(`已载入预设：${name}`);
}

function renderUnits() {
    const rows = state.units.map((u, i) => {
        const len = u.original.length;
        const fill = u.fill?.candidate
            ? `<label class="prs-fill" title="长纯文本 ${u.fill.chars} 字，占比 ${Math.round(u.fill.ratio * 100)}%"><input type="checkbox" data-fill="${u.uid}" ${state.filler.has(u.uid) ? 'checked' : ''}> 填充</label>`
            : '';
        return `<div class="prs-unit ${u.skip ? 'prs-dim' : ''}">
            <label><input type="checkbox" data-unit="${i}" ${u.selected ? 'checked' : ''} ${u.skip ? 'disabled' : ''}> ${esc(u.label)}</label>
            <span class="prs-note">${u.skip ? `跳过：${u.skip}` : `${len} 字`}</span>${fill}
            <details><summary>预览</summary><pre>${esc(u.original.slice(0, 1500))}${len > 1500 ? '\n…' : ''}</pre></details>
        </div>`;
    });
    $p('#prs-units').html(rows.join('') || '<div class="prs-note">先载入预设</div>');
}

function checkConflicts() {
    const lits = [...(state.protected?.literals || []), ...lines($p('#prs-keep').val())];
    const parsed = parseNameMap($p('#prs-namemap').val());
    const c = nameMapConflicts(parsed, lits);
    const { dropped } = sanitizeNameMap(parsed);
    const msg = [];
    if (dropped.length) msg.push(`名称表里有代词，运行时会跳过：${dropped.join('、')}。代词机械替换会把“谁对谁说”弄乱；自称怎么写请放进风格卡，交给 AI 按上下文处理。`);
    if (c.length) msg.push(`注意：${c.join('、')} 出现在预设正则要匹配的字面量里，这些位置不会被替换（替换会让正则失效）。`);
    $p('#prs-conflict').html(msg.map(m => `<div>${esc(m)}</div>`).join(''));
}

const lines = (s) => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);

/* ---------------- 表单 ↔ 设置 ---------------- */

function readForm() {
    const s = settings();
    Object.assign(s, {
        source: $p('input[name="prs-source"]:checked').val() || 'main',
        url: $p('#prs-url').val().trim(), key: $p('#prs-key').val().trim(), saveKey: $p('#prs-save-key').prop('checked'),
        model: $p('#prs-model').val().trim(), temperature: Number($p('#prs-temp').val()), thinking: $p('#prs-thinking').val(),
        concurrency: Math.max(1, Number($p('#prs-conc').val()) || 1), retries: Math.max(0, Number($p('#prs-retry').val()) || 0),
        chunkSize: Math.max(500, Number($p('#prs-chunk').val()) || 4000),
        batchSize: Math.max(0, Number($p('#prs-batch').val()) || 0),
        direction: $p('#prs-direction').val(), userCall: $p('#prs-usercall').val().trim(), mode: $p('#prs-mode').val(), intensity: $p('#prs-intensity').val(), nameMap: $p('#prs-namemap').val(),
        styleCard: $p('#prs-style').val(), extraKeep: $p('#prs-keep').val(), extraKill: $p('#prs-kill').val(),
    });
    // Key 不勾记住时只留在内存里
    state.key = s.key;
    save();
    return { ...s, key: state.key };
}

function writeForm() {
    const s = settings();
    $p(`input[name="prs-source"][value="${s.source}"]`).prop('checked', true);
    $p('#prs-url').val(s.url); $p('#prs-key').val(s.key || state.key || ''); $p('#prs-save-key').prop('checked', s.saveKey);
    $p('#prs-model').val(s.model); $p('#prs-temp').val(s.temperature); $p('#prs-thinking').val(s.thinking); $p('#prs-conc').val(s.concurrency);
    $p('#prs-retry').val(s.retries); $p('#prs-chunk').val(s.chunkSize); $p('#prs-batch').val(s.batchSize);
    $p('#prs-direction').val(s.direction); $p('#prs-usercall').val(s.userCall); $p('#prs-mode').val(s.mode); $p('#prs-intensity').val(s.intensity); $p('#prs-namemap').val(s.nameMap);
    $p('#prs-style').val(s.styleCard); $p('#prs-keep').val(s.extraKeep); $p('#prs-kill').val(s.extraKill);
    $p('#prs-custom').toggle(s.source === 'custom');
}

function caller(cfg) {
    if (cfg.source === 'custom' && (!cfg.url || !cfg.model)) throw new Error('独立接口需要填写地址和模型');
    return makeCaller({ ...cfg, maxTokens: 0 }, ctx);
}

/* ---------------- 分析 / 运行 ---------------- */

/** 按钮进入忙碌状态：图标换成转圈、显示已等待秒数、禁止重复点击；返回结束函数 */
function busy(sel, text) {
    const $b = $p(sel);
    const html = $b.html();
    const t0 = Date.now();
    const draw = () => $b.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${esc(text)} ${Math.floor((Date.now() - t0) / 1000)}s`);
    draw();
    $b.addClass('prs-busy').attr('aria-busy', 'true');
    const timer = setInterval(draw, 1000);
    return () => { clearInterval(timer); $b.html(html).removeClass('prs-busy').removeAttr('aria-busy'); };
}

async function onAnalyze() {
    if (!state.preset) return toastr.warning('先载入预设');
    if ($p('#prs-analyze').hasClass('prs-busy')) return;
    const cfg = readForm();
    const { system, user } = buildAnalyzePrompt(sampleText(state.preset, state.units), cfg.direction, cfg.userCall);
    log('正在让 AI 分析预设…');
    const done = busy('#prs-analyze', '分析中…');
    try {
        const r = parseAnalyzeResult(await caller(cfg)(system, user));
        $p('#prs-mode').val(r.type);
        if (r.name_map) $p('#prs-namemap').val(r.name_map);
        if (r.style_card) $p('#prs-style').val(r.style_card);
        // 新角色作品里的其他人物名放进禁用词，防止被拿来称呼用户
        if (r.avoid_names.length) {
            const cur = lines($p('#prs-kill').val());
            $p('#prs-kill').val([...new Set([...cur, ...r.avoid_names])].join('\n'));
        }
        readForm();
        checkConflicts();
        log(`分析完成：${r.type === 'persona' ? '人物扮演类' : '直接破限类'}；原人格：${r.personas.join('、') || '无'}。可以手动修改名称表和风格卡。`, 'prs-ok');
    } catch (e) {
        log(`分析失败：${e.message}`, 'prs-err');
    } finally {
        done();
    }
}

async function onRun() {
    if (state.running) return;
    if (!state.preset) return toastr.warning('先载入预设');
    const cfg = readForm();
    const units = state.units.filter(u => u.selected && !u.skip);
    if (!units.length) return toastr.warning('没有勾选模块');
    let callLLM;
    try { callLLM = caller(cfg); } catch (e) { return toastr.error(e.message); }
    const books = (state.books || []).filter(b => b.enabled);
    if (state.filler.size && !books.length) log('勾选了填充但书库为空，跳过填充', 'prs-err');

    state.running = true;
    const doneBusy = busy('#prs-run', '改写中…');
    state.signal = { aborted: false };
    $p('#prs-progress').attr({ value: 0, max: units.length });
    log(`开始改写 ${units.length} 个模块（并发 ${cfg.concurrency}）`);
    try {
        state.results = await runReskin({
            preset: state.preset, units, callLLM, signal: state.signal,
            options: {
                mode: cfg.mode, intensity: cfg.intensity, userCall: cfg.userCall, styleCard: cfg.styleCard, nameMapText: cfg.nameMap,
                extraKeep: lines(cfg.extraKeep), extraKill: lines(cfg.extraKill),
                fillerUids: state.filler, books, retries: cfg.retries, concurrency: cfg.concurrency, chunkSize: cfg.chunkSize, batchSize: cfg.batchSize,
            },
            onProgress: ({ done, total, result, stage }) => {
                if (stage) return log(stage);
                $p('#prs-progress').attr('value', done);
                $p('#prs-progress-text').text(`${done}/${total}`);
                const bad = result.status === 'failed' || result.status === 'partial';
                log(`${statusText(result.status)}：${result.label}${result.notes.length ? ' — ' + result.notes.join('；') : ''}`, bad ? 'prs-err' : '');
            },
        });
        const n = (s) => state.results.filter(r => r.status === s).length;
        log(`完成：成功 ${n('ok')}，部分 ${n('partial')}，失败保留原文 ${n('failed')}，仅替换名称 ${n('mapped')}，无需改动 ${n('unchanged')}`, 'prs-ok');
    } catch (e) {
        log(`运行出错：${e.message}`, 'prs-err');
    } finally {
        state.running = false;
        doneBusy();
        renderResults();
    }
}

const statusText = (s) => ({ ok: '已改写', partial: '部分改写', failed: '保留原文', mapped: '仅替换名称', unchanged: '无需改动' }[s] || s);

function renderResults() {
    const rs = (state.results || []).filter(r => r.status !== 'unchanged');
    $p('#prs-results').html(rs.map((r) => `<div class="prs-unit prs-st-${r.status}">
        <label><input type="checkbox" data-accept="${r.uid}" ${r.accepted ? 'checked' : ''}> ${esc(r.label)}</label>
        <span class="prs-badge">${statusText(r.status)}</span>
        <details><summary>对照</summary><div class="prs-cmp"><pre>${esc(r.original)}</pre><pre>${esc(r.output)}</pre></div></details>
    </div>`).join('') || '<div class="prs-note">还没有结果</div>');
}

function buildOutput() {
    if (!state.results) throw new Error('还没有改写结果');
    const out = assemblePreset(state.preset, state.results);
    if (!diffStructure(state.preset, out)) throw new Error('结构校验失败：除文字外有字段被改动，已中止');
    return out;
}

async function onSave() {
    try {
        const out = buildOutput();
        const name = String($p('#prs-outname').val() || '').trim();
        if (!name) return toastr.warning('填写新预设名');
        const { pm, names } = openaiPresets();
        if (names.includes(name)) {
            const ok = await ctx().callGenericPopup(`预设「${esc(name)}」已存在，覆盖吗？`, ctx().POPUP_TYPE.CONFIRM);
            if (!ok) return;
        }
        await pm.savePreset(name, out);
        toastr.success(`已保存为预设：${name}`);
        log(`已保存：${name}`, 'prs-ok');
    } catch (e) { toastr.error(e.message); }
}

function onDownload() {
    try {
        const out = buildOutput();
        const name = String($p('#prs-outname').val() || 'reskin').trim();
        const blob = new Blob([JSON.stringify(out, null, 4)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${name}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toastr.error(e.message); }
}

/* ---------------- 弹窗 ---------------- */

function bindEvents(root) {
    root.on('change', 'input[name="prs-source"]', () => { $p('#prs-custom').toggle(readForm().source === 'custom'); });
    root.on('change', 'input.text_pole, textarea, select:not(#prs-src), #prs-save-key', () => { readForm(); checkConflicts(); });
    root.on('click', '#prs-load', () => {
        const name = $p('#prs-src').val();
        loadPresetForReskin(name).then(({ preset, note }) => {
            setPreset(preset, name);
            if (note) $p('#prs-stats').append(`<div class="prs-note">${esc(note)}</div>`);
            if (note) log(note);
        }).catch((e) => toastr.error(e.message));
    });
    root.on('change', '#prs-file', async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        try { setPreset(JSON.parse(await f.text()), f.name.replace(/\.json$/i, '')); } catch (err) { toastr.error(`导入失败：${err.message}`); }
        e.target.value = '';
    });
    root.on('click', '#prs-fetch-models', async () => {
        const cfg = readForm();
        try {
            const ms = await listModels(cfg.url, cfg.key);
            $p('#prs-models').html(ms.map(m => `<option value="${esc(m)}">`).join(''));
            toastr.success(`获取到 ${ms.length} 个模型`);
        } catch (e) { toastr.error(e.message); }
    });
    root.on('change', '[data-unit]', (e) => { state.units[Number(e.target.dataset.unit)].selected = e.target.checked; });
    root.on('change', '[data-fill]', (e) => {
        const id = e.target.dataset.fill;
        if (e.target.checked) state.filler.add(id); else state.filler.delete(id);
    });
    root.on('change', '[data-book]', (e) => { state.books[Number(e.target.dataset.book)].enabled = e.target.checked; });
    root.on('change', '[data-accept]', (e) => {
        const r = state.results.find(x => x.uid === e.target.dataset.accept);
        if (r) r.accepted = e.target.checked;
    });
    root.on('click', '#prs-sel-all', () => { state.units.forEach(u => { u.selected = !u.skip; }); renderUnits(); });
    root.on('click', '#prs-sel-none', () => { state.units.forEach(u => { u.selected = false; }); renderUnits(); });
    root.on('click', '#prs-analyze', onAnalyze);
    root.on('click', '#prs-run', onRun);
    root.on('click', '#prs-stop', () => { state.signal.aborted = true; log('已请求停止，进行中的请求结束后停下'); });
    root.on('click', '#prs-save', onSave);
    root.on('click', '#prs-download', onDownload);
}

async function openTool() {
    const html = await (await fetch(`${BASE}template.html`, { cache: 'no-cache' })).text();
    const root = $(html);
    bindEvents(root);
    const popup = ctx().callGenericPopup(root, ctx().POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '关闭' });
    writeForm();
    try { fillPresetSelect(); } catch (e) { log(`读取预设列表失败：${e.message}`, 'prs-err'); }
    checkConflicts();
    $p('#prs-books').html('<span class="prs-note">加载中…</span>');
    loadBooks().then(renderBooks).catch((e) => {
        console.error('[预设换皮] 书库加载失败', e);
        state.books = null;
        $p('#prs-books').html(`<span class="prs-warn">书库加载失败：${esc(e.message)}（地址 ${esc(BASE)}books/）</span>`);
    });
    if (state.preset) {
        const keep = state.results;
        setPreset(state.preset, state.presetName);
        state.results = keep;
        renderResults();
    } else renderUnits();
    await popup;
    state.signal.aborted = true;
}

jQuery(() => {
    settings();
    const panel = $(`<div class="prs-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>预设换皮</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <div class="prs-note">把聊天补全预设的文字交给 AI 换一种说法，宏、标签、正则和脚本原样保留，另存为新预设。</div>
                <div id="prs-open" class="menu_button"><i class="fa-solid fa-shirt"></i> 打开预设换皮</div>
            </div>
        </div></div>`);
    panel.on('click', '#prs-open', openTool);
    $('#extensions_settings2').append(panel);
});
