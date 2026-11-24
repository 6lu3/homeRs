// 小票识别服务：限额（持久化）、并发、超时、重复检测、错误映射。
// fetch、时钟、目录都由外部注入，所以可以完全离线测试。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildRequest, extractReplyText, parseItems, buildIntents, fingerprint } = require('./receipt');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DUP_TTL_MS = 48 * 3600e3;
const DUP_MAX = 100;
const UNREADABLE = '识别服务返回了无法理解的内容，请重拍或手动录入';

class ReceiptError extends Error {
  constructor(status, message) { super(message); this.name = 'ReceiptError'; this.status = status; }
}

const pad2 = n => String(n).padStart(2, '0');
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

function createReceiptService({ getConfig, getStock, dataDir, fetchImpl = fetch, today = localDate, nowMs = Date.now, log = console.log }) {
  const usageFile = path.join(dataDir, 'receipt-usage.json');
  let usage = null;          // { date, count }，首次使用时从文件加载并缓存
  let busy = false;          // 同一时间只处理一张
  const seen = new Map();    // 指纹 -> 时间戳，保持插入顺序（最旧的在最前）

  function loadUsage() {
    const day = today();
    if (!usage) {
      try {
        const j = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
        usage = { date: String(j.date), count: Number.isInteger(j.count) && j.count >= 0 ? j.count : 0 };
      } catch { usage = { date: day, count: 0 }; } // 不存在或损坏：按今天 0 次处理，不能因为坏文件挡住全家
    }
    if (usage.date !== day) usage = { date: day, count: 0 };
    return usage;
  }
  function saveUsage() {
    try { fs.writeFileSync(usageFile, JSON.stringify(usage)); } catch { log('小票识别：用量文件写入失败'); }
  }
  function remember(fp) {
    const now = nowMs();
    for (const [k, t] of seen) if (now - t > DUP_TTL_MS) seen.delete(k);
    const dup = seen.has(fp);
    seen.delete(fp); seen.set(fp, now);
    while (seen.size > DUP_MAX) seen.delete(seen.keys().next().value);
    return dup;
  }

  async function forward(cfg, buf, mime) {
    const { url, headers, body } = buildRequest(cfg, buf.toString('base64'), mime);
    let res, raw = '';
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutSec * 1000) });
      if (res.ok) raw = await res.text();
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new ReceiptError(504, '识别超时');
      log('小票识别：连不上识别服务');
      throw new ReceiptError(502, '连不上识别服务，请稍后再试');
    }
    if (!res.ok) {
      log(`小票识别：识别服务返回 HTTP ${res.status}`); // 只记状态码，不记响应原文
      if (res.status === 401 || res.status === 403) throw new ReceiptError(502, '识别服务拒绝了请求，请检查服务器上的 key');
      throw new ReceiptError(502, `识别服务出错（HTTP ${res.status}），请稍后再试`);
    }
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new ReceiptError(502, UNREADABLE);
    let json;
    try { json = JSON.parse(raw); } catch { throw new ReceiptError(502, UNREADABLE); }
    const parsed = parseItems(extractReplyText(cfg.format, json));
    if (!parsed) throw new ReceiptError(502, UNREADABLE);
    const count = parsed.items.length;
    return {
      text: parsed.store ? `小票识别：${parsed.store}，共 ${count} 件` : `小票识别：共 ${count} 件`,
      intents: buildIntents(parsed.items, getStock()),
      duplicate: count > 0 ? remember(fingerprint(parsed.items)) : false,
      count,
    };
  }

  return {
    status() { return { enabled: !!getConfig().enabled }; },
    async scan(buf, mime) {
      const cfg = getConfig();
      if (!cfg.enabled) throw new ReceiptError(503, '识别服务未配置');
      // 下面到置 busy 之前没有任何 await，所以并发请求不会同时通过检查
      if (busy) throw new ReceiptError(429, '正在识别上一张，请稍等');
      const u = loadUsage();
      if (cfg.dailyLimit > 0 && u.count >= cfg.dailyLimit) throw new ReceiptError(429, '今天的识别次数用完了');
      u.count++; saveUsage();
      busy = true;
      try { return await forward(cfg, buf, mime); } finally { busy = false; }
    },
  };
}

module.exports = { createReceiptService, ReceiptError };
