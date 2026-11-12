// 用 Edge/Chrome 无头模式 + CDP 截图：node test/screenshot.js
// 先登录拿到会话 cookie，再以手机视口截取主要页面。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://localhost:3000';
const BROWSER = process.env.BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(__dirname, 'shots'); fs.mkdirSync(OUT, { recursive: true });
const PORT = 9333;

async function login() {
  const res = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'home1234' }) });
  return res.headers.get('set-cookie').split(';')[0].split('=')[1];
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const token = await login();
  const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--user-data-dir=' + path.join(OUT, 'profile'), 'about:blank'], { stdio: 'ignore' });
  let ws, id = 0; const pending = new Map(); const events = [];
  try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
    ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else events.push(m); };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Runtime.enable'); await send('Log.enable');
    const shot = async (name) => {
      await sleep(600);
      const { result } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.data, 'base64'));
      console.log('saved', name);
    };
    const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result; };

    const layout = async (label, selectors) => {
      const r = await evalJs(`JSON.stringify({
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        boxes: ${JSON.stringify(selectors)}.map(s => { const el = document.querySelector(s); if (!el) return [s, 'MISSING'];
          const b = el.getBoundingClientRect(); const vis = b.width > 0 && b.height > 0 && b.left >= 0 && b.right <= window.innerWidth && b.top >= 0 && b.bottom <= window.innerHeight;
          return [s, vis ? 'ok' : 'OFF', Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })
      })`);
      const d = JSON.parse(r.value);
      console.log(`[${label}] overflowX=${d.overflowX}`, d.boxes.map(b => b.join(':')).join('  '));
    };

    await send('Page.navigate', { url: BASE + '/' }); await shot('1-login');
    await layout('login', ['#login-pw', '#login-form button']);
    await send('Network.setCookie', { name: 'inv_session', value: token, url: BASE });
    await send('Page.navigate', { url: BASE + '/' }); await sleep(800); await shot('2-list');
    // 模拟不支持原生弹窗的内嵌浏览器：任何 prompt/confirm 调用都直接抛错
    await evalJs(`window.prompt = window.confirm = window.alert = () => { throw new Error('prompt() is not supported.'); }; 'patched'`);
    await layout('list', ['#q', '#filter-btn', '#stats', '.card', '.card .qty-ctl', '#add-btn', '.tabbar']);
    console.log('cards:', (await evalJs(`document.querySelectorAll('.card').length`)).value, 'badges:', (await evalJs(`[...document.querySelectorAll('.badge')].map(b=>b.textContent).join('|')`)).value);
    await evalJs(`document.querySelector('#filter-btn').click()`); await shot('3-filters');
    await layout('filters', ['#f-location', '#f-category', '#f-expiring', '#f-reset']);
    await evalJs(`document.querySelector('#filter-btn').click(); document.querySelector('.card').click()`); await shot('4-edit');
    await layout('edit', ['#ed-title', '#ed-img-area', '#ed-name', '#ed-qty', '#ed-unit', '#ed-location', '#item-form button[type=submit]']);
    console.log('edit values:', (await evalJs(`[['#ed-name','#ed-qty','#ed-unit','#ed-category','#ed-expires','#ed-note'].map(s=>document.querySelector(s).value).join('|'), document.querySelector('#ed-location').selectedOptions[0].textContent].join(' @ ')`)).value);
    await evalJs(`document.querySelector('#ed-cancel').click(); document.querySelector('[data-view=locations]').click()`); await sleep(500); await shot('5-locations');
    await layout('locations', ['#loc-add-root', '.loc-row', '.loc-row:last-child']);
    console.log('loc rows:', (await evalJs(`document.querySelectorAll('.loc-row').length`)).value);
    await evalJs(`document.querySelector('[data-view=settings]').click()`); await shot('6-settings');
    await layout('settings', ['a[href="/api/export.csv"]', '#pw-form', '#logout']);

    // 页面内对话框：位置页点「＋ 房间」→ 输入 → 保存；再点名称 → 删除 → 确认
    await evalJs(`document.querySelector('[data-view=locations]').click()`); await sleep(400);
    await evalJs(`document.querySelector('#loc-add-root').click()`); await sleep(200); await shot('10-dialog-input');
    await layout('dialog', ['#dialog-box, .dialog-box', '#dlg-input', '#dlg-buttons button[type=submit]']);
    await evalJs(`document.querySelector('#dlg-input').value = '测试房间'; document.querySelector('#dialog-form').requestSubmit()`); await sleep(600);
    console.log('room added:', (await evalJs(`[...document.querySelectorAll('.loc-row .nm')].some(n => n.textContent.includes('测试房间'))`)).value);
    await evalJs(`[...document.querySelectorAll('.loc-row')].find(r => r.textContent.includes('测试房间')).querySelector('.nm').click()`); await sleep(200);
    await evalJs(`document.querySelector('#dlg-buttons [data-value=delete]').click()`); await sleep(200); await shot('11-dialog-confirm');
    console.log('confirm text:', (await evalJs(`document.querySelector('#dlg-msg').textContent`)).value);
    await evalJs(`document.querySelector('#dialog-form').requestSubmit()`); await sleep(600);
    console.log('room deleted:', (await evalJs(`![...document.querySelectorAll('.loc-row .nm')].some(n => n.textContent.includes('测试房间'))`)).value);

    // 快速录入：一句话 → 确认卡 → 执行
    await evalJs(`document.querySelector('[data-view=items]').click()`); await sleep(300);
    await layout('quick', ['#quick-text', '#quick-form button']);
    await evalJs(`document.querySelector('#quick-text').value = '买了两盒酸奶放冷藏，保质期到12月1日'; document.querySelector('#quick-form').requestSubmit()`); await sleep(800); await shot('12-quick-confirm');
    await layout('quick-confirm', ['#cf-ok', '.cf-item', '.cf-item [data-k=name]', '.cf-item [data-k=location]']);
    console.log('confirm card:', (await evalJs(`[...document.querySelectorAll('.cf-item')].map(el => el.querySelector('.cf-act').textContent + ' ' + el.querySelector('[data-k=name]').value + ' x' + el.querySelector('[data-k=quantity]').value + el.querySelector('[data-k=unit]').value + ' @' + el.querySelector('[data-k=location]').selectedOptions[0].textContent.trim() + ' [' + el.querySelector('[data-k=category]').value + '] ' + el.querySelector('[data-k=expires_at]').value).join(' | ')`)).value);
    await evalJs(`document.querySelector('#cf-ok').click()`); await sleep(1000);
    console.log('toast:', (await evalJs(`document.querySelector('#toast').textContent`)).value);
    console.log('yogurt in list:', (await evalJs(`[...document.querySelectorAll('.card .name span:first-child')].some(n => n.textContent === '酸奶')`)).value);
    // 新位置 + 移动已有物品
    await evalJs(`document.querySelector('#quick-text').value = '把电钻放到车库的工具架上'; document.querySelector('#quick-form').requestSubmit()`); await sleep(800);
    console.log('move card:', (await evalJs(`[...document.querySelectorAll('.cf-item')].map(el => el.querySelector('.cf-act').textContent + ' ' + el.querySelector('[data-k=name]').value + ' @' + el.querySelector('[data-k=location]').selectedOptions[0].textContent.trim()).join(' | ')`)).value);
    await evalJs(`document.querySelector('#cf-ok').click()`); await sleep(1000);
    console.log('drill moved:', (await evalJs(`[...document.querySelectorAll('.card')].find(c => c.textContent.includes('电钻')).querySelector('.meta').textContent`)).value);
    // 清理
    await evalJs(`(async () => { const items = await (await fetch('/api/items')).json(); for (const i of items) if (i.name === '酸奶') await fetch('/api/items/' + i.id + '?purge=1', { method: 'DELETE' });
      const d = items.find(i => i.name === '电钻'); const locs = await (await fetch('/api/locations')).json(); const st = locs.find(l => l.name === '储物柜');
      await fetch('/api/items/' + d.id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location_id: st.id }) });
      const g = locs.find(l => l.path === '车库'); if (g) await fetch('/api/locations/' + g.id, { method: 'DELETE' }); })()`);

    // 首页仪表盘 / 购物清单 / 删除撤销（若演示物品在回收站里先恢复，并保证数量 >0）
    await evalJs(`(async () => { const h = { 'content-type': 'application/json' }; const trash = await (await fetch('/api/trash')).json(); const t = trash.find(i => i.name === '布洛芬缓释胶囊'); if (t) await fetch('/api/items/' + t.id + '/restore', { method: 'POST' }); const items = await (await fetch('/api/items')).json(); const b = items.find(i => i.name === '布洛芬缓释胶囊'); if (b) await fetch('/api/items/' + b.id, { method: 'PUT', headers: h, body: JSON.stringify({ min_quantity: 5, quantity: 1 }) }); })()`); await sleep(300);
    await evalJs(`document.querySelector('[data-view=home]').click()`); await sleep(800); await shot('13-home');
    await layout('home', ['.tiles', '.tile', '.home-list', '.home-row', '.log-row']);
    console.log('home tiles:', (await evalJs(`[...document.querySelectorAll('.tile')].map(t => t.querySelector('span').textContent + '=' + t.querySelector('b').textContent).join(', ')`)).value);
    console.log('home sections:', (await evalJs(`[...document.querySelectorAll('#home-body h3')].map(h => h.textContent).join(' | ')`)).value);
    await evalJs(`document.querySelector('.tile.low').click()`); await sleep(600); await shot('14-shopping');
    await layout('shopping', ['#shop-text', '.shop-row', '[data-bought]']);
    console.log('shopping rows:', (await evalJs(`[...document.querySelectorAll('.shop-row')].map(r => r.querySelector('.nm').textContent + ' / ' + (r.querySelector('.meta')||{}).textContent).join(' | ')`)).value);
    await evalJs(`document.querySelector('#shop-text').value = '垃圾袋'; document.querySelector('#shop-form').requestSubmit()`); await sleep(600);
    console.log('extra added:', (await evalJs(`!!document.querySelector('.shop-row[data-extra]')`)).value);
    await evalJs(`document.querySelector('[data-done]').click()`); await sleep(500);
    await evalJs(`document.querySelector('#shop-clear').click()`); await sleep(500);
    console.log('extra cleared:', (await evalJs(`!document.querySelector('.shop-row[data-extra]')`)).value);
    await evalJs(`document.querySelector('[data-bought]').click()`); await sleep(700);
    console.log('bought toast:', (await evalJs(`document.querySelector('#toast').textContent`)).value);
    // 删除 → 撤销
    await evalJs(`document.querySelector('[data-view=items]').click()`); await sleep(500);
    await evalJs(`document.querySelector('.card').click()`); await sleep(400);
    const delName = (await evalJs(`document.querySelector('#ed-name').value`)).value;
    await layout('editor-min', ['#ed-min', '#ed-log']);
    await evalJs(`document.querySelector('#ed-delete').click()`); await sleep(700); await shot('15-undo');
    await layout('undo', ['#toast', '.toast-act']);
    console.log('deleted gone:', (await evalJs(`![...document.querySelectorAll('.card .name span:first-child')].some(n => n.textContent === ${JSON.stringify(delName)})`)).value);
    await evalJs(`document.querySelector('.toast-act').click()`); await sleep(800);
    console.log('undo restored:', (await evalJs(`[...document.querySelectorAll('.card .name span:first-child')].some(n => n.textContent === ${JSON.stringify(delName)})`)).value);
    // 恢复演示数据
    await evalJs(`(async () => { const items = await (await fetch('/api/items')).json(); const b = items.find(i => i.name === '布洛芬缓释胶囊'); if (b) await fetch('/api/items/' + b.id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ min_quantity: 0, quantity: 2 }) }); })()`);

    // 图纸：先用页面里的 canvas 生成一张简易户型图并上传，再标记一个位置、点击标记
    await evalJs(`document.querySelector('[data-view=plans]').click()`); await sleep(500); await shot('7-plans-empty');
    await layout('plans-empty', ['#plan-upload', '#plan-empty']);
    await evalJs(`(async () => {
      const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 1200, 800); g.strokeStyle = '#333'; g.lineWidth = 6; g.strokeRect(40, 40, 1120, 720);
      g.beginPath(); g.moveTo(600, 40); g.lineTo(600, 760); g.moveTo(40, 400); g.lineTo(1160, 400); g.stroke();
      g.fillStyle = '#333'; g.font = '40px sans-serif'; g.fillText('客厅', 280, 230); g.fillText('厨房', 850, 230); g.fillText('卧室', 280, 600); g.fillText('卫生间', 820, 600);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      await fetch('/api/plans?name=' + encodeURIComponent('测试户型'), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
      const locs = await (await fetch('/api/locations')).json(); const plans = await (await fetch('/api/plans')).json(); const pid = plans[0].id;
      const put = (n, x, y) => fetch('/api/locations/' + locs.find(l => l.name === n).id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: pid, x, y }) });
      await put('冰箱冷冻', 75, 20); await put('衣柜', 25, 80); await put('镜柜', 75, 70);
      document.querySelector('[data-view=items]').click(); document.querySelector('[data-view=plans]').click();
    })()`);
    await sleep(1200); await shot('8-plan');
    await layout('plan', ['#plan-select', '#plan-mark', '#plan-img', '.pin', '.pin:nth-child(3)']);
    console.log('pins:', (await evalJs(`[...document.querySelectorAll('.pin')].map(p => p.textContent + '@' + p.style.left + ',' + p.style.top).join(' | ')`)).value);
    await evalJs(`const p = document.querySelector('.pin[data-id]'); const r = p.getBoundingClientRect(); const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 5, pointerId: 1, isPrimary: true }; p.dispatchEvent(new PointerEvent('pointerdown', o)); p.dispatchEvent(new PointerEvent('pointerup', o));`);
    await shot('9-pin-popup');
    await layout('pin-pop', ['#pin-pop', '#pin-pop [data-act=view]']);
    console.log('popup:', (await evalJs(`document.querySelector('#pp-name').textContent + ' / ' + document.querySelector('#pp-count').textContent`)).value);
    // 清理测试图纸
    await evalJs(`(async () => { for (const p of await (await fetch('/api/plans')).json()) if (p.name === '测试户型') await fetch('/api/plans/' + p.id, { method: 'DELETE' }); })()`);

    const errors = events.filter(m => m.method === 'Runtime.exceptionThrown' || (m.method === 'Log.entryAdded' && m.params.entry.level === 'error'));
    console.log('console errors:', errors.length, errors.map(e => JSON.stringify(e.params).slice(0, 300)));
  } finally { ws?.close(); proc.kill(); }
})().catch(e => { console.error(e); process.exit(1); });
