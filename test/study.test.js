// 学习计划纯逻辑测试：node test/study.test.js
const { isDate, daysBetween, itemsOnDate, upcoming, progress, monthLayout } = require('../lib/study');

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
const BAD = '日期格式应为 YYYY-MM-DD';

check('isDate 合法与非法', () => {
  eq(isDate('2026-11-26'), true);
  eq(isDate('2026-02-30'), false);
  eq(isDate('2026-1-1'), false);
  eq(isDate(''), false);
  eq(isDate(null), false);
  eq(isDate('2028-02-29'), true);
  eq(isDate('2027-02-29'), false);
});

check('daysBetween 含首尾、跨年、闰年、倒序', () => {
  eq(daysBetween('2026-12-01', '2026-12-10'), 10);
  eq(daysBetween('2026-12-05', '2026-12-05'), 1);
  eq(daysBetween('2026-12-31', '2027-01-01'), 2);
  eq(daysBetween('2028-02-28', '2028-03-01'), 3);
  eq(daysBetween('2026-12-10', '2026-12-01'), 0);
});

const A = { id: 1, start_date: '2026-12-01', end_date: '2026-12-10' };
const B = { id: 2, start_date: '2026-12-05', end_date: '2026-12-05' };
const C = { id: 3, start_date: '2026-12-20', end_date: '2026-12-25' };
const D = { id: 4, start_date: '2026-12-11', end_date: '2026-12-12' };
const E = { id: 5, start_date: '2026-12-11', end_date: '2026-12-30' };
const F = { id: 6, start_date: '2027-01-01', end_date: '2027-01-02' };

check('itemsOnDate 含边界、范围外不算、顺序保持', () => {
  eq(itemsOnDate([A, B, C], '2026-12-05').map(i => i.id), [1, 2]);
  eq(itemsOnDate([A, B, C], '2026-12-01').map(i => i.id), [1]);
  eq(itemsOnDate([A, B, C], '2026-12-10').map(i => i.id), [1]);
  eq(itemsOnDate([A, B, C], '2026-12-11').map(i => i.id), []);
});

check('upcoming 只取开始日在后的、升序、默认 3 项、limit 生效', () => {
  eq(upcoming([C, D, E, F, A], '2026-12-10').map(i => i.id), [4, 5, 3]);
  eq(upcoming([C, D, E, F, A], '2026-12-10', 2).map(i => i.id), [4, 5]);
  eq(upcoming([A, B], '2026-12-05').map(i => i.id), []);   // 开始日等于当天不算「即将」
  eq(upcoming([F, C], '2026-11-01').map(i => i.id), [3, 6]);
});

check('progress：第几天、共几天、范围外为 null', () => {
  const p = progress(A, [], '2026-12-03', '2026-12-03');
  eq([p.total, p.dayIndex], [10, 3]);
  eq(progress(A, [], '2026-12-11', '2026-12-11').dayIndex, null);
  eq(progress(A, [], '2026-11-30', '2026-12-11').dayIndex, null);
});
check('progress：范围外勾选不计入 done，重复只算一次', () => {
  eq(progress(A, ['2026-12-01', '2026-12-01', '2026-12-02', '2026-12-20', '2026-11-30'], '2026-12-03', '2026-12-03').done, 2);
});
check('progress：missed 只数已过去且没勾的天', () => {
  // 10 天项，今天是第 5 天，勾了第 1、2 天 → 第 3、4 天落下；今天和未来不算
  eq(progress(A, ['2026-12-01', '2026-12-02'], '2026-12-05', '2026-12-05').missed, 2);
  eq(progress(A, [], '2026-12-01', '2026-12-01').missed, 0);
  eq(progress(A, [], '2026-12-01', '2026-12-20').missed, 10);   // 整项都过去了
  eq(progress(A, [], '2026-12-01', '2026-11-20').missed, 0);    // 还没开始
});
check('progress：单日项', () => {
  const p = progress(B, [], '2026-12-05', '2026-12-05');
  eq([p.total, p.dayIndex, p.done, p.missed], [1, 1, 0, 0]);
});

check('monthLayout 跨月、整月、无交集', () => {
  const X = { id: 9, start_date: '2026-11-28', end_date: '2026-12-03' };
  eq(monthLayout([X], '2026-11'), [{ id: 9, days: [28, 29, 30] }]);
  eq(monthLayout([X], '2026-12'), [{ id: 9, days: [1, 2, 3] }]);
  eq(monthLayout([X], '2026-10'), []);
  eq(monthLayout([X], '2027-01'), []);
  const Y = { id: 10, start_date: '2027-12-01', end_date: '2029-01-01' };
  const days = monthLayout([Y], '2028-02')[0].days;
  eq([days.length, days[0], days[28]], [29, 1, 29]);
  eq(monthLayout([A, B, C], '2026-12').map(m => m.id), [1, 2, 3]);
});
check('monthLayout 非法月份抛错', () => {
  throws(() => monthLayout([A], '2026-13'), '月份格式应为 YYYY-MM');
  throws(() => monthLayout([A], '2026-1'), '月份格式应为 YYYY-MM');
});

check('非法日期参数抛错', () => {
  throws(() => daysBetween('abc', '2026-01-01'), BAD);
  throws(() => itemsOnDate([A], '2026-02-30'), BAD);
  throws(() => upcoming([A], ''), BAD);
  throws(() => progress(A, [], 'x', '2026-01-01'), BAD);
});

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
