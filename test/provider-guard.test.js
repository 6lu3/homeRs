// 共用防护模块回归测试：node test/provider-guard.test.js
// 全部离线：假的 fetch、临时目录、可控的时钟。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ServiceError, timeoutMs, createUsage, callProvider } = require('../lib/provider-guard');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const KEY = 'sk-secret-123';
const UNREADABLE = '识别服务返回了无法理解的内容';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
const fails = async p => { try { await p; return null; } catch (e) { return e; } };
const isErr = (e, status, msg, Cls = ServiceError) => e instanceof Cls && e.status === status && e.message === msg;
const textReply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

function run(fetchImpl, over = {}) {
  const logs = [];
  const p = callProvider({ fetchImpl, url: 'https://p/x', headers: { authorization: 'Bearer ' + KEY }, body: { a: 1 }, timeoutSec: 60, log: (...a) => logs.push(a.join(' ')), unreadable: UNREADABLE, ...over });
  return { p, logs };
}
const leaks = (logs, extra = []) => [KEY, ...extra].some(s => logs.join('\n').includes(s));

(async () => {
  // AbortSignal.timeout 的定时器不会让进程保持运行；真实服务器有 HTTP 监听所以没问题，测试里要自己保活
  const keepAlive = setInterval(() => {}, 1000);
  try {
    // ---------- ServiceError / timeoutMs ----------
    {
      const e = new ServiceError(502, '坏了');
      check('ServiceError：是 Error，带 status 和 message', e instanceof Error && e.status === 502 && e.message === '坏了');
      class X extends ServiceError {}
      check('ServiceError：子类实例也满足 instanceof ServiceError', new X(1, 'a') instanceof ServiceError);
      check('timeoutMs：1.1→1100，1e7→2147483647，0→1', timeoutMs(1.1) === 1100 && timeoutMs(1e7) === 2147483647 && timeoutMs(0) === 1);
    }

    // ---------- createUsage ----------
    {
      const dir = tmp(), file = path.join(dir, 'u.json');
      const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
      const u = createUsage({ file, today: () => '2026-11-24' });
      check('用量：limit 2 时依次返回 true,true,false', [u.tryConsume(2), u.tryConsume(2), u.tryConsume(2)].join() === 'true,true,false');
      check('用量：文件记录今天已用 2 次', read().date === '2026-11-24' && read().count === 2);
      check('用量：新建实例（模拟重启）后上限仍然生效', createUsage({ file, today: () => '2026-11-24' }).tryConsume(2) === false);
      const next = createUsage({ file, today: () => '2026-11-25' });
      check('用量：跨天自动归零', next.tryConsume(2) === true && read().date === '2026-11-25' && read().count === 1);
      const unlimited = createUsage({ file: path.join(dir, 'v.json'), today: () => '2026-11-24' });
      let ok = 0; for (let i = 0; i < 5; i++) if (unlimited.tryConsume(0)) ok++;
      check('用量：limit 为 0 表示不限', ok === 5);
      const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, 'not json');
      check('用量：文件损坏按 0 处理并被重写成合法 JSON', createUsage({ file: bad, today: () => '2026-11-24' }).tryConsume(2) === true && JSON.parse(fs.readFileSync(bad, 'utf8')).count === 1);
      const old = path.join(dir, 'old.json'); fs.writeFileSync(old, JSON.stringify({ date: '2026-11-23', count: 99 }));
      check('用量：文件里是昨天的日期按 0 处理', createUsage({ file: old, today: () => '2026-11-24' }).tryConsume(2) === true && JSON.parse(fs.readFileSync(old, 'utf8')).count === 1);
      const logs = [];
      const nodir = createUsage({ file: path.join(dir, 'no', 'such', 'dir', 'x.json'), today: () => '2026-11-24', log: (...a) => logs.push(a.join(' ')) });
      check('用量：写文件失败时仍然放行并记一条日志', nodir.tryConsume(2) === true && logs.length === 1);
    }

    // ---------- callProvider：成功与请求形状 ----------
    {
      let seen;
      const { p } = run(async (url, init) => { seen = { url, init }; return textReply('{"ok":true}'); });
      const text = await p;
      check('callProvider：成功返回响应文本', text === '{"ok":true}');
      check('callProvider：POST、原样带头、JSON 字符串体、带 signal', seen.url === 'https://p/x' && seen.init.method === 'POST' && seen.init.headers.authorization === 'Bearer ' + KEY && seen.init.body === '{"a":1}' && !!seen.init.signal);
    }

    // ---------- 超时与网络错误 ----------
    {
      const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
      check('超时：504「识别超时」', isErr(await fails(run(hang, { timeoutSec: 0.05 }).p), 504, '识别超时'));
      check('超时：timeoutSec=1.1 正常（不会因为非整数毫秒失败）', (await fails(run(async () => textReply('{}'), { timeoutSec: 1.1 }).p)) === null);
      const r = run(async () => { throw new TypeError('fetch failed'); });
      check('网络错误：502「连不上识别服务，请稍后再试」', isErr(await fails(r.p), 502, '连不上识别服务，请稍后再试'));
    }

    // ---------- HTTP 错误映射且不泄露 ----------
    {
      const body = '{"error":"bad key sk-secret-123 and header x-secret"}';
      const cases = [[401, '识别服务拒绝了请求，请检查服务器上的 key'], [403, '识别服务拒绝了请求，请检查服务器上的 key'], [500, '识别服务出错（HTTP 500），请稍后再试'], [429, '识别服务出错（HTTP 429），请稍后再试']];
      for (const [status, msg] of cases) {
        const r = run(async () => textReply(body, status));
        const e = await fails(r.p);
        check(`HTTP ${status}：消息正确`, isErr(e, 502, msg));
        check(`HTTP ${status}：消息和日志都不含 key 与响应原文`, ![KEY, 'bad key', 'x-secret'].some(s => e.message.includes(s)) && !leaks(r.logs, ['bad key', 'x-secret']));
      }
    }

    // ---------- 响应体读取：边读边限 2 MiB ----------
    {
      const stream = (chunks, size = 1024 * 1024) => {
        const state = { pulled: 0, cancelled: false };
        const body = new ReadableStream({
          pull(c) { if (state.pulled >= chunks) { c.close(); return; } state.pulled++; c.enqueue(new Uint8Array(size).fill(120)); },
          cancel() { state.cancelled = true; },
        });
        return { state, body };
      };
      const noText = async () => { throw new Error('不应该调用 text()'); };
      let s = stream(20);
      check('读取：超过 2 MiB 立即中止并取消流', isErr(await fails(run(async () => ({ ok: true, status: 200, headers: new Headers(), body: s.body, text: noText })).p), 502, UNREADABLE) && s.state.pulled <= 4 && s.state.cancelled);
      s = stream(20);
      check('读取：content-length 超过 2 MiB 时不读响应体，直接取消', isErr(await fails(run(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '3000000' }), body: s.body, text: noText })).p), 502, UNREADABLE) && s.state.pulled <= 1 && s.state.cancelled);
      s = stream(3);
      check('读取：HTTP 出错时丢弃响应体', isErr(await fails(run(async () => ({ ok: false, status: 500, headers: new Headers(), body: s.body, text: noText })).p), 502, '识别服务出错（HTTP 500），请稍后再试') && s.state.cancelled);
      const payload = Buffer.from(JSON.stringify({ text: '把鸡蛋放入冰箱冷藏，买了五花肉一盒' }));
      const parts = []; for (let i = 0; i < payload.length; i += 7) parts.push(new Uint8Array(payload.subarray(i, i + 7)));
      const body = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
      const got = await run(async () => ({ ok: true, status: 200, headers: new Headers(), body, text: noText })).p;
      check('读取：中文被切在多个小块里也能正确拼回', JSON.parse(got).text === '把鸡蛋放入冰箱冷藏，买了五花肉一盒');
      check('读取：没有可读流时读完后也检查 2 MiB', isErr(await fails(run(async () => textReply('x'.repeat(2 * 1024 * 1024 + 1))).p), 502, UNREADABLE));
    }

    // ---------- ErrorClass ----------
    {
      class MyErr extends ServiceError {}
      const e = await fails(run(async () => textReply('', 500), { ErrorClass: MyErr }).p);
      check('ErrorClass：抛出的是传入的类', e instanceof MyErr && e instanceof ServiceError && e.status === 502);
    }

    console.log(`\n通过 ${pass}，失败 ${fail}`);
  } finally { clearInterval(keepAlive); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('测试脚本自身出错：', e); process.exit(1); });
