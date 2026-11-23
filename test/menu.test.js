// 菜单纯逻辑测试：node test/menu.test.js
const { weekStart, addDays, purgeBefore, computePurchase, buildNote } = require('../lib/menu');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + e.message); }
}
function eq(got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function throws(fn) {
  try { fn(); } catch (e) { return; }
  throw new Error('应当抛错');
}

check('weekStart 周一/周日/跨月', () => {
  eq(weekStart('2026-11-23'), '2026-11-23');
  eq(weekStart('2026-11-29'), '2026-11-23');
  eq(weekStart('2026-12-01'), '2026-11-30');
});
check('weekStart 非法日期抛错', () => {
  throws(() => weekStart('2026-02-30'));
  throws(() => weekStart('abc'));
  throws(() => weekStart(''));
  try { weekStart('abc'); } catch (e) { eq(e.message, '日期格式应为 YYYY-MM-DD'); }
});
check('addDays', () => {
  eq(addDays('2026-11-30', 7), '2026-12-07');
  eq(addDays('2026-01-01', -1), '2025-12-31');
});
check('purgeBefore', () => {
  eq(purgeBefore('2026-11-23'), '2026-08-17');
  eq(purgeBefore('2026-05-31'), '2026-02-23');
});

const ing = (name, quantity = null, unit = '', item_id = null) => ({ name, item_id, quantity, unit });
const find = (arr, name, kind) => arr.find(l => l.name === name && (!kind || l.kind === kind));

const items = [
  { id: 1, name: '鸡蛋', quantity: 6, unit: '个' },
  { id: 2, name: '猪肉', quantity: 0, unit: '斤' },
  { id: 3, name: '牛奶', quantity: 1, unit: '瓶' },
  { id: 4, name: '面粉', quantity: 3, unit: 'kg' },
  { id: 5, name: '青菜', quantity: 2, unit: '把' },
  { id: 6, name: '青菜', quantity: 1, unit: '把' },
  { id: 7, name: '大米', quantity: 5, unit: 'kg' },
];

check('1 同菜两次、无数量无库存 → need servings', () => {
  const dish = { name: '番茄炒蛋', ingredients: [ing('番茄')] };
  const r = computePurchase({ dishes: [dish, dish], items, shopping: [] });
  const l = find(r.need, '番茄');
  eq(l.kind, 'servings'); eq(l.servings, 2); eq(l.quantity, null);
  eq(l.dishes, [{ name: '番茄炒蛋', count: 2 }]);
});
check('2 无数量、库存有 → enough', () => {
  const r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('鸡蛋')] }], items, shopping: [] });
  if (find(r.need, '鸡蛋')) throw new Error('不应在 need');
  if (!find(r.enough, '鸡蛋')) throw new Error('应在 enough');
});
check('3 库存数量为 0 视为没有', () => {
  const r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('猪肉')] }], items, shopping: [] });
  if (!find(r.need, '猪肉')) throw new Error('应在 need');
});
check('4 数量不足 → need 差额；充足 → enough', () => {
  let r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('牛奶', 2, '瓶')] }], items, shopping: [] });
  const l = find(r.need, '牛奶');
  eq(l.kind, 'qty'); eq(l.quantity, 1); eq(l.unit, '瓶');
  const rich = items.map(i => i.id === 3 ? { ...i, quantity: 5 } : i);
  r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('牛奶', 2, '瓶')] }], items: rich, shopping: [] });
  if (find(r.need, '牛奶') || !find(r.enough, '牛奶')) throw new Error('应在 enough');
});
check('5 单位不一致走 servings 规则', () => {
  const r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('面粉', 2, '袋')] }], items, shopping: [] });
  const l = find(r.enough, '面粉');
  if (!l) throw new Error('应在 enough');
  eq(l.kind, 'servings');
});
check('6 有数量且无库存 → need qty', () => {
  const r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('葱', 2, '把')] }], items, shopping: [] });
  const l = find(r.need, '葱');
  eq(l.kind, 'qty'); eq(l.quantity, 2); eq(l.unit, '把');
});
check('7 同名有数量与无数量分成两行', () => {
  const r = computePurchase({
    dishes: [{ name: 'A', ingredients: [ing('鸡蛋', 4, '个')] }, { name: 'B', ingredients: [ing('鸡蛋')] }],
    items, shopping: [],
  });
  const all = r.need.concat(r.enough, r.exists).filter(l => l.name === '鸡蛋');
  eq(all.length, 2);
  eq(all.map(l => l.kind).sort(), ['qty', 'servings']);
});
check('8 名称 trim 匹配；重名物品视为无库存', () => {
  let r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('  鸡蛋 ')] }], items, shopping: [] });
  if (!r.enough.length) throw new Error('应匹配到库存');
  r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('青菜')] }], items, shopping: [] });
  if (!find(r.need, '青菜')) throw new Error('匹配不唯一应进 need');
});
check('9 item_id 不存在 → 回退按名称', () => {
  const r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('鸡蛋', null, '', 999)] }], items, shopping: [] });
  if (!find(r.enough, '鸡蛋')) throw new Error('应按名称匹配到库存');
});
check('10 购物清单已有 → exists', () => {
  const r = computePurchase({ dishes: [{ name: 'A', ingredients: [ing('番茄')] }], items, shopping: [{ name: '番茄' }] });
  if (find(r.need, '番茄')) throw new Error('不应在 need');
  if (!find(r.exists, '番茄')) throw new Error('应在 exists');
});

check('buildNote', () => {
  eq(buildNote({ kind: 'servings', servings: 2, quantity: null, unit: '', dishes: [{ name: '番茄炒蛋', count: 2 }] }),
    '来自本周菜单：番茄炒蛋×2 · 共 2 份');
  eq(buildNote({ kind: 'servings', servings: 2, quantity: null, unit: '', dishes: [{ name: '番茄炒蛋', count: 1 }, { name: '青椒肉丝', count: 1 }] }),
    '来自本周菜单：番茄炒蛋、青椒肉丝 · 共 2 份');
  eq(buildNote({ kind: 'qty', servings: 1, quantity: 1, unit: '瓶', dishes: [{ name: '牛奶泡饭', count: 1 }] }),
    '来自本周菜单：牛奶泡饭 · 共 1瓶');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
