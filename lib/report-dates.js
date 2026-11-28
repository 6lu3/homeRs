'use strict';
// 大小周日期规则（无 I/O）。公司大小周：单休周周六上班，双休周周六休息。
// 周六生成周报 = 本周单休（下周双休），周五生成 = 本周双休（下周单休）；其他日子按单双周交替推。
const { weekStart, addDays } = require('./menu');

const DEFAULT_ANCHOR = '2026-11-23';   // 某个单休周的周一
const DAY_MS = 86400000;
const parts = s => { weekStart(s); return s.split('-').map(Number); };   // weekStart 顺带校验日期，非法抛「日期格式应为 YYYY-MM-DD」
const utc = s => { const [y, m, d] = parts(s); return Date.UTC(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((utc(b) - utc(a)) / DAY_MS);

// 2026-12-04 → 2026.12.4（月日不补零，与公司周报写法一致）
function fmtDot(date) {
  const [y, m, d] = parts(date);
  return `${y}.${m}.${d}`;
}
const md = date => { const [, m, d] = parts(date); return `${m}.${d}`; };

// 本周是单休还是双休。today 落在该周内：周六 ⇒ single，周五 ⇒ double；否则按与基准周的奇偶
function restKind({ start, today, anchor = DEFAULT_ANCHOR }) {
  const mon = weekStart(start);
  const anchorMon = weekStart(anchor);   // 先校验：哪怕下面按当天直接判断，非法的基准日也要报错
  const off = dayDiff(mon, today);
  if (off >= 0 && off <= 6) {
    const dow = new Date(utc(today)).getUTCDay();
    if (dow === 6) return 'single';
    if (dow === 5) return 'double';
  }
  const weeks = Math.round(dayDiff(anchorMon, mon) / 7);
  return ((weeks % 2) + 2) % 2 === 0 ? 'single' : 'double';
}

function reportDates({ start, today, anchor = DEFAULT_ANCHOR, kind, name = '' }) {
  const from = weekStart(start);
  parts(today);
  weekStart(anchor);
  if (kind != null && kind !== '' && kind !== 'single' && kind !== 'double') throw new Error('本周类型无效');
  const k = kind || restKind({ start: from, today, anchor });
  const to = addDays(from, k === 'single' ? 5 : 4);          // 单休：周一到周六；双休：周一到周五
  const nextMon = addDays(from, 7);
  const planEnd = addDays(nextMon, k === 'single' ? 4 : 5);  // 本周单休 ⇒ 下周双休 ⇒ 到周五；本周双休 ⇒ 下周单休 ⇒ 到周六
  return {
    kind: k, from, to, time: fmtDot(today),
    planRange: `${fmtDot(nextMon)}-${fmtDot(planEnd)}`,
    filename: `${name}${md(from)}-${md(to)}-周报.docx`,
  };
}

module.exports = { DEFAULT_ANCHOR, fmtDot, restKind, reportDates };
