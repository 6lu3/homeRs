// 语音识别服务回归测试：node test/asr-service.test.js
// 全部离线：假的 fetch、临时目录、可控的时钟。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAsrService, AsrError } = require('../lib/asr-service');
const { createReceiptService } = require('../lib/receipt-service');
const { ServiceError } = require('../lib/provider-guard');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const KEY = 'sk-secret-123';
const UNREADABLE = '识别服务返回了无法理解的内容，请再说一遍';
const WAV = Buffer.from('RIFFabcd');
const baseCfg = (over = {}) => ({ enabled: true, url: 'https://p/x', key: KEY, model: 'm', format: 'responses', extra: {}, timeoutSec: 30, dailyLimit: 100, maxSeconds: 30, problem: '', ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asr-'));
const okReply = obj => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
const said = t => okReply({ output: [{ type: 'message', content: [{ type: 'output_text', text: t }] }] });
const httpReply = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const usageOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'asr-usage.json'), 'utf8'));
const fails = async p => { try { await p; return null; } catch (e) { return e; } };
const isErr = (e, status, msg) => e instanceof AsrError && e.status === status && e.message === msg;

function mk({ cfg = baseCfg(), dir = tmp(), fetchImpl, today = () => '2026-11-24' } = {}) {
  const calls = [], logs = [];
  const f = fetchImpl || (async () => said('买了两盒酸奶放冷藏'));
  const svc = createAsrService({
    getConfig: () => cfg, dataDir: dir,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return f(url, init); },
    today, log: (...a) => logs.push(a.join(' ')),
  });
  return { svc, calls, logs, dir };
}
const leaks = (m, extra = []) => [KEY, ...extra].some(s => m.logs.join('\n').includes(s));

(async () => {
  // AbortSignal.timeout 的定时器不会让进程保持运行；真实服务器有 HTTP 监听所以没问题，测试里要自己保活
  const keepAlive = setInterval(() => {}, 1000);
  try {
    // ---------- 未配置 ----------
    {
      const m = mk({ cfg: baseCfg({ enabled: false }) });
      const e = await fails(m.svc.transcribe(WAV));
      check('未配置：status 为 enabled:false 且带默认 maxSeconds', JSON.stringify(m.svc.status()) === '{"enabled":false,"maxSeconds":30}');
      check('未配置：transcribe 抛 503「语音识别未配置」', isErr(e, 503, '语音识别未配置'));
      check('未配置：没有转发、没有写用量文件', m.calls.length === 0 && !fs.existsSync(path.join(m.dir, 'asr-usage.json')));
      check('AsrError 是 ServiceError 的子类', e instanceof ServiceError);
    }

    // ---------- 成功 ----------
    {
      const m = mk({ cfg: baseCfg({ maxSeconds: 45 }), fetchImpl: async () => said('把鸡蛋放入冰箱冷藏 买了五花肉一盒') });
      const r = await m.svc.transcribe(WAV);
      check('成功：status 带配置里的 maxSeconds', JSON.stringify(m.svc.status()) === '{"enabled":true,"maxSeconds":45}');
      check('成功：返回规范化后的文字（空格变句号）', r.text === '把鸡蛋放入冰箱冷藏。买了五花肉一盒');
      const c = m.calls[0];
      check('成功：恰好转发一次，带鉴权头、音频数据和超时信号', m.calls.length === 1 && c.init.method === 'POST' && c.init.headers.authorization === 'Bearer ' + KEY && c.init.body.includes('data:audio/wav;base64,') && !!c.init.signal);
      check('成功：日志不含 key', !leaks(m));
    }

    // ---------- 空文字与无法理解 ----------
    {
      const long = Array.from({ length: 25 }, () => '买了苹果一盒放冷藏').join('。');
      const cutRes = await mk({ fetchImpl: async () => said(long) }).svc.transcribe(WAV);
      check('过长：返回截到句末的文字，并带 truncated:true', cutRes.truncated === true && cutRes.text.length <= 200 && cutRes.text.endsWith('放冷藏'));
      const okRes = await mk({ fetchImpl: async () => said('买了牛奶') }).svc.transcribe(WAV);
      check('没超长时返回里没有 truncated 键', JSON.stringify(okRes) === '{"text":"买了牛奶"}');
    }
    {
      const run = async fetchImpl => fails(mk({ fetchImpl }).svc.transcribe(WAV));
      const empty = await mk({ fetchImpl: async () => said('') }).svc.transcribe(WAV);
      check('空文字：返回 200 的 {text:""}，不是错误', JSON.stringify(empty) === '{"text":""}');
      check('无法理解：回复里没有 output', isErr(await run(async () => okReply({})), 502, UNREADABLE));
      check('无法理解：响应本身不是 JSON', isErr(await run(async () => ({ ok: true, status: 200, text: async () => 'not json at all' })), 502, UNREADABLE));
      check('无法理解：响应超过 2 MiB', isErr(await run(async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(2 * 1024 * 1024 + 1) })), 502, UNREADABLE));
    }

    // ---------- 用量 ----------
    {
      const dir = tmp();
      const m = mk({ dir, cfg: baseCfg({ dailyLimit: 2 }) });
      await m.svc.transcribe(WAV); await m.svc.transcribe(WAV);
      check('用量：第三次 429「今天的语音识别次数用完了」', isErr(await fails(m.svc.transcribe(WAV)), 429, '今天的语音识别次数用完了'));
      const u = usageOf(dir);
      check('用量：文件是 asr-usage.json，记录今天已用 2 次', u.date === '2026-11-24' && u.count === 2 && !fs.existsSync(path.join(dir, 'receipt-usage.json')));
      const m2 = mk({ dir, cfg: baseCfg({ dailyLimit: 2 }) });
      check('用量：新建服务（模拟重启）后上限仍然生效', isErr(await fails(m2.svc.transcribe(WAV)), 429, '今天的语音识别次数用完了'));
      const m3 = mk({ dir, cfg: baseCfg({ dailyLimit: 2 }), today: () => '2026-11-25' });
      await m3.svc.transcribe(WAV);
      check('用量：跨天自动归零', usageOf(dir).date === '2026-11-25' && usageOf(dir).count === 1);
      const m4 = mk({ cfg: baseCfg({ dailyLimit: 0 }) });
      let ok = 0; for (let i = 0; i < 5; i++) { await m4.svc.transcribe(WAV); ok++; }
      check('用量：dailyLimit 为 0 表示不限', ok === 5);
      const f = mk({ fetchImpl: async () => httpReply(500, 'boom') });
      await fails(f.svc.transcribe(WAV));
      check('用量：识别服务失败的调用也计数', usageOf(f.dir).count === 1);
      const dir2 = tmp(); fs.writeFileSync(path.join(dir2, 'asr-usage.json'), 'not json');
      await mk({ dir: dir2 }).svc.transcribe(WAV);
      check('用量：文件损坏按 0 处理并被重写成合法 JSON', usageOf(dir2).count === 1);
    }

    // ---------- 并发 ----------
    {
      let release; const gate = new Promise(r => { release = r; });
      let mode = 'gate';
      const m = mk({ fetchImpl: async () => { if (mode === 'gate') await gate; return mode === 'fail' ? httpReply(500) : said('买了牛奶'); } });
      const p1 = m.svc.transcribe(WAV);
      const e2 = await fails(m.svc.transcribe(WAV));
      check('并发：进行中再来请求立即 429，且没有再转发、不额外计数', isErr(e2, 429, '正在识别上一段，请稍等') && m.calls.length === 1 && usageOf(m.dir).count === 1);
      release(); await p1;
      mode = 'ok';
      check('并发：完成后可以继续识别', (await m.svc.transcribe(WAV)).text === '买了牛奶');
      mode = 'fail';
      await fails(m.svc.transcribe(WAV));
      mode = 'ok';
      check('并发：失败之后「进行中」也被清除', (await fails(m.svc.transcribe(WAV))) === null);
    }

    // ---------- 超时、网络错误与错误映射 ----------
    {
      let mode = 'hang';
      const m = mk({ cfg: baseCfg({ timeoutSec: 0.05 }), fetchImpl: (url, { signal }) => mode === 'hang'
        ? new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)))
        : Promise.resolve(said('买了牛奶')) });
      check('超时：抛 504「识别超时」', isErr(await fails(m.svc.transcribe(WAV)), 504, '识别超时'));
      mode = 'ok';
      check('超时：之后「进行中」已清除，可继续', (await fails(m.svc.transcribe(WAV))) === null);
      const n = mk({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
      check('网络错误：502「连不上识别服务，请稍后再试」', isErr(await fails(n.svc.transcribe(WAV)), 502, '连不上识别服务，请稍后再试'));
      const body = '{"error":"bad key sk-secret-123 and header x-secret"}';
      const cases = [[401, '识别服务拒绝了请求，请检查服务器上的 key'], [403, '识别服务拒绝了请求，请检查服务器上的 key'], [500, '识别服务出错（HTTP 500），请稍后再试']];
      for (const [status, msg] of cases) {
        const x = mk({ cfg: baseCfg({ dailyLimit: 0 }), fetchImpl: async () => httpReply(status, body) });
        const e = await fails(x.svc.transcribe(WAV));
        check(`错误映射：HTTP ${status}`, isErr(e, 502, msg));
        check(`错误映射：HTTP ${status} 的消息和日志都不含 key 与响应原文`, ![KEY, 'bad key', 'x-secret'].some(s => e.message.includes(s)) && !leaks(x, ['bad key', 'x-secret']));
      }
    }

    // ---------- 与小票识别互不阻塞 ----------
    {
      const dir = tmp();
      let relA, relR;
      const gateA = new Promise(r => { relA = r; }), gateR = new Promise(r => { relR = r; });
      const asr = createAsrService({ getConfig: () => baseCfg(), dataDir: dir, today: () => '2026-11-24', log: () => {}, fetchImpl: async () => { await gateA; return said('买了牛奶'); } });
      const receipt = createReceiptService({ getConfig: () => ({ enabled: true, url: 'https://r/x', key: KEY, model: 'm', format: 'openai', extra: {}, timeoutSec: 30, dailyLimit: 30 }), getStock: () => [], dataDir: dir, today: () => '2026-11-24', log: () => {},
        fetchImpl: async () => { await gateR; return okReply({ choices: [{ message: { content: JSON.stringify({ items: [{ name: '豆腐', quantity: 1, unit: '盒' }] }) } }] }); } });
      const pa = asr.transcribe(WAV);
      const pr = receipt.scan(Buffer.from('abc'), 'image/jpeg');
      const early = await Promise.race([Promise.all([pa.catch(e => e), pr.catch(e => e)]).then(() => 'done'), new Promise(r => setTimeout(() => r('pending'), 30))]);
      check('互不阻塞：两个请求同时在进行，谁都没有被 429 拒绝', early === 'pending');
      relA(); relR();
      const [ra, rr] = await Promise.all([pa, pr]);
      check('互不阻塞：放行后两个都成功', ra.text === '买了牛奶' && rr.count === 1);
      check('互不阻塞：各写各的用量文件', usageOf(dir).count === 1 && JSON.parse(fs.readFileSync(path.join(dir, 'receipt-usage.json'), 'utf8')).count === 1);
    }

    console.log(`\n通过 ${pass}，失败 ${fail}`);
  } finally { clearInterval(keepAlive); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('测试脚本自身出错：', e); process.exit(1); });
