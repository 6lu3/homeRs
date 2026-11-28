// 周报 AI 的配置、请求、提示词、草稿校验测试：node test/report-ai.test.js
const { LIMITS, resolveConfig, buildTextRequest, buildPrompt, promptHash, parseDraft, validateDraft, validateDotDate, validateDotRange } = require('../lib/report-ai');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + e.message); }
}
function eq(got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function throws(fn, msg) {
  try { fn(); } catch (e) { if (msg) eq(e.message, msg); return; }
  throw new Error('应当抛错');
}
const ok = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

// ---------- resolveConfig ----------
const RECEIPT = { enabled: true, url: 'https://ark.example/receipt', key: 'RK-SECRET', model: 'vision-1', format: 'responses', extra: { thinking: { type: 'disabled' } }, timeoutSec: 60, dailyLimit: 30, problem: '' };
const R = (file, env = {}, receipt = RECEIPT) => resolveConfig(file, env, receipt);

check('resolveConfig：周报什么都没配 ⇒ 沿用图片识别；超时和每日次数不沿用', () => {
  const c = R(undefined);
  eq([c.enabled, c.inherited, c.url, c.key, c.model, c.format], [true, true, RECEIPT.url, 'RK-SECRET', 'vision-1', 'responses']);
  eq(c.extra, RECEIPT.extra);
  eq([c.timeoutSec, c.dailyLimit], [90, 20]);
});
check('resolveConfig：只配 model ⇒ 换成文字模型，其余沿用', () => {
  const c = R({ model: 'text-1' });
  eq([c.enabled, c.inherited, c.url, c.key, c.model, c.format], [true, true, RECEIPT.url, 'RK-SECRET', 'text-1', 'responses']);
});
check('resolveConfig：只配 format / extra ⇒ 覆盖沿用的值', () => {
  eq(R({ format: 'openai' }).format, 'openai');
  eq(R({ extra: { max_tokens: 100 } }).extra, { max_tokens: 100 });
  eq(R({ extra: {} }).extra, {});
});
check('resolveConfig：周报配了 url 但没配 key ⇒ 不沿用图片识别的 key，报配置不完整，且问题里没有 key', () => {
  const c = R({ url: 'https://other.example/v1', model: 'm' });
  eq([c.enabled, c.key, c.inherited], [false, '', false]);
  ok(c.problem.includes('缺少：key'), c.problem);
  ok(!JSON.stringify(c).includes('RK-SECRET'), '返回值里出现了图片识别的 key');
});
check('resolveConfig：周报配了 url 就什么都不沿用（format 缺省 openai，extra 缺省空）', () => {
  const c = R({ url: 'https://other.example/v1', key: 'OWN-KEY', model: 'm' });
  eq([c.enabled, c.inherited, c.url, c.key, c.model, c.format, c.extra], [true, false, 'https://other.example/v1', 'OWN-KEY', 'm', 'openai', {}]);
  eq(R({ url: 'https://other.example/v1' }).problem, '周报配置不完整，缺少：key、model');
});
check('resolveConfig：环境变量覆盖文件，空串环境变量不覆盖', () => {
  eq(R({ model: 'file-m' }, { REPORT_MODEL: 'env-m' }).model, 'env-m');
  eq(R({ model: 'file-m' }, { REPORT_MODEL: '  ' }).model, 'file-m');
  const c = R(undefined, { REPORT_API_URL: 'https://e.example/', REPORT_API_KEY: 'EK', REPORT_MODEL: 'em', REPORT_FORMAT: 'anthropic', REPORT_EXTRA: '{"a":1}', REPORT_TIMEOUT_S: '30', REPORT_DAILY_LIMIT: '5' });
  eq([c.enabled, c.url, c.key, c.model, c.format, c.extra, c.timeoutSec, c.dailyLimit], [true, 'https://e.example/', 'EK', 'em', 'anthropic', { a: 1 }, 30, 5]);
});
check('resolveConfig：extra / format 非法 ⇒ 给出问题', () => {
  ok(R(undefined, { REPORT_EXTRA: '{坏的' }).problem.includes('REPORT_EXTRA'));
  ok(R(undefined, { REPORT_EXTRA: '[1]' }).problem.includes('REPORT_EXTRA'));
  ok(R({ extra: 'x' }).problem.includes('extra'));
  ok(R({ format: 'weird' }).problem.includes('接口格式'));
  eq(R({ format: 'weird' }).enabled, false);
});
check('resolveConfig：timeoutSec / dailyLimit 的各种取值，只看周报自己的', () => {
  eq(R({ timeoutSec: 45 }).timeoutSec, 45);
  eq(R({ timeoutSec: 0 }).timeoutSec, 90);
  eq(R({ timeoutSec: -3 }).timeoutSec, 90);
  eq(R({ timeoutSec: 'abc' }).timeoutSec, 90);
  eq(R({ dailyLimit: 0 }).dailyLimit, 0);
  eq(R({ dailyLimit: 7 }).dailyLimit, 7);
  eq(R({ dailyLimit: -1 }).dailyLimit, 20);
  eq(R({ dailyLimit: 2.5 }).dailyLimit, 20);
});
check('resolveConfig：图片识别不可用且周报没配 ⇒ 不可用但没有问题；只配了 key 没地址 ⇒ 报不完整', () => {
  const off = { ...RECEIPT, enabled: false, url: '', key: '', model: '' };
  const c = R(undefined, {}, off);
  eq([c.enabled, c.problem], [false, '']);
  const d = R({ key: 'K' }, {}, off);
  eq(d.enabled, false);
  ok(d.problem.includes('缺少：url'), d.problem);
});
check('resolveConfig：问题文字里从不出现 key', () => {
  for (const cfg of [{ url: 'u', key: 'RK-SECRET-2' }, { format: 'bad', key: 'RK-SECRET-2' }, { extra: 'x', key: 'RK-SECRET-2' }]) {
    ok(!R(cfg).problem.includes('RK-SECRET'), JSON.stringify(cfg));
  }
});

// ---------- buildTextRequest ----------
check('buildTextRequest：三种格式', () => {
  const base = { url: 'https://x.example/api', key: 'K1', model: 'm1', extra: { temperature: 0.2 } };
  const o = buildTextRequest({ ...base, format: 'openai' }, '你好');
  eq([o.url, o.headers.authorization], ['https://x.example/api', 'Bearer K1']);
  eq(o.body, { temperature: 0.2, model: 'm1', messages: [{ role: 'user', content: '你好' }] });
  const a = buildTextRequest({ ...base, format: 'anthropic' }, '你好');
  eq([a.headers['x-api-key'], a.headers['anthropic-version'], a.headers.authorization], ['K1', '2023-06-01', undefined]);
  eq(a.body, { max_tokens: 4000, temperature: 0.2, model: 'm1', messages: [{ role: 'user', content: '你好' }] });
  const r = buildTextRequest({ ...base, format: 'responses' }, '你好');
  eq(r.headers.authorization, 'Bearer K1');
  eq(r.body, { temperature: 0.2, model: 'm1', input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }] });
});
check('buildTextRequest：extra 可以覆盖 anthropic 的 max_tokens', () => {
  eq(buildTextRequest({ url: 'u', key: 'k', model: 'm', format: 'anthropic', extra: { max_tokens: 100 } }, 'p').body.max_tokens, 100);
});

// ---------- buildPrompt ----------
const IN = {
  weekLabel: '11.23-11.28',
  entries: [{ date: '2026-11-24', text: '修了登录 bug' }, { date: '2026-11-23', text: '对接接口' }, { date: '2026-11-24', text: '开周会' }],
  doneTodos: [{ date: '2026-11-25', text: '写方案' }],
  openTodos: [{ due_date: '2026-11-30', text: '整理报告' }, { due_date: '', text: '联系供应商' }],
  examples: ['示例正文一', '示例正文二'],
};
check('buildPrompt：同样的输入逐字相同；各节齐全；记录按日期升序且同日保持顺序', () => {
  const p = buildPrompt(IN);
  eq(buildPrompt(IN), p);
  for (const s of ['## 示例周报', '### 示例 1', '示例正文一', '### 示例 2', '## 本周（11.23-11.28）记录', '## 本周完成的待办', '## 还没做完的待办']) ok(p.includes(s), '缺少：' + s);
  ok(p.indexOf('11.23 周一：对接接口') < p.indexOf('11.24 周二：修了登录 bug'), '日期顺序不对');
  ok(p.indexOf('11.24 周二：修了登录 bug') < p.indexOf('11.24 周二：开周会'), '同一天的顺序不对');
  ok(p.includes('11.25 完成：写方案'), '完成的待办格式不对');
  ok(p.includes('整理报告（11.30）') && p.includes('联系供应商（没选日期）'), '未完成待办格式不对');
});
check('buildPrompt：规则要求（不得编造、只返回 JSON）、没有 key', () => {
  const p = buildPrompt(IN);
  ok(p.includes('不得编造'), '缺少「不得编造」');
  ok(p.includes('"items"') && p.includes('"progress"') && p.includes('"plan"') && p.includes('"issues"'), '缺少 JSON 格式说明');
  ok(!p.includes('RK-SECRET'));
});
check('buildPrompt：示例超过 6000 字被截断、超过 4 份只取最后 4 份', () => {
  const long = 'X'.repeat(7000);
  const p = buildPrompt({ ...IN, examples: [long] });
  ok(p.includes('X'.repeat(LIMITS.example)) && !p.includes('X'.repeat(LIMITS.example + 1)), '没有按 6000 字截断');
  const p5 = buildPrompt({ ...IN, examples: ['e1', 'e2', 'e3', 'e4', 'e5'] });
  ok(!p5.includes('e1') && p5.includes('e2') && p5.includes('e5'), '应只取最后 4 份');
  ok(p5.includes('### 示例 4') && !p5.includes('### 示例 5'));
});
check('buildPrompt：没有示例 / 没有某类内容时写「（没有示例）」「（无）」', () => {
  const p = buildPrompt({ weekLabel: 'x', entries: [], doneTodos: [], openTodos: [], examples: [] });
  ok(p.includes('（没有示例）'));
  eq(p.split('（无）').length - 1, 3);
});

// ---------- promptHash ----------
check('promptHash：同输入同输出、差一个字不同、32 位十六进制', () => {
  eq(promptHash('abc'), promptHash('abc'));
  ok(promptHash('abc') !== promptHash('abd'));
  ok(/^[0-9a-f]{32}$/.test(promptHash('周报')));
});

// ---------- parseDraft ----------
check('parseDraft：标准 JSON', () => {
  eq(parseDraft('{"items":[{"title":"项目甲","lines":["a","b"],"progress":80}],"issues":"需要采购","plan":["下周做 X"]}'),
    { items: [{ title: '项目甲', lines: ['a', 'b'], progress: 80 }], issues: '需要采购', plan: ['下周做 X'] });
});
check('parseDraft：被 ``` 围栏和说明文字包着也能取出', () => {
  const d = parseDraft('好的，结果如下：\n```json\n{"items":[{"title":"甲","lines":[],"progress":1}]}\n```\n以上。');
  eq(d.items[0].title, '甲');
});
check('parseDraft：progress 取整并夹紧，非数字按 0', () => {
  const p = v => parseDraft(JSON.stringify({ items: [{ title: 't', lines: [], progress: v }] })).items[0].progress;
  eq([p(99.6), p(-5), p('abc'), p(150), p('70'), p(null), p(0)], [100, 0, 0, 100, 70, 0, 0]);
});
check('parseDraft：空标题的项被丢弃；超限被截断；issues 缺省为「无」；非字符串细节被忽略', () => {
  const d = parseDraft(JSON.stringify({
    items: [{ title: '  ', lines: ['x'], progress: 1 }, { title: 'T'.repeat(100), lines: [...Array(15).fill('L'), 5, null, { a: 1 }], progress: 1 }],
    plan: Array(20).fill('P'),
  }));
  eq(d.items.length, 1);
  eq([...d.items[0].title].length, LIMITS.title);
  eq(d.items[0].lines.length, LIMITS.lines);
  eq(d.issues, '无');
  eq(d.plan.length, LIMITS.plan);
  eq(parseDraft(JSON.stringify({ items: [{ title: 't', lines: ['y'.repeat(300)], progress: 1 }] })).items[0].lines[0].length, LIMITS.text);
});
check('parseDraft：项目最多 12 项；完全无效返回 null', () => {
  eq(parseDraft(JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ title: 'T' + i, lines: [], progress: 1 })) })).items.length, LIMITS.items);
  for (const bad of ['', '随便说说', '{坏的', '{"items":[]}', '{"items":"x"}', '{"plan":["a"]}', '{"items":[{"title":"","lines":[]}]}', 'null', '[1,2]']) eq(parseDraft(bad), null);
});

// ---------- validateDraft / validateDotDate / validateDotRange ----------
const GOOD = { items: [{ title: ' 项目 ', lines: [' 细节 '], progress: 100 }], issues: ' 无 ', plan: [' 计划 '] };
check('validateDraft：合法草稿通过并 trim；空白细节被丢弃；issues 空白 ⇒「无」', () => {
  eq(validateDraft(GOOD), { items: [{ title: '项目', lines: ['细节'], progress: 100 }], issues: '无', plan: ['计划'] });
  eq(validateDraft({ ...GOOD, issues: '   ' }).issues, '无');
  eq(validateDraft({ ...GOOD, issues: undefined }).issues, '无');
  eq(validateDraft({ items: [{ title: 't', lines: ['', '  ', 'x'], progress: 0 }], plan: ['', 'p'] }), { items: [{ title: 't', lines: ['x'], progress: 0 }], issues: '无', plan: ['p'] });
  eq(validateDraft({ items: [{ title: 't', lines: [], progress: 0 }], plan: [] }).plan, []);
});
check('validateDraft：各种超限和非法', () => {
  const item = (o = {}) => ({ title: 't', lines: [], progress: 50, ...o });
  throws(() => validateDraft({ ...GOOD, items: [] }), '至少要有一个工作项');
  throws(() => validateDraft({ ...GOOD, items: Array(13).fill(item()) }), '工作项最多 12 个');
  throws(() => validateDraft({ ...GOOD, items: [item({ title: '  ' })] }), '项目标题不能为空');
  throws(() => validateDraft({ ...GOOD, items: [item({ title: 'a'.repeat(61) })] }), '项目标题最长 60 字');
  throws(() => validateDraft({ ...GOOD, items: [item({ lines: Array(11).fill('x') })] }), '细节最多 10 条');
  throws(() => validateDraft({ ...GOOD, items: [item({ lines: ['x'.repeat(201)] })] }), '每条最长 200 字');
  throws(() => validateDraft({ ...GOOD, items: [item({ progress: 50.5 })] }), '完成度应为 0–100 的整数');
  throws(() => validateDraft({ ...GOOD, items: [item({ progress: '50' })] }), '完成度应为 0–100 的整数');
  throws(() => validateDraft({ ...GOOD, items: [item({ progress: 101 })] }), '完成度应为 0–100 的整数');
  throws(() => validateDraft({ ...GOOD, plan: Array(13).fill('p') }), '计划最多 12 条');
  throws(() => validateDraft({ ...GOOD, plan: ['p'.repeat(201)] }), '每条最长 200 字');
  throws(() => validateDraft({ ...GOOD, issues: 'x'.repeat(201) }), '需协调的问题最长 200 字');
  for (const bad of [null, 'x', 5, [], { items: 'x' }, { items: [null] }, { items: [item({ lines: 'x' })] }, { ...GOOD, plan: 'x' }, { ...GOOD, issues: 5 }]) throws(() => validateDraft(bad), '草稿格式不对');
});
check('validateDotDate / validateDotRange', () => {
  eq(validateDotDate('2026.11.28'), '2026.11.28');
  eq(validateDotDate('2026.1.5'), '2026.1.5');
  for (const bad of ['2026.13.1', '2026-11-28', '26.11.28', '2026.2.30', '2026.11', '', null, 5]) throws(() => validateDotDate(bad), '日期格式不对');
  eq(validateDotRange('2026.11.30-2026.12.4'), '2026.11.30-2026.12.4');
  eq(validateDotRange('2026.12.4-2026.12.4'), '2026.12.4-2026.12.4');
  for (const bad of ['2026.12.4-2026.11.30', '2026.11.30', '2026.11.30-', '-2026.12.4', '2026.11.30-2026.13.4', '']) throws(() => validateDotRange(bad), '日期格式不对');
});

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
