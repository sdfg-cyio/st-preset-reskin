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
    // 在内存里翻转当前预设第一个模块开关（不保存），看插件能否读到，再翻回去
    const flip = `(async () => { const m = await import('/scripts/openai.js'); const po = m.oai_settings.prompt_order; const list = po.find(x => String(x.character_id) === '100001') || po[0]; const e = list.order.find(o => o.identifier !== 'main') || list.order[0]; e.enabled = !e.enabled; return e.identifier + '=' + e.enabled; })()`;
    console.log('翻转', await evalJs(flip));
    try {
        await evalJs(`document.querySelector('#prs-open').click()`);
        for (let i = 0; i < 20; i++) { await sleep(400); if (await evalJs(`document.querySelectorAll('#prs-src option').length`)) break; }
        const cur = await evalJs(`document.querySelector('#prs-src').value`);
        await evalJs(`document.querySelector('#prs-load').click()`);
        await sleep(2500);
        console.log('当前预设', cur);
        console.log('提示:', await evalJs(`[...document.querySelectorAll('#prs-stats .prs-note')].map(e => e.textContent).join(' / ')`));
        // 再选一个别的预设看提示
        await evalJs(`(() => { const s = document.querySelector('#prs-src'); const o = [...s.options].find(o => o.value !== s.value); if (o) { s.value = o.value; document.querySelector('#prs-load').click(); } })()`);
        await sleep(2000);
        console.log('别的预设提示:', await evalJs(`[...document.querySelectorAll('#prs-stats .prs-note')].map(e => e.textContent).join(' / ')`));
    } finally {
        console.log('翻回', await evalJs(flip));
    }
    console.log('报错', errors.length ? '\n  ' + errors.join('\n  ') : '无');
} finally {
    try { ws?.close(); } catch { /* 忽略 */ }
    browser.kill();
    await sleep(800);
    fs.rmSync(prof, { recursive: true, force: true });
}
