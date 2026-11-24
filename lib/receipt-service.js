// 小票识别服务：限额（持久化）、并发、超时、重复检测、错误映射。
// fetch、时钟、目录都由外部注入，所以可以完全离线测试。
// 响应读取、超时、错误映射、每日用量等与语音识别共用的部分在 lib/provider-guard.js。
'use strict';
const path = require('node:path');
const { buildRequest, extractReplyText, parseItems, buildIntents, fingerprint } = require('./receipt');
const { ServiceError, localDate, callProvider, createUsage } = require('./provider-guard');

const DUP_TTL_MS = 48 * 3600e3;
const DUP_MAX = 100;
const UNREADABLE = '识别服务返回了无法理解的内容，请重拍或手动录入';

class ReceiptError extends ServiceError {
  constructor(status, message) { super(status, message); this.name = 'ReceiptError'; }
}

function createReceiptService({ getConfig, getStock, dataDir, fetchImpl = fetch, today = localDate, nowMs = Date.now, log = console.log }) {
  const usage = createUsage({ file: path.join(dataDir, 'receipt-usage.json'), today, log, label: '小票识别' });
  let busy = false;          // 同一时间只处理一张
  const seen = new Map();    // 指纹 -> 时间戳，保持插入顺序（最旧的在最前）

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
    const raw = await callProvider({ fetchImpl, url, headers, body, timeoutSec: cfg.timeoutSec, log, unreadable: UNREADABLE, ErrorClass: ReceiptError, label: '小票识别' });
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
      if (!usage.tryConsume(cfg.dailyLimit)) throw new ReceiptError(429, '今天的识别次数用完了');
      busy = true;
      try { return await forward(cfg, buf, mime); } finally { busy = false; }
    },
  };
}

module.exports = { createReceiptService, ReceiptError };
