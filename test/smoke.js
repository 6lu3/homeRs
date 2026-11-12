// API 冒烟测试：node test/smoke.js  （需服务已在 3000 端口运行）
const BASE = process.env.BASE || 'http://localhost:3000';
let cookie = '';
async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, { method, headers: { cookie, ...headers }, body });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}
const json = (m, p, o) => call(m, p, JSON.stringify(o), { 'content-type': 'application/json' });
const assert = (c, msg) => { if (!c) throw new Error('FAIL: ' + msg); console.log('ok  ', msg); };

(async () => {
  let r = await call('GET', '/api/items');
  assert(r.status === 401, '未登录访问被拒绝');
  r = await json('POST', '/api/login', { password: 'wrong' });
  assert(r.status === 401, '错误密码被拒绝');
  r = await json('POST', '/api/login', { password: 'home1234' });
  assert(r.status === 200 && cookie, '登录成功并获得会话');

  r = await call('GET', '/api/locations');
  assert(r.status === 200 && r.body.length > 0, `预置位置 ${r.body.length} 个`);
  const kitchen = r.body.find(l => l.name === '厨房');
  const fridge = r.body.find(l => l.name === '冰箱冷藏');
  assert(fridge.path === '厨房 / 冰箱冷藏' && fridge.depth === 1, '位置路径正确');

  r = await json('POST', '/api/locations', { name: '第二层', parent_id: fridge.id });
  assert(r.status === 201 && r.body.path === '厨房 / 冰箱冷藏 / 第二层', '新增三级位置');
  const shelf = r.body;

  r = await json('POST', '/api/items', { name: '酸奶', category: '食品', quantity: 6, unit: '瓶', location_id: shelf.id, expires_at: '2026-11-15', note: '测试' });
  assert(r.status === 201 && r.body.location_path === '厨房 / 冰箱冷藏 / 第二层', '新增物品');
  const item = r.body;
  r = await json('POST', '/api/items', { name: '', quantity: 1 });
  assert(r.status === 400, '空名称被拒绝');

  r = await json('PUT', `/api/items/${item.id}`, { quantity: 5 });
  assert(r.body.quantity === 5 && r.body.name === '酸奶', '局部更新数量');

  r = await call('GET', '/api/items?q=酸');
  assert(r.body.some(i => i.id === item.id), '搜索命中');
  r = await call('GET', `/api/items?location=${kitchen.id}`);
  assert(r.body.some(i => i.id === item.id), '按上级位置筛选包含下级');
  r = await call('GET', '/api/items?expiring=7');
  assert(r.body.some(i => i.id === item.id), '到期筛选');

  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  r = await call('POST', `/api/items/${item.id}/image`, png, { 'content-type': 'image/png' });
  assert(r.status === 200 && r.body.image, '上传图片');
  const img = await fetch(BASE + '/uploads/' + r.body.image, { headers: { cookie } });
  assert(img.status === 200 && img.headers.get('content-type') === 'image/png', '读取图片');

  r = await json('DELETE', `/api/locations/${shelf.id}`);
  assert(r.status === 400, '有物品的位置不能删除');

  r = await call('GET', '/api/export.csv');
  assert(r.status === 200 && r.body.includes('酸奶') && r.body.includes('厨房 / 冰箱冷藏 / 第二层'), '导出 CSV');

  const csv = '名称,分类,数量,单位,位置,到期日,备注\r\n"创可贴, 大号",药品,2,盒,卫生间 / 镜柜 / 上层,2027/01/01,"带""引号"""\r\n螺丝刀,工具,1,把,阳台 / 储物柜,,\r\n';
  r = await call('POST', '/api/import', csv, { 'content-type': 'text/csv' });
  assert(r.status === 200 && r.body.imported === 2 && r.body.errors.length === 0, '导入 CSV');
  r = await call('GET', '/api/items?q=创可贴');
  assert(r.body[0].name === '创可贴, 大号' && r.body[0].location_path === '卫生间 / 镜柜 / 上层' && r.body[0].expires_at === '2027-01-01' && r.body[0].note === '带"引号"', '导入内容与自动创建位置正确');

  r = await call('GET', '/api/stats');
  assert(r.body.items >= 3, `统计：${JSON.stringify(r.body)}`);

  // 一句话解析
  r = await json('POST', '/api/parse', { text: '今天买了两盒酸奶放到冷藏里，保质期到12月1日' });
  assert(r.status === 200 && r.body.intents.length === 1, '解析接口返回意图');
  const pi = r.body.intents[0];
  assert(pi.action === 'add' && pi.existing?.name === '酸奶' && pi.quantity === 2 && pi.unit === '盒' && pi.location.location.path === '厨房 / 冰箱冷藏' && /-12-01$/.test(pi.expires_at), `解析：${pi.action}（已有同名物品在别处）${pi.name}×${pi.quantity}${pi.unit} @${pi.location.location.path} ⏰${pi.expires_at}`);
  r = await json('POST', '/api/parse', { text: '把灭火器放到车库' });
  assert(r.body.intents[0].action === 'add' && r.body.intents[0].location.create.path === '车库', '解析：未知位置建议新建');
  r = await json('POST', '/api/parse', { text: '' });
  assert(r.status === 400, '空句子被拒绝');
  r = await json('POST', '/api/locations/path', { path: '书房 / 书架 / 第二层' });
  assert(r.status === 200 && r.body.path === '书房 / 书架 / 第二层' && r.body.depth === 2, '按路径逐级创建位置');
  const study = (await call('GET', '/api/locations')).body.find(l => l.path === '书房');
  await call('DELETE', `/api/locations/${study.id}`);

  // 图纸与标记
  r = await call('POST', '/api/plans?name=' + encodeURIComponent('一楼'), png, { 'content-type': 'image/png' });
  assert(r.status === 201 && r.body.name === '一楼' && r.body.image.startsWith('plan-'), '上传图纸');
  const plan = r.body;
  r = await json('PUT', `/api/locations/${fridge.id}`, { plan_id: plan.id, x: 33.3, y: 60 });
  assert(r.status === 200 && r.body.plan_id === plan.id && r.body.x === 33.3, '把位置标记到图纸上');
  r = await json('PUT', `/api/locations/${fridge.id}`, { plan_id: plan.id, x: 150, y: 0 });
  assert(r.status === 400, '越界坐标被拒绝');
  r = await json('PUT', `/api/locations/${fridge.id}`, { x: 40, y: 41 });
  assert(r.body.x === 40 && r.body.name === '冰箱冷藏', '拖动更新坐标且不影响名称');
  r = await call('GET', '/api/locations');
  const k = r.body.find(l => l.id === kitchen.id);
  assert(k.item_count === 0 && k.item_count_total >= 1, `上级位置含下级物品数：${k.item_count_total}`);
  r = await call('GET', '/api/plans');
  assert(r.body.find(p => p.id === plan.id).pins === 1, '图纸标记数统计');
  r = await json('PUT', `/api/plans/${plan.id}`, { name: '二楼' });
  assert(r.body.name === '二楼', '图纸重命名');
  r = await json('PUT', `/api/locations/${fridge.id}`, { plan_id: null });
  assert(r.body.plan_id === null && r.body.x === null, '移除标记');
  await json('PUT', `/api/locations/${fridge.id}`, { plan_id: plan.id, x: 1, y: 1 });
  r = await json('DELETE', `/api/plans/${plan.id}`);
  assert(r.status === 200 && (await call('GET', '/api/locations')).body.find(l => l.id === fridge.id).plan_id === null, '删除图纸后标记自动清除');

  // 最低库存 / 购物清单 / 日志 / 回收站
  const yogurt = (await call('GET', '/api/items')).body.find(i => i.name === '酸奶');
  r = await json('PUT', `/api/items/${yogurt.id}`, { min_quantity: 10 });
  assert(r.body.min_quantity === 10, '设置最低库存');
  r = await call('GET', '/api/items?low=1');
  assert(r.body.some(i => i.id === yogurt.id), '低库存筛选');
  r = await call('GET', '/api/shopping');
  const lowRow = r.body.low.find(i => i.id === yogurt.id);
  assert(lowRow && lowRow.need === 5, `购物清单自动列出缺货（还差 ${lowRow?.need}）`);
  r = await json('POST', `/api/items/${yogurt.id}/bought`, {});
  assert(r.body.quantity === 10, '「已买」补到最低库存');
  assert(!(await call('GET', '/api/shopping')).body.low.some(i => i.id === yogurt.id), '补货后自动离开清单');
  r = await json('POST', '/api/shopping', { name: '垃圾袋' });
  const extraId = r.body.id;
  r = await json('PUT', `/api/shopping/${extraId}`, { done: true });
  assert(r.body.done === 1, '手动条目勾选');
  r = await call('DELETE', '/api/shopping');
  assert(r.body.removed >= 1, '清除已买条目');
  r = await call('GET', `/api/log?item=${yogurt.id}`);
  const acts = r.body.map(x => x.action);
  assert(acts.includes('create') && acts.includes('quantity') && acts.includes('update') && r.body.some(x => x.source === 'list'), `变动日志：${[...new Set(acts)].join('/')}`);
  r = await call('GET', '/api/dashboard');
  assert(r.body.counts && Array.isArray(r.body.recent) && r.body.recent.some(i => i.id === yogurt.id) && r.body.log.length > 0, '首页仪表盘');
  r = await call('DELETE', `/api/items/${yogurt.id}`);
  assert(r.status === 200 && !(await call('GET', '/api/items')).body.some(i => i.id === yogurt.id), '删除进回收站');
  r = await call('GET', '/api/trash');
  assert(r.body.some(i => i.id === yogurt.id), '回收站可见');
  r = await call('POST', `/api/items/${yogurt.id}/restore`);
  assert(r.status === 200 && (await call('GET', '/api/items')).body.some(i => i.id === yogurt.id), '恢复');
  r = await json('PUT', `/api/items/${yogurt.id}`, { quantity: 0 });
  assert(r.body.auto_deleted === true && !(await call('GET', '/api/items')).body.some(i => i.id === yogurt.id) && (await call('GET', '/api/trash')).body.some(i => i.id === yogurt.id), '数量归零自动进回收站');
  r = await call('DELETE', `/api/items/${yogurt.id}?purge=1`);
  assert(r.status === 200 && !(await call('GET', '/api/trash')).body.some(i => i.id === yogurt.id), '彻底删除');

  // 清理（只删本测试创建的数据）
  for (const i of (await call('GET', '/api/items')).body) if (['酸奶', '创可贴, 大号', '螺丝刀'].includes(i.name)) await call('DELETE', `/api/items/${i.id}?purge=1`);
  r = await json('DELETE', `/api/locations/${shelf.id}`);
  assert(r.status === 200, '删除空位置');
  const bath = (await call('GET', '/api/locations')).body.find(l => l.path === '卫生间 / 镜柜 / 上层');
  await call('DELETE', `/api/locations/${bath.id}`);
  r = await call('POST', '/api/logout');
  r = await call('GET', '/api/items');
  assert(r.status === 401, '退出登录后失效');
  console.log('\n全部通过');
})().catch(e => { console.error(e.message); process.exit(1); });
