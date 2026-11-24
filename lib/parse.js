'use strict';
// 中文口语 → 结构化录入指令（纯规则，不依赖任何 AI / 网络）
// 输入："今天买了两盒酸奶放到冷藏里"  输出：[{ action:'add', name:'酸奶', quantity:2, unit:'盒', location:{...}, category:'食品' }]

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const NUM_RE = '\\d+(?:\\.\\d+)?|[一二两三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九]|半|几';
const UNIT_RE = '公斤|千克|毫升|kg|ml|[个盒瓶包袋罐卷件双套只条支把箱桶张本块粒片颗听斤克升打对份筒根台副提捆束串节盘碗杯顶辆幅瓣]';
// 数字后面若紧跟这些字，说明不是数量（5号电池、32寸电视、3M胶带、3层）
const NOT_QTY_AFTER = /^[号寸岁楼层分米年月日点℃度格码A-Za-z]/;

function parseNumber(s) {
  if (!s) return null;
  if (/^\d/.test(s)) return Number(s);
  if (s === '半') return 0.5;
  if (s === '几') return 3;
  if (s.includes('十')) { const [a, b] = s.split('十'); return (a ? CN_DIGIT[a] : 1) * 10 + (b ? CN_DIGIT[b] : 0); }
  return CN_DIGIT[s] ?? null;
}

// ---------- 分类词典（关键字 → 分类），可按自家习惯增删；靠前的分类优先 ----------
const CATEGORY_KEYWORDS = {
  药品: ['药', '胶囊', '创可贴', '口罩', '酒精', '碘伏', '感冒', '退烧', '消炎', '绷带', '体温计', '血压', '维生素', '钙片', '藿香', '止咳', '眼药', '膏药', '纱布', '棉签', '益生菌', '板蓝根', '布洛芬', '对乙酰', '阿莫西林', '头孢'],
  工具: ['钻', '螺丝', '锤', '钳', '扳手', '胶带', '胶水', '卷尺', '电笔', '焊', '锯', '螺母', '钉', '扎带', '万用表', '梯子', '手电', '美工刀', '刀片'],
  数码: ['耳机', '鼠标', '键盘', '硬盘', 'U盘', '内存卡', '路由', '相机', '镜头', '显示器', '线材', 'HDMI', '网线', '数据线', '充电器', '充电宝'],
  日用: ['电池', '纸巾', '卷纸', '抽纸', '湿巾', '洗衣液', '洗衣粉', '洗洁精', '牙膏', '牙刷', '肥皂', '香皂', '洗发水', '沐浴露', '护发素', '垃圾袋', '保鲜膜', '保鲜袋', '毛巾', '灯泡', '插座', '插排', '雨伞', '剃须', '剪刀', '指甲', '洗手液', '消毒液', '洁厕', '除湿', '樟脑', '衣架', '拖鞋', '牙线'],
  清洁: ['抹布', '拖把', '扫把', '清洁剂', '刷子', '海绵', '垃圾桶', '吸尘'],
  文具: ['笔', '本子', '笔记本', '打印纸', 'A4', '胶棒', '订书', '文件夹', '便利贴', '墨水', '尺子'],
  衣物: ['衣', '裤', '袜', '鞋', '帽', '围巾', '手套', '被', '床单', '枕', '毯', '毛衣', '羽绒', '内衣', 'T恤', '裙'],
  玩具: ['玩具', '乐高', '积木', '拼图', '玩偶', '娃娃', '桌游'],
  食品: ['奶', '饺', '面', '米', '油', '盐', '糖', '肉', '鱼', '虾', '菜', '蛋', '果', '零食', '饼干', '茶', '咖啡', '酱', '醋', '包子', '馒头', '速冻', '罐头', '饮料', '可乐', '啤酒', '酒', '汤圆', '火锅', '调料', '辣椒', '花椒', '八角', '蜂蜜', '麦片', '巧克力', '坚果', '核桃', '红枣', '粉', '豆', '汁', '薯片', '矿泉水', '纯净水'],
};
function guessCategory(name, locationPath = '') {
  if (name.includes('娃娃菜')) return '食品'; // 词表里的「娃娃」会把它误判成玩具
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) if (kws.some(k => name.includes(k))) return cat;
  if (/冰箱|冷藏|冷冻|厨房|吊柜|地柜/.test(locationPath)) return '食品';
  if (/药箱|药柜|镜柜/.test(locationPath)) return '药品';
  if (/衣柜|衣帽/.test(locationPath)) return '衣物';
  if (/工具/.test(locationPath)) return '工具';
  return '';
}

// ---------- 日期 ----------
function fmt(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const EXP_WORD = '(?:保质期|有效期|到期|过期|能放|赏味期)';
function extractExpiry(text, today = new Date()) {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const add = (days = 0, months = 0, years = 0) => { const d = new Date(base); d.setFullYear(d.getFullYear() + years); d.setMonth(d.getMonth() + months); d.setDate(d.getDate() + days); return d; };
  const rules = [
    [new RegExp(`${EXP_WORD}?(?:到|是|至|为)?(\\d{4})[年\\-/.](\\d{1,2})[月\\-/.](\\d{1,2})日?(?:到期|过期)?`), m => new Date(+m[1], +m[2] - 1, +m[3])],
    [new RegExp(`${EXP_WORD}?(?:到|是|至|为)?(\\d{1,2})月(\\d{1,2})日?(?:到期|过期)?`), m => { const d = new Date(base.getFullYear(), +m[1] - 1, +m[2]); if (d < base) d.setFullYear(d.getFullYear() + 1); return d; }],
    [new RegExp(`${EXP_WORD}?(?:是|为)?(${NUM_RE})天(?:后)?(?:到期|过期)?`), m => add(parseNumber(m[1]))],
    [new RegExp(`${EXP_WORD}?(?:是|为)?(${NUM_RE})(?:个)?(?:星期|周)(?:后)?(?:到期|过期)?`), m => add(parseNumber(m[1]) * 7)],
    [new RegExp(`${EXP_WORD}?(?:是|为)?(${NUM_RE})个月(?:后)?(?:到期|过期)?`), m => add(0, parseNumber(m[1]))],
    [new RegExp(`${EXP_WORD}?(?:是|为)?(${NUM_RE})年(?:后)?(?:到期|过期)?`), m => add(0, 0, parseNumber(m[1]))],
    [new RegExp(`${EXP_WORD}?(?:到)?下个?月底(?:到期|过期)?`), () => new Date(base.getFullYear(), base.getMonth() + 2, 0)],
    [new RegExp(`${EXP_WORD}?(?:到)?下个?月(?:到期|过期)?`), () => add(0, 1)],
    [new RegExp(`${EXP_WORD}?(?:到)?月底(?:到期|过期)?`), () => new Date(base.getFullYear(), base.getMonth() + 1, 0)],
    [new RegExp(`${EXP_WORD}?(?:到)?下周(?:到期|过期)?`), () => add(7)],
    [new RegExp(`${EXP_WORD}?(?:到)?明年(?:到期|过期)?`), () => add(0, 0, 1)],
    [new RegExp(`${EXP_WORD}?(?:到)?后天(?:到期|过期)?`), () => add(2)],
    [new RegExp(`${EXP_WORD}?(?:到)?明天(?:到期|过期)?`), () => add(1)],
  ];
  for (const [re, fn] of rules) {
    const m = text.match(re);
    if (!m) continue;
    // 必须带有到期语义的词，避免把"三天前买的"当成到期
    if (!new RegExp(EXP_WORD).test(m[0])) continue;
    const d = fn(m);
    if (!d || isNaN(d)) continue;
    const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/[，,、]+$/, '').replace(/^[，,、]+/, '');
    return { expires_at: fmt(d), rest };
  }
  return { expires_at: '', rest: text };
}

// ---------- 数量 ----------
function extractQuantity(phrase) {
  // 1) 数字+单位（任何位置）  2) 开头的阿拉伯数字  3) 结尾的阿拉伯数字
  let m = phrase.match(new RegExp(`(${NUM_RE})\\s*(${UNIT_RE})`));
  if (m && !NOT_QTY_AFTER.test(phrase.slice(m.index + m[0].length))) {
    const rest = phrase.slice(0, m.index) + phrase.slice(m.index + m[0].length);
    return { quantity: parseNumber(m[1]), unit: m[2], name: rest };
  }
  // 没有单位时只认阿拉伯数字，避免"三鲜水饺"被拆成 3 + 鲜水饺
  m = phrase.match(/^(\d+(?:\.\d+)?)/);
  if (m && !NOT_QTY_AFTER.test(phrase.slice(m[0].length)) && phrase.length > m[0].length) return { quantity: Number(m[1]), unit: '', name: phrase.slice(m[0].length) };
  m = phrase.match(/(\d+(?:\.\d+)?)$/);
  if (m && phrase.length > m[0].length && !/[A-Za-z]$/.test(phrase.slice(0, m.index))) return { quantity: Number(m[1]), unit: '', name: phrase.slice(0, m.index) };
  return { quantity: null, unit: '', name: phrase };
}
function cleanName(s) {
  return s.replace(/^.{0,6}?(?:前|刚|新)?买的/, '').replace(/^(的|一些|些|点|一点|一点儿|点儿|新的)+/, '').replace(/(的|了|啦|呀|啊|哦|呢|嘛)+$/, '').replace(/^(那个|这个|一个)/, '').trim();
}
function splitItems(phrase) {
  return phrase.split(/[、，,;；]|和|跟|以及|还有|与|加上|外加/).map(s => s.trim()).filter(Boolean);
}

// ---------- 位置匹配 ----------
const LOCATION_ALIASES = { 冷藏: ['冰箱冷藏'], 冷冻: ['冰箱冷冻'], 冰箱: ['冰箱冷藏'], 柜子: ['柜'], 厕所: ['卫生间', '洗手间'], 洗手间: ['卫生间'], 洗手台: ['卫生间'], 门口: ['玄关'], 床头: ['床头柜'] };
function cleanLocationPhrase(s) {
  return s.replace(/^(到|在|进|去|往|于)+/, '').replace(/(里面|里边|里头|上面|上边|下面|下边|那里|这里|那儿|这儿|里|上|中|内|下|边|处)+$/, '').replace(/(了|啦|的)+$/, '').trim();
}
function matchLocation(phraseRaw, locations) {
  const phrase = cleanLocationPhrase(phraseRaw);
  if (!phrase) return { location: null, create: null, alternatives: [], phrase: '' };
  const parts = phrase.split(/的/).map(cleanLocationPhrase).filter(Boolean);
  const byId = new Map(locations.map(l => [l.id, l]));
  const ancestors = (l) => { const out = []; let cur = l; let guard = 0; while (cur && cur.parent_id != null && guard++ < 50) { cur = byId.get(cur.parent_id); if (cur) out.push(cur); } return out; };
  const scored = locations.map(l => {
    let score = 0;
    const partsMatched = new Set();
    parts.forEach((p, idx) => {
      const names = [p, ...(LOCATION_ALIASES[p] || [])];
      let best = 0;
      for (const n of names) {
        if (l.name === n) best = Math.max(best, 10 * n.length);
        else if (l.name.includes(n)) best = Math.max(best, 6 * n.length);
        else if (n.includes(l.name) && l.name.length >= 2) {
          // 短语里同时出现了上级名称（"卫生间镜柜"）→ 更具体的下级优先
          const anc = ancestors(l).filter(a => n.includes(a.name)).length;
          best = Math.max(best, 4 * l.name.length + 5 * anc);
        }
      }
      if (best) { score += best * (idx === parts.length - 1 ? 1.5 : 1); partsMatched.add(idx); }
      // 父级命中加分（"卧室的衣柜"→卧室/衣柜）
      else if (ancestors(l).some(a => names.some(n => a.name === n || a.name.includes(n)))) { score += 3 * p.length; partsMatched.add(idx); }
    });
    return { l, score, partsMatched };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score || b.l.depth - a.l.depth);

  if (scored.length) {
    const top = scored[0];
    const alternatives = scored.slice(1, 4).filter(s => s.score >= top.score * 0.6).map(s => ({ id: s.l.id, path: s.l.path }));
    // 有部分词没匹配到：可能是在已有位置下新建子位置，如"厨房的第三个抽屉"
    const unmatched = parts.filter((_, i) => !top.partsMatched.has(i));
    if (unmatched.length && top.partsMatched.size) {
      const name = unmatched.join('');
      return { location: null, create: { name, parent_id: top.l.id, parent_path: top.l.path, path: `${top.l.path} / ${name}` }, alternatives: [{ id: top.l.id, path: top.l.path }, ...alternatives], phrase };
    }
    return { location: { id: top.l.id, path: top.l.path }, create: null, alternatives, phrase, ambiguous: alternatives.length > 0 && scored[1].score === top.score };
  }
  // 完全没匹配：建议新建（多级用"的"分开）
  const name = parts[parts.length - 1];
  const parentPath = parts.length > 1 ? parts.slice(0, -1).join(' / ') : null;
  return { location: null, create: { name, parent_id: null, parent_path: parentPath, path: parentPath ? `${parentPath} / ${name}` : name }, alternatives: [], phrase };
}

// ---------- 物品匹配 ----------
function matchItem(name, items) {
  const n = name.replace(/\s/g, '');
  if (!n) return null;
  const exact = items.find(i => i.name.replace(/\s/g, '') === n);
  if (exact) return exact;
  const cands = items.filter(i => { const a = i.name.replace(/\s/g, ''); return a.length >= 2 && n.length >= 2 && (a.includes(n) || n.includes(a)); });
  cands.sort((a, b) => Math.abs(a.name.length - n.length) - Math.abs(b.name.length - n.length));
  return cands[0] || null;
}

// ---------- 主入口 ----------
const FILLERS = /^(我|今天|今儿|昨天|刚才|刚刚|刚|帮我|请|麻烦|记一下|记录一下|记录|记一笔|那个|嗯|然后|另外|还有就是|对了|顺便)+/;
const PUT = '(?:放到|放在|放进|放入|放回|放|收到|收在|收进|搁到|搁在|搁|塞到|塞进|塞|摆到|摆在|摆|挂到|挂在|挂|存到|存在|存进|存|丢到|丢进|扔到|扔进|移到|移至|搬到|搬去|拿到|转移到|归到)(?:了)?(?:到|在|进|去)?(?:了)?';
const BUY = '(?:买了|买回来了|买回来|买回了|买回|新买了|新买|添了|新添了|新增了|新增|添置了|添置|入手了|入手|到了|收到了|领了|囤了|囤|进了|加了|补了|补货|又买了)';
const USE = '(?:用了|吃了|喝了|拿了|拿走了|取了|取走了|消耗了|少了|用掉了|吃掉了|送人了|给人了)';
const GONE = '(?:用完了|吃完了|喝完了|没了|没有了|用光了|用没了|吃光了|扔了|扔掉了|丢了|丢掉了|过期扔了|处理掉了)';

function parse(text, ctx = {}) {
  const { locations = [], items = [], today = new Date() } = ctx;
  const original = String(text || '').trim();
  let t = original.replace(/[！!。？?～~\s]+/g, '').replace(/．/g, '.');
  t = t.replace(FILLERS, '');
  const { expires_at, rest } = extractExpiry(t, today);
  t = rest.replace(FILLERS, '');

  const intents = [];
  let conf = 'high';
  let m;
  const mkItems = (phrase, action, extra = {}) => {
    for (const p of splitItems(phrase)) {
      const q = extractQuantity(p);
      const name = cleanName(q.name);
      if (!name) continue;
      intents.push({ action, name, quantity: q.quantity, unit: q.unit, ...extra });
    }
  };

  if ((m = t.match(new RegExp(`^(?:把|将)?(.+?)${GONE}$`)))) {
    mkItems(m[1], 'deplete');
  } else if ((m = t.match(new RegExp(`^${USE}(.+)$`)))) {
    mkItems(m[1], 'consume');
  } else if ((m = t.match(new RegExp(`^(.+?)${USE}(${NUM_RE})?(${UNIT_RE})?$`)))) {
    const q = extractQuantity(m[1]);
    intents.push({ action: 'consume', name: cleanName(q.name), quantity: m[2] ? parseNumber(m[2]) : q.quantity, unit: m[3] || q.unit });
  } else if ((m = t.match(new RegExp(`^(.+?)(?:还有|还剩|剩下|剩|只剩|现在有|库存|数量是|数量)(${NUM_RE})(${UNIT_RE})?$`)))) {
    intents.push({ action: 'set_quantity', name: cleanName(m[1]), quantity: parseNumber(m[2]), unit: m[3] || '' });
  } else if ((m = t.match(new RegExp(`^(?:把|将)(.+?)${PUT}(.+)$`)))) {
    mkItems(m[1], 'move', { locationPhrase: m[2] });                    // 把 X 放到 Y
  } else if ((m = t.match(new RegExp(`^${BUY}(.+?)${PUT}(.+)$`)))) {
    mkItems(m[1], 'add', { locationPhrase: m[2] });                     // 买了 X 放到 Y
  } else if ((m = t.match(new RegExp(`^${BUY}(.+)$`)))) {
    mkItems(m[1], 'add');                                               // 买了 X
  } else if ((m = t.match(new RegExp(`^(.+?)${PUT}(.+)$`)))) {
    mkItems(m[1], 'move', { locationPhrase: m[2] });                    // X 放到 Y
  } else if ((m = t.match(/^(.+?)(?:在|位于)(.+)$/))) {
    mkItems(m[1], 'move', { locationPhrase: m[2] });                    // X 在 Y
    conf = 'medium';
  } else if (expires_at && t) {
    mkItems(t, 'expire');                                               // X 保质期到……
  } else if (t) {
    mkItems(t, 'add');                                                  // 兜底：当作新增
    conf = 'low';
  }

  // 完善每条意图：位置匹配 / 已有物品 / 分类 / 到期
  for (const it of intents) {
    it.location = it.locationPhrase ? matchLocation(it.locationPhrase, locations) : null;
    delete it.locationPhrase;
    it.existing = matchItem(it.name, items);
    if (it.action === 'move' && !it.existing) it.action = 'add';                 // 没这个物品，"放到"就是新增
    if (it.action === 'add' && it.existing) {
      const sameLoc = it.location?.location && it.existing.location_id === it.location.location.id;
      if (sameLoc || !it.location) it.action = 'restock';                           // 已有同名物品 → 加数量
    }
    if (['consume', 'deplete', 'set_quantity', 'expire'].includes(it.action) && !it.existing) { it.warning = `没有找到叫「${it.name}」的物品，将按新增处理`; it.action = 'add'; conf = 'low'; }
    if (it.action === 'consume' && it.quantity == null) it.quantity = 1;
    if (['add', 'restock'].includes(it.action) && it.quantity == null) it.quantity = 1;
    const locPath = it.location?.location?.path || it.location?.create?.path || it.existing?.location_path || '';
    it.category = it.existing?.category || guessCategory(it.name, locPath);
    it.expires_at = expires_at || '';
    if (!it.unit && it.existing?.unit) it.unit = it.existing.unit;
    if (it.location?.ambiguous && conf === 'high') conf = 'medium';
  }
  return { text: original, intents, confidence: intents.length ? conf : 'none' };
}

module.exports = { parse, matchLocation, matchItem, guessCategory, extractExpiry, extractQuantity, parseNumber, CATEGORY_KEYWORDS };
