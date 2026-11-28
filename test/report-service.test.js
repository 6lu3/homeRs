// 周报整理服务测试：node test/report-service.test.js
// 全部离线：假的 fetch、临时目录、可控的时钟。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReportService, ReportError } = require('../lib/report-service');
const { buildPrompt, promptHash } = require('../lib/report-ai');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const KEY = 'sk-secret-123';
const SECRET_WORDS = '某机密项目的联调';       // 提示词里的内容，日志里不应出现
const PROMPT = buildPrompt({ weekLabel: '11.23-11.28', entries: [{ date: '2026-11-24', text: SECRET_WORDS }], doneTodos: [], openTodos: [], examples: ['示例'] });
const HASH = promptHash(PROMPT);
const baseCfg = (over = {}) => ({ enabled: true, url: 'https://p/x', key: KEY, model: 'm', format: 'openai', extra: {}, timeoutSec: 90, dailyLimit: 20, problem: '', ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'report-svc-'));
const DRAFT = { items: [{ title: '甲', lines: ['做了 x'], progress: 80.4 }], issues: '', plan: ['下周做 y'] };
const NORMAL = { items: [{ title: '甲', lines: ['做了 x'], progress: 80 }], issues: '无', plan: ['下周做 y'] };
const okReply = obj => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const openai = text => okReply({ choices: [{ message: { content: text } }] });
const httpReply = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const fails = async p => { try { await p; return null; } catch (e) { return e; } };
const isErr = (e, status, msg) => e instanceof ReportError && e.status === status && e.message === msg;
const usageOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));

function mk({ cfg = baseCfg(), dir = tmp(), fetchImpl, today = () => '2026-11-28' } = {}) {
  const calls = [], logs = [];
  const f = fetchImpl || (async () => openai(JSON.stringify(DRAFT)));
  const svc = createReportService({
    getConfig: () => cfg, dataDir: dir,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return f(url, init); },
    today, log: (...a) => logs.push(a.join(' ')),
  });
  return { svc, calls, logs, dir };
}
const gen = (m, over = {}) => m.svc.generate({ prompt: PROMPT, hash: HASH, ...over });
const leaks = m => [KEY, SECRET_WORDS, '做了 x'].some(s => m.logs.join('\n').includes(s));

(async () => {
  const keepAlive = setInterval(() => {}, 1000);   // AbortSignal.timeout 的定时器不让进程保活，测试里自己保活

  { const m = mk(); check('status：可用', m.svc.status().enabled === true); }
  { const m = mk({ cfg: baseCfg({ enabled: false, url: '', key: '', model: '' }) });
    check('status：未配置', m.svc.status().enabled === false);
    const e = await fails(gen(m));
    check('未配置 ⇒ 503，没有调用 fetch', isErr(e, 503, '周报整理未配置') && m.calls.length === 0);
  }

  { const m = mk();
    const e = await fails(gen(m, { hash: 'x'.repeat(32) }));
    check('指纹不一致 ⇒ 409，没有调用 fetch', isErr(e, 409, '内容在预览之后有变化，请重新预览') && m.calls.length === 0);
    check('指纹不一致不占用次数', !fs.existsSync(path.join(m.dir, 'usage.json')) || usageOf(m.dir).count === 0);
    const e2 = await fails(m.svc.generate({ prompt: PROMPT + '多了一个字', hash: HASH }));
    check('提示词变了而指纹是旧的 ⇒ 409', isErr(e2, 409, '内容在预览之后有变化，请重新预览') && m.calls.length === 0);
    const d = await gen(m);
    check('指纹一致 ⇒ 调用一次并返回规整后的草稿（完成度取整、issues 缺省为「无」）', m.calls.length === 1 && JSON.stringify(d) === JSON.stringify(NORMAL));
    check('请求里带了提示词原文和 key（key 只在请求头）', m.calls[0].init.body.includes(SECRET_WORDS) && m.calls[0].init.headers.authorization === 'Bearer ' + KEY && !m.calls[0].init.body.includes(KEY));
  }

  // 三种接口格式的回复
  const text = JSON.stringify(DRAFT);
  for (const [format, body] of [
    ['openai', { choices: [{ message: { content: text } }] }],
    ['anthropic', { content: [{ type: 'text', text }] }],
    ['responses', { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }],
  ]) {
    const m = mk({ cfg: baseCfg({ format }), fetchImpl: async () => okReply(body) });
    const d = await gen(m);
    check(`格式 ${format}：能读出草稿`, JSON.stringify(d) === JSON.stringify(NORMAL));
  }

  // 回复读不懂
  for (const [name, f] of [
    ['回复不是 JSON 文字', async () => openai('我觉得这周还不错')],
    ['items 为空', async () => openai('{"items":[]}')],
    ['HTTP 响应体本身不是 JSON', async () => ({ ok: true, status: 200, text: async () => '<html>' })],
    ['空回复', async () => okReply({ choices: [] })],
  ]) {
    const m = mk({ fetchImpl: f });
    const e = await fails(gen(m));
    check(`${name} ⇒ 502 固定文案`, isErr(e, 502, 'AI 返回了无法理解的内容，请重试'));
  }

  // 并发：同一时间只处理一个
  { let release; const gate = new Promise(r => { release = r; });
    const m = mk({ fetchImpl: async () => { await gate; return openai(JSON.stringify(DRAFT)); } });
    const first = gen(m);
    const e = await fails(gen(m));
    check('正在整理时再来一个 ⇒ 429', isErr(e, 429, '正在整理上一份，请稍等'));
    release(); await first;
    check('第一个结束后又可以了（busy 被复位）', (await gen(m)).items.length === 1);
  }
  { const m2 = mk({ fetchImpl: async () => { throw new Error('boom'); } });
    const e1 = await fails(gen(m2)), e2 = await fails(gen(m2));
    check('失败后 busy 也会复位（第二次仍是 502，不是 429）', e1 && e2 && e1.status === 502 && e2.status === 502);
  }

  // 每日限额：持久化、跨天归零
  { const dir = tmp(); let day = '2026-11-28';
    const cfg = baseCfg({ dailyLimit: 2 });
    const a = mk({ cfg, dir, today: () => day });
    await gen(a); await gen(a);
    const e3 = await fails(gen(a));
    check('第三次 ⇒ 429，没有调用 fetch', isErr(e3, 429, '今天的整理次数用完了') && a.calls.length === 2);
    check('用量文件记了 2 次', usageOf(dir).count === 2 && usageOf(dir).date === '2026-11-28');
    const b = mk({ cfg, dir, today: () => day });          // 模拟服务重启
    check('重启后继续计数（不会清零）', isErr(await fails(gen(b)), 429, '今天的整理次数用完了') && b.calls.length === 0);
    day = '2026-11-29';
    check('跨天后归零', (await gen(a)).items.length === 1);
  }
  { const m = mk({ cfg: baseCfg({ dailyLimit: 0 }) });
    for (let i = 0; i < 5; i++) await gen(m);
    check('dailyLimit 为 0 表示不限', m.calls.length === 5);
  }

  // 上游错误：固定中文文案，不泄露 key
  for (const [name, f, status, msg] of [
    ['上游 401', async () => httpReply(401, KEY), 502, '识别服务拒绝了请求，请检查服务器上的 key'],
    ['上游 500', async () => httpReply(500, SECRET_WORDS), 502, '识别服务出错（HTTP 500），请稍后再试'],
    ['网络错误', async () => { throw new Error('connect ECONNREFUSED ' + KEY); }, 502, '连不上识别服务，请稍后再试'],
    ['超时', async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, 504, '识别超时'],
  ]) {
    const m = mk({ fetchImpl: f });
    const e = await fails(gen(m));
    check(`${name} ⇒ ${status}「${msg}」`, isErr(e, status, msg));
    check(`${name}：错误消息和日志里没有 key、提示词内容`, !e.message.includes(KEY) && !leaks(m));
  }
  { const huge = { ok: true, status: 200, headers: { get: () => String(3 * 1024 * 1024) }, body: null, text: async () => 'x' };
    const m = mk({ fetchImpl: async () => huge });
    check('响应超过 2 MiB ⇒ 502「没有读懂 AI 的回复，请重试」', isErr(await fails(gen(m)), 502, '没有读懂 AI 的回复，请重试'));
  }

  // 日志
  { const m = mk();
    await gen(m);
    await fails(gen(m, { hash: 'bad' }));
    check('正常调用和 409 之后，日志里没有提示词内容、回复内容和 key', !leaks(m));
  }

  clearInterval(keepAlive);
  console.log(`\n${pass} 通过，${fail} 失败`);
  if (fail) process.exit(1);
})();
