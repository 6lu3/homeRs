'use strict';
// 周报 AI 的纯逻辑：配置（可沿用图片识别的配置）、文字请求、提示词、草稿校验。不做任何网络和磁盘操作。
const crypto = require('node:crypto');
const { extractReplyText } = require('./receipt');

const LIMITS = { items: 12, title: 60, lines: 10, text: 200, issues: 200, plan: 12, example: 6000, examples: 4 };
const FORMATS = ['openai', 'anthropic', 'responses'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const chars = s => [...s];
const cut = (s, max) => chars(s).slice(0, max).join('');

// ---------- 配置 ----------
// 规则（防止把图片识别的 key 发到另一家服务）：
//  · 周报没配 url ⇒ url / key / format / extra 沿用图片识别的（周报自己配了的项覆盖之），model 周报自己的优先；
//  · 周报配了 url ⇒ 什么都不沿用，key 和 model 必须自己配齐；
//  · timeoutSec / dailyLimit 只看周报自己的配置。
// problem 绝不包含 key。
function resolveConfig(fileCfg, env = {}, receiptCfg = {}) {
  const f = isObj(fileCfg) ? fileCfg : {};
  const pick = (envKey, fileKey) => {
    const e = env[envKey];
    if (e != null && String(e).trim() !== '') return String(e).trim();
    return f[fileKey] != null ? String(f[fileKey]).trim() : '';
  };
  const own = { url: pick('REPORT_API_URL', 'url'), key: pick('REPORT_API_KEY', 'key'), model: pick('REPORT_MODEL', 'model'), format: pick('REPORT_FORMAT', 'format') };
  let problem = '';
  let ownExtra;   // undefined = 周报没有配 extra
  const envExtra = env.REPORT_EXTRA;
  if (envExtra != null && String(envExtra).trim() !== '') {
    try {
      const v = JSON.parse(envExtra);
      if (isObj(v)) ownExtra = v; else problem = 'REPORT_EXTRA 必须是 JSON 对象';
    } catch { problem = 'REPORT_EXTRA 不是合法的 JSON'; }
  } else if (f.extra !== undefined && f.extra !== null) {
    if (isObj(f.extra)) ownExtra = f.extra; else problem = '周报配置里的 extra 必须是 JSON 对象';
  }
  const t = Number(pick('REPORT_TIMEOUT_S', 'timeoutSec'));
  const timeoutSec = Number.isFinite(t) && t > 0 ? t : 90;
  const rawLimit = pick('REPORT_DAILY_LIMIT', 'dailyLimit');
  const n = Number(rawLimit);
  const dailyLimit = rawLimit !== '' && Number.isInteger(n) && n >= 0 ? n : 20;

  let url, key, model, format, extra, inherited = false;
  if (own.url) {
    url = own.url; key = own.key; model = own.model; format = own.format || 'openai'; extra = ownExtra || {};
    const missing = [['key', key], ['model', model]].filter(([, v]) => !v).map(([k]) => k);
    if (!problem && missing.length) problem = `周报配置不完整，缺少：${missing.join('、')}`;
  } else {
    const r = receiptCfg && receiptCfg.enabled ? receiptCfg : null;
    inherited = !!r;
    url = r ? r.url : '';
    key = own.key || (r ? r.key : '');
    model = own.model || (r ? r.model : '');
    format = own.format || (r ? r.format : 'openai');
    extra = ownExtra !== undefined ? ownExtra : (r ? r.extra : {});
    const anyOwn = own.key || own.model || own.format || ownExtra !== undefined;
    if (!problem && !r && anyOwn) {
      const missing = [['url', url], ['key', key], ['model', model]].filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) problem = `周报配置不完整，缺少：${missing.join('、')}`;
    }
  }
  if (!problem && !FORMATS.includes(format)) problem = `接口格式不支持，可选 ${FORMATS.join(' / ')}`;
  return { enabled: !problem && !!url && !!key && !!model, url, key, model, format, extra: extra || {}, timeoutSec, dailyLimit, problem, inherited };
}

// ---------- 请求 ----------
function buildTextRequest(cfg, prompt) {
  const json = { 'content-type': 'application/json' };
  if (cfg.format === 'anthropic') {
    return {
      url: cfg.url,
      headers: { ...json, 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: { max_tokens: 4000, ...cfg.extra, model: cfg.model, messages: [{ role: 'user', content: prompt }] },
    };
  }
  const headers = { ...json, authorization: 'Bearer ' + cfg.key };
  if (cfg.format === 'responses') {
    return { url: cfg.url, headers, body: { ...cfg.extra, model: cfg.model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] } };
  }
  return { url: cfg.url, headers, body: { ...cfg.extra, model: cfg.model, messages: [{ role: 'user', content: prompt }] } };
}

// ---------- 提示词 ----------
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const md = d => `${Number(d.slice(5, 7))}.${Number(d.slice(8, 10))}`;
const weekday = d => WEEKDAY[new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay()];

const RULES = `你是帮我整理每周工作周报的助手。请根据下面的「本周记录」，参照「示例周报」的写法，整理出一份周报草稿。

规则：
1. 按项目或事项归类，一个项目一项：title 是项目名（写法参照示例，例如「某某事项」），lines 是这个项目本周做的具体事情，每条一句话，简洁。
2. 只使用下面记录里出现的事实，不得编造没有记录的工作、数据或结果。
3. progress 是这个项目的完成度，0 到 100 的整数，根据记录判断，拿不准就写保守一些的数字。
4. plan 是下周计划，来自「还没做完的待办」和记录里能看出的后续工作，每条一句话。
5. issues 是需要协调解决的问题或建议，记录里没有提到就写「无」。
6. 不要写日期。
7. 只返回 JSON，不要任何其他文字，格式如下：
{"items":[{"title":"项目名","lines":["细节一","细节二"],"progress":100}],"issues":"无","plan":["计划一"]}`;

function buildPrompt({ weekLabel, entries = [], doneTodos = [], openTodos = [], examples = [] }) {
  const ex = examples.slice(-LIMITS.examples).map((t, i) => `### 示例 ${i + 1}\n${cut(String(t), LIMITS.example)}`);
  const rec = entries.map((e, i) => ({ e, i })).sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i))
    .map(x => `${md(x.e.date)} ${weekday(x.e.date)}：${x.e.text}`);
  const done = doneTodos.map(t => `${md(t.date)} 完成：${t.text}`);
  const open = openTodos.map(t => `${t.text}（${t.due_date ? md(t.due_date) : '没选日期'}）`);
  const sec = (title, lines, empty) => `## ${title}\n${lines.length ? lines.join('\n') : empty}`;
  return [
    RULES,
    sec('示例周报', ex, '（没有示例）'),
    sec(`本周（${weekLabel}）记录`, rec, '（无）'),
    sec('本周完成的待办', done, '（无）'),
    sec('还没做完的待办', open, '（无）'),
  ].join('\n\n');
}

const promptHash = prompt => crypto.createHash('sha256').update(String(prompt)).digest('hex').slice(0, 32);

// ---------- 草稿 ----------
// 宽松：处理模型回复（容错取出 JSON，超限的截断，缺的补默认）。取不到可用内容返回 null
function parseDraft(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!isObj(j)) return null;
  const str = (v, max) => (typeof v === 'string' ? cut(v.trim(), max) : '');
  const list = (v, max, n) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => str(x, max)).filter(Boolean).slice(0, n) : []);
  const items = (Array.isArray(j.items) ? j.items : []).map(it => {
    if (!isObj(it)) return null;
    const title = str(it.title, LIMITS.title);
    if (!title) return null;
    const p = Number(it.progress);
    return { title, lines: list(it.lines, LIMITS.text, LIMITS.lines), progress: Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0 };
  }).filter(Boolean).slice(0, LIMITS.items);
  if (!items.length) return null;
  return { items, issues: str(j.issues, LIMITS.issues) || '无', plan: list(j.plan, LIMITS.text, LIMITS.plan) };
}

// 严格：导出前校验用户改过的草稿，超限就报错，不截断
const BAD_DRAFT = '草稿格式不对';
function validateDraft(draft) {
  if (!isObj(draft) || !Array.isArray(draft.items) || (draft.plan !== undefined && !Array.isArray(draft.plan))) throw new Error(BAD_DRAFT);
  if (draft.issues !== undefined && typeof draft.issues !== 'string') throw new Error(BAD_DRAFT);
  if (draft.items.length === 0) throw new Error('至少要有一个工作项');
  if (draft.items.length > LIMITS.items) throw new Error(`工作项最多 ${LIMITS.items} 个`);
  const clean = (arr, tooMany) => {
    const out = arr.map(x => (typeof x === 'string' ? x.trim() : null)).filter(x => x !== '');   // 空白条目直接丢弃
    if (out.some(x => x === null)) throw new Error(BAD_DRAFT);
    if (out.length > tooMany.max) throw new Error(tooMany.msg);
    if (out.some(x => chars(x).length > LIMITS.text)) throw new Error('每条最长 200 字');
    return out;
  };
  const items = draft.items.map(it => {
    if (!isObj(it) || !Array.isArray(it.lines)) throw new Error(BAD_DRAFT);
    const title = typeof it.title === 'string' ? it.title.trim() : '';
    if (!title) throw new Error('项目标题不能为空');
    if (chars(title).length > LIMITS.title) throw new Error(`项目标题最长 ${LIMITS.title} 字`);
    if (!Number.isInteger(it.progress) || it.progress < 0 || it.progress > 100) throw new Error('完成度应为 0–100 的整数');
    return { title, lines: clean(it.lines, { max: LIMITS.lines, msg: `细节最多 ${LIMITS.lines} 条` }), progress: it.progress };
  });
  const issues = (draft.issues || '').trim();
  if (chars(issues).length > LIMITS.issues) throw new Error('需协调的问题最长 200 字');
  const plan = clean(draft.plan || [], { max: LIMITS.plan, msg: `计划最多 ${LIMITS.plan} 条` });
  return { items, issues: issues || '无', plan };
}

const BAD_DATE = '日期格式不对';
function dotDate(s) {
  const m = typeof s === 'string' ? /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(s) : null;
  if (!m) throw new Error(BAD_DATE);
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d), c = new Date(t);
  if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d) throw new Error(BAD_DATE);
  return t;
}
function validateDotDate(s) { dotDate(s); return s; }
function validateDotRange(s) {
  const m = typeof s === 'string' ? /^([^-]+)-([^-]+)$/.exec(s) : null;
  if (!m) throw new Error(BAD_DATE);
  if (dotDate(m[1]) > dotDate(m[2])) throw new Error(BAD_DATE);
  return s;
}

module.exports = { LIMITS, extractReplyText, resolveConfig, buildTextRequest, buildPrompt, promptHash, parseDraft, validateDraft, validateDotDate, validateDotRange };
