'use strict';
// 学习计划纯逻辑：天数、覆盖、进度、按月布局（无 I/O，便于测试）

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_MS = 86400000;
const BAD_DATE = '日期格式应为 YYYY-MM-DD';

// YYYY-MM-DD → UTC 毫秒；用真实日历校验，非法返回 NaN
function toMs(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) return NaN;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const c = new Date(t);
  return c.getUTCFullYear() === y && c.getUTCMonth() === mo - 1 && c.getUTCDate() === d ? t : NaN;
}
function ms(s) {
  const t = toMs(s);
  if (Number.isNaN(t)) throw new Error(BAD_DATE);
  return t;
}
const isDate = s => !Number.isNaN(toMs(s));

// 含首尾的天数；结束早于开始为 0
function daysBetween(start, end) {
  const a = ms(start), b = ms(end);
  return b < a ? 0 : Math.round((b - a) / DAY_MS) + 1;
}

function itemsOnDate(items, date) {
  const t = ms(date);
  return items.filter(i => ms(i.start_date) <= t && t <= ms(i.end_date));
}

// 开始日晚于 date 的项，按开始日升序（同日保持输入顺序），最多 limit 项
function upcoming(items, date, limit = 3) {
  const t = ms(date);
  return items
    .map((it, idx) => ({ it, idx, s: ms(it.start_date) }))
    .filter(x => x.s > t)
    .sort((a, b) => a.s - b.s || a.idx - b.idx)
    .slice(0, limit)
    .map(x => x.it);
}

// total 共几天；done 范围内已勾选的天数；dayIndex date 是第几天（范围外为 null）；
// missed 范围内早于 today 且没勾选的天数
function progress(item, checkedDates, date, today) {
  const s = ms(item.start_date), e = ms(item.end_date), d = ms(date), td = ms(today);
  const checked = new Set();
  for (const c of checkedDates) {
    const t = toMs(c);
    if (!Number.isNaN(t) && t >= s && t <= e) checked.add(t);
  }
  const total = e < s ? 0 : Math.round((e - s) / DAY_MS) + 1;
  let missed = 0;
  for (let t = s; t <= e && t < td; t += DAY_MS) if (!checked.has(t)) missed++;
  return {
    total,
    done: checked.size,
    dayIndex: d >= s && d <= e ? Math.round((d - s) / DAY_MS) + 1 : null,
    missed,
  };
}

// 该月内每个项占的日号；只含与该月有交集的项
function monthLayout(items, month) {
  const m = typeof month === 'string' ? MONTH_RE.exec(month) : null;
  if (!m || +m[2] < 1 || +m[2] > 12) throw new Error('月份格式应为 YYYY-MM');
  const y = +m[1], mo = +m[2];
  const first = Date.UTC(y, mo - 1, 1);
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const last = Date.UTC(y, mo - 1, n);
  const out = [];
  for (const it of items) {
    const s = Math.max(ms(it.start_date), first), e = Math.min(ms(it.end_date), last);
    if (s > e) continue;
    const days = [];
    for (let t = s; t <= e; t += DAY_MS) days.push(new Date(t).getUTCDate());
    out.push({ id: it.id, days });
  }
  return out;
}

module.exports = { isDate, daysBetween, itemsOnDate, upcoming, progress, monthLayout };
