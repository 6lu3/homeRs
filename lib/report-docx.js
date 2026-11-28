'use strict';
// 周报 docx 的读取和模板填充（无 I/O，只依赖 ./zip）。
// 模板是用户的真实 Word 周报：一张表，靠合并单元格排版。我们按关键字找到各个区域，
// 以每个区域的第一行为样板复制行、替换文字，其余原样保留。
const { readZip, writeZip } = require('./zip');

const NOT_DOCX = '不是有效的 docx 文件';
const bad = msg => new Error('模板结构不认识：' + msg);

// ---------- 小工具 ----------
const cp = n => { try { return String.fromCodePoint(n); } catch { return ''; } };
const unesc = s => s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => cp(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => cp(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// 填进 XML 的文字：去掉 XML 1.0 不允许的控制字符，换行 / 制表变空格，再转义
const esc = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[\r\n\t]+/g, ' ')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const norm = s => s.replace(/\s+/g, '');

const RE_TR = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
const RE_TC = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
const RE_P = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const RE_DATE = /(日期[:：]\s*)\d{4}\.\d{1,2}\.\d{1,2}/;
const HAS_NUMPR = /<w:numPr>/;

function paraText(p) {
  let t = '';
  p.replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g, (m, g) => { t += g !== undefined ? unesc(g) : m === '<w:tab/>' ? '\t' : '\n'; return m; });
  return t;
}
function parseCell(xml, start) {
  const span = /<w:gridSpan w:val="(\d+)"/.exec(xml);
  const paras = [...xml.matchAll(RE_P)].map(m => ({ xml: m[0], text: paraText(m[0]) }));
  return { xml, start, end: start + xml.length, span: span ? +span[1] : 1, paras, text: paras.map(p => p.text).join('') };
}
function parseRow(xml, start) {
  const cells = [...xml.matchAll(RE_TC)].map(m => parseCell(m[0], m.index));
  return { xml, start, end: start + xml.length, cells, texts: cells.map(c => norm(c.text)) };
}
function openDocx(docx) {
  let z;
  try { z = readZip(docx); } catch { throw new Error(NOT_DOCX); }
  const buf = z.get('word/document.xml');
  if (!buf) throw new Error(NOT_DOCX);
  return { z, xml: buf.toString('utf8') };
}

// ---------- 读取文字 ----------
// 表格外的段落各占一行；表格每行占一行，单元格用 " | " 连接，单元格里的多个段落用 " / " 连接，空的省略
function extractText(docx) {
  const { xml } = openDocx(docx);
  const body = xml.slice(Math.max(0, xml.indexOf('<w:body')));
  const out = [];
  body.replace(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, blk => {
    if (blk.startsWith('<w:tbl')) {
      for (const tr of blk.matchAll(RE_TR)) {
        const cells = [...tr[0].matchAll(RE_TC)].map(m => parseCell(m[0], 0).paras.map(p => p.text.trim()).filter(Boolean).join(' / ')).filter(Boolean);
        if (cells.length) out.push(cells.join(' | '));
      }
    } else {
      const t = paraText(blk).trim();
      if (t) out.push(t);
    }
    return blk;
  });
  return out.join('\n');
}

// ---------- 分析模板（checkTemplate 和 fillTemplate 共用） ----------
function parseNums(numXml) {
  const map = new Map();
  let max = 0;
  for (const m of numXml.matchAll(/<w:num\s[^>]*>[\s\S]*?<\/w:num>/g)) {
    const id = /w:numId="(\d+)"/.exec(m[0]), ab = /<w:abstractNumId w:val="(\d+)"/.exec(m[0]);
    if (id && ab) { map.set(id[1], ab[1]); max = Math.max(max, +id[1]); }
  }
  return { map, max };
}

function analyze(docx) {
  const { z, xml } = openDocx(docx);
  const tblCount = (xml.match(/<w:tbl(?:\s[^>]*)?>/g) || []).length;
  if (tblCount === 0) throw bad('找不到表格');
  if (tblCount > 1) throw bad('应当只有一张表格');
  const tStart = xml.search(/<w:tbl(?:\s[^>]*)?>/), tEnd = xml.indexOf('</w:tbl>') + '</w:tbl>'.length;
  const rows = [...xml.slice(tStart, tEnd).matchAll(RE_TR)].map(m => parseRow(m[0], tStart + m.index));

  const find = (from, pred) => { for (let i = from; i < rows.length; i++) if (pred(rows[i])) return i; return -1; };
  const has = (r, t) => r.texts.includes(t);
  const inc = (r, t) => r.texts.some(x => x.includes(t));
  const iTime = find(0, r => r.texts.indexOf('时间') >= 0 && r.texts.indexOf('时间') < r.texts.length - 1);
  if (iTime < 0) throw bad('找不到抬头里的「时间」');
  const iWH = find(iTime + 1, r => has(r, '工作内容') && has(r, '解决方案及结果'));
  if (iWH < 0) throw bad('找不到「工作内容」「解决方案及结果」表头');
  const iIssue = find(iWH + 1, r => inc(r, '本周工作需协调解决的问题或者建议'));
  if (iIssue < 0) throw bad('找不到「本周工作需协调解决的问题或者建议」');
  const iPH = find(iIssue + 1, r => has(r, '工作计划') && has(r, '日期'));
  if (iPH < 0) throw bad('找不到「工作计划」「日期」表头');
  const iAp = find(iPH + 1, r => inc(r, '部门经理批阅'));
  if (iAp < 0) throw bad('找不到「部门经理批阅」');
  if (iIssue + 1 >= iPH) throw bad('「本周工作需协调解决的问题或者建议」下面没有内容行');
  if (iAp + 1 >= rows.length) throw bad('「部门经理批阅」下面没有签名行');
  if (iWH + 1 >= iIssue) throw bad('「工作内容」表头下面没有样板行');
  if (iPH + 1 >= iAp) throw bad('「工作计划」表头下面没有样板行');

  const signRow = rows[iAp + 1];
  // Word 常把一个日期拆成很多个 run（"202" "6" "." "11" …），所以按整段文字找，而不是按单个文字节点
  if (![...signRow.xml.matchAll(RE_P)].some(p => RE_DATE.test(paraText(p[0])))) throw bad('找不到签名处的日期（形如「日期： 2026.11.28」）');

  const wSample = rows[iWH + 1], pSample = rows[iPH + 1];
  const spansOk = r => r.cells.length === 3 && r.cells.map(c => c.span).join() === '1,3,2';
  if (!spansOk(wSample)) throw bad('工作项样板行应当有 3 个单元格（依次跨 1 / 3 / 2 列）');
  if (!spansOk(pSample)) throw bad('计划样板行应当有 3 个单元格（依次跨 1 / 3 / 2 列）');

  const content = wSample.cells[1];
  const titleP = content.paras[0];
  if (!titleP) throw bad('工作项样板的内容格里没有段落');
  if (HAS_NUMPR.test(titleP.xml)) throw bad('工作项样板缺少标题段（第一段不应带编号）');
  const detailP = content.paras.find(p => HAS_NUMPR.test(p.xml));
  if (!detailP) throw bad('工作项样板缺少带编号的细节段');
  const sampleNumId = (/<w:numId w:val="(\d+)"/.exec(detailP.xml) || [])[1];
  const numBuf = z.get('word/numbering.xml');
  if (!sampleNumId || !numBuf) throw bad('找不到编号定义（word/numbering.xml）');
  const nums = parseNums(numBuf.toString('utf8'));
  if (!nums.map.has(sampleNumId)) throw bad('找不到样板细节段所用的编号定义');

  let name = '';
  for (let i = 0; i <= iTime && !name; i++) {
    const k = rows[i].texts.indexOf('姓名');
    if (k >= 0 && rows[i].cells[k + 1]) name = rows[i].cells[k + 1].text.trim();
  }
  return { z, xml, rows, iTime, iWH, iIssue, iPH, iAp, signRow, titleP, detailP, sampleNumId, numXml: numBuf.toString('utf8'), nums, name };
}

function checkTemplate(docx) {
  return { name: analyze(docx).name };
}

// ---------- 填充 ----------
const firstPara = cell => (cell.paras[0] ? cell.paras[0].xml : '<w:p></w:p>');

// 按样板段落重建一个段落：保留段落属性和第一个 run 的格式，只换文字（也顺带去掉 w14:paraId 等属性）
function rebuildPara(sampleP, text, numId) {
  const pPrM = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(sampleP);
  let pPr = pPrM ? pPrM[0] : '';
  if (numId != null) pPr = pPr.replace(/(<w:numId w:val=")\d+(")/, `$1${numId}$2`);
  const run = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/.exec(sampleP);
  const rPrM = run ? /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(run[0]) : /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(pPr);   // 没有 run 的空段落：用段落标记上的格式
  return `<w:p>${pPr}<w:r>${rPrM ? rPrM[0] : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}
// 把单元格里的所有段落换成 paras
function setCellParas(cellXml, paras) {
  const first = cellXml.search(/<w:p(?:\s[^>]*)?>/);
  const end = cellXml.lastIndexOf('</w:tc>');
  return cellXml.slice(0, first >= 0 ? first : end) + paras.join('') + '</w:tc>';
}
// 用样板行的行属性 + 新的单元格拼出一行；行高 exact 改成 atLeast（否则内容多了 Word 会截断）
function buildRow(sample, cellXmls) {
  const prefix = sample.xml.slice(0, sample.cells[0].start).replace(/w:hRule="exact"/g, 'w:hRule="atLeast"');
  return (prefix + cellXmls.join('') + '</w:tr>').replace(/ w14:(?:paraId|textId)="[^"]*"/g, '');
}

// 把一个段落里「日期：」后面的日期换成 time。日期可能被拆在多个 <w:t> 里：
// 按整段文字找到日期的范围，把新日期写进第一个涉及的节点，其余涉及的节点只清掉被替换的那部分，节点之外的文字和格式都不动。
function replaceDate(pXml, time) {
  const nodes = [...pXml.matchAll(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g)].map(m => ({ index: m.index, open: m[1], close: m[3], text: unesc(m[2]), len: m[0].length }));
  const full = nodes.map(n => n.text).join('');
  const m = RE_DATE.exec(full);
  if (!m) return pXml;
  const ds = m.index + m[1].length, de = m.index + m[0].length;
  let off = 0, first = true, out = '', last = 0;
  for (const n of nodes) {
    const a = off, b = off + n.text.length;
    off = b;
    out += pXml.slice(last, n.index);
    last = n.index + n.len;
    let text = n.text;
    if (b > ds && a < de) {
      const before = a < ds ? n.text.slice(0, ds - a) : '';
      const after = b > de ? n.text.slice(de - a) : '';
      text = before + (first ? time : '') + after;
      first = false;
    }
    let open = n.open;
    if (/^\s|\s$/.test(text) && !/xml:space=/.test(open)) open = open.replace(/>$/, ' xml:space="preserve">');
    out += open + esc(text) + n.close;
  }
  return out + pXml.slice(last);
}

function fillTemplate(docx, data) {
  const a = analyze(docx);
  const { rows } = a;
  const items = Array.isArray(data.items) ? data.items : [];
  const plan = Array.isArray(data.plan) ? data.plan : [];

  // 编号：每个工作项用自己的一套（新建 <w:num>，指向样板所用的 abstractNum，并从 1 重新开始）
  const abstractId = a.nums.map.get(a.sampleNumId);
  const firstNew = a.nums.max + 1;
  let numXml = a.numXml;
  if (items.length) {
    const add = items.map((_, k) => `<w:num w:numId="${firstNew + k}"><w:abstractNumId w:val="${abstractId}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('');
    const at = numXml.lastIndexOf('</w:num>') + '</w:num>'.length;
    numXml = numXml.slice(0, at) + add + numXml.slice(at);
  }

  // 工作项区
  const wSample = rows[a.iWH + 1];
  const workXml = items.map((it, k) => {
    const [c0, c1, c2] = wSample.cells;
    const paras = [rebuildPara(a.titleP.xml, it.title)];
    for (const line of it.lines || []) paras.push(rebuildPara(a.detailP.xml, line, firstNew + k));
    return buildRow(wSample, [
      setCellParas(c0.xml, [rebuildPara(firstPara(c0), String(k + 1))]),
      setCellParas(c1.xml, paras),
      setCellParas(c2.xml, [rebuildPara(firstPara(c2), `${it.progress}%`)]),
    ]);
  }).join('');

  // 计划区（没有计划时保留一行全空的）
  const pSample = rows[a.iPH + 1];
  const planTexts = plan.length ? plan.map((t, k) => [String(k + 1), t, data.planRange]) : [['', '', '']];
  const planXml = planTexts.map(cols => buildRow(pSample, pSample.cells.map((c, i) => setCellParas(c.xml, [rebuildPara(firstPara(c), cols[i])])))).join('');

  // 问题行：第一个单元格只留一个段落
  const issueRow = rows[a.iIssue + 1];
  const ic = issueRow.cells[0];
  const issueNew = issueRow.xml.slice(0, ic.start) + setCellParas(ic.xml, [rebuildPara(firstPara(ic), String(data.issues ?? '').trim() || '无')]) + issueRow.xml.slice(ic.end);

  // 抬头里「时间」右边那一格
  const tRow = rows[a.iTime];
  const tc = tRow.cells[tRow.texts.indexOf('时间') + 1];
  const timeNew = tRow.xml.slice(0, tc.start) + setCellParas(tc.xml, [rebuildPara(firstPara(tc), data.time)]) + tRow.xml.slice(tc.end);

  // 签名行：只换「日期：」后面的日期，其余文字（包括签名姓名）原样
  const signNew = a.signRow.xml.replace(RE_P, p => replaceDate(p, data.time));

  // 从后往前替换，前面的位置不受影响
  let out = a.xml;
  const splice = (start, end, str) => { out = out.slice(0, start) + str + out.slice(end); };
  splice(a.signRow.start, a.signRow.end, signNew);
  splice(rows[a.iPH + 1].start, rows[a.iAp - 1].end, planXml);
  splice(issueRow.start, issueRow.end, issueNew);
  splice(rows[a.iWH + 1].start, rows[a.iIssue - 1].end, workXml);
  splice(tRow.start, tRow.end, timeNew);

  const entries = new Map();
  if (a.z.has('[Content_Types].xml')) entries.set('[Content_Types].xml', a.z.get('[Content_Types].xml'));
  for (const [k, v] of a.z) if (!entries.has(k)) entries.set(k, v);
  entries.set('word/document.xml', Buffer.from(out, 'utf8'));
  entries.set('word/numbering.xml', Buffer.from(numXml, 'utf8'));
  return writeZip(entries);
}

module.exports = { extractText, checkTemplate, fillTemplate };
