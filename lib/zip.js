'use strict';
// 最小的 zip 读写（无 I/O，只用 node:zlib）：供 docx 读写使用。
// 只支持：压缩方法 0（存储）和 8（deflate）、UTF-8 文件名、无加密、无 zip64。
const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const BAD = '不是有效的压缩包';
const MAX_ENTRIES = 200, MAX_TOTAL = 30 * 1024 * 1024;

// ---------- CRC32（自己实现，不依赖较新的 Node） ----------
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- 读 ----------
function readZip(buf, { maxEntries = MAX_ENTRIES, maxTotal = MAX_TOTAL } = {}) {
  try {
    return parse(buf, maxEntries, maxTotal);
  } catch (e) {
    if (e instanceof RangeError) throw new Error(BAD);   // 偏移 / 长度越界：文件被截断或伪造
    throw e;
  }
}
function parse(buf, maxEntries, maxTotal) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error(BAD);
  // 结尾记录在文件末尾 22 字节之前（带注释时更靠前，最多 64 KiB）
  let end = -1;
  for (let i = buf.length - 22, stop = Math.max(0, buf.length - 22 - 65535); i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new Error(BAD);
  const count = buf.readUInt16LE(end + 10), cdSize = buf.readUInt32LE(end + 12), cdOff = buf.readUInt32LE(end + 16);
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) throw new Error('不支持 zip64');
  if (cdOff + cdSize > end) throw new Error(BAD);
  if (count > maxEntries) throw new Error('压缩包条目过多');
  const out = new Map();
  let total = 0, p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(BAD);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || lho === 0xFFFFFFFF) throw new Error('不支持 zip64');
    if (flags & 1) throw new Error('不支持加密的压缩包');
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;   // 目录条目：docx 不需要，直接跳过
    if (buf.readUInt32LE(lho) !== SIG_LOCAL) throw new Error(BAD);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw new Error(BAD);
    const raw = buf.subarray(start, start + csize);
    if (total + usize > maxTotal) throw new Error('压缩包解压后过大');
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, maxTotal - total) }); }
      catch (e) {
        if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('压缩包解压后过大');
        throw new Error('压缩包已损坏');
      }
    } else throw new Error('不支持的压缩方法');
    total += data.length;
    if (total > maxTotal) throw new Error('压缩包解压后过大');
    if (data.length !== usize || crc32(data) !== crc) throw new Error('压缩包已损坏');
    out.set(name, data);
  }
  return out;
}

// ---------- 写 ----------
const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;   // 固定为 1980-01-01 00:00，输出可重复

function writeZip(entries) {
  const list = entries instanceof Map ? [...entries] : [...entries];
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of list) {
    const nameBuf = Buffer.from(String(name), 'utf8');
    const crc = crc32(data);
    let method = 8, body = zlib.deflateRawSync(data);
    if (data.length === 0 || body.length >= data.length) { method = 0; body = data; }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, body);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_END, 0); eocd.writeUInt16LE(list.length, 8); eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { crc32, readZip, writeZip };
