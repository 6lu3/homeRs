// 识别服务回归测试：node test/receipt-service.test.js
// 全部离线：假的 fetch、临时目录、可控的时钟。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReceiptService, ReceiptError } = require('../lib/receipt-service');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const KEY = 'sk-secret-123';
const UNREADABLE = '识别服务返回了无法理解的内容，请重拍或手动录入';
const IMG = Buffer.from('abc');
const baseCfg = (over = {}) => ({ enabled: true, url: 'https://p/x', key: KEY, model: 'm', format: 'openai', extra: {}, timeoutSec: 60, dailyLimit: 30, problem: '', ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'));
const okReply = obj => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const content = c => okReply({ choices: [{ message: { content: c } }] });
const reply = (items, store = '') => content(JSON.stringify({ store, items }));
const httpReply = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const usageOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'receipt-usage.json'), 'utf8'));
const fails = async p => { try { await p; return null; } catch (e) { return e; } };
const isErr = (e, status, msg) => e instanceof ReceiptError && e.status === status && e.message === msg;
const counter = () => { let n = 0; return () => reply([{ name: '商品' + (n++), quantity: 1, unit: '个' }]); };

function mk({ cfg = baseCfg(), stock = [], dir = tmp(), fetchImpl, today = () => '2026-11-24', nowMs = () => 1_700_000_000_000 } = {}) {
  const calls = [], logs = [];
  const f = fetchImpl || (async () => reply([{ name: '豆腐', quantity: 1, unit: '盒' }]));
  const svc = createReceiptService({
    getConfig: () => cfg, getStock: () => stock, dataDir: dir,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return f(url, init); },
    today, nowMs, log: (...a) => logs.push(a.join(' ')),
  });
  return { svc, calls, logs, dir };
}
const leaks = (m, extra = []) => [KEY, ...extra].some(s => m.logs.join('\n').includes(s));

(async () => {
  // AbortSignal.timeout 的定时器不会让进程保持运行；真实服务器有 HTTP 监听所以没问题，测试里要自己保活
  const keepAlive = setInterval(() => {}, 1000);
  try {
  {
    const m = mk({ cfg: baseCfg({ enabled: false }) });
    const e = await fails(m.svc.scan(IMG, 'image/jpeg'));
    check('未配置：status 为 enabled:false', JSON.stringify(m.svc.status()) === '{"enabled":false}');
    check('未配置：scan 抛 503「识别服务未配置」', isErr(e, 503, '识别服务未配置'));
    check('未配置：没有转发、没有写用量文件', m.calls.length === 0 && !fs.existsSync(path.join(m.dir, 'receipt-usage.json')));
  }

  // ---------- 成功（openai） ----------
  {
    const stock = [{ id: 1, name: '豆腐', quantity: 2, unit: '盒', category: '食品', location_id: null, location_path: '' }];
    const m = mk({ stock, fetchImpl: async () => reply([{ name: '大娃娃菜 500g', quantity: 1, unit: '份' }, { name: '豆腐', quantity: 2, unit: '盒' }], '测试店') });
    const r = await m.svc.scan(IMG, 'image/jpeg');
    check('成功：status 为 enabled:true', JSON.stringify(m.svc.status()) === '{"enabled":true}');
    check('成功：返回 count、text、duplicate、意图', r.count === 2 && r.text === '小票识别：测试店，共 2 件' && r.duplicate === false && r.intents[0].action === 'add' && r.intents[1].action === 'restock');
    const c = m.calls[0];
    check('成功：恰好转发一次，带鉴权头、图片数据和超时信号', m.calls.length === 1 && c.init.method === 'POST' && c.init.headers.authorization === 'Bearer ' + KEY && c.init.body.includes('data:image/jpeg;base64,') && !!c.init.signal);
    check('成功：日志不含 key', !leaks(m));
    const m2 = mk({ fetchImpl: async () => reply([{ name: 'a', quantity: 1 }, { name: 'b', quantity: 1 }]) });
    check('成功：无店名时的标题', (await m2.svc.scan(IMG, 'image/jpeg')).text === '小票识别：共 2 件');
  }

  // ---------- 三种格式 ----------
  {
    const items = JSON.stringify({ items: [{ name: '豆腐', quantity: 1, unit: '盒' }] });
    let m = mk({ cfg: baseCfg({ format: 'anthropic' }), fetchImpl: async () => okReply({ content: [{ type: 'text', text: items }] }) });
    let r = await m.svc.scan(IMG, 'image/png');
    check('格式：anthropic 成功，且带 x-api-key', r.count === 1 && m.calls[0].init.headers['x-api-key'] === KEY);
    m = mk({ cfg: baseCfg({ format: 'responses' }), fetchImpl: async () => okReply({ output: [{ type: 'message', content: [{ type: 'output_text', text: items }] }] }) });
    r = await m.svc.scan(IMG, 'image/webp');
    check('格式：responses 成功', r.count === 1 && JSON.parse(m.calls[0].init.body).input[0].content[0].type === 'input_image');
  }

  // ---------- 用量 ----------
  {
    const dir = tmp();
    const m = mk({ dir, cfg: baseCfg({ dailyLimit: 2 }), fetchImpl: counter() });
    await m.svc.scan(IMG, 'image/jpeg'); await m.svc.scan(IMG, 'image/jpeg');
    const e = await fails(m.svc.scan(IMG, 'image/jpeg'));
    check('用量：第三次 429「今天的识别次数用完了」', isErr(e, 429, '今天的识别次数用完了'));
    const u = usageOf(dir);
    check('用量：文件记录今天已用 2 次', u.date === '2026-11-24' && u.count === 2);
    const m2 = mk({ dir, cfg: baseCfg({ dailyLimit: 2 }), fetchImpl: counter() });
    check('用量：新建服务（模拟重启）后上限仍然生效', isErr(await fails(m2.svc.scan(IMG, 'image/jpeg')), 429, '今天的识别次数用完了'));
    const m3 = mk({ dir, cfg: baseCfg({ dailyLimit: 2 }), fetchImpl: counter(), today: () => '2026-11-25' });
    await m3.svc.scan(IMG, 'image/jpeg');
    const u3 = usageOf(dir);
    check('用量：跨天自动归零', u3.date === '2026-11-25' && u3.count === 1);
    const m4 = mk({ cfg: baseCfg({ dailyLimit: 0 }), fetchImpl: counter() });
    let ok = 0; for (let i = 0; i < 5; i++) { await m4.svc.scan(IMG, 'image/jpeg'); ok++; }
    check('用量：dailyLimit 为 0 表示不限', ok === 5);
  }
  {
    const m = mk({ fetchImpl: async () => httpReply(500, 'boom') });
    await fails(m.svc.scan(IMG, 'image/jpeg'));
    check('用量：识别服务失败的调用也计数', usageOf(m.dir).count === 1);
  }
  {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'receipt-usage.json'), 'not json');
    const m = mk({ dir, cfg: baseCfg({ dailyLimit: 2 }) });
    await m.svc.scan(IMG, 'image/jpeg');
    const u = usageOf(dir);
    check('用量：文件损坏按 0 处理并被重写成合法 JSON', u.count === 1 && u.date === '2026-11-24');
    const dir2 = tmp();
    fs.writeFileSync(path.join(dir2, 'receipt-usage.json'), JSON.stringify({ date: '2026-11-23', count: 99 }));
    const m2 = mk({ dir: dir2, cfg: baseCfg({ dailyLimit: 2 }) });
    await m2.svc.scan(IMG, 'image/jpeg');
    check('用量：文件里是昨天的日期按 0 处理', usageOf(dir2).count === 1);
  }

  // ---------- 并发 ----------
  {
    let release; const gate = new Promise(r => { release = r; });
    let mode = 'gate';
    const m = mk({ fetchImpl: async () => { if (mode === 'gate') await gate; return mode === 'fail' ? httpReply(500) : reply([{ name: '豆腐', quantity: 1 }]); } });
    const p1 = m.svc.scan(IMG, 'image/jpeg');
    const e2 = await fails(m.svc.scan(IMG, 'image/jpeg'));
    check('并发：进行中再来请求立即 429，且没有再转发', isErr(e2, 429, '正在识别上一张，请稍等') && m.calls.length === 1);
    check('并发：计数在转发前就已写入，被拒的请求不计数', usageOf(m.dir).count === 1);
    release(); await p1;
    mode = 'ok';
    check('并发：完成后可以继续识别', (await m.svc.scan(IMG, 'image/jpeg')).count === 1);
    mode = 'fail';
    await fails(m.svc.scan(IMG, 'image/jpeg'));
    mode = 'ok';
    check('并发：失败之后「进行中」也被清除', (await fails(m.svc.scan(IMG, 'image/jpeg'))) === null);
  }

  // ---------- 超时与网络错误 ----------
  {
    let mode = 'hang';
    const m = mk({ cfg: baseCfg({ timeoutSec: 0.05 }), fetchImpl: (url, { signal }) => mode === 'hang'
      ? new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)))
      : Promise.resolve(reply([{ name: '豆腐', quantity: 1 }])) });
    check('超时：抛 504「识别超时」', isErr(await fails(m.svc.scan(IMG, 'image/jpeg')), 504, '识别超时'));
    mode = 'ok';
    check('超时：之后「进行中」已清除，可继续', (await fails(m.svc.scan(IMG, 'image/jpeg'))) === null);
    const n = mk({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    check('网络错误：502「连不上识别服务，请稍后再试」', isErr(await fails(n.svc.scan(IMG, 'image/jpeg')), 502, '连不上识别服务，请稍后再试'));
  }

  // ---------- 错误映射且不泄露 ----------
  {
    const body = '{"error":"bad key sk-secret-123 and header x-secret"}';
    const cases = [[401, '识别服务拒绝了请求，请检查服务器上的 key'], [403, '识别服务拒绝了请求，请检查服务器上的 key'], [500, '识别服务出错（HTTP 500），请稍后再试'], [429, '识别服务出错（HTTP 429），请稍后再试']];
    for (const [status, msg] of cases) {
      const m = mk({ cfg: baseCfg({ dailyLimit: 0 }), fetchImpl: async () => httpReply(status, body) });
      const e = await fails(m.svc.scan(IMG, 'image/jpeg'));
      check(`错误映射：HTTP ${status}`, isErr(e, 502, msg));
      check(`错误映射：HTTP ${status} 的消息和日志都不含 key 与响应原文`, ![KEY, 'bad key', 'x-secret'].some(s => e.message.includes(s)) && !leaks(m, ['bad key', 'x-secret']));
    }
  }

  // ---------- 无法理解的回复 ----------
  {
    const run = async fetchImpl => fails(mk({ fetchImpl }).svc.scan(IMG, 'image/jpeg'));
    check('无法理解：纯文字', isErr(await run(async () => content('抱歉')), 502, UNREADABLE));
    check('无法理解：缺少 items', isErr(await run(async () => content('{"store":"x"}')), 502, UNREADABLE));
    check('无法理解：items 不是数组', isErr(await run(async () => content('{"items":"no"}')), 502, UNREADABLE));
    check('无法理解：取不到回复文字', isErr(await run(async () => okReply({})), 502, UNREADABLE));
    check('无法理解：响应本身不是 JSON', isErr(await run(async () => ({ ok: true, status: 200, text: async () => 'not json at all' })), 502, UNREADABLE));
    check('无法理解：响应超过 2 MB', isErr(await run(async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(2 * 1024 * 1024 + 1) })), 502, UNREADABLE));
    const m = mk({ fetchImpl: async () => content('{"items":[]}') });
    const r = await m.svc.scan(IMG, 'image/jpeg');
    check('空商品：成功返回 0 件、空意图、非重复', r.count === 0 && r.intents.length === 0 && r.duplicate === false);
    const r2 = await m.svc.scan(IMG, 'image/jpeg');
    check('空商品：不记指纹', r2.duplicate === false);
    const f = mk({ fetchImpl: async () => content('```json\n{"items":[{"name":"豆腐","quantity":1,"unit":"盒"}]}\n```') });
    check('代码块包住的合法回复可以解析', (await f.svc.scan(IMG, 'image/jpeg')).count === 1);
  }

  // ---------- 重复检测 ----------
  {
    let t = 0, items = [{ name: '豆腐', quantity: 1, unit: '盒' }];
    const m = mk({ cfg: baseCfg({ dailyLimit: 0 }), nowMs: () => t, fetchImpl: async () => reply(items) });
    check('重复：第一次不是重复', (await m.svc.scan(IMG, 'image/jpeg')).duplicate === false);
    check('重复：相同内容第二次是重复', (await m.svc.scan(IMG, 'image/jpeg')).duplicate === true);
    items = [{ name: '豆腐', quantity: 2, unit: '盒' }];
    check('重复：数量不同不算重复', (await m.svc.scan(IMG, 'image/jpeg')).duplicate === false);
    items = [{ name: '豆腐', quantity: 1, unit: '盒' }];
    t = 49 * 3600e3 + 1;
    check('重复：超过 48 小时后不再算重复', (await m.svc.scan(IMG, 'image/jpeg')).duplicate === false);
    let n = 0;
    const m2 = mk({ cfg: baseCfg({ dailyLimit: 0 }), fetchImpl: async () => reply([{ name: '商品' + (n++), quantity: 1 }]) });
    for (let i = 0; i < 101; i++) await m2.svc.scan(IMG, 'image/jpeg');
    n = 0;
    check('重复：只保留最近 100 个，最旧的被丢弃', (await m2.svc.scan(IMG, 'image/jpeg')).duplicate === false);
    n = 100;
    check('重复：最近的仍然记得', (await m2.svc.scan(IMG, 'image/jpeg')).duplicate === true);
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  } finally { clearInterval(keepAlive); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('测试脚本自身出错：', e); process.exit(1); });
