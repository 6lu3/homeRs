'use strict';
// 周报整理服务：发送前指纹校验、并发、每日限额（持久化）、调用 AI、解析草稿。
// fetch、时钟、目录由外部注入，所以可以完全离线测试。响应读取、超时、错误映射、用量持久化复用 provider-guard。
const fs = require('node:fs');
const path = require('node:path');
const { extractReplyText, buildTextRequest, promptHash, parseDraft } = require('./report-ai');
const { ServiceError, localDate, callProvider, createUsage } = require('./provider-guard');

class ReportError extends ServiceError {
  constructor(status, message) { super(status, message); this.name = 'ReportError'; }
}

function createReportService({ getConfig, dataDir, fetchImpl = fetch, today = localDate, log = console.log }) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* 之后写用量文件失败时 createUsage 会自己记日志 */ }
  const usage = createUsage({ file: path.join(dataDir, 'usage.json'), today, log, label: '周报整理' });
  let busy = false;   // 同一时间只整理一份

  return {
    status() { return { enabled: !!getConfig().enabled }; },
    // prompt 由服务端组装；hash 是用户预览时看到的那份的指纹，不一致就拒绝（此时还没有调用 AI、没有占用次数）
    async generate({ prompt, hash }) {
      const cfg = getConfig();
      if (!cfg.enabled) throw new ReportError(503, '周报整理未配置');
      if (promptHash(prompt) !== hash) throw new ReportError(409, '内容在预览之后有变化，请重新预览');
      // 下面到置 busy 之前没有任何 await，所以并发请求不会同时通过检查
      if (busy) throw new ReportError(429, '正在整理上一份，请稍等');
      if (!usage.tryConsume(cfg.dailyLimit)) throw new ReportError(429, '今天的整理次数用完了');
      busy = true;
      try {
        const { url, headers, body } = buildTextRequest(cfg, prompt);
        const raw = await callProvider({ fetchImpl, url, headers, body, timeoutSec: cfg.timeoutSec, log, unreadable: '没有读懂 AI 的回复，请重试', ErrorClass: ReportError, label: '周报整理' });
        const unreadable = new ReportError(502, 'AI 返回了无法理解的内容，请重试');
        let json;
        try { json = JSON.parse(raw); } catch { throw unreadable; }
        const draft = parseDraft(extractReplyText(cfg.format, json));
        if (!draft) throw unreadable;
        return draft;
      } finally { busy = false; }
    },
  };
}

module.exports = { createReportService, ReportError };
