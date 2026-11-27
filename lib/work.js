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

// entries：本周记录 [{date, kind, text, done}]，输入顺序即同一天内的顺序
// nextWeekTodos：落在下一周的未完成待办 [{date, text}]（由调用方筛好）
function buildReport({ start, entries, nextWeekTodos }) {
  if (!entries.length) return { text: '', empty: true };
  const end = addDays(start, 6);
  const lines = [`本周工作（${md(start)} – ${md(end)}）`];
  // 已做 = 类型为已做，或已勾选完成的待办
  const doneIn = entries.filter(e => e.kind === 'done' || e.done);
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const day = doneIn.filter(e => e.date === date);
    if (!day.length) continue;
    lines.push(WEEK_NAMES[i]);
    for (const e of day) lines.push(`- ${e.text}`);
  }
  const plan = [
    ...entries.filter(e => e.kind === 'todo' && !e.done),
    ...nextWeekTodos
      .map((t, idx) => ({ t, idx }))
      .sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.idx - b.idx))
      .map(x => x.t),
  ];
  if (plan.length) {
    lines.push('下周计划');
    for (const p of plan) lines.push(`- ${p.text}`);
  }
  return { text: lines.join('\n'), empty: false };
}

module.exports = { splitSpoken, nextMonday, buildReport };
