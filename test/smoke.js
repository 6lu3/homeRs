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
  r = await call('GET', '/api/receipt/status');
  assert(r.status === 401, '未登录访问小票识别状态被拒绝');
  r = await call('GET', '/api/asr/status');
  assert(r.status === 401, '未登录访问语音识别状态被拒绝');
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

  // ---- 每周菜单 ----
  {
    const W = '2030-01-07', W2 = '2030-01-08';
    const saved = cookie; cookie = '';
    r = await call('GET', `/api/menu/week?start=${W}`);
    assert(r.status === 401, '菜单：未登录被拒绝');
    cookie = saved;
    for (const [d, m] of [[W, 'lunch'], [W2, 'dinner']]) await json('PUT', '/api/menu/meal', { date: d, meal: m, dishes: [] });
    r = await call('GET', '/api/menu/week?start=2030-01-10');
    assert(r.status === 200 && r.body.start === W && r.body.end === '2030-01-13' && r.body.days.length === 7 && Array.isArray(r.body.days[0].meals.lunch) && r.body.days[0].meals.lunch.length === 0, '菜单：周四归一到周一，7 天');
    r = await call('GET', '/api/menu/week?start=abc');
    assert(r.status === 400, '菜单：非法 start 400');
    r = await json('PUT', '/api/menu/meal', { date: '2030-13-45', meal: 'lunch', dishes: [] });
    assert(r.status === 400, '菜单：非法 date 400');
    r = await json('PUT', '/api/menu/meal', { date: W, meal: 'brunch', dishes: [] });
    assert(r.status === 400, '菜单：非法餐次 400');
    r = await json('PUT', '/api/menu/meal', { date: W, meal: 'lunch', dishes: [{ name: '番茄炒蛋', ingredients: [{ name: '番茄' }, { name: '鸡蛋', quantity: 4, unit: '个' }] }, { name: '   ' }] });
    assert(r.status === 200 && r.body.length === 1 && r.body[0].ingredients.length === 2, '菜单：保存一餐，空名菜被丢弃');
    r = await call('GET', `/api/menu/week?start=${W}`);
    assert(r.body.days[0].meals.lunch[0].name === '番茄炒蛋', '菜单：读回已保存的菜');
    r = await json('PUT', '/api/menu/meal', { date: W, meal: 'lunch', dishes: [{ name: 'x', ingredients: [{ name: 'y', quantity: -1 }] }] });
    assert(r.status === 400, '菜单：负数数量 400');
    r = await json('PUT', '/api/menu/meal', { date: W, meal: 'lunch', dishes: [{ name: 'x', ingredients: [{ name: 'y', quantity: 'abc' }] }] });
    assert(r.status === 400, '菜单：非数字数量 400');
    r = await call('GET', `/api/menu/week?start=${W}`);
    assert(r.body.days[0].meals.lunch[0].name === '番茄炒蛋', '菜单：校验失败不改动原数据');
    r = await json('PUT', '/api/menu/meal', { date: W, meal: 'lunch', dishes: [{ name: '青菜' }] });
    assert(r.status === 200 && r.body.length === 1 && r.body[0].name === '青菜', '菜单：整餐替换');
    r = await json('PUT', '/api/menu/meal', { date: W, meal: 'lunch', dishes: [] });
    assert(r.status === 200 && Array.isArray(r.body) && r.body.length === 0 && (await call('GET', `/api/menu/week?start=${W}`)).body.days[0].meals.lunch.length === 0, '菜单：清空一餐');

    assert(!(await call('GET', '/api/items?q=番茄')).body.length, '菜单：库存里没有番茄（前置）');
    const tomato = [{ name: '番茄炒蛋', ingredients: [{ name: '番茄' }, { name: '鸡蛋', quantity: 4, unit: '个' }] }];
    await json('PUT', '/api/menu/meal', { date: W, meal: 'lunch', dishes: tomato });
    await json('PUT', '/api/menu/meal', { date: W2, meal: 'dinner', dishes: tomato });
    r = await call('GET', `/api/menu/suggest?q=${encodeURIComponent('番茄')}`);
    assert(r.status === 200 && r.body[0].name === '番茄炒蛋' && r.body[0].ingredients.some(i => i.name === '番茄'), '菜单：菜名联想带出食材');
    r = await json('POST', '/api/menu/purchase/preview', { start: W });
    assert(r.status === 200 && r.body.need.some(l => l.name === '番茄' && l.servings === 2), '菜单：采购预览需买番茄×2');
    r = await json('POST', '/api/menu/purchase', { lines: [{ name: '番茄', note: '来自本周菜单：番茄炒蛋×2 · 共 2 份' }] });
    assert(r.status === 200 && r.body.added === 1 && r.body.skipped === 0, '菜单：加入购物清单');
    r = await json('POST', '/api/menu/purchase', { lines: [{ name: '番茄', note: 'x' }] });
    assert(r.body.added === 0 && r.body.skipped === 1, '菜单：重复加入被跳过');
    r = await call('GET', '/api/shopping');
    const tom = r.body.extra.find(e => e.name === '番茄');
    assert(tom && tom.note.startsWith('来自本周菜单'), '菜单：购物清单里有番茄');
    if (tom) await call('DELETE', `/api/shopping/${tom.id}`);
    r = await json('POST', '/api/menu/purchase', { lines: [{ name: '菜单合并测试', note: '甲' }, { name: ' 菜单合并测试 ', note: '乙' }] });
    assert(r.status === 200 && r.body.added === 1 && r.body.skipped === 0, '菜单：同请求同名行合并为一条');
    r = await call('GET', '/api/shopping');
    const mg = r.body.extra.filter(e => e.name === '菜单合并测试');
    assert(mg.length === 1 && mg[0].note === '甲；乙', '菜单：合并后备注用「；」连接');
    for (const e of mg) await call('DELETE', `/api/shopping/${e.id}`);
    r = await json('POST', '/api/menu/purchase/preview', { start: '2030-02-04' });
    assert(r.body.need.length === 0 && r.body.enough.length === 0 && r.body.exists.length === 0, '菜单：空周预览为空');

    r = await json('POST', '/api/items', { name: '菜单测试物品', quantity: 1 });
    const tmpItem = r.body;
    await json('PUT', '/api/menu/meal', { date: W, meal: 'lunch', dishes: [{ name: '番茄炒蛋', ingredients: [{ name: '菜单测试物品', item_id: tmpItem.id }] }] });
    await call('DELETE', `/api/items/${tmpItem.id}?purge=1`);
    r = await call('GET', `/api/menu/week?start=${W}`);
    assert(r.status === 200 && r.body.days[0].meals.lunch[0].ingredients[0].item_id === null, '菜单：物品被彻底删除后食材 item_id 置空');
    for (const [d, m] of [[W, 'lunch'], [W2, 'dinner']]) await json('PUT', '/api/menu/meal', { date: d, meal: m, dishes: [] });
  }

  // 学习计划（用远期日期，避免撞到真实数据）
  {
    // 成员：固定两位，可改名
    r = await call('GET', '/api/study/members');
    assert(r.status === 200 && r.body.length === 2, '学习成员：默认有两位');
    const [m1, m2] = r.body;
    const oldName = m1.name;
    try {
      r = await json('PUT', `/api/study/members/${m1.id}`, { name: '  冒烟成员  ' });
      assert(r.status === 200 && r.body.name === '冒烟成员', '学习成员：改名并去掉首尾空白');
      r = await json('PUT', `/api/study/members/${m1.id}`, { name: '   ' });
      assert(r.status === 400 && r.body.error === '名称不能为空', '学习成员：空名被拒绝');
      r = await json('PUT', `/api/study/members/${m1.id}`, { name: 'x'.repeat(21) });
      assert(r.status === 400 && r.body.error === '名称最长 20 字', '学习成员：超过 20 字被拒绝');
      r = await json('PUT', `/api/study/members/${m1.id}`, { name: 'y'.repeat(20) });
      assert(r.status === 200, '学习成员：恰好 20 字可以');
      r = await json('PUT', '/api/study/members/999999', { name: '甲' });
      assert(r.status === 404 && r.body.error === '成员不存在', '学习成员：不存在返回 404');
      r = await call('GET', '/api/study/members');
      assert(r.body[0].name === 'y'.repeat(20), '学习成员：失败的改名请求没有改动名字');
    } finally {
      r = await json('PUT', `/api/study/members/${m1.id}`, { name: oldName });  // 无论中途断言是否失败都改回
    }
    assert(r.status === 200 && r.body.name === oldName, '学习成员：名字已改回');

    const P = { name: '冒烟学习计划', member_id: m1.id, start_date: '2031-01-01', end_date: '2031-06-30' };
    r = await json('POST', '/api/study/plans', { ...P, member_id: undefined });
    assert(r.status === 400 && r.body.error === '成员不存在', '学习计划：缺 member_id 被拒绝');
    r = await json('POST', '/api/study/plans', { ...P, member_id: 999999 });
    assert(r.status === 400 && r.body.error === '成员不存在', '学习计划：member_id 不存在被拒绝');
    r = await call('GET', '/api/study/plans?member=abc');
    assert(r.status === 400, '学习计划：plans 的 member 参数非法被拒绝');
    r = await call('GET', '/api/study/items?member=abc');
    assert(r.status === 400, '学习计划：items 的 member 参数非法被拒绝');
    for (const q of ['', '&member=abc', '&member=999999', '&member=0']) {
      r = await call('GET', `/api/study/day?date=2031-03-03${q}`);
      assert(r.status === 400 && r.body.error === '成员不存在', `学习计划：day 的 member 缺失或非法被拒绝（${q || '缺失'}）`);
      r = await call('GET', `/api/study/month?month=2031-03${q}`);
      assert(r.status === 400 && r.body.error === '成员不存在', `学习计划：month 的 member 缺失或非法被拒绝（${q || '缺失'}）`);
    }

    r = await json('POST', '/api/study/plans', { ...P, name: '  ' });
    assert(r.status === 400 && r.body.error === '名称不能为空', '学习计划：空名称被拒绝');
    r = await json('POST', '/api/study/plans', { ...P, end_date: '2030-12-31' });
    assert(r.status === 400 && r.body.error === '结束日期不能早于开始日期', '学习计划：结束早于开始被拒绝');
    r = await json('POST', '/api/study/plans', { ...P, start_date: '2031-02-30' });
    assert(r.status === 400 && r.body.error === '日期格式应为 YYYY-MM-DD', '学习计划：非法日期被拒绝');
    r = await json('POST', '/api/study/plans', P);
    assert(r.status === 200 && r.body.id > 0, '学习计划：新建大计划');
    const plan = r.body;
    r = await json('POST', '/api/study/plans', { ...P, name: '冒烟学习计划乙' });
    const plan2 = r.body;

    const I = { plan_id: plan.id, name: 'Python 基础', start_date: '2031-03-01', end_date: '2031-03-10', note: '第一章起' };
    r = await json('POST', '/api/study/items', { ...I, plan_id: 999999 });
    assert(r.status === 400 && r.body.error === '大计划不存在', '学习计划：学习项的大计划不存在被拒绝');
    r = await json('POST', '/api/study/items', { ...I, name: '' });
    assert(r.status === 400, '学习计划：学习项空名称被拒绝');
    r = await json('POST', '/api/study/items', I);
    assert(r.status === 200 && r.body.id > 0, '学习计划：新建学习项');
    const it = r.body;
    r = await json('POST', '/api/study/items', { ...I, name: '超出范围的项', start_date: '2032-01-01', end_date: '2032-01-05' });
    assert(r.status === 200, '学习计划：学习项日期可超出大计划范围');
    const itOut = r.body;
    r = await json('POST', '/api/study/items', { ...I, plan_id: plan2.id, name: '乙的项' });
    const itB = r.body;
    r = await json('POST', '/api/study/items', { ...I, name: '后面的项', start_date: '2031-03-20', end_date: '2031-03-25' });
    const itLater = r.body;

    // 某天要学什么
    r = await call('GET', `/api/study/day?date=2031-03-03&member=${m1.id}`);
    const mine = r.body.items.find(x => x.id === it.id);
    assert(r.status === 200 && mine && mine.dayIndex === 3 && mine.total === 10 && mine.checked === false && mine.done === 0, '学习计划：当天列出覆盖它的项，第 3 天 / 共 10 天');
    assert(mine.plan_name === '冒烟学习计划' && mine.note === '第一章起', '学习计划：当天返回大计划名和备注');
    assert(!r.body.items.some(x => x.id === itLater.id), '学习计划：范围外的项不在当天列表');
    assert(r.body.upcoming.some(x => x.id === itLater.id), '学习计划：开始日在后的项出现在即将开始');
    r = await call('GET', '/api/study/day');
    assert(r.status === 400, '学习计划：缺 date 被拒绝');
    r = await call('GET', `/api/study/day?date=2031-02-30&member=${m1.id}`);
    assert(r.status === 400, '学习计划：非法 date 被拒绝');

    // 勾选
    r = await json('PUT', '/api/study/check', { item_id: it.id, date: '2031-03-03', checked: true });
    assert(r.status === 200 && r.body.checked === true, '学习计划：范围内勾选成功');
    await json('PUT', '/api/study/check', { item_id: it.id, date: '2031-03-03', checked: true });
    r = await call('GET', `/api/study/day?date=2031-03-03&member=${m1.id}`);
    let m = r.body.items.find(x => x.id === it.id);
    assert(m.checked === true && m.done === 1, '学习计划：重复勾选不产生重复记录');
    r = await json('PUT', '/api/study/check', { item_id: it.id, date: '2031-03-11', checked: true });
    assert(r.status === 400 && r.body.error === '这一天不在该学习项的日期范围内', '学习计划：范围外勾选被拒绝');
    r = await call('GET', `/api/study/day?date=2031-03-03&member=${m1.id}`);
    assert(r.body.items.find(x => x.id === it.id).done === 1, '学习计划：被拒绝的勾选没有写入');
    r = await json('PUT', '/api/study/check', { item_id: it.id, date: '2031-03-03', checked: 'true' });
    assert(r.status === 400, '学习计划：checked 不是布尔值被拒绝');
    r = await call('GET', `/api/study/day?date=2031-03-03&member=${m1.id}`);
    assert(r.body.items.find(x => x.id === it.id).done === 1, '学习计划：checked 格式错误时不会误删已有勾选');
    r = await json('PUT', '/api/study/check', { item_id: 999999, date: '2031-03-03', checked: true });
    assert(r.status === 404, '学习计划：勾选不存在的项返回 404');
    r = await json('PUT', '/api/study/check', { item_id: it.id, date: '2031-03-04', checked: false });
    assert(r.status === 200, '学习计划：取消没勾过的日期不报错');

    // 改日期不丢勾选
    r = await json('PUT', `/api/study/items/${it.id}`, { ...I, start_date: '2031-03-05', end_date: '2031-03-10' });
    assert(r.status === 200, '学习计划：修改学习项日期');
    r = await call('GET', `/api/study/day?date=2031-03-05&member=${m1.id}`);
    assert(r.body.items.find(x => x.id === it.id).done === 0, '学习计划：勾选被挤出范围后不计入进度');
    r = await json('PUT', `/api/study/items/${it.id}`, I);
    r = await call('GET', `/api/study/day?date=2031-03-05&member=${m1.id}`);
    assert(r.body.items.find(x => x.id === it.id).done === 1, '学习计划：日期改回后原有勾选恢复计入');

    // 列表与按月
    r = await call('GET', `/api/study/items?plan=${plan.id}`);
    const li = r.body.find(x => x.id === it.id);
    assert(r.status === 200 && li && li.checked.includes('2031-03-03') && !r.body.some(x => x.id === itB.id), '学习计划：按大计划列出学习项及已勾选日期');
    r = await call('GET', '/api/study/plans');
    assert(r.body.find(x => x.id === plan.id).item_count === 3, '学习计划：大计划列表带项数');
    r = await call('GET', `/api/study/month?month=2031-03&member=${m1.id}`);
    const mi = r.body.items.find(x => x.id === it.id);
    assert(r.status === 200 && r.body.daysInMonth === 31 && mi && mi.days.length === 10 && mi.days[0] === 1 && JSON.stringify(mi.checked) === '[3]', '学习计划：按月返回占的日号和已勾选日号');
    assert(!r.body.items.some(x => x.id === itOut.id), '学习计划：按月不含与该月无交集的项');
    r = await call('GET', `/api/study/month?month=2031-13&member=${m1.id}`);
    assert(r.status === 400, '学习计划：非法月份被拒绝');
    r = await call('GET', '/api/study/items?plan=abc');
    assert(r.status === 400, '学习计划：plan 参数不是数字被拒绝');

    // 两位成员互相隔离；转移计划后归属跟着变，勾选保留
    r = await json('POST', '/api/study/plans', { ...P, name: '冒烟乙方计划', member_id: m2.id });
    assert(r.status === 200 && r.body.member_id === m2.id, '学习成员：给第二位成员建计划');
    const planM2 = r.body;
    try {
    r = await json('POST', '/api/study/items', { plan_id: planM2.id, name: '乙方的项', start_date: '2031-03-01', end_date: '2031-03-10' });
    assert(r.status === 200 && r.body.id > 0, '学习成员：给第二位的计划建学习项');
    const itM2 = r.body;
    r = await json('POST', '/api/study/items', { plan_id: planM2.id, name: '乙方更早的项', start_date: '2031-02-20', end_date: '2031-02-25' });
    assert(r.status === 200 && r.body.id > 0, '学习成员：给第二位建一个开始日最早的项');
    const itM2Early = r.body;
    r = await json('PUT', '/api/study/check', { item_id: itM2.id, date: '2031-03-03', checked: true });
    assert(r.status === 200, '学习成员：给第二位的项勾选');
    r = await call('GET', `/api/study/day?date=2031-03-03&member=${m1.id}`);
    assert(!r.body.items.some(x => x.id === itM2.id), '学习成员：第一位的今天看不到第二位的项');
    r = await call('GET', `/api/study/day?date=2031-03-03&member=${m2.id}`);
    assert(r.body.items.some(x => x.id === itM2.id) && !r.body.items.some(x => x.id === it.id), '学习成员：第二位的今天只有自己的项');
    // 即将开始：2031-02-20 开始的项比所有人的都早，不会被 limit=3 截掉，所以反向断言真的能测出过滤
    r = await call('GET', `/api/study/day?date=2031-02-15&member=${m2.id}`);
    assert(r.body.upcoming.some(x => x.id === itM2Early.id), '学习成员：第二位的即将开始含自己的项');
    r = await call('GET', `/api/study/day?date=2031-02-15&member=${m1.id}`);
    assert(!r.body.upcoming.some(x => x.id === itM2Early.id), '学习成员：第一位的即将开始不含第二位的项');
    r = await call('GET', `/api/study/plans?member=${m1.id}`);
    assert(r.body.some(x => x.id === plan.id) && !r.body.some(x => x.id === planM2.id), '学习成员：计划列表按成员过滤');
    r = await call('GET', `/api/study/items?member=${m2.id}`);
    assert(r.body.some(x => x.id === itM2.id) && !r.body.some(x => x.id === it.id), '学习成员：学习项列表按成员过滤');
    r = await call('GET', `/api/study/month?month=2031-03&member=${m1.id}`);
    assert(!r.body.items.some(x => x.id === itM2.id), '学习成员：按月也按成员过滤');
    r = await json('PUT', `/api/study/plans/${planM2.id}`, { name: '冒烟乙方计划', member_id: m1.id, start_date: '2031-01-01', end_date: '2031-06-30' });
    assert(r.status === 200 && r.body.member_id === m1.id, '学习成员：把计划转给第一位');
    r = await call('GET', `/api/study/day?date=2031-03-03&member=${m1.id}`);
    const moved = r.body.items.find(x => x.id === itM2.id);
    assert(moved && moved.done === 1, '学习成员：转移后第一位看得到，勾选没有丢');
    r = await call('GET', `/api/study/day?date=2031-03-03&member=${m2.id}`);
    assert(!r.body.items.some(x => x.id === itM2.id), '学习成员：转移后第二位看不到');
    r = await json('PUT', `/api/study/plans/${planM2.id}`, { name: '冒烟乙方计划', member_id: 999999, start_date: '2031-01-01', end_date: '2031-06-30' });
    assert(r.status === 400 && r.body.error === '成员不存在', '学习成员：转给不存在的成员被拒绝');
    } finally {
      await call('DELETE', `/api/study/plans/${planM2.id}`);  // 中途断言失败也要清掉，避免残留
    }

    r = await json('PUT', '/api/study/check', { item_id: true, date: '2031-03-03', checked: true });
    assert(r.status === 404, '学习计划：item_id 不是整数时不会误操作 id=1 的项');

    // 删除
    r = await call('DELETE', `/api/study/items/${itLater.id}`);
    assert(r.status === 200, '学习计划：删除学习项');
    r = await call('DELETE', `/api/study/plans/${plan.id}`);
    assert(r.status === 200 && r.body.removed === 2, '学习计划：删除大计划返回连带删除的项数');
    r = await call('GET', '/api/study/items');
    assert(!r.body.some(x => x.id === it.id || x.id === itOut.id) && r.body.some(x => x.id === itB.id), '学习计划：删除大计划连带删除其项，不影响别的计划');
    r = await json('PUT', '/api/study/check', { item_id: it.id, date: '2031-03-03', checked: true });
    assert(r.status === 404, '学习计划：已删除的项不能再勾选');
    r = await call('DELETE', `/api/study/plans/${plan2.id}`);
    r = await call('DELETE', `/api/study/plans/${plan2.id}`);
    assert(r.status === 404, '学习计划：删除不存在的大计划返回 404');
  }

  // 每周工作记录（用 2032 年的日期，避免撞到真实数据）。
  // 不允许删除人员，所以这里复用一个名为「冒烟人员」的人员（没有才添加），建议只在临时数据目录上跑冒烟测试。
  // 「最多 10 个人员」有意不在冒烟里测：人员不能删除，测了会在真实库里留下 10 个人，由人工验收覆盖
  {
    const createdEntries = [], createdTodos = [];   // 本块创建的记录 / 待办 id，结束时清理
    try {
      r = await call('GET', '/api/work/people');
      assert(r.status === 200 && r.body.length >= 1, '每周工作：默认至少有一位人员');
      const first = r.body[0];
      let smoker = r.body.find(p => p.name === '冒烟人员');
      r = await json('POST', '/api/work/people', { name: '   ' });
      assert(r.status === 400 && r.body.error === '名称不能为空', '每周工作：添加人员空名被拒绝');
      r = await json('POST', '/api/work/people', { name: 'x'.repeat(21) });
      assert(r.status === 400 && r.body.error === '名称最长 20 字', '每周工作：添加人员超过 20 字被拒绝');
      if (!smoker) {
        r = await json('POST', '/api/work/people', { name: '冒烟人员' });
        assert(r.status === 200 && r.body.name === '冒烟人员', '每周工作：添加人员');
        smoker = r.body;
      }
      r = await json('PUT', `/api/work/people/${smoker.id}`, { name: '  冒烟人员改名  ' });
      assert(r.status === 200 && r.body.name === '冒烟人员改名', '每周工作：人员改名并去掉首尾空白');
      r = await call('GET', '/api/work/people');
      assert(r.body.find(p => p.id === smoker.id).name === '冒烟人员改名', '每周工作：改名后列表更新');
      r = await json('PUT', `/api/work/people/${smoker.id}`, { name: '冒烟人员' });
      assert(r.status === 200 && r.body.name === '冒烟人员', '每周工作：人员名字改回');
      r = await json('PUT', '/api/work/people/999999', { name: '甲' });
      assert(r.status === 404 && r.body.error === '人员不存在', '每周工作：改名不存在的人员返回 404');

      const W = '2032-03-01';   // 周一
      for (const q of ['', '&person=abc', '&person=999999', '&person=0']) {
        r = await call('GET', `/api/work/week?start=${W}${q}`);
        assert(r.status === 400 && r.body.error === '人员不存在', `每周工作：week 的 person 缺失或非法被拒绝（${q || '缺失'}）`);
        r = await call('GET', `/api/work/report?start=${W}${q}`);
        assert(r.status === 400 && r.body.error === '人员不存在', `每周工作：report 的 person 缺失或非法被拒绝（${q || '缺失'}）`);
        r = await call('GET', `/api/work/todos?x=1${q}`);
        assert(r.status === 400 && r.body.error === '人员不存在', `每周工作：todos 的 person 缺失或非法被拒绝（${q || '缺失'}）`);
      }
      r = await call('GET', `/api/work/week?start=2032-02-30&person=${first.id}`);
      assert(r.status === 400, '每周工作：week 的 start 非法被拒绝');

      // ---- 记录（只有「已做」）----
      const E = { person_id: first.id, date: '2032-03-03', text: '对接接口' };
      r = await json('POST', '/api/work/entries', { ...E, text: '   ' });
      assert(r.status === 400 && r.body.error === '内容不能为空', '每周工作：空内容被拒绝');
      r = await json('POST', '/api/work/entries', { ...E, text: 'x'.repeat(201) });
      assert(r.status === 400 && r.body.error === '内容最长 200 字', '每周工作：超长内容被拒绝');
      r = await json('POST', '/api/work/entries', { ...E, date: '2032-02-30' });
      assert(r.status === 400 && r.body.error === '日期格式应为 YYYY-MM-DD', '每周工作：非法日期被拒绝');
      r = await json('POST', '/api/work/entries', { ...E, person_id: 999999 });
      assert(r.status === 400 && r.body.error === '人员不存在', '每周工作：记录的人员不存在被拒绝');
      // 旧页面兼容：传 kind:'todo' 必须被拒绝，而且什么都不能写进去
      r = await json('POST', '/api/work/entries', { ...E, kind: 'todo', text: '旧页面误传的待办' });
      assert(r.status === 400 && r.body.error === '类型无效', '每周工作：记录接口传 kind=todo 被拒绝');
      r = await json('POST', '/api/work/entries/batch', { person_id: first.id, date: '2032-03-03', kind: 'todo', text: '旧页面误传。批量' });
      assert(r.status === 400 && r.body.error === '类型无效', '每周工作：批量接口传 kind=todo 被拒绝');
      r = await call('GET', `/api/work/week?start=${W}&person=${first.id}`);
      assert(!r.body.days.some(d => d.entries.some(x => x.text.includes('旧页面误传'))), '每周工作：被拒绝的 kind=todo 请求没有写入任何东西');
      r = await json('POST', '/api/work/entries', E);
      assert(r.status === 200 && r.body.id > 0 && r.body.date === '2032-03-03' && r.body.text === '对接接口', '每周工作：新增记录（不传 kind）');
      const e1 = r.body; createdEntries.push(e1.id);
      r = await json('POST', '/api/work/entries', { ...E, kind: 'done', text: '显式传 done 也可以', date: '2032-03-04' });
      assert(r.status === 200, '每周工作：显式传 kind=done 也可以');
      const e2 = r.body; createdEntries.push(e2.id);
      r = await call('GET', `/api/work/week?start=2032-03-03&person=${first.id}`);   // start 不是周一，自动归一
      assert(r.status === 200 && r.body.start === W && r.body.end === '2032-03-07' && r.body.days.length === 7, '每周工作：week 归一到周一并返回 7 天');
      const got = r.body.days[2].entries.find(x => x.id === e1.id);
      assert(got && JSON.stringify(Object.keys(got).sort()) === JSON.stringify(['date', 'id', 'text']), '每周工作：周视图里的记录只有 id、date、text');

      // 修改
      r = await json('PUT', `/api/work/entries/${e1.id}`, { text: '对接接口（改）' });
      assert(r.status === 200 && r.body.text === '对接接口（改）', '每周工作：修改文字');
      r = await json('PUT', `/api/work/entries/${e1.id}`, { date: '2032-03-10' });
      assert(r.status === 200 && r.body.date === '2032-03-10', '每周工作：修改日期');
      r = await call('GET', `/api/work/week?start=${W}&person=${first.id}`);
      assert(!r.body.days.some(d => d.entries.some(x => x.id === e1.id)), '每周工作：改了日期后从旧周消失');
      r = await call('GET', '/api/work/week?start=2032-03-08&person=' + first.id);
      assert(r.body.days[2].entries.some(x => x.id === e1.id), '每周工作：改了日期后出现在新周');
      r = await json('PUT', `/api/work/entries/${e1.id}`, { date: '2032-03-03' });
      r = await json('PUT', `/api/work/entries/${e1.id}`, { kind: 'todo' });
      assert(r.status === 400 && r.body.error === '类型无效', '每周工作：修改记录时传 kind=todo 被拒绝');
      r = await json('PUT', '/api/work/entries/999999', { text: 'x' });
      assert(r.status === 404 && r.body.error === '记录不存在', '每周工作：修改不存在的记录返回 404');

      // 批量与撤销
      r = await json('POST', '/api/work/entries/batch', { person_id: first.id, date: '2032-03-02', kind: 'done', text: '修了bug。开了周会' });
      assert(r.status === 200 && r.body.count === 2 && r.body.ids.length === 2 && r.body.truncated === false, '每周工作：批量记录拆成两条');
      const batchIds = r.body.ids; createdEntries.push(...batchIds);
      r = await json('POST', '/api/work/entries/batch', { person_id: first.id, date: '2032-03-02', text: '1。2。3。4。5。6。7' });
      assert(r.status === 200 && r.body.count === 5 && r.body.truncated === true, '每周工作：超过 5 句只记前 5 条并标记 truncated（不传 kind）');
      const batch2 = r.body.ids; createdEntries.push(...batch2);
      r = await json('POST', '/api/work/entries/batch', { person_id: first.id, date: '2032-03-02', text: '。。' });
      assert(r.status === 400 && r.body.error === '没有可记录的内容', '每周工作：拆不出内容被拒绝');
      r = await call('GET', `/api/work/week?start=${W}&person=${first.id}`);
      const before = r.body.days[1].entries.length;
      r = await json('POST', '/api/work/entries/batch', { person_id: first.id, date: '2032-03-02', text: '正常的一条。' + 'x'.repeat(201) });
      assert(r.status === 400 && r.body.error === '内容最长 200 字', '每周工作：批量里有超长内容被拒绝');
      r = await call('GET', `/api/work/week?start=${W}&person=${first.id}`);
      assert(r.body.days[1].entries.length === before, '每周工作：批量失败时整批都没有写入');
      r = await json('POST', '/api/work/entries/delete', { ids: batch2 });
      assert(r.status === 200 && r.body.removed === 5, '每周工作：批量删除（撤销）');
      r = await json('POST', '/api/work/entries/delete', { ids: Array.from({ length: 21 }, (_, i) => 2000000000 + i) });
      assert(r.status === 400, '每周工作：一次删除超过 20 个 id 被拒绝');
      r = await json('POST', '/api/work/entries/delete', { ids: 'abc' });
      assert(r.status === 400, '每周工作：ids 不是数组被拒绝');
      r = await call('GET', `/api/work/week?start=${W}&person=${first.id}`);
      assert(batchIds.every(id => r.body.days[1].entries.some(x => x.id === id)), '每周工作：撤销只删了指定的那一批');

      // ---- 待办（单独的清单）----
      const T = { person_id: first.id, text: '写方案' };
      r = await json('POST', '/api/work/todos', { ...T, text: '   ' });
      assert(r.status === 400 && r.body.error === '内容不能为空', '每周工作：待办空内容被拒绝');
      r = await json('POST', '/api/work/todos', { ...T, text: 'x'.repeat(201) });
      assert(r.status === 400 && r.body.error === '内容最长 200 字', '每周工作：待办超长内容被拒绝');
      r = await json('POST', '/api/work/todos', { ...T, due_date: '2032-02-30' });
      assert(r.status === 400 && r.body.error === '日期格式应为 YYYY-MM-DD', '每周工作：待办非法日期被拒绝');
      r = await json('POST', '/api/work/todos', { ...T, person_id: 999999 });
      assert(r.status === 400 && r.body.error === '人员不存在', '每周工作：待办的人员不存在被拒绝');
      r = await json('POST', '/api/work/todos', { ...T, due_date: '2032-03-09' });
      assert(r.status === 200 && r.body.id > 0 && r.body.due_date === '2032-03-09' && r.body.done === false && r.body.done_date === '', '每周工作：新建有日期的待办');
      const t1 = r.body; createdTodos.push(t1.id);
      r = await json('POST', '/api/work/todos', { ...T, text: '联系供应商' });
      assert(r.status === 200 && r.body.due_date === '', '每周工作：新建没选日期的待办（不传 due_date）');
      const t2 = r.body; createdTodos.push(t2.id);
      r = await json('POST', '/api/work/todos', { ...T, text: '整理测试报告', due_date: '' });
      assert(r.status === 200 && r.body.due_date === '', '每周工作：due_date 传空串也是没选日期');
      const t3 = r.body; createdTodos.push(t3.id);
      r = await json('POST', '/api/work/todos', { ...T, text: '已过期的事', due_date: '2032-02-20' });
      assert(r.status === 200, '每周工作：新建已过期的待办');
      const t4 = r.body; createdTodos.push(t4.id);

      r = await call('GET', `/api/work/todos?person=${first.id}&filter=bad`);
      assert(r.status === 400 && r.body.error === 'filter 无效', '每周工作：filter 非法被拒绝');
      r = await call('GET', `/api/work/todos?person=${first.id}`);
      const mine = r.body.filter(x => [t1.id, t2.id, t3.id, t4.id].includes(x.id)).map(x => x.id);
      assert(r.status === 200 && JSON.stringify(mine) === JSON.stringify([t4.id, t1.id, t2.id, t3.id]), '每周工作：还没做（默认）——有日期的按日期升序，没日期的在后');
      assert(Object.keys(r.body[0]).sort().join() === 'done,done_date,due_date,id,text', '每周工作：待办列表项的字段');

      // 勾选 / 取消
      r = await json('PUT', `/api/work/todos/${t1.id}`, { done: 'true' });
      assert(r.status === 400 && r.body.error === 'done 应为 true 或 false', '每周工作：待办 done 不是布尔值被拒绝');
      r = await json('PUT', `/api/work/todos/${t1.id}`, { done: true, done_date: '2032-03-03' });
      assert(r.status === 200 && r.body.done === true && r.body.done_date === '2032-03-03', '每周工作：勾选待办，完成日期取请求里给的');
      r = await json('PUT', `/api/work/todos/${t2.id}`, { done: true });
      assert(r.status === 200 && /^\d{4}-\d{2}-\d{2}$/.test(r.body.done_date), '每周工作：勾选时不给完成日期，取服务器日期');
      const t2done = r.body.done_date;
      r = await json('PUT', `/api/work/todos/${t2.id}`, { done: true });
      assert(r.body.done_date === t2done, '每周工作：已完成的待办再勾选，完成日期保持不变');
      r = await call('GET', `/api/work/todos?person=${first.id}&filter=open`);
      assert(!r.body.some(x => x.id === t1.id) && r.body.some(x => x.id === t3.id), '每周工作：完成后从「还没做」里消失');
      r = await call('GET', `/api/work/todos?person=${first.id}&filter=done`);
      assert(r.body.some(x => x.id === t1.id && x.done === true) && !r.body.some(x => x.id === t3.id), '每周工作：完成后出现在「已完成」里');
      r = await call('GET', `/api/work/todos?person=${first.id}&filter=all`);
      const iOpen = r.body.findIndex(x => x.id === t3.id), iDone = r.body.findIndex(x => x.id === t1.id);
      assert(iOpen >= 0 && iDone > iOpen, '每周工作：全部——没做完的在前，已完成的在后');
      r = await json('PUT', `/api/work/todos/${t2.id}`, { done: false });
      assert(r.body.done === false && r.body.done_date === '', '每周工作：取消勾选后完成日期清空');

      // 修改 / 清除日期
      r = await json('PUT', `/api/work/todos/${t3.id}`, { text: '整理测试报告（改）', due_date: '2032-03-12' });
      assert(r.status === 200 && r.body.text === '整理测试报告（改）' && r.body.due_date === '2032-03-12', '每周工作：改待办的文字和日期');
      r = await json('PUT', `/api/work/todos/${t3.id}`, { text: '整理测试报告（再改）' });
      assert(r.body.due_date === '2032-03-12', '每周工作：不传 due_date 时日期保持不变');
      r = await json('PUT', `/api/work/todos/${t3.id}`, { due_date: '' });
      assert(r.status === 200 && r.body.due_date === '', '每周工作：due_date 传空串清除日期');
      r = await json('PUT', `/api/work/todos/${t3.id}`, { due_date: '2032-13-01' });
      assert(r.status === 400, '每周工作：待办改成非法日期被拒绝');
      r = await json('PUT', '/api/work/todos/999999', { text: 'x' });
      assert(r.status === 404 && r.body.error === '待办不存在', '每周工作：修改不存在的待办返回 404');

      // 撤销式重建：带 done / done_date 原样恢复
      r = await json('POST', '/api/work/todos', { person_id: first.id, text: '不应该被写入的待办', done: 'true' });
      assert(r.status === 400 && r.body.error === 'done 应为 true 或 false', '每周工作：新建待办时 done 不是布尔值被拒绝');
      r = await call('GET', `/api/work/todos?person=${first.id}&filter=all`);
      assert(!r.body.some(x => x.text === '不应该被写入的待办'), '每周工作：被拒绝的新建没有写入');
      r = await json('POST', '/api/work/todos', { person_id: first.id, text: '撤销恢复的已完成待办', due_date: '2032-03-01', done: true, done_date: '2032-03-03' });
      assert(r.status === 200 && r.body.done === true && r.body.done_date === '2032-03-03' && r.body.due_date === '2032-03-01', '每周工作：撤销重建——已完成状态原样恢复');
      createdTodos.push(r.body.id);
      r = await json('POST', '/api/work/todos', { person_id: first.id, text: '撤销恢复的未完成待办', done: false, done_date: '2032-03-03' });
      assert(r.status === 200 && r.body.done === false && r.body.done_date === '', '每周工作：重建未完成待办时完成日期被强制清空');
      createdTodos.push(r.body.id);

      // 人员隔离
      r = await json('POST', '/api/work/entries', { person_id: smoker.id, date: '2032-03-03', text: '冒烟人员的一条' });
      const es = r.body; createdEntries.push(es.id);
      r = await json('POST', '/api/work/todos', { person_id: smoker.id, text: '冒烟人员的待办' });
      const ts = r.body; createdTodos.push(ts.id);
      r = await call('GET', `/api/work/week?start=${W}&person=${smoker.id}`);
      assert(r.body.days[2].entries.some(x => x.id === es.id) && !r.body.days.some(d => d.entries.some(x => x.id === e1.id)), '每周工作：人员之间的周视图互相隔离');
      r = await call('GET', `/api/work/todos?person=${first.id}&filter=all`);
      assert(!r.body.some(x => x.id === ts.id), '每周工作：人员之间的待办互相隔离');
      r = await call('GET', `/api/work/todos?person=${smoker.id}&filter=all`);
      assert(r.body.some(x => x.id === ts.id) && !r.body.some(x => x.id === t1.id), '每周工作：另一位只看到自己的待办');

      // ---- 周报 ----
      // 本周（3/1–3/7）：记录 e1（3/3）、e2（3/4）、批量 batchIds（3/2）；待办 t1 在 3/3 完成；再造一条「本周之外完成」的待办
      r = await json('POST', '/api/work/todos', { person_id: first.id, text: '上上周完成的事', done: true, done_date: '2032-02-17' });
      createdTodos.push(r.body.id);
      r = await call('GET', `/api/work/report?start=${W}&person=${first.id}`);
      assert(r.status === 200 && r.body.empty === false && r.body.text.startsWith('本周工作（3/1 – 3/7）'), '每周工作：周报标题');
      assert(r.body.text.includes('- 对接接口（改）'), '每周工作：周报含已做记录');
      const lines = r.body.text.split('\n');
      const iDay = lines.indexOf('周三'), iPlan = lines.indexOf('下周计划');
      assert(iDay >= 0 && lines.slice(iDay, iPlan).includes('- 写方案'), '每周工作：本周完成的待办按完成日期列在对应的日子下');
      assert(!r.body.text.includes('上上周完成的事'), '每周工作：本周之外完成的待办不在周报里');
      assert(iPlan > 0, '每周工作：周报有下周计划');
      const plan = lines.slice(iPlan + 1);
      assert(plan.includes('- 已过期的事') && plan.includes('- 联系供应商') && plan.includes('- 整理测试报告（再改）'), '每周工作：下周计划含已过期的和没选日期的待办');
      assert(plan.indexOf('- 已过期的事') < plan.indexOf('- 联系供应商'), '每周工作：下周计划里有日期的在没日期的前面');
      assert(!plan.includes('- 写方案'), '每周工作：已完成的待办不在下周计划里');
      r = await json('PUT', `/api/work/todos/${t1.id}`, { done: false });
      r = await call('GET', `/api/work/report?start=${W}&person=${first.id}`);
      assert(!r.body.text.split('\n').slice(0, r.body.text.split('\n').indexOf('下周计划')).includes('- 写方案'), '每周工作：取消勾选后从周报「做了什么」里消失');
      assert(r.body.text.split('\n').includes('- 写方案'), '每周工作：取消勾选后出现在下周计划里');
      r = await call('GET', `/api/work/report?start=2032-06-07&person=${first.id}`);
      assert(r.status === 200 && r.body.empty === true && r.body.text === '', '每周工作：整周没有记录时周报为空，即使有没完成的待办');
      r = await call('GET', `/api/work/report?start=${W}&person=${smoker.id}`);
      assert(!r.body.text.includes('对接接口') && !r.body.text.includes('写方案'), '每周工作：周报不含别人的记录和待办');

      // ---- 删除 ----
      r = await call('DELETE', `/api/work/entries/${e2.id}`);
      assert(r.status === 200, '每周工作：删除记录');
      r = await call('DELETE', `/api/work/entries/${e2.id}`);
      assert(r.status === 404, '每周工作：重复删除记录返回 404');
      r = await json('PUT', `/api/work/entries/${e2.id}`, { text: 'x' });
      assert(r.status === 404, '每周工作：修改已删除的记录返回 404');
      r = await call('DELETE', `/api/work/todos/${t4.id}`);
      assert(r.status === 200, '每周工作：删除待办');
      r = await call('DELETE', `/api/work/todos/${t4.id}`);
      assert(r.status === 404 && r.body.error === '待办不存在', '每周工作：重复删除待办返回 404');
      r = await json('PUT', `/api/work/todos/${t4.id}`, { text: 'x' });
      assert(r.status === 404, '每周工作：修改已删除的待办返回 404');
    } finally {
      const ids = createdEntries.filter(Number.isInteger);
      for (let i = 0; i < ids.length; i += 20) await json('POST', '/api/work/entries/delete', { ids: ids.slice(i, i + 20) });
      for (const id of createdTodos.filter(Number.isInteger)) await call('DELETE', `/api/work/todos/${id}`);
    }
  }

  // 清理（只删本测试创建的数据）
  for (const i of (await call('GET', '/api/items')).body) if (['酸奶', '创可贴, 大号', '螺丝刀'].includes(i.name)) await call('DELETE', `/api/items/${i.id}?purge=1`);
  r = await json('DELETE', `/api/locations/${shelf.id}`);
  assert(r.status === 200, '删除空位置');
  const bath = (await call('GET', '/api/locations')).body.find(l => l.path === '卫生间 / 镜柜 / 上层');
  await call('DELETE', `/api/locations/${bath.id}`);
  // 小票识别（假定服务启动时没有配置识别服务，即没有 RECEIPT_* 环境变量和 receipt 配置）
  r = await call('GET', '/api/receipt/status');
  assert(r.status === 200 && r.body.enabled === false, '小票识别：未配置时状态为未启用');
  r = await call('POST', '/api/receipt/scan', Buffer.from('x'), { 'content-type': 'image/jpeg' });
  assert(r.status === 503 && String(r.body.error).includes('识别服务未配置'), '小票识别：未配置时扫描返回 503');
  // 语音识别（假定服务启动时没有配置语音识别，即没有 ASR_* 环境变量和 asr 配置）
  r = await call('GET', '/api/asr/status');
  assert(r.status === 200 && r.body.enabled === false && r.body.maxSeconds === 30, '语音识别：未配置时状态为未启用');
  r = await call('POST', '/api/asr/transcribe', Buffer.from('x'), { 'content-type': 'audio/wav' });
  assert(r.status === 503 && String(r.body.error).includes('语音识别未配置'), '语音识别：未配置时转写返回 503');
  // 一口气说多件事（用句号隔开）
  r = await json('POST', '/api/parse', { text: '买了牛奶。买了鸡蛋' });
  assert(r.status === 200 && r.body.intents.length === 2, '一句话解析：用句号隔开的两件事得到两条意图');
  r = await call('POST', '/api/logout');
  r = await call('GET', '/api/items');
  assert(r.status === 401, '退出登录后失效');
  console.log('\n全部通过');
})().catch(e => { console.error(e.message); process.exit(1); });
