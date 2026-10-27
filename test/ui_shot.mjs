// 用无头 Edge 打开本地酒馆，点开换皮窗口截图并收集报错（只读，不保存任何东西）
// 用法: node test/ui_shot.mjs [端口]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = process.argv[2] || '8000';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'prs-edge-'));
const out = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/(\w:)/, '$1'), 'out');
fs.mkdirSync(out, { recursive: true });
const browser = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${prof}`, '--window-size=1000,1300', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let ws;
try {
    let target;
    for (let i = 0; i < 40 && !target; i++) {
        await sleep(300);
        try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(t => t.type === 'page'); } catch { /* 还没起来 */ }
    }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
        if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
            if (/预设换皮|reskin|prs-/i.test(t)) errors.push(m.params.type + ' ' + t.slice(0, 300));
        }
        if (m.method === 'Network.loadingFailed' || (m.method === 'Network.responseReceived' && m.params.response.status >= 400 && /reskin/.test(m.params.response.url))) errors.push('NET ' + JSON.stringify(m.params).slice(0, 200));
    });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const shot = async (name) => {
        const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: false });
        fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, 'base64'));
    };
    await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    for (let i = 0; i < 60; i++) { await sleep(500); if (await evalJs(`!!document.querySelector('#prs-open')`)) break; }
    await sleep(1500);
    // 设置面板里的按钮
    await evalJs(`(() => { const d = document.querySelector('.prs-settings .inline-drawer-content'); if (d) d.style.display = 'block'; const e = document.querySelector('#extensions_settings2'); e && e.closest('.drawer-content')?.classList.add('openDrawer'); })()`);
    const btn = await evalJs(`(() => { const b = document.querySelector('#prs-open'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.width, r.height]; })()`);
    console.log('设置面板按钮尺寸', btn);
    await evalJs(`document.querySelector('#prs-open').click()`);
    for (let i = 0; i < 20; i++) { await sleep(500); if (await evalJs(`document.querySelectorAll('#prs-books .prs-chip').length`)) break; }
    console.log('书库条目', await evalJs(`document.querySelectorAll('#prs-books .prs-chip').length`), '预设选项', await evalJs(`document.querySelectorAll('#prs-src option').length`));
    // 载入第一个含 Izumi 的预设，看模块列表
    await evalJs(`(() => { const s = document.querySelector('#prs-src'); const o = [...s.options].find(o => /Izumi/i.test(o.text)) || s.options[0]; s.value = o.value; document.querySelector('#prs-load').click(); })()`);
    await sleep(1500);
    // 竖排按钮检测：高度明显大于宽度
    const tall = await evalJs(`[...document.querySelectorAll('.prs-root .menu_button')].map(b => { const r = b.getBoundingClientRect(); return [b.textContent.trim().slice(0, 8), Math.round(r.width), Math.round(r.height)]; }).filter(x => x[2] > 45)`);
    console.log('过高的按钮', JSON.stringify(tall));
    await evalJs(`(() => { const r = document.querySelector('input[name="prs-source"][value="custom"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(300);
    const lay = await evalJs(`(() => {
        const R = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
        return { model: R('#prs-model'), refresh: R('#prs-fetch-models'), saveKey: R('#prs-save-key'), saveKeyLabel: R('label.prs-check'),
            analyze: R('#prs-analyze'), mode: R('#prs-mode'), intensity: R('#prs-intensity'), outname: R('#prs-outname'), save: R('#prs-save'), dl: R('#prs-download'),
            run: R('#prs-run'), stop: R('#prs-stop'), selAll: R('#prs-sel-all'), file: R('.prs-file-btn'), load: R('#prs-load') };
    })()`);
    for (const [k, v] of Object.entries(lay)) console.log('  ', k, JSON.stringify(v));
    const sc = `document.querySelector('.prs-root').closest('.popup-content') || document.querySelector('.prs-root').parentElement`;
    for (const [i, frac] of [[1, 0], [2, 0.3], [3, 0.6], [4, 1]].map(x => x)) {
        await evalJs(`(() => { const e = ${sc}; e.scrollTop = (e.scrollHeight - e.clientHeight) * ${frac}; })()`);
        await sleep(300);
        await shot(`ui_${i}.jpg`);
    }
    console.log('报错', errors.length ? '\n  ' + errors.join('\n  ') : '无');
} finally {
    try { ws?.close(); } catch { /* 忽略 */ }
    browser.kill();
    await sleep(800);
    fs.rmSync(prof, { recursive: true, force: true });
}
