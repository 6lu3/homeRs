// zip 读写测试：node test/zip.test.js
const zlib = require('node:zlib');
const { crc32, readZip, writeZip } = require('../lib/zip');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + e.message); }
}
function eq(got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function throws(fn, msg) {
  try { fn(); } catch (e) { if (msg) eq(e.message, msg); return; }
  throw new Error('应当抛错');
}
// 确定性的「不可压缩」数据（简单线性同余），保证 deflate 之后更大，从而走 stored 分支
function noise(n, seed = 1) {
  const b = Buffer.alloc(n); let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; b[i] = s >>> 24; }
  return b;
}

check('crc32：空 buffer 为 0，标准校验值 0xCBF43926', () => {
  eq(crc32(Buffer.alloc(0)), 0);
  eq(crc32(Buffer.from('123456789')), 0xCBF43926);
  if (typeof zlib.crc32 === 'function') eq(crc32(Buffer.from('周报 docx')), zlib.crc32(Buffer.from('周报 docx')));
});

const sample = () => new Map([
  ['[Content_Types].xml', Buffer.from('<Types/>')],
  ['word/文档.xml', Buffer.from('正文 '.repeat(500))],
  ['word/empty.xml', Buffer.alloc(0)],
  ['word/random.bin', noise(64)],
]);

check('往返：内容和顺序都一致（中文文件名、空条目、可压缩、不可压缩）', () => {
  const back = readZip(writeZip(sample()));
  eq([...back.keys()], [...sample().keys()]);
  for (const [k, v] of sample()) if (!back.get(k).equals(v)) throw new Error('内容不一致：' + k);
});
check('往返：也接受 [名字, 内容] 数组', () => {
  const back = readZip(writeZip([['a.txt', Buffer.from('甲')], ['b.txt', Buffer.from('乙')]]));
  eq([...back.keys()], ['a.txt', 'b.txt']);
  eq(back.get('b.txt').toString(), '乙');
});
check('写出的文件符合 zip 规范：魔数、结尾记录、每个本地头都置了 UTF-8 标志', () => {
  const buf = writeZip(sample());
  eq(buf.readUInt32LE(0), 0x04034b50);
  eq(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  let off = 0, n = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    eq((buf.readUInt16LE(off + 6) & 0x0800) !== 0, true);
    off += 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28) + buf.readUInt32LE(off + 18);
    n++;
  }
  eq(n, 4);
});
check('输出可重复：同样的输入得到逐字节相同的结果', () => {
  if (!writeZip(sample()).equals(writeZip(sample()))) throw new Error('两次输出不同');
});
check('目录条目被跳过', () => {
  const back = readZip(writeZip([['a/', Buffer.alloc(0)], ['a/b.txt', Buffer.from('x')]]));
  eq([...back.keys()], ['a/b.txt']);
});

check('不是 zip：空、随机内容', () => {
  throws(() => readZip(Buffer.alloc(0)), '不是有效的压缩包');
  throws(() => readZip(Buffer.from('hello world, definitely not a zip file')), '不是有效的压缩包');
});
check('数据被改坏：stored 条目 CRC 不符、deflate 条目解压失败，都报已损坏', () => {
  const buf = writeZip([['r.bin', noise(40)]]);
  const bad = Buffer.from(buf); bad[30 + 5 + 10] ^= 0xff;          // 本地头 30 字节 + 名字 5 字节之后的数据区
  throws(() => readZip(bad), '压缩包已损坏');
  const z = writeZip([['t.txt', Buffer.from('重复的文字 '.repeat(200))]]);
  const bad2 = Buffer.from(z); bad2[30 + 5 + 3] ^= 0xff;
  throws(() => readZip(bad2), '压缩包已损坏');
});
check('条目数超过上限', () => {
  const buf = writeZip([['a', Buffer.from('1')], ['b', Buffer.from('2')], ['c', Buffer.from('3')]]);
  throws(() => readZip(buf, { maxEntries: 2 }), '压缩包条目过多');
  eq(readZip(buf, { maxEntries: 3 }).size, 3);
});
check('解压后总大小超过上限（含压缩炸弹）', () => {
  throws(() => readZip(writeZip([['a', Buffer.from('x'.repeat(200))]]), { maxTotal: 100 }), '压缩包解压后过大');
  const bomb = writeZip([['zeros.bin', Buffer.alloc(1024 * 1024)]]);
  if (bomb.length > 5000) throw new Error('测试前提不成立：全零数据应当压得很小');
  throws(() => readZip(bomb, { maxTotal: 1000 }), '压缩包解压后过大');
  eq(readZip(bomb, { maxTotal: 2 * 1024 * 1024 }).get('zeros.bin').length, 1024 * 1024);
});
check('加密条目、zip64 被拒绝', () => {
  const buf = Buffer.from(writeZip([['a.txt', Buffer.from('x')]]));
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const enc = Buffer.from(buf); enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
  throws(() => readZip(enc), '不支持加密的压缩包');
  const z64 = Buffer.from(buf); z64.writeUInt16LE(0xFFFF, z64.length - 22 + 10);
  throws(() => readZip(z64), '不支持 zip64');
});
check('结尾记录里的偏移越界：报不是有效的压缩包，而不是抛出内部错误', () => {
  const buf = Buffer.from(writeZip([['a.txt', Buffer.from('x')]]));
  buf.writeUInt32LE(0x7fffffff, buf.length - 22 + 16);
  throws(() => readZip(buf), '不是有效的压缩包');
});

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);
