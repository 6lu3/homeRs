// 小票识别和语音识别共用的防护逻辑：响应读取上限、超时换算、错误映射、每日用量持久化。
// fetch、时钟、文件都由外部注入，所以可以完全离线测试。
'use strict';
const fs = require('node:fs');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class ServiceError extends Error {
  constructor(status, message) { super(message); this.name = 'ServiceError'; this.status = status; }
}

const pad2 = n => String(n).padStart(2, '0');
// 服务器本地日期 YYYY-MM-DD
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
// AbortSignal.timeout 只接受整数毫秒，且有上限
const timeoutMs = sec => Math.min(Math.max(1, Math.round(sec * 1000)), 2 ** 31 - 1);

// 丢弃响应体，释放连接（读取之前才能 cancel）
async function discard(res) {
  try { await res.body?.cancel?.(); } catch { /* 忽略 */ }
}
// 读取响应文本，最多 2 MiB：超过就中止并返回 null，不会先把整个响应读进内存
async function readLimited(res) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > MAX_RESPONSE_BYTES) { await discard(res); return null; }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return await res.text(); // 没有可读流的实现（如测试里的假响应）
}

// POST 一个 JSON 到识别服务，返回响应文本；所有失败都映射成固定的中文提示，
// 日志只记状态码，绝不记录响应原文、请求头或 key。
async function callProvider({ fetchImpl, url, headers, body, timeoutSec, log = console.log, unreadable, ErrorClass = ServiceError }) {
  let res, raw = '';
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs(timeoutSec)) });
    if (res.ok) raw = await readLimited(res); else await discard(res);
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new ErrorClass(504, '识别超时');
    log('识别服务：连不上');
    throw new ErrorClass(502, '连不上识别服务，请稍后再试');
  }
  if (!res.ok) {
    log(`识别服务：返回 HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) throw new ErrorClass(502, '识别服务拒绝了请求，请检查服务器上的 key');
    throw new ErrorClass(502, `识别服务出错（HTTP ${res.status}），请稍后再试`);
  }
  if (raw === null || Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new ErrorClass(502, unreadable);
  return raw;
}

// 每日用量：首次使用时从文件加载并缓存，每次计数后同步写回；跨天自动归零
function createUsage({ file, today = localDate, log = console.log }) {
  let usage = null; // { date, count }
  function load() {
    const day = today();
    if (!usage) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        usage = { date: String(j.date), count: Number.isInteger(j.count) && j.count >= 0 ? j.count : 0 };
      } catch { usage = { date: day, count: 0 }; } // 不存在或损坏：按今天 0 次处理，不能因为坏文件挡住全家
    }
    if (usage.date !== day) usage = { date: day, count: 0 };
    return usage;
  }
  function save() {
    try { fs.writeFileSync(file, JSON.stringify(usage)); } catch { log('识别服务：用量文件写入失败'); }
  }
  return {
    // limit 为 0 表示不限；已达上限返回 false（不计数），否则计数 +1、写文件、返回 true
    tryConsume(limit) {
      const u = load();
      if (limit > 0 && u.count >= limit) return false;
      u.count++; save();
      return true;
    },
  };
}

module.exports = { ServiceError, MAX_RESPONSE_BYTES, localDate, timeoutMs, callProvider, createUsage };
