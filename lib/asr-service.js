// 语音识别服务：限额（持久化）、并发、超时、错误映射。
// fetch、时钟、目录都由外部注入，所以可以完全离线测试。
// 响应读取、超时、错误映射、每日用量等与小票识别共用的部分在 lib/provider-guard.js；
// 本服务的「进行中」标志和用量文件都是自己的，与小票识别互不阻塞。
'use strict';
const path = require('node:path');
const { buildRequest, extractReplyText, normalizeTranscript } = require('./asr');
const { ServiceError, localDate, callProvider, createUsage } = require('./provider-guard');

const UNREADABLE = '识别服务返回了无法理解的内容，请再说一遍';

class AsrError extends ServiceError {
  constructor(status, message) { super(status, message); this.name = 'AsrError'; }
}

function createAsrService({ getConfig, dataDir, fetchImpl = fetch, today = localDate, log = console.log }) {
  const usage = createUsage({ file: path.join(dataDir, 'asr-usage.json'), today, log });
  let busy = false; // 同一时间只处理一段

  async function forward(cfg, buf) {
    const { url, headers, body } = buildRequest(cfg, buf.toString('base64'));
    const raw = await callProvider({ fetchImpl, url, headers, body, timeoutSec: cfg.timeoutSec, log, unreadable: UNREADABLE, ErrorClass: AsrError });
    let json;
    try { json = JSON.parse(raw); } catch { throw new AsrError(502, UNREADABLE); }
    const text = extractReplyText(json);
    if (text === null) throw new AsrError(502, UNREADABLE); // 结构不对；结构对但没有文字则是 200 的空文字
    return { text: normalizeTranscript(text) };
  }

  return {
    status() { const c = getConfig(); return { enabled: !!c.enabled, maxSeconds: c.maxSeconds || 30 }; },
    async transcribe(buf) {
      const cfg = getConfig();
      if (!cfg.enabled) throw new AsrError(503, '语音识别未配置');
      // 下面到置 busy 之前没有任何 await，所以并发请求不会同时通过检查
      if (busy) throw new AsrError(429, '正在识别上一段，请稍等');
      if (!usage.tryConsume(cfg.dailyLimit)) throw new AsrError(429, '今天的语音识别次数用完了');
      busy = true;
      try { return await forward(cfg, buf); } finally { busy = false; }
    },
  };
}

module.exports = { createAsrService, AsrError };
