// 测试用的合成周报模板（docx）。结构与真实公司模板相同，内容全是假数据，不含任何真实周报内容。
// 用法：buildTemplate() 得到一个 Buffer；通过 opts 构造「缺了某一块」的坏模板。
'use strict';
const { writeZip } = require('../../lib/zip');

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const RPR = '<w:rPr><w:rFonts w:hint="eastAsia" w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体" w:cs="宋体"/><w:sz w:val="21"/></w:rPr>';
const NUMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const CN = ['一', '二', '三', '四', '五', '六', '七', '八'];
const W = [1168, 1692, 1692, 1853, 2054, 2280];          // 6 列网格
const W3 = W[1] + W[2] + W[3], W2 = W[4] + W[5], W6 = W.reduce((a, b) => a + b, 0);

function buildTemplate(opts = {}) {
  const { name = '测试员', workRows = 3, planRows = 3, omit, extraTable = false, badSpan = false, fourCells = false, signRuns } = opts;
  let pid = 0;
  const id = () => `w14:paraId="${(++pid).toString(16).toUpperCase().padStart(8, '0')}"`;
  const para = (text, { numId, jc = 'left' } = {}) =>
    `<w:p ${id()}><w:pPr>${numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` : ''}<w:spacing w:line="26" w:lineRule="atLeast"/><w:jc w:val="${jc}"/>${RPR}</w:pPr><w:r>${RPR}<w:t>${esc(text)}</w:t></w:r></w:p>`;
  const cell = (width, span, paras) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>${paras.join('')}</w:tc>`;
  const row = (cells, height, rule = 'exact') =>
    `<w:tr ${id()}><w:trPr><w:trHeight w:val="${height}" w:hRule="${rule}"/><w:jc w:val="center"/></w:trPr>${cells.join('')}</w:tr>`;
  const one = (text, jc) => [para(text, { jc })];
  const BROKEN = { time: '时刻', workHeader: '工作事项', issueTitle: '问题与建议', planHeader: '工作安排', approve: '经理意见' };
  const label = (key, text) => (omit === key ? BROKEN[key] : text);   // 构造坏模板：把某个关键字换成别的词
  // 签名段落。真实模板里日期被 Word 拆成了很多个 run（"202" "6" "." "11" "." "28"），所以这里也要能造出这种
  const run = (t, preserve) => `<w:r>${RPR}<w:t${preserve ? ' xml:space="preserve"' : ''}>${esc(t)}</w:t></w:r>`;
  const signPara = () => {
    if (omit === 'signDate') return para('签名：某某');
    if (signRuns === 'trailing') return para('签名：某某   日期： 2026.1.1 完');
    if (signRuns === 'split') {
      return `<w:p ${id()}><w:pPr>${RPR}</w:pPr>${run('签名：')}${run('某某')}${run('   日期： ', true)}${['202', '6', '.', '1', '.', '1'].map(t => run(t)).join('')}</w:p>`;
    }
    return para('签名：某某   日期： 2026.1.1');
  };

  const rows = [];
  // 抬头行：部门｜值｜姓名｜值｜时间｜值（行高用 exact，用来验证抬头行不会被改动）
  rows.push(row([
    cell(W[0], 1, one('部门')), cell(W[1], 1, one('技术部')), cell(W[2], 1, one('姓名')), cell(W[3], 1, one(name)),
    cell(W[4], 1, one(label('time', '时间'))), cell(W[5], 1, one('2026.1.1')),
  ], 400));
  rows.push(row([cell(W6, 6, one('本周工作内容'))], 400));
  rows.push(row([cell(W[0], 1, one('序号')), cell(W3, 3, one(label('workHeader', '工作内容'))), cell(W2, 2, one('解决方案及结果'))], 400));
  for (let k = 1; k <= workRows; k++) {
    const content = [para(`事项${NUMS[k - 1] || k}`)];
    if (omit !== 'detailPara') content.push(para('细节一', { numId: k }), para('细节二', { numId: k }));
    const cells = [cell(W[0], 1, one(String(k), 'center'))];
    if (fourCells) cells.push(cell(W3, 3, content), cell(W[4], 1, one('额外')), cell(W[5], 1, one('100%')));
    else cells.push(cell(W3, 3, content), cell(W2, badSpan ? 3 : 2, one('100%')));
    rows.push(row(cells, 1835));
  }
  rows.push(row([cell(W6, 6, one(label('issueTitle', '本周工作需协调解决的问题或者建议')))], 400));
  rows.push(row([cell(W6, 6, one('无'))], 400));
  rows.push(row([cell(W[0], 1, one('序号')), cell(W3, 3, one(label('planHeader', '工作计划'))), cell(W2, 2, one('日期'))], 400));
  for (let k = 1; k <= planRows; k++) {
    rows.push(row([cell(W[0], 1, one(String(k), 'center')), cell(W3, 3, one(`计划${CN[k - 1] || k}`)), cell(W2, 2, one('2026.1.1-2026.1.5'))], 624));
  }
  rows.push(row([cell(W6, 6, one(label('approve', '部门经理批阅')))], 400));
  rows.push(row([cell(W6, 6, [para(''), para(''), signPara()])], 800));

  const grid = `<w:tblGrid>${W.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const tbl = `<w:tbl><w:tblPr><w:tblW w:w="${W6}" w:type="dxa"/></w:tblPr>${grid}${rows.join('')}</w:tbl>`;
  const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="567" w:right="567" w:bottom="567" w:left="567" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${para('工 作 周 报', { jc: 'center' })}${tbl}${extraTable ? `<w:tbl><w:tblPr/>${grid}${row([cell(W6, 6, one('多余的表'))], 400)}</w:tbl>` : ''}${sect}</w:body></w:document>`;

  // 编号：4 个抽象列表，numId 1..max(4, workRows) 各指向其中一个；末尾放 numIdMacAtCleanup，用来验证新增的 <w:num> 插在它之前
  const nNum = Math.max(4, workRows);
  const abstracts = [0, 1, 2, 3].map(a => `<w:abstractNum w:abstractNumId="${a}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>`).join('');
  const nums = Array.from({ length: nNum }, (_, i) => `<w:num w:numId="${i + 1}" w15:restartNumberingAfterBreak="0"><w:abstractNumId w:val="${(i + 2) % 4}"/></w:num>`).join('');
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W_NS} xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">${abstracts}${nums}<w:numIdMacAtCleanup w:val="${nNum}"/></w:numbering>`;

  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${omit === 'numbering' ? '' : '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'}</Types>`;
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${omit === 'numbering' ? '' : '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'}</Relationships>`;

  const entries = [
    ['[Content_Types].xml', Buffer.from(types)],
    ['_rels/.rels', Buffer.from(rels)],
    ['word/document.xml', Buffer.from(doc)],
    ['word/_rels/document.xml.rels', Buffer.from(docRels)],
  ];
  if (omit !== 'numbering') entries.push(['word/numbering.xml', Buffer.from(numbering)]);
  return writeZip(entries);
}

module.exports = { buildTemplate };
