'use strict';
// 每周工作记录纯逻辑：拆句、下周一、周报（无 I/O，便于测试）
const { weekStart, addDays } = require('./menu');

const WEEK_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 口述文字 → 多条。按 。！？；; 和换行拆开，逗号不是分隔符；最多 max 条，多出的丢弃并标记 truncated
function splitSpoken(text, max = 5) {
  const all = String(text ?? '').split(/[。！？!?；;\n\r]+/).map(s => s.trim()).filter(Boolean);
  return { parts: all.slice(0, max), truncated: all.length > max };
}

// 该日期所在周的下一周周一
function nextMonday(date) {
  return addDays(weekStart(date), 7);
}

// M/D（不补零）
const md = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

// entries：本周的记录 [{date, text}]，输入顺序即同一天内的顺序
// doneTodos：本周完成的待办 [{date, text}]，date 是完成日期
// openTodos：全部没完成的待办 [{due_date, text}]，due_date 为空串表示没选日期
function buildReport({ start, entries, doneTodos, openTodos }) {
  if (!entries.length && !doneTodos.length) return { text: '', empty: true };
  const end = addDays(start, 6);
  const lines = [`本周工作（${md(start)} – ${md(end)}）`];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    // 同一天先列记录，再列完成的待办
    const day = [...entries.filter(e => e.date === date), ...doneTodos.filter(e => e.date === date)];
    if (!day.length) continue;
    lines.push(WEEK_NAMES[i]);
    for (const e of day) lines.push(`- ${e.text}`);
  }
  // 下周计划 = 全部没做完的待办：有日期的按日期升序（同日保持输入顺序），没日期的排最后
  const dated = openTodos.map((t, idx) => ({ t, idx })).filter(x => x.t.due_date)
    .sort((a, b) => (a.t.due_date < b.t.due_date ? -1 : a.t.due_date > b.t.due_date ? 1 : a.idx - b.idx)).map(x => x.t);
  const plan = [...dated, ...openTodos.filter(t => !t.due_date)];
  if (plan.length) {
    lines.push('下周计划');
    for (const p of plan) lines.push(`- ${p.text}`);
  }
  return { text: lines.join('\n'), empty: false };
}

module.exports = { splitSpoken, nextMonday, buildReport };
