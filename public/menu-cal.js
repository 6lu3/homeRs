// 每周菜单：日历式网格的 HTML 渲染（纯函数，浏览器和 Node 通用）
// 浏览器里是 window.MenuCal.render，Node 里是 require('./menu-cal').render
(function (root) {
  'use strict';
  // 周一到周日的主题色（与 days[0] 是周一对应）
  const ACCENTS = ['#7D9B76', '#C1795A', '#C29A3F', '#6C8BA0', '#B57B8E', '#8D7FB0', '#A67C52'];
  const WEEK_CHAR = ['日', '一', '二', '三', '四', '五', '六']; // 下标 = getDay()
  const MEALS = [['breakfast', '早'], ['lunch', '午'], ['dinner', '晚']];
  const MORE_AFTER = 3; // 手机上最多显示 3 道，由 CSS 隐藏后面的

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = n => String(n).padStart(2, '0');
  // 本地日期，不用 toISOString，避免时区差一天
  function parts(date) {
    const [y, m, d] = date.split('-').map(Number);
    return { m, d, dow: new Date(y, m - 1, d).getDay() };
  }
  // 手机用短标签、宽屏用长标签，显示哪个由 CSS 决定
  const both = (short, long) => `<span class="mc-s">${short}</span><span class="mc-l">${long}</span>`;

  function render(week, today) {
    const days = week.days.map(day => ({ day, ...parts(day.date) }));
    let html = '<div class="mc"><div class="mc-corner"></div>';
    days.forEach(({ day, m, d, dow }, i) => {
      html += `<div class="mc-head${day.date === today ? ' today' : ''}" style="--accent:${ACCENTS[i]}">` +
        `<span class="mc-cn">${both(WEEK_CHAR[dow], '周' + WEEK_CHAR[dow])}</span>` +
        `<span class="mc-dt">${both(d, `${m}.${pad2(d)}`)}</span></div>`;
    });
    MEALS.forEach(([key, ch]) => {
      html += `<div class="mc-rl">${both(ch, ch + '餐')}</div>`;
      days.forEach(({ day, dow }, i) => {
        const names = ((day.meals && day.meals[key]) || []).map(x => esc(x.name));
        const label = `周${WEEK_CHAR[dow]} ${ch}餐：${names.join('、') || '未安排'}`;
        const inner = names.length
          ? names.map(n => `<span class="mc-dish">${n}</span>`).join('') + (names.length > MORE_AFTER ? `<span class="mc-more">+${names.length - MORE_AFTER}</span>` : '')
          : '<span class="mc-plus">＋</span>';
        html += `<div class="mc-cell${day.date === today ? ' today' : ''}" style="--accent:${ACCENTS[i]}">` +
          `<button type="button" class="mc-entry" data-date="${esc(day.date)}" data-meal="${key}" aria-label="${label}">${inner}</button></div>`;
      });
    });
    return html + '</div>';
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { render };
  else root.MenuCal = { render };
})(typeof window !== 'undefined' ? window : globalThis);
