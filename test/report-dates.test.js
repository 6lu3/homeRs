// 大小周日期规则测试：node test/report-dates.test.js
const { DEFAULT_ANCHOR, fmtDot, restKind, reportDates } = require('../lib/report-dates');

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
const A = '2026-11-23';   // 单休周的周一（基准）

check('默认基准是 2026-11-23', () => eq(DEFAULT_ANCHOR, '2026-11-23'));

check('fmtDot：月日不补零', () => {
  eq(fmtDot('2026-11-28'), '2026.11.28');
  eq(fmtDot('2026-12-04'), '2026.12.4');
  eq(fmtDot('2027-01-05'), '2027.1.5');
  throws(() => fmtDot('2026-02-30'), BAD);
  throws(() => fmtDot('abc'), BAD);
});

check('restKind：周六在该周内 ⇒ 单休；周五在该周内 ⇒ 双休（以当天为准）', () => {
  eq(restKind({ start: '2026-11-23', today: '2026-11-28', anchor: A }), 'single');
  eq(restKind({ start: '2026-11-16', today: '2026-11-20', anchor: A }), 'double');
  // 当天为准，哪怕和单双周交替的结果相反（节假日打断交替的情形）：2026-11-16 那周按奇偶本是双休，周六生成就是单休
  eq(restKind({ start: '2026-11-16', today: '2026-11-21', anchor: A }), 'single');
  eq(restKind({ start: '2026-11-23', today: '2026-11-27', anchor: A }), 'double');
});
check('restKind：其他日子按单双周交替推', () => {
  eq(restKind({ start: '2026-11-23', today: '2026-11-29', anchor: A }), 'single');   // 周日补生成
  eq(restKind({ start: '2026-11-30', today: '2026-11-30', anchor: A }), 'double');   // 周一
  eq(restKind({ start: '2026-11-30', today: '2026-12-03', anchor: A }), 'double');   // 周四提前生成
});
check('restKind：today 是周六但不在该周内 ⇒ 按奇偶', () => {
  eq(restKind({ start: '2026-11-16', today: '2026-11-28', anchor: A }), 'double');
  eq(restKind({ start: '2026-12-07', today: '2026-11-28', anchor: A }), 'single');
});
check('restKind：奇偶（基准前后、负数）', () => {
  eq(restKind({ start: '2026-11-09', today: '2026-01-01', anchor: A }), 'single');   // -2
  eq(restKind({ start: '2026-11-16', today: '2026-01-01', anchor: A }), 'double');   // -1
  eq(restKind({ start: '2026-12-07', today: '2026-01-01', anchor: A }), 'single');   // +2
  eq(restKind({ start: '2026-12-14', today: '2026-01-01', anchor: A }), 'double');   // +3
  eq(restKind({ start: '2025-11-24', today: '2026-01-01', anchor: A }), 'single');   // -52（偶数）
});
check('restKind：start 不是周一、anchor 不是周一，都先归到那周的周一', () => {
  eq(restKind({ start: '2026-11-26', today: '2026-11-29', anchor: A }), 'single');
  eq(restKind({ start: '2026-11-23', today: '2026-11-29', anchor: '2026-11-25' }), 'single');
  eq(restKind({ start: '2026-11-30', today: '2026-12-02', anchor: '2026-11-27' }), 'double');
});
check('restKind：缺省 anchor 用默认基准', () => {
  eq(restKind({ start: '2026-11-30', today: '2026-12-02' }), 'double');
  eq(restKind({ start: '2026-12-07', today: '2026-12-08' }), 'single');
});

check('reportDates：周六生成（本周单休，下周双休）', () => {
  eq(reportDates({ start: '2026-11-23', today: '2026-11-28', anchor: A, name: '测试员' }), {
    kind: 'single', from: '2026-11-23', to: '2026-11-28', time: '2026.11.28',
    planRange: '2026.11.30-2026.12.4', filename: '测试员11.23-11.28-周报.docx',
  });
});
check('reportDates：周五生成（本周双休，下周单休）', () => {
  eq(reportDates({ start: '2026-11-16', today: '2026-11-20', anchor: A, name: '测试员' }), {
    kind: 'double', from: '2026-11-16', to: '2026-11-20', time: '2026.11.20',
    planRange: '2026.11.23-2026.11.28', filename: '测试员11.16-11.20-周报.docx',
  });
});
check('reportDates：手动指定 kind 优先于按当天判断', () => {
  const r = reportDates({ start: '2026-11-23', today: '2026-11-28', anchor: A, kind: 'double', name: 'X' });
  eq([r.kind, r.to, r.planRange, r.filename], ['double', '2026-11-27', '2026.11.30-2026.12.5', 'X11.23-11.27-周报.docx']);
  const s = reportDates({ start: '2026-11-16', today: '2026-11-20', anchor: A, kind: 'single', name: 'X' });
  eq([s.kind, s.to, s.planRange], ['single', '2026-11-21', '2026.11.23-2026.11.27']);
});
check('reportDates：跨月、跨年', () => {
  const m = reportDates({ start: '2026-11-30', today: '2026-12-05', anchor: A, kind: 'single', name: 'N' });
  eq([m.to, m.filename, m.planRange], ['2026-12-05', 'N11.30-12.5-周报.docx', '2026.12.7-2026.12.11']);
  const y = reportDates({ start: '2026-12-28', today: '2026-12-31', anchor: A, kind: 'single', name: 'N' });
  eq([y.to, y.planRange, y.time], ['2027-01-02', '2027.1.4-2027.1.8', '2026.12.31']);
});
check('reportDates：不传 name 时文件名以数字开头；start 不是周一也归一', () => {
  eq(reportDates({ start: '2026-11-26', today: '2026-11-28', anchor: A }).filename, '11.23-11.28-周报.docx');
  eq(reportDates({ start: '2026-11-26', today: '2026-11-28', anchor: A }).from, '2026-11-23');
});
check('reportDates：非法输入', () => {
  throws(() => reportDates({ start: '2026-02-30', today: '2026-11-28' }), BAD);
  throws(() => reportDates({ start: '2026-11-23', today: 'abc' }), BAD);
  throws(() => reportDates({ start: '2026-11-23', today: '2026-11-28', anchor: '2026-13-01' }), BAD);
  throws(() => reportDates({ start: '2026-11-23', today: '2026-11-28', kind: 'triple' }), '本周类型无效');
});

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
