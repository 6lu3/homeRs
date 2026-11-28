// docx 模板解析与填充测试：node test/report-docx.test.js
// 模板由 test/helpers/report-template.js 现场构造（合成数据，不含真实周报内容）
const { extractText, checkTemplate, fillTemplate } = require('../lib/report-docx');
const { readZip, writeZip } = require('../lib/zip');
const { buildTemplate } = require('./helpers/report-template');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + e.message); }
}
function eq(got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function throws(fn, test) {
  try { fn(); } catch (e) { if (typeof test === 'function' ? test(e.message) : e.message === test) return e.message; throw new Error('错误消息不符：' + e.message); }
  throw new Error('应当抛错');
}
const doc = buf => readZip(buf).get('word/document.xml').toString('utf8');
const numbering = buf => readZip(buf).get('word/numbering.xml').toString('utf8');
const lines = buf => extractText(buf).split('\n');
const count = (s, re) => (s.match(re) || []).length;
const STRUCT = msg => msg && msg.startsWith('模板结构不认识：');

const DATA = {
  time: '2026.11.30',
  items: [
    { title: '项目A', lines: ['A细节1', 'A细节2', 'A细节3'], progress: 100 },
    { title: '项目B', lines: [], progress: 50 },
    { title: '项目C', lines: ['C细节1'], progress: 0 },
  ],
  issues: '无',
  plan: ['新计划1', '新计划2'],
  planRange: '2026.11.30-2026.12.4',
};

// ---------- extractText ----------
check('extractText：表格外的段落、表格按行按格，空单元格和空段落省略', () => {
  eq(lines(buildTemplate()), [
    '工 作 周 报',
    '部门 | 技术部 | 姓名 | 测试员 | 时间 | 2026.1.1',
    '本周工作内容',
    '序号 | 工作内容 | 解决方案及结果',
    '1 | 事项甲 / 细节一 / 细节二 | 100%',
    '2 | 事项乙 / 细节一 / 细节二 | 100%',
    '3 | 事项丙 / 细节一 / 细节二 | 100%',
    '本周工作需协调解决的问题或者建议',
    '无',
    '序号 | 工作计划 | 日期',
    '1 | 计划一 | 2026.1.1-2026.1.5',
    '2 | 计划二 | 2026.1.1-2026.1.5',
    '3 | 计划三 | 2026.1.1-2026.1.5',
    '部门经理批阅',
    '签名：某某   日期： 2026.1.1',
  ]);
});
check('extractText：不是有效 docx', () => {
  throws(() => extractText(Buffer.from('随便什么内容')), '不是有效的 docx 文件');
  throws(() => extractText(writeZip([['a.txt', Buffer.from('x')]])), '不是有效的 docx 文件');
});

// ---------- checkTemplate ----------
check('checkTemplate：合法模板返回抬头里的姓名', () => {
  eq(checkTemplate(buildTemplate()), { name: '测试员' });
  eq(checkTemplate(buildTemplate({ name: '' })), { name: '' });
});
for (const [omit, keyword] of [['time', '时间'], ['workHeader', '工作内容'], ['issueTitle', '本周工作需协调'], ['planHeader', '工作计划'], ['approve', '部门经理批阅'], ['signDate', '日期']]) {
  check(`checkTemplate：缺少「${keyword}」被拒绝并说明`, () => {
    const msg = throws(() => checkTemplate(buildTemplate({ omit })), STRUCT);
    if (!msg.includes(keyword)) throw new Error('消息里没有关键字：' + msg);
  });
}
check('checkTemplate：缺编号定义 / 样板缺细节段 / 多张表 / 单元格数不对 / 跨列不对', () => {
  if (!throws(() => checkTemplate(buildTemplate({ omit: 'numbering' })), STRUCT).includes('编号')) throw new Error('应提到编号');
  if (!throws(() => checkTemplate(buildTemplate({ omit: 'detailPara' })), STRUCT).includes('细节段')) throw new Error('应提到细节段');
  if (!throws(() => checkTemplate(buildTemplate({ extraTable: true })), STRUCT).includes('一张表')) throw new Error('应提到只能有一张表');
  if (!throws(() => checkTemplate(buildTemplate({ fourCells: true })), STRUCT).includes('单元格')) throw new Error('应提到单元格');
  if (!throws(() => checkTemplate(buildTemplate({ badSpan: true })), STRUCT).includes('单元格')) throw new Error('应提到单元格');
});
check('checkTemplate：不是 docx', () => {
  throws(() => checkTemplate(Buffer.from('not a zip')), '不是有效的 docx 文件');
  throws(() => checkTemplate(writeZip([['a.txt', Buffer.from('x')]])), '不是有效的 docx 文件');
});

// ---------- fillTemplate ----------
check('fillTemplate：工作项（含没有细节行的项目）、序号、完成度、问题、时间和签名日期', () => {
  const out = fillTemplate(buildTemplate(), DATA);
  eq(lines(out), [
    '工 作 周 报',
    '部门 | 技术部 | 姓名 | 测试员 | 时间 | 2026.11.30',
    '本周工作内容',
    '序号 | 工作内容 | 解决方案及结果',
    '1 | 项目A / A细节1 / A细节2 / A细节3 | 100%',
    '2 | 项目B | 50%',
    '3 | 项目C / C细节1 | 0%',
    '本周工作需协调解决的问题或者建议',
    '无',
    '序号 | 工作计划 | 日期',
    '1 | 新计划1 | 2026.11.30-2026.12.4',
    '2 | 新计划2 | 2026.11.30-2026.12.4',
    '部门经理批阅',
    '签名：某某   日期： 2026.11.30',
  ]);
});
check('fillTemplate：5 个工作项；模板里原有的假内容全部消失', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ title: `T${i + 1}`, lines: ['x'], progress: 10 * (i + 1) }));
  const text = extractText(fillTemplate(buildTemplate(), { ...DATA, items }));
  for (const gone of ['事项甲', '事项乙', '事项丙', '计划一', '计划二', '计划三', '细节一']) if (text.includes(gone)) throw new Error('旧内容还在：' + gone);
  eq(text.split('\n').filter(l => /^\d \| T\d/.test(l)).length, 5);
  if (!text.includes('5 | T5 / x | 50%')) throw new Error('第 5 项不对');
});
check('fillTemplate：问题为空白时写「无」，有内容时照写', () => {
  eq(lines(fillTemplate(buildTemplate(), { ...DATA, issues: '   ' })).indexOf('无') > 0, true);
  const t = lines(fillTemplate(buildTemplate(), { ...DATA, issues: '需要采购配件' }));
  eq(t[t.indexOf('本周工作需协调解决的问题或者建议') + 1], '需要采购配件');
});
check('fillTemplate：计划 0 条保留一行全空的计划行，1 条 / 5 条正常', () => {
  const rowsOf = buf => count(doc(buf), /<w:tr[ >]/g);
  const one = fillTemplate(buildTemplate(), { ...DATA, plan: ['只有一条'] });
  const zero = fillTemplate(buildTemplate(), { ...DATA, plan: [] });
  eq(rowsOf(zero), rowsOf(one));                                              // 空计划仍保留一行
  const planPart = buf => { const l = lines(buf); return l.slice(l.indexOf('序号 | 工作计划 | 日期') + 1, l.indexOf('部门经理批阅')); };
  eq(planPart(zero), []);                                                     // 那一行全空，extractText 里不出现
  eq(planPart(one), ['1 | 只有一条 | 2026.11.30-2026.12.4']);
  eq(planPart(fillTemplate(buildTemplate(), { ...DATA, plan: ['a', 'b', 'c', 'd', 'e'] })).length, 5);
});
check('fillTemplate：行高只改填过的行（exact → atLeast），其他行不动', () => {
  const x = doc(fillTemplate(buildTemplate(), DATA));
  const rows = [...x.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(m => m[0]);
  const filled = rows.filter(r => /项目[ABC]|新计划/.test(r));
  eq(filled.length, 5);
  for (const r of filled) if (r.includes('hRule="exact"') || !r.includes('hRule="atLeast"')) throw new Error('填过的行行高没改');
  const head = rows.find(r => r.includes('技术部'));
  if (!head.includes('hRule="exact"')) throw new Error('抬头行不该被改动');
});
check('fillTemplate：每个工作项用自己的新编号（从 1 开始），新 <w:num> 插在 numIdMacAtCleanup 之前', () => {
  const tpl = buildTemplate();
  const before = numbering(tpl), out = fillTemplate(tpl, DATA), after = numbering(out);
  eq(count(after, /<w:num\s/g), count(before, /<w:num\s/g) + 3);
  const oldMax = Math.max(...[...before.matchAll(/<w:num\s[^>]*w:numId="(\d+)"/g)].map(m => +m[1]));
  const fresh = [...after.matchAll(/<w:num\s[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)].filter(m => +m[1] > oldMax);
  eq(fresh.length, 3);
  eq(new Set(fresh.map(m => m[1])).size, 3);
  for (const m of fresh) if (!/<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"\/><\/w:lvlOverride>/.test(m[2])) throw new Error('缺 startOverride');
  if (after.indexOf('<w:numIdMacAtCleanup') < after.lastIndexOf('</w:num>')) throw new Error('新 num 没有插在 numIdMacAtCleanup 之前');
  // 第 k 个项目的细节段都用第 k 个新 numId
  const rows = [...doc(out).matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(m => m[0]);
  const ids = ['项目A', '项目B', '项目C'].map(t => [...new Set([...rows.find(r => r.includes(t)).matchAll(/<w:numId w:val="(\d+)"/g)].map(m => m[1]))]);
  eq(ids[0], [fresh[0][1]]); eq(ids[1], []); eq(ids[2], [fresh[2][1]]);
});
check('fillTemplate：文字转义，控制字符去掉，换行变空格；读回的文字是转义前的内容', () => {
  const nasty = 'a<b>&"\'c\u0001d\ne';
  const out = fillTemplate(buildTemplate(), { ...DATA, items: [{ title: nasty, lines: [nasty], progress: 1 }], issues: nasty, plan: [nasty] });
  const x = doc(out);
  if (!x.includes('a&lt;b&gt;&amp;')) throw new Error('没有转义');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(x)) throw new Error('还有控制字符');
  const want = 'a<b>&"\'cd e';
  if (!lines(out).some(l => l.includes(`1 | ${want} / ${want} | 1%`))) throw new Error('工作项读回不对');
  if (!lines(out).includes(want)) throw new Error('问题读回不对');
});
check('fillTemplate：输出结构完整——能解开、条目名和顺序不变、Content_Types 不变、标签配对、没有重复的 paraId', () => {
  const tpl = buildTemplate(), out = fillTemplate(tpl, DATA);
  const a = readZip(tpl), b = readZip(out);
  eq([...b.keys()], [...a.keys()]);
  if (!b.get('[Content_Types].xml').equals(a.get('[Content_Types].xml'))) throw new Error('Content_Types 被改动');
  if (!b.get('_rels/.rels').equals(a.get('_rels/.rels'))) throw new Error('_rels 被改动');
  const x = doc(out);
  for (const [open, close] of [[/<w:tr[ >]/g, /<\/w:tr>/g], [/<w:tc[ >]/g, /<\/w:tc>/g], [/<w:p[ >]/g, /<\/w:p>/g], [/<w:tbl[ >]/g, /<\/w:tbl>/g]]) eq(count(x, open), count(x, close));
  const ids = [...x.matchAll(/w14:paraId="([^"]*)"/g)].map(m => m[1]);
  eq(new Set(ids).size, ids.length);
  if (!x.startsWith('<?xml')) throw new Error('XML 声明丢了');
});
check('fillTemplate：填过的文档还能当模板（第一个工作项有细节行时）', () => {
  eq(checkTemplate(fillTemplate(buildTemplate(), DATA)), { name: '测试员' });
});
// 真实模板里签名处的日期被 Word 拆成了很多个 run（"202" "6" "." "11" "." "28"），不能只看单个文字节点
check('fillTemplate：签名日期被拆在多个 run 里（真实模板的写法）也能替换，姓名和空格保留', () => {
  const tpl = buildTemplate({ signRuns: 'split' });
  eq(checkTemplate(tpl), { name: '测试员' });
  const out = fillTemplate(tpl, DATA);
  eq(lines(out)[lines(out).length - 1], '签名：某某   日期： 2026.11.30');
  eq(lines(fillTemplate(tpl, { ...DATA, time: '2026.12.4' })).pop(), '签名：某某   日期： 2026.12.4');
  eq(count(doc(out), /<w:p[ >]/g), count(doc(out), /<\/w:p>/g));
  if (!doc(out).includes('xml:space="preserve">   日期： <')) throw new Error('前导空格所在的节点丢了 xml:space');
});
check('fillTemplate：日期后面还有文字时只替换日期', () => {
  const out = fillTemplate(buildTemplate({ signRuns: 'trailing' }), DATA);
  eq(lines(out).pop(), '签名：某某   日期： 2026.11.30 完');
});
check('fillTemplate：坏模板抛和 checkTemplate 相同的错误', () => {
  for (const omit of ['time', 'workHeader', 'signDate', 'numbering']) {
    const bad = buildTemplate({ omit });
    let want; try { checkTemplate(bad); } catch (e) { want = e.message; }
    throws(() => fillTemplate(bad, DATA), want);
  }
});
check('fillTemplate：多于模板原有行数的计划和项目（模板只有 1 行样板时也行）', () => {
  const out = fillTemplate(buildTemplate({ workRows: 1, planRows: 1 }), DATA);
  eq(lines(out).filter(l => /^\d \| 项目/.test(l)).length, 3);
  eq(lines(out).filter(l => /^\d \| 新计划/.test(l)).length, 2);
});

// ---------- 终审补充 ----------
const timed = fn => { const t = Date.now(); const r = fn(); return [r, Date.now() - t]; };
const withDoc = (tpl, fn) => { const z = readZip(tpl); z.set('word/document.xml', Buffer.from(fn(z.get('word/document.xml').toString('utf8')))); return writeZip(z); };

check('含修订记录 / 被插入的内容的模板：上传时就拒绝并说明怎么办（否则按懒惰正则截取会生成不配对的标签）', () => {
  for (const opts of [{ trackedChanges: true }, { insertedRun: true }]) {
    const msg = throws(() => checkTemplate(buildTemplate(opts)), STRUCT);
    if (!msg.includes('修订')) throw new Error('应提示修订记录：' + msg);
    throws(() => fillTemplate(buildTemplate(opts), DATA), STRUCT);
  }
});
check('标签不配对的文档被拒绝；大量没闭合的 <w:tr> 也被很快拒绝（不会让正则卡住）', () => {
  const broken = withDoc(buildTemplate(), x => x.replace('</w:p></w:tc></w:tr></w:tbl>', '</w:tc></w:tr></w:tbl>'));
  if (!throws(() => checkTemplate(broken), STRUCT).includes('不配对')) throw new Error('应提示标签不配对');
  const bomb = withDoc(buildTemplate(), x => x.replace('</w:tbl>', '<w:tr>'.repeat(300000) + '</w:tbl>'));
  const [, ms] = timed(() => { try { checkTemplate(bomb); } catch (e) { return e.message; } });
  if (ms > 2000) throw new Error(`拒绝太慢：${ms} ms`);
  throws(() => checkTemplate(bomb), STRUCT);
});
check('「需协调的问题」那一行也把固定行高改成最小行高', () => {
  const out = fillTemplate(buildTemplate(), { ...DATA, issues: '需要采购配件' });
  const rows = [...doc(out).matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(m => m[0]);
  const issue = rows.find(r => r.includes('需要采购配件'));
  if (issue.includes('hRule="exact"') || !issue.includes('hRule="atLeast"')) throw new Error('问题行行高没改');
  if (!rows.find(r => r.includes('技术部')).includes('hRule="exact"')) throw new Error('抬头行不该被改动');
});
check('编号层级取自样板细节段（ilvl 不是 0 时 startOverride 也用同一层）', () => {
  const out = fillTemplate(buildTemplate({ detailIlvl: 1 }), DATA);
  const n = numbering(out);
  eq(count(n, /<w:lvlOverride w:ilvl="1"><w:startOverride w:val="1"\/>/g), 3);
  eq(count(n, /<w:lvlOverride w:ilvl="0">/g), 0);
});
check('标题段带 numId=0（取消编号）不算「带编号」，不误拒绝', () => {
  const tpl = buildTemplate({ titleNumZero: true });
  eq(checkTemplate(tpl), { name: '测试员' });
  eq(lines(fillTemplate(tpl, DATA)).filter(l => /^\d \| 项目/.test(l)).length, 3);
});
check('压缩包层面的问题透传固定文案（条目过多），其余仍是「不是有效的 docx 文件」', () => {
  const many = writeZip(Array.from({ length: 201 }, (_, i) => [`f${i}.txt`, Buffer.from('x')]));
  throws(() => checkTemplate(many), '压缩包条目过多');
  throws(() => extractText(many), '压缩包条目过多');
  throws(() => checkTemplate(Buffer.from('不是 zip')), '不是有效的 docx 文件');
});

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
