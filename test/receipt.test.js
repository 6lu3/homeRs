// 小票识别纯逻辑回归测试：node test/receipt.test.js
const { PROMPT, resolveConfig, buildRequest, extractReplyText, parseItems, cleanName, buildIntents, fingerprint } = require('../lib/receipt');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- PROMPT ----------
check('PROMPT：包含提示词必须有的规则词', ['JSON', '购物袋', '折扣', '小计', '合计', '运费', '散称', 'kg'].every(w => PROMPT.includes(w)));

// ---------- resolveConfig ----------
{
  const KEY = 'sk-secret-123';
  let c = resolveConfig(undefined, {});
  check('resolveConfig：空配置未启用且无问题', c.enabled === false && c.problem === '');
  c = resolveConfig({ url: 'https://a/x', key: KEY, model: 'm' }, {});
  check('resolveConfig：文件配置齐全即启用，默认值正确', c.enabled === true && c.format === 'openai' && c.timeoutSec === 60 && c.dailyLimit === 30 && same(c.extra, {}));
  c = resolveConfig({ url: 'https://a/x', key: KEY, model: 'm' }, { RECEIPT_API_URL: 'https://b/y' });
  check('resolveConfig：环境变量逐项覆盖文件（url 换，key 仍取文件）', c.url === 'https://b/y' && c.key === KEY && c.enabled);
  c = resolveConfig({ url: 'u', key: KEY, model: 'm', extra: { a: 1 } }, { RECEIPT_EXTRA: '{"thinking":{"type":"disabled"}}' });
  check('resolveConfig：RECEIPT_EXTRA 整体替换文件里的 extra', same(c.extra, { thinking: { type: 'disabled' } }));
  for (const bad of ['not json', '[1]']) {
    c = resolveConfig({ url: 'u', key: KEY, model: 'm' }, { RECEIPT_EXTRA: bad });
    check(`resolveConfig：RECEIPT_EXTRA=${bad} 视为未配置，problem 提到它且不含 key`, c.enabled === false && c.problem.includes('RECEIPT_EXTRA') && !c.problem.includes(KEY));
  }
  c = resolveConfig({ url: 'u', key: KEY, model: 'm' }, { RECEIPT_FORMAT: 'foo' });
  check('resolveConfig：非法格式未启用且有 problem（不含 key）', c.enabled === false && c.problem !== '' && !c.problem.includes(KEY));
  c = resolveConfig({ url: 'u', key: KEY, model: 'm' }, { RECEIPT_FORMAT: 'responses' });
  check('resolveConfig：responses 格式正常', c.enabled && c.format === 'responses');
  const t = v => resolveConfig({ url: 'u', key: KEY, model: 'm' }, { RECEIPT_TIMEOUT_S: v }).timeoutSec;
  check('resolveConfig：超时秒数解析（5→5，0/abc→60，0.05→0.05）', t('5') === 5 && t('0') === 60 && t('abc') === 60 && t('0.05') === 0.05);
  const d = v => resolveConfig({ url: 'u', key: KEY, model: 'm' }, { RECEIPT_DAILY_LIMIT: v }).dailyLimit;
  check('resolveConfig：每日上限解析（0→0，10→10，-3/abc→30）', d('0') === 0 && d('10') === 10 && d('-3') === 30 && d('abc') === 30);
}

// ---------- buildRequest ----------
{
  const base = { url: 'https://a/x', key: 'sk-x', model: 'm', extra: {}, timeoutSec: 60, dailyLimit: 30 };
  let r = buildRequest({ ...base, format: 'openai', extra: { temperature: 0 } }, 'QUJD', 'image/jpeg');
  const oc = r.body.messages[0].content;
  check('buildRequest：openai 地址、鉴权头、文字块、图片块', r.url === 'https://a/x' && r.headers.authorization === 'Bearer sk-x' && oc[0].type === 'text' && oc[0].text === PROMPT && oc[1].image_url.url === 'data:image/jpeg;base64,QUJD');
  check('buildRequest：extra 合并进最外层', r.body.temperature === 0);
  r = buildRequest({ ...base, format: 'openai', extra: { model: 'evil', messages: 'evil' } }, 'QUJD', 'image/jpeg');
  check('buildRequest：extra 不能覆盖 model 和 messages', r.body.model === 'm' && Array.isArray(r.body.messages));
  r = buildRequest({ ...base, format: 'anthropic' }, 'QUJD', 'image/png');
  const ac = r.body.messages[0].content;
  check('buildRequest：anthropic 头和请求体', r.headers['x-api-key'] === 'sk-x' && r.headers['anthropic-version'] === '2023-06-01' && !r.headers.authorization && r.body.max_tokens === 2000 && same(ac[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }) && ac[1].type === 'text');
  r = buildRequest({ ...base, format: 'anthropic', extra: { max_tokens: 4000 } }, 'QUJD', 'image/png');
  check('buildRequest：anthropic 的 max_tokens 默认 2000，但 extra 里设置的优先', r.body.max_tokens === 4000);
  r = buildRequest({ ...base, format: 'responses' }, 'QUJD', 'image/webp');
  const rc = r.body.input[0].content;
  check('buildRequest：responses 请求体（input_image/input_text，无 messages）', same(rc[0], { type: 'input_image', image_url: 'data:image/webp;base64,QUJD' }) && rc[1].type === 'input_text' && r.body.messages === undefined && r.headers.authorization === 'Bearer sk-x');
}

// ---------- extractReplyText ----------
{
  check('extractReplyText：openai', extractReplyText('openai', { choices: [{ message: { content: 'hi' } }] }) === 'hi');
  check('extractReplyText：anthropic 只拼接文字块', extractReplyText('anthropic', { content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] }) === 'ab');
  check('extractReplyText：responses 取 message 里的 output_text', extractReplyText('responses', { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'x' }, { type: 'output_text', text: 'y' }] }] }) === 'xy');
  check('extractReplyText：垃圾输入返回空串', ['openai', 'anthropic', 'responses'].every(f => extractReplyText(f, null) === '' && extractReplyText(f, {}) === ''));
}

// ---------- parseItems ----------
{
  const body = '{"store":"测试店","items":[{"name":"豆腐","quantity":2,"unit":"盒"}]}';
  let p = parseItems('```json\n' + body + '\n```');
  check('parseItems：代码块包住的 JSON', p && p.store === '测试店' && p.items.length === 1 && p.items[0].name === '豆腐');
  p = parseItems('好的，结果如下：' + body + ' 以上。');
  check('parseItems：前后有多余文字', p && p.items.length === 1);
  check('parseItems：纯文字返回 null', parseItems('抱歉') === null);
  check('parseItems：没有 items 返回 null', parseItems('{"store":"x"}') === null);
  check('parseItems：items 不是数组返回 null', parseItems('{"items":"no"}') === null);
  check('parseItems：空 items 合法', same(parseItems('{"items":[]}'), { store: '', items: [] }));
  p = parseItems(JSON.stringify({ store: 123, date: '2026-11-23', items: [
    { name: '  青菜  ', quantity: 'abc', unit: '袋' }, { name: '   ', quantity: 1 }, { name: 'a'.repeat(80), quantity: 0, unit: '很长很长很长很长很长的单位' },
    { name: '负数', quantity: -1 }, { name: '空数量', quantity: null }, { name: '小数', quantity: 2.456, unit: '个' }, 'oops', 5, null,
  ] }));
  check('parseItems：名称去空白、空名丢弃、非对象丢弃', p.items.map(i => i.name).join('|') === ['青菜', 'a'.repeat(60), '负数', '空数量', '小数'].join('|'));
  check('parseItems：数量清洗（abc/0/-1/null→1，2.456→2.46）', p.items[0].quantity === 1 && p.items[1].quantity === 1 && p.items[2].quantity === 1 && p.items[3].quantity === 1 && p.items[4].quantity === 2.46);
  check('parseItems：单位最长 8 字，店名非字符串→空，结果没有日期', p.items[1].unit.length === 8 && p.store === '' && !('date' in p));
  const many = { items: Array.from({ length: 70 }, (_, i) => ({ name: '商品' + i, quantity: 1 })) };
  check('parseItems：最多保留 60 个商品', parseItems(JSON.stringify(many)).items.length === 60);
}

// ---------- cleanName ----------
{
  const cases = [['大娃娃菜 500g', '大娃娃菜'], ['青虾仁 300g/盒', '青虾仁'], ['牛奶 250ml*12', '牛奶'], ['牛奶 250ml×12', '牛奶'], ['可乐 1.5L', '可乐'],
    ['苹果 2斤', '苹果'], ['陈克明圆挂面800g', '陈克明圆挂面'], ['大米 5KG', '大米'], ['NB 内酯豆腐 350g', 'NB 内酯豆腐'], ['500g', '500g'],
    ['可乐 330ml*24罐', '可乐'], ['64GB U盘', '64GB U盘'], ['5G 路由器', '5G 路由器'], ['8GB内存条', '8GB内存条']];
  for (const [a, b] of cases) check(`cleanName：「${a}」→「${b}」`, cleanName(a) === b);
}

// ---------- buildIntents ----------
{
  const stock = [
    { id: 1, name: '豆腐', quantity: 2, unit: '盒', category: '食品', location_id: 5, location_path: '厨房 / 冰箱冷藏' },
    { id: 2, name: '酸奶', quantity: 6, unit: '瓶', category: '食品', location_id: null, location_path: '' },
  ];
  let r = buildIntents([{ name: 'NB 内酯豆腐 350g', quantity: 1, unit: '盒' }], stock);
  check('buildIntents：品牌前缀+规格仍匹配库存 → 补货，并提示小票上的原文', r.length === 1 && r[0].action === 'restock' && r[0].existing.id === 1 && r[0].quantity === 1 && r[0].unit === '盒' && r[0].warning === '小票上是「NB 内酯豆腐」，请确认是同一件物品');
  r = buildIntents([{ name: '大娃娃菜 500g', quantity: 1, unit: '份' }], stock);
  check('buildIntents：没匹配到 → 新增，去规格并猜分类', r[0].action === 'add' && r[0].name === '大娃娃菜' && r[0].unit === '份' && r[0].category === '食品' && !r[0].existing);
  r = buildIntents([{ name: 'NB 混合纯坚果 盐焗味 400g', quantity: 1, unit: '罐' }], stock);
  check('buildIntents：新增保留品牌前缀', r[0].action === 'add' && r[0].name === 'NB 混合纯坚果 盐焗味');
  r = buildIntents([{ name: '酸奶', quantity: 2, unit: '盒' }], stock);
  check('buildIntents：单位不同 → 预填库存单位并警告', r[0].action === 'restock' && r[0].unit === '瓶' && r[0].warning === '小票单位「盒」和库存单位「瓶」不同，请核对数量');
  r = buildIntents([{ name: '酸奶', quantity: 2, unit: '' }], stock);
  check('buildIntents：小票单位为空 → 用库存单位，无警告', r[0].unit === '瓶' && !r[0].warning);
  r = buildIntents([{ name: '酸奶', quantity: 2, unit: '盒' }], [{ ...stock[1], unit: '' }]);
  check('buildIntents：库存单位为空 → 用小票单位，无警告', r[0].unit === '盒' && !r[0].warning);
  r = buildIntents([{ name: '豆腐', quantity: 1, unit: '盒' }, { name: '内酯豆腐 350g', quantity: 2, unit: '盒' }], stock);
  check('buildIntents：多行命中同一件物品且单位相同 → 合并，并列出与库存名不同的小票原文', r.length === 1 && r[0].action === 'restock' && r[0].quantity === 3 && r[0].warning === '小票上是「内酯豆腐」，请确认是同一件物品');
  const eggs = [{ id: 3, name: '鸡蛋', quantity: 10, unit: '个', category: '食品', location_id: null, location_path: '' }];
  r = buildIntents([{ name: '鸡蛋面', quantity: 1, unit: '包' }], eggs);
  check('buildIntents：子串误匹配（鸡蛋面 ≈ 鸡蛋）时，警告里写出小票原文', r[0].action === 'restock' && r[0].warning.includes('「鸡蛋面」') && r[0].warning.includes('单位'));
  r = buildIntents([{ name: '酸奶饮品', quantity: 1, unit: '盒' }], stock);
  check('buildIntents：名称警告和单位警告同时出现，用「；」连接', r[0].warning === '小票上是「酸奶饮品」，请确认是同一件物品；小票单位「盒」和库存单位「瓶」不同，请核对数量');
  r = buildIntents([{ name: '豆腐', quantity: 1, unit: '盒' }, { name: '豆腐干', quantity: 1, unit: '盒' }], stock);
  check('buildIntents：不同名称合并时只列出与库存名不同的那些', r.length === 1 && r[0].quantity === 2 && r[0].warning === '小票上是「豆腐干」，请确认是同一件物品');
  r = buildIntents([{ name: '豆腐', quantity: 1, unit: '盒' }, { name: '豆腐', quantity: 1, unit: '袋' }], stock);
  check('buildIntents：单位冲突 → 第二条改为新增并警告', r.length === 2 && r[0].action === 'restock' && r[0].quantity === 1 && r[0].unit === '盒' && r[1].action === 'add' && r[1].name === '豆腐' && r[1].unit === '袋' && r[1].warning === '和已有「豆腐」单位不同，已作为新物品');
  r = buildIntents([{ name: '青菜', quantity: 1, unit: '份' }, { name: '青菜', quantity: 2, unit: '份' }], stock);
  check('buildIntents：同名同单位的新增合并', r.length === 1 && r[0].action === 'add' && r[0].quantity === 3);
  r = buildIntents([{ name: '青菜', quantity: 1, unit: '份' }, { name: '青菜', quantity: 1, unit: '袋' }], stock);
  check('buildIntents：同名不同单位的新增不合并', r.length === 2 && r.every(i => i.action === 'add'));
  r = buildIntents([{ name: '青菜', quantity: 1, unit: '份' }, { name: '酸奶', quantity: 1, unit: '瓶' }], []);
  check('buildIntents：库存为空时全是新增，顺序保持', r.length === 2 && r[0].name === '青菜' && r[1].name === '酸奶' && r.every(i => i.action === 'add'));
  r = buildIntents([{ name: '青菜', quantity: 1, unit: '份' }, { name: '酸奶', quantity: 1, unit: '瓶' }, { name: '豆腐', quantity: 1, unit: '盒' }], stock);
  check('buildIntents：输出顺序与首次出现一致', r.map(i => i.name).join('|') === '青菜|酸奶|豆腐');
  check('buildIntents：空列表返回空数组', same(buildIntents([], stock), []));
}

// ---------- fingerprint ----------
{
  const a = [{ name: '豆腐', quantity: 1, unit: '盒' }, { name: 'Milk', quantity: 2, unit: '瓶' }];
  const b = [{ name: ' milk ', quantity: 2, unit: '瓶' }, { name: '豆腐', quantity: 1, unit: '盒' }];
  check('fingerprint：顺序、大小写、空格不影响', fingerprint(a) === fingerprint(b));
  check('fingerprint：数量不同则不同', fingerprint(a) !== fingerprint([{ ...a[0], quantity: 2 }, a[1]]));
  check('fingerprint：64 位十六进制', /^[0-9a-f]{64}$/.test(fingerprint(a)));
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
