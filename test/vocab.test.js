// 词表与切分回归测试：node test/vocab.test.js
const { COMMON_ITEMS, RAW_WORDS } = require('../lib/vocab');
const { buildVocab, segmentNames } = require('../lib/parse');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 内置词表 ----------
check('词表：至少 300 个词', COMMON_ITEMS.length >= 300);
check('词表：整理前的原始词表里没有重复（有人手滑写了两遍会被发现）', new Set(RAW_WORDS).size === RAW_WORDS.length);
check('词表：每个词都只由汉字组成（没有空白、标点、字母）', RAW_WORDS.every(w => /^[一-鿿]+$/.test(w)));
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
  check('segmentNames：词数相同时靠前的词更长优先', same(segmentNames('甲乙丙丁戊', new Set(['甲乙丙', '甲乙', '丁戊', '丙丁戊'])), ['甲乙丙', '丁戊']));
  check('segmentNames：单字词在中间可以切', same(segmentNames('鱼牛肉', new Set(['鱼', '牛肉'])), ['鱼', '牛肉']));
  check('segmentNames：切出的最后一个词是单字就不拆（花生米、葡萄酒、牛奶糖这类整体名称）', segmentNames('牛肉鱼', new Set(['鱼', '牛肉'])) === null && segmentNames('鱼虾', new Set(['鱼', '虾'])) === null && segmentNames('花生米', V) === null && segmentNames('牛奶糖', V) === null);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
