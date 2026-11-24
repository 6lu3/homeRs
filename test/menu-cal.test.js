// 日历渲染回归测试：node test/menu-cal.test.js
const { render } = require('../public/menu-cal');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const count = (s, sub) => s.split(sub).length - 1;
const DATES = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'];
const ACCENTS = ['#7D9B76', '#C1795A', '#C29A3F', '#6C8BA0', '#B57B8E', '#8D7FB0', '#A67C52'];
// over: { '2026-11-24|lunch': ['番茄炒蛋', ...] }
function week(over = {}, dates = DATES) {
  const dishes = (d, m) => (over[`${d}|${m}`] || []).map(name => ({ id: 1, name, ingredients: [] }));
  return {
    start: dates[0], end: dates[6],
    days: dates.map(date => ({ date, meals: { breakfast: dishes(date, 'breakfast'), lunch: dishes(date, 'lunch'), dinner: dishes(date, 'dinner') } })),
  };
}
const NOT_THIS_WEEK = '2026-12-31';

// 结构
{
  const html = render(week(), NOT_THIS_WEEK);
  check('结构：7 个表头、21 个格子按钮、3 个行标签', count(html, 'class="mc-head') === 7 && count(html, 'class="mc-entry"') === 21 && count(html, 'class="mc-rl"') === 3);
  const meals = [...html.matchAll(/data-meal="(\w+)"/g)].map(m => m[1]);
  check('结构：餐次顺序是 7 个早、7 个午、7 个晚', meals.join() === [...Array(7).fill('breakfast'), ...Array(7).fill('lunch'), ...Array(7).fill('dinner')].join());
  const dates = [...html.matchAll(/data-date="([\d-]+)"/g)].map(m => m[1]);
  check('结构：每行的日期依次是周一到周日', dates.slice(0, 7).join() === DATES.join() && dates.slice(7, 14).join() === DATES.join());
}

// 今天高亮
{
  const heads = html => [...html.matchAll(/<div class="mc-head( today)?"/g)].map(m => !!m[1]);
  let html = render(week(), '2026-11-25');
  check('今天高亮：周三只有 1 个表头和 3 个格子高亮', count(html, 'mc-head today') === 1 && count(html, 'mc-cell today') === 3);
  check('今天高亮：高亮的是第 3 个表头', heads(html).indexOf(true) === 2);
  html = render(week(), NOT_THIS_WEEK);
  check('今天高亮：今天不在本周时没有任何高亮', count(html, ' today') === 0);
  html = render(week(), '2026-11-29');
  check('今天高亮：今天是周日时高亮最后一列', heads(html).indexOf(true) === 6 && count(html, 'mc-cell today') === 3);
}

// 主题色
{
  const html = render(week(), NOT_THIS_WEEK);
  const heads = [...html.matchAll(/<div class="mc-head[^"]*" style="--accent:(#[0-9A-Fa-f]{6})"/g)].map(m => m[1]);
  check('主题色：7 个表头依次是周一到周日的颜色', heads.join() === ACCENTS.join());
  const cells = [...html.matchAll(/<div class="mc-cell[^"]*" style="--accent:(#[0-9A-Fa-f]{6})"/g)].map(m => m[1]);
  check('主题色：每个格子与所在列的表头同色', cells.length === 21 && cells.every((c, i) => c === ACCENTS[i % 7]));
}

// 标签
{
  let html = render(week(), NOT_THIS_WEEK);
  check('标签：周二显示「二/周二」和「24/11.24」', html.includes('<span class="mc-s">二</span><span class="mc-l">周二</span>') && html.includes('<span class="mc-s">24</span><span class="mc-l">11.24</span>'));
  check('标签：周日显示「日/周日」', html.includes('<span class="mc-s">日</span><span class="mc-l">周日</span>'));
  check('标签：行标签是早/午/晚和早餐/午餐/晚餐', html.includes('<span class="mc-s">早</span><span class="mc-l">早餐</span>') && html.includes('<span class="mc-s">午</span><span class="mc-l">午餐</span>') && html.includes('<span class="mc-s">晚</span><span class="mc-l">晚餐</span>'));
  html = render(week({}, ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06']), NOT_THIS_WEEK);
  check('标签：个位日号短日期不补零、长日期补零（12.05）', html.includes('<span class="mc-s">5</span><span class="mc-l">12.05</span>'));
}

// aria-label
{
  const html = render(week({ '2026-11-24|lunch': ['番茄炒蛋', '清炒时蔬'] }), NOT_THIS_WEEK);
  check('aria-label：写出周几、餐次和全部菜名', html.includes('aria-label="周二 午餐：番茄炒蛋、清炒时蔬"'));
  check('aria-label：空餐写「未安排」', html.includes('aria-label="周一 早餐：未安排"'));
}

// 超过 3 道
{
  const four = ['甲', '乙', '丙', '丁'];
  let html = render(week({ '2026-11-24|lunch': four }), NOT_THIS_WEEK);
  check('超过 3 道：4 道菜都输出，另有 +1，aria-label 含全部', count(html, 'class="mc-dish"') === 4 && html.includes('<span class="mc-more">+1</span>') && html.includes('aria-label="周二 午餐：甲、乙、丙、丁"'));
  html = render(week({ '2026-11-24|lunch': ['甲', '乙', '丙'] }), NOT_THIS_WEEK);
  check('超过 3 道：恰好 3 道时没有 +N', count(html, 'mc-more') === 0 && count(html, 'class="mc-dish"') === 3);
  html = render(week({ '2026-11-24|lunch': [...four, '戊'] }), NOT_THIS_WEEK);
  check('超过 3 道：5 道时显示 +2', html.includes('<span class="mc-more">+2</span>'));
}

// 空周
{
  const html = render(week(), NOT_THIS_WEEK);
  check('空周：21 格都是「＋」、没有菜名、仍是 21 个可点按钮', count(html, 'class="mc-plus"') === 21 && count(html, 'class="mc-dish"') === 0 && count(html, 'class="mc-entry"') === 21);
}

// 转义
{
  const raw = '<b>"x"&\'';
  const esc = '&lt;b&gt;&quot;x&quot;&amp;&#39;';
  const html = render(week({ '2026-11-24|lunch': [raw] }), NOT_THIS_WEEK);
  check('转义：菜名和 aria-label 里的特殊字符都被转义', count(html, esc) === 2 && !html.includes('<b>') && !html.includes('"x"'));
  check('转义：每个 aria-label 属性都完整闭合', (html.match(/aria-label="[^"]*"/g) || []).length === 21 && count(html, 'aria-label="') === 21);
}

// 缺键
{
  const w = week();
  w.days[1].meals = { breakfast: [{ name: '粥' }] };
  let html = '', threw = false;
  try { html = render(w, NOT_THIS_WEEK); } catch (e) { threw = true; }
  check('缺键：某天缺少午、晚的键时不抛错，按空处理', !threw && count(html, 'class="mc-entry"') === 21 && count(html, 'class="mc-plus"') === 20 && count(html, 'class="mc-dish"') === 1);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
