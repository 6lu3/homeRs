// 词表与切分回归测试：node test/vocab.test.js
const { COMMON_ITEMS } = require('../lib/vocab');
const { buildVocab, segmentNames } = require('../lib/parse');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 内置词表 ----------
check('词表：至少 300 个词', COMMON_ITEMS.length >= 300);
check('词表：没有重复', new Set(COMMON_ITEMS).size === COMMON_ITEMS.length);
check('词表：词里没有空白字符', COMMON_ITEMS.every(w => w.length > 0 && !/\s/.test(w)));
check('词表：包含各类常见物品', ['牛肉', '猪肉', '猪肉丝', '排骨', '西红柿', '鸡蛋', '青菜', '牛肉面', '酸奶', '洗衣液'].every(w => COMMON_ITEMS.includes(w)));
check('词表：单字词只来自允许的那一小组', COMMON_ITEMS.filter(w => w.length === 1).every(w => '鱼虾蛋米葱姜蒜梨桃枣盐糖醋酒茶'.includes(w)));

// ---------- buildVocab ----------
{
  const v = buildVocab([{ name: '5 号电池' }, { name: '电钻' }, { name: '饼' }]);
  check('buildVocab：包含库存名（去掉空白）和内置词', v.has('5号电池') && v.has('电钻') && v.has('牛肉'));
  check('buildVocab：带空白的原名不在里面', !v.has('5 号电池'));
  check('buildVocab：长度为 1 的库存名不加入', !v.has('饼'));
  check('buildVocab：没有库存也能用', buildVocab([]).has('牛肉') && buildVocab(undefined).has('牛肉'));
}

// ---------- segmentNames ----------
{
  const V = new Set(COMMON_ITEMS);
  check('segmentNames：牛肉猪肉猪肉丝排骨 → 4 个词', same(segmentNames('牛肉猪肉猪肉丝排骨', V), ['牛肉', '猪肉', '猪肉丝', '排骨']));
  check('segmentNames：西红柿鸡蛋青菜 → 3 个词', same(segmentNames('西红柿鸡蛋青菜', V), ['西红柿', '鸡蛋', '青菜']));
  check('segmentNames：牛肉面 本身就是一个词 → null', segmentNames('牛肉面', V) === null);
  check('segmentNames：有一段不在词表里 → null（宁可不拆）', segmentNames('牛肉火星肉', V) === null);
  check('segmentNames：只有一个词 → null', segmentNames('牛肉', V) === null);
  check('segmentNames：空串、非字符串 → null', segmentNames('', V) === null && segmentNames(null, V) === null && segmentNames(5, V) === null);
  check('segmentNames：词数最少优先（猪肉丝 + 排骨）', same(segmentNames('猪肉丝排骨', new Set(['猪肉', '猪肉丝', '丝', '排骨'])), ['猪肉丝', '排骨']));
  check('segmentNames：词数相同时靠前的词更长优先', same(segmentNames('牛肉丝瓜', new Set(['牛肉丝', '牛肉', '丝瓜', '瓜'])), ['牛肉丝', '瓜']));
  check('segmentNames：单字词也能切', same(segmentNames('鱼虾', new Set(['鱼', '虾'])), ['鱼', '虾']));
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
