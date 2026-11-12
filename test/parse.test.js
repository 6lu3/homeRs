// 解析器回归测试：node test/parse.test.js
const { parse } = require('../lib/parse');

// 模拟一棵位置树（与预置数据一致）+ 几件已有物品
const locs = []; let id = 0;
const add = (name, parent) => { const l = { id: ++id, name, parent_id: parent ? parent.id : null, depth: parent ? parent.depth + 1 : 0, path: parent ? `${parent.path} / ${name}` : name }; locs.push(l); return l; };
const 客厅 = add('客厅'); add('电视柜', 客厅); const 茶几 = add('茶几抽屉', 客厅);
const 厨房 = add('厨房'); const 冷藏 = add('冰箱冷藏', 厨房); const 冷冻 = add('冰箱冷冻', 厨房); add('吊柜', 厨房); add('地柜', 厨房);
const 卧室 = add('卧室'); const 衣柜 = add('衣柜', 卧室); add('床头柜', 卧室);
const 卫生间 = add('卫生间'); const 镜柜 = add('镜柜', 卫生间);
const 阳台 = add('阳台'); add('储物柜', 阳台);
const 玄关 = add('玄关'); add('鞋柜', 玄关);
const items = [
  { id: 1, name: '5 号电池', quantity: 12, unit: '节', category: '日用', location_id: 茶几.id, location_path: 茶几.path },
  { id: 2, name: '创可贴', quantity: 2, unit: '盒', category: '药品', location_id: 镜柜.id, location_path: 镜柜.path },
  { id: 3, name: '速冻水饺', quantity: 2, unit: '袋', category: '食品', location_id: 冷冻.id, location_path: 冷冻.path },
  { id: 4, name: '电钻', quantity: 1, unit: '把', category: '工具', location_id: null, location_path: '' },
];
const today = new Date(2026, 10, 12); // 2026-11-12
const ctx = { locations: locs, items, today };

let pass = 0, fail = 0;
function check(text, expect) {
  const r = parse(text, ctx);
  const got = r.intents.map(i => ({
    action: i.action, name: i.name, quantity: i.quantity, unit: i.unit, category: i.category, expires_at: i.expires_at,
    loc: i.location ? (i.location.location?.path || (i.location.create ? 'NEW:' + i.location.create.path : 'UNKNOWN')) : null,
  }));
  const problems = [];
  if (!Array.isArray(expect)) expect = [expect];
  if (got.length !== expect.length) problems.push(`意图数 ${got.length} ≠ ${expect.length}`);
  expect.forEach((e, idx) => { const g = got[idx] || {}; for (const k of Object.keys(e)) if (JSON.stringify(g[k]) !== JSON.stringify(e[k])) problems.push(`[${idx}].${k}: 得到 ${JSON.stringify(g[k])}，期望 ${JSON.stringify(e[k])}`); });
  if (problems.length) { fail++; console.log(`✘ ${text}\n    ${problems.join('\n    ')}\n    实际：${JSON.stringify(got)}`); }
  else { pass++; console.log(`✔ ${text}  →  ${got.map(g => `${g.action} ${g.name}×${g.quantity}${g.unit} @${g.loc ?? '-'} [${g.category}]${g.expires_at ? ' ⏰' + g.expires_at : ''}`).join(' ; ')}`); }
}

// 新增 + 位置
check('今天买了两盒酸奶放到冷藏里', { action: 'add', name: '酸奶', quantity: 2, unit: '盒', loc: '厨房 / 冰箱冷藏', category: '食品' });
check('我买了一袋速冻汤圆放冰箱冷冻', { action: 'add', name: '速冻汤圆', quantity: 1, unit: '袋', loc: '厨房 / 冰箱冷冻', category: '食品' });
check('买了12节5号电池放在客厅茶几抽屉', { action: 'restock', name: '5号电池', quantity: 12, unit: '节', loc: '客厅 / 茶几抽屉', category: '日用' });
check('新买了一把螺丝刀放到阳台储物柜', { action: 'add', name: '螺丝刀', quantity: 1, unit: '把', loc: '阳台 / 储物柜', category: '工具' });
check('买了三鲜水饺两袋放冷冻', { action: 'add', name: '三鲜水饺', quantity: 2, unit: '袋', loc: '厨房 / 冰箱冷冻' });
// 新增无位置
check('买了一箱牛奶', { action: 'add', name: '牛奶', quantity: 1, unit: '箱', loc: null, category: '食品' });
// 多物品
check('今天买了鸡蛋、一盒黄油和两瓶酱油放冷藏', [
  { action: 'add', name: '鸡蛋', quantity: 1, loc: '厨房 / 冰箱冷藏', category: '食品' },
  { action: 'add', name: '黄油', quantity: 1, unit: '盒' },
  { action: 'add', name: '酱油', quantity: 2, unit: '瓶' },
]);
// 移动已有物品
check('我把电钻放到了阳台储物柜', { action: 'move', name: '电钻', loc: '阳台 / 储物柜', category: '工具' });
check('把创可贴放到卧室的床头柜里', { action: 'move', name: '创可贴', loc: '卧室 / 床头柜' });
check('电钻在客厅电视柜', { action: 'move', name: '电钻', loc: '客厅 / 电视柜' });
// 不存在的物品说"放到" = 新增；位置带层级
check('把体温计放到卫生间镜柜', { action: 'add', name: '体温计', loc: '卫生间 / 镜柜', category: '药品' });
// 新位置：在已有位置下新建 / 全新房间
check('把毛巾放到卫生间的第二层抽屉', { action: 'add', name: '毛巾', loc: 'NEW:卫生间 / 第二层抽屉', category: '日用' });
check('把灭火器放到车库', { action: 'add', name: '灭火器', loc: 'NEW:车库' });
check('把旧书放到书房的书架上', { action: 'add', name: '旧书', loc: 'NEW:书房 / 书架' });
// 同名物品再买 → 补货
check('又买了两盒创可贴', { action: 'restock', name: '创可贴', quantity: 2, unit: '盒' });
check('买了一袋速冻水饺放冷冻', { action: 'restock', name: '速冻水饺', quantity: 1 });
// 消耗 / 用完 / 设数量
check('吃了一袋速冻水饺', { action: 'consume', name: '速冻水饺', quantity: 1, unit: '袋' });
check('创可贴用了一盒', { action: 'consume', name: '创可贴', quantity: 1, unit: '盒' });
check('拿了两节电池', { action: 'consume', name: '电池', quantity: 2, unit: '节' });
check('创可贴用完了', { action: 'deplete', name: '创可贴' });
check('速冻水饺还剩一袋', { action: 'set_quantity', name: '速冻水饺', quantity: 1, unit: '袋' });
check('电池还有8节', { action: 'set_quantity', name: '电池', quantity: 8, unit: '节' });
// 到期
check('买了一盒牛奶放冷藏，保质期到12月1日', { action: 'add', name: '牛奶', loc: '厨房 / 冰箱冷藏', expires_at: '2026-12-01' });
check('买了面包放吊柜，三天后过期', { action: 'add', name: '面包', loc: '厨房 / 吊柜', expires_at: '2026-11-15' });
check('买了两罐奶粉放地柜 保质期一年', { action: 'add', name: '奶粉', quantity: 2, unit: '罐', loc: '厨房 / 地柜', expires_at: '2027-11-12' });
check('速冻水饺保质期到2027年3月1日', { action: 'expire', name: '速冻水饺', expires_at: '2027-03-01' });
check('三天前买的面包放吊柜', { action: 'add', name: '面包', loc: '厨房 / 吊柜', expires_at: '' });
// 兜底
check('感冒药', { action: 'add', name: '感冒药', category: '药品', loc: null });

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
