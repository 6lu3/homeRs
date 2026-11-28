// 每周工作纯逻辑测试：node test/work.test.js
const { splitSpoken, nextMonday, buildReport } = require('../lib/work');

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

check('splitSpoken：按句号拆', () => {
  eq(splitSpoken('修了bug。开了周会'), { parts: ['修了bug', '开了周会'], truncated: false });
});
check('splitSpoken：各种分隔符，超过上限被截断', () => {
  const r = splitSpoken('a；b;c\nd!e?f');
  eq(r.parts, ['a', 'b', 'c', 'd', 'e']);
  eq(r.truncated, true);
  eq(splitSpoken('a；b;c\nd!e?f', 6), { parts: ['a', 'b', 'c', 'd', 'e', 'f'], truncated: false });
});
check('splitSpoken：恰好 5 段不算截断', () => {
  eq(splitSpoken('1。2。3。4。5'), { parts: ['1', '2', '3', '4', '5'], truncated: false });
});
check('splitSpoken：逗号不是分隔符，空段被丢弃', () => {
  eq(splitSpoken('。。 ，'), { parts: ['，'], truncated: false });
  eq(splitSpoken('。。。'), { parts: [], truncated: false });
});
check('splitSpoken：空输入与首尾空白', () => {
  eq(splitSpoken(''), { parts: [], truncated: false });
  eq(splitSpoken(null), { parts: [], truncated: false });
  eq(splitSpoken(undefined), { parts: [], truncated: false });
  eq(splitSpoken('  开会  。  写周报  '), { parts: ['开会', '写周报'], truncated: false });
});

check('nextMonday：周一、周日、跨年、闰年', () => {
  eq(nextMonday('2026-11-23'), '2026-11-30');
  eq(nextMonday('2026-11-29'), '2026-11-30');
  eq(nextMonday('2026-12-30'), '2027-01-04');
  eq(nextMonday('2028-02-28'), '2028-03-06');
});
check('nextMonday：非法日期抛错', () => {
  throws(() => nextMonday('2026-02-30'), '日期格式应为 YYYY-MM-DD');
  throws(() => nextMonday('abc'), '日期格式应为 YYYY-MM-DD');
});

const R = (date, text) => ({ date, text });
const O = (due_date, text) => ({ due_date, text });
const T = (start, over = {}) => buildReport({ start, entries: [], doneTodos: [], openTodos: [], ...over });

check('buildReport：完整示例逐字比较', () => {
  const r = buildReport({
    start: '2026-11-23',
    entries: [R('2026-11-23', '对接 A 项目接口'), R('2026-11-24', '修了登录 bug'), R('2026-11-24', '开周会')],
    doneTodos: [R('2026-11-24', '写方案')],
    openTodos: [O('2026-11-27', '整理测试报告'), O('', '联系供应商')],
  });
  eq(r.empty, false);
  eq(r.text, ['本周工作（11/23 – 11/29）', '周一', '- 对接 A 项目接口', '周二', '- 修了登录 bug', '- 开周会', '- 写方案', '下周计划', '- 整理测试报告', '- 联系供应商'].join('\n'));
});
check('buildReport：没有记录也没有完成的待办时为空，即使有没完成的待办', () => {
  eq(T('2026-11-23'), { text: '', empty: true });
  eq(T('2026-11-23', { openTodos: [O('2026-11-30', 'x'), O('', 'y')] }), { text: '', empty: true });
});
check('buildReport：只有完成的待办（没有记录）也能生成', () => {
  eq(T('2026-11-23', { doneTodos: [R('2026-11-25', '写方案')] }).text, ['本周工作（11/23 – 11/29）', '周三', '- 写方案'].join('\n'));
});
check('buildReport：下周计划排序——有日期的按日期升序，没日期的在最后', () => {
  const r = T('2026-11-23', {
    entries: [R('2026-11-23', 'a')],
    openTodos: [O('2026-12-02', 'c'), O('', 'u1'), O('2026-11-30', 'b'), O('2026-11-30', 'b2'), O('', 'u2'), O('2026-11-20', '过期')],
  });
  eq(r.text.split('\n').slice(-7), ['下周计划', '- 过期', '- b', '- b2', '- c', '- u1', '- u2']);
});
check('buildReport：没有未完成待办时没有下周计划', () => {
  eq(T('2026-11-23', { entries: [R('2026-11-23', 'a')] }).text.includes('下周计划'), false);
});
check('buildReport：同一天先列记录再列完成的待办，周日显示为周日', () => {
  const r = T('2026-11-23', { entries: [R('2026-11-29', '记录')], doneTodos: [R('2026-11-29', '待办')] });
  eq(r.text.split('\n').slice(1), ['周日', '- 记录', '- 待办']);
});
check('buildReport：没有内容的日子省略', () => {
  const r = T('2026-11-23', { entries: [R('2026-11-23', 'a'), R('2026-11-27', 'b')] });
  eq(r.text.split('\n').slice(1), ['周一', '- a', '周五', '- b']);
});
check('buildReport：跨月、跨年的标题', () => {
  eq(T('2026-11-30', { entries: [R('2026-11-30', 'a')] }).text.split('\n')[0], '本周工作（11/30 – 12/6）');
  eq(T('2026-12-28', { entries: [R('2026-12-28', 'a')] }).text.split('\n')[0], '本周工作（12/28 – 1/3）');
});

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
