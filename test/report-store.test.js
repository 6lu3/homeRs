// 周报的文件存储测试：node test/report-store.test.js（临时目录，离线）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReportStore } = require('../lib/report-store');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + e.message); }
}
function eq(got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
const ok = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
const dirs = [];
const tmp = () => { const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'report-store-')), 'report'); dirs.push(d); return d; };   // 子目录还不存在：store 要按需创建

check('模板：没有时为 null，读写往返（目录不存在时自动创建）', () => {
  const s = createReportStore(tmp());
  eq(s.getTemplate(), null);
  eq(s.hasTemplate(), false);
  s.setTemplate(Buffer.from([1, 2, 3, 0, 255]));
  eq(s.hasTemplate(), true);
  ok(s.getTemplate().equals(Buffer.from([1, 2, 3, 0, 255])));
  s.setTemplate(Buffer.from('新的'));
  eq(s.getTemplate().toString(), '新的');
});
check('同标题替换：新的写失败时，旧的还在（先写新的再删旧的）', () => {
  const d = tmp(), s = createReportStore(d);
  s.addExample({ title: '同名', text: '旧' });
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('磁盘满了'); };
  let threw = false;
  try { s.addExample({ title: '同名', text: '新' }); } catch { threw = true; } finally { fs.renameSync = realRename; }
  ok(threw, '写入失败应当抛错');
  eq(s.readExamples(), ['旧']);
});
check('设置：缺省、往返、归一到周一、文件损坏按缺省', () => {
  const d = tmp(), s = createReportStore(d);
  eq(s.getSettings(), { anchor: '2026-11-23' });
  s.setSettings({ anchor: '2032-03-03' });
  eq(s.getSettings(), { anchor: '2032-03-01' });
  fs.writeFileSync(path.join(d, 'settings.json'), '{坏的');
  eq(s.getSettings(), { anchor: '2026-11-23' });
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ anchor: '不是日期' }));
  eq(s.getSettings(), { anchor: '2026-11-23' });
  let threw = false; try { s.setSettings({ anchor: '2032-13-01' }); } catch { threw = true; }
  ok(threw, '非法日期应当抛错');
});
check('示例：添加 5 份只剩最新 4 份，按 id 升序，title 和字数正确', () => {
  const s = createReportStore(tmp());
  const ids = [1, 2, 3, 4, 5].map(i => s.addExample({ title: `示例${i}`, text: '字'.repeat(i * 10) }));
  eq(ids.every((v, i) => i === 0 || v > ids[i - 1]), true);
  const list = s.listExamples();
  eq(list.map(x => x.title), ['示例2', '示例3', '示例4', '示例5']);
  eq(list.map(x => x.chars), [20, 30, 40, 50]);
  eq(list.map(x => x.id), ids.slice(1));
  eq(s.readExamples().map(t => t.length), [20, 30, 40, 50]);
});
check('示例：同标题替换（份数不增加、文字是新的）；超过 6000 字截断', () => {
  const s = createReportStore(tmp());
  s.addExample({ title: '11.23-11.28', text: '旧' });
  s.addExample({ title: '别的', text: 'x' });
  s.addExample({ title: '11.23-11.28', text: '新' });
  eq(s.listExamples().length, 2);
  eq(s.readExamples(), ['x', '新']);
  const id = s.addExample({ title: '长', text: '长'.repeat(7000) });
  eq(s.listExamples().find(x => x.id === id).chars, 6000);
});
check('示例：连续添加的 id 严格递增（同一毫秒也一样，包括替换同标题的情形）', () => {
  const real = Date.now; Date.now = () => 1_700_000_000_000;
  try {
    const s = createReportStore(tmp());
    const a = s.addExample({ title: 'a', text: '1' }), b = s.addExample({ title: 'b', text: '2' }), c = s.addExample({ title: 'a', text: '3' });
    ok(a < b && b < c, `${a} ${b} ${c}`);
  } finally { Date.now = real; }
});
check('示例：损坏的文件被跳过，列表不抛错', () => {
  const d = tmp(), s = createReportStore(d);
  const id = s.addExample({ title: '好的', text: '内容' });
  fs.writeFileSync(path.join(d, 'examples', '999.json'), '{坏的');
  fs.writeFileSync(path.join(d, 'examples', '998.json'), JSON.stringify({ title: 5 }));
  fs.writeFileSync(path.join(d, 'examples', 'note.txt'), 'x');
  eq(s.listExamples().map(x => x.id), [id]);
  eq(s.readExamples(), ['内容']);
});
check('示例：removeExample——存在 true、不存在 false、不合法的 id 一律 false 且不碰文件', () => {
  const d = tmp(), s = createReportStore(d);
  const id = s.addExample({ title: 't', text: 'x' });
  fs.writeFileSync(path.join(d, 'keep.json'), '{}');
  for (const bad of ['../keep', '1a', '0', 0, -1, 1.5, NaN, null, undefined, '', `${id}`, 1e21]) eq(s.removeExample(bad), false);
  ok(fs.existsSync(path.join(d, 'keep.json')), 'keep.json 被误删');
  eq(s.listExamples().length, 1);
  eq(s.removeExample(id), true);
  eq(s.removeExample(id), false);
  eq(s.listExamples(), []);
});
check('写入先写临时文件再改名：目录里没有遗留的 .tmp', () => {
  const d = tmp(), s = createReportStore(d);
  s.setTemplate(Buffer.from('x')); s.setSettings({ anchor: '2032-03-01' }); s.addExample({ title: 't', text: 'x' });
  const all = [...fs.readdirSync(d), ...fs.readdirSync(path.join(d, 'examples'))];
  eq(all.filter(n => n.endsWith('.tmp')), []);
});

for (const d of dirs) fs.rmSync(path.dirname(d), { recursive: true, force: true });
console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
