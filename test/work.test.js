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

const E = (date, kind, text, done = false) => ({ date, kind, text, done });

check('buildReport：完整示例逐字比较', () => {
  const r = buildReport({
    start: '2026-11-23',
    entries: [
      E('2026-11-23', 'done', '对接 A 项目接口'),
      E('2026-11-24', 'done', '修了登录 bug'),
      E('2026-11-24', 'done', '开周会'),
      E('2026-11-27', 'todo', '整理测试报告'),
    ],
    nextWeekTodos: [],
  });
  eq(r.empty, false);
  eq(r.text, ['本周工作（11/23 – 11/29）', '周一', '- 对接 A 项目接口', '周二', '- 修了登录 bug', '- 开周会', '下周计划', '- 整理测试报告'].join('\n'));
});
check('buildReport：没有记录时为空', () => {
  eq(buildReport({ start: '2026-11-23', entries: [], nextWeekTodos: [] }), { text: '', empty: true });
  // 只有下周待办、本周一条记录都没有：按规格仍然不生成
  eq(buildReport({ start: '2026-11-23', entries: [], nextWeekTodos: [{ date: '2026-11-30', text: 'x' }] }), { text: '', empty: true });
});
check('buildReport：已完成待办算本周做了什么，未完成的只在下周计划', () => {
  const r = buildReport({
    start: '2026-11-23',
    entries: [E('2026-11-25', 'todo', '写方案', true), E('2026-11-26', 'todo', '评审方案', false)],
    nextWeekTodos: [],
  });
  eq(r.text, ['本周工作（11/23 – 11/29）', '周三', '- 写方案', '下周计划', '- 评审方案'].join('\n'));
});
check('buildReport：下周已有的待办按日期升序追加在本周未完成待办之后', () => {
  const r = buildReport({
    start: '2026-11-23',
    entries: [E('2026-11-23', 'done', '甲'), E('2026-11-24', 'todo', '乙')],
    nextWeekTodos: [{ date: '2026-12-02', text: '丁' }, { date: '2026-11-30', text: '丙' }, { date: '2026-11-30', text: '丙2' }],
  });
  eq(r.text.split('\n').slice(-5), ['下周计划', '- 乙', '- 丙', '- 丙2', '- 丁']);
});
check('buildReport：只有未完成待办时没有日子段，没有待办时没有下周计划段', () => {
  eq(buildReport({ start: '2026-11-23', entries: [E('2026-11-24', 'todo', '乙')], nextWeekTodos: [] }).text,
    ['本周工作（11/23 – 11/29）', '下周计划', '- 乙'].join('\n'));
  const r = buildReport({ start: '2026-11-23', entries: [E('2026-11-24', 'done', '甲')], nextWeekTodos: [] });
  eq(r.text.includes('下周计划'), false);
});
check('buildReport：跨月、跨年的标题', () => {
  eq(buildReport({ start: '2026-11-30', entries: [E('2026-11-30', 'done', 'a')], nextWeekTodos: [] }).text.split('\n')[0], '本周工作（11/30 – 12/6）');
  eq(buildReport({ start: '2026-12-28', entries: [E('2026-12-28', 'done', 'a')], nextWeekTodos: [] }).text.split('\n')[0], '本周工作（12/28 – 1/3）');
});
check('buildReport：同一天保持输入顺序，周日也能正确显示', () => {
  const r = buildReport({ start: '2026-11-23', entries: [E('2026-11-29', 'done', 'z'), E('2026-11-29', 'done', 'a')], nextWeekTodos: [] });
  eq(r.text.split('\n').slice(1), ['周日', '- z', '- a']);
});

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
