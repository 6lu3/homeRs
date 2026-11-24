// 小票识别的纯逻辑：配置解析、请求构造、回复解析、去规格、生成录入意图、指纹。
// 不做任何网络和磁盘操作，方便离线测试。
'use strict';
const crypto = require('node:crypto');
const { matchItem, guessCategory } = require('./parse');

const PROMPT = `这是一张购物凭证（超市小票、电子发票截图或 App 订单截图）。请只返回 JSON，不要任何其他文字：
{"store":"店名","items":[{"name":"商品名","quantity":数量,"unit":"单位"}]}
规则：
1. 只列实际购买的商品；不要列购物袋、折扣、优惠、小计、合计、运费、包装费。
2. quantity 是购买的件数，商品名里的规格重量（如 500g）不算数量；没写数量就填 1。
3. 按重量计价的散称商品，quantity 填重量，unit 填 kg、斤 或 g。
4. unit 尽量从商品名或规格里判断（盒/瓶/袋/个/罐 等），判断不了就填空字符串。
5. 商品名保留小票上的写法。`;

const FORMATS = ['openai', 'anthropic', 'responses'];
const MAX_ITEMS = 60;
const round2 = n => Math.round(n * 100) / 100;

// ---------- 配置 ----------
// 逐项合并，环境变量优先；RECEIPT_EXTRA 整体替换文件里的 extra。problem 绝不包含 key。
function resolveConfig(fileCfg, env = {}) {
  const f = fileCfg && typeof fileCfg === 'object' ? fileCfg : {};
  const pick = (envKey, fileKey) => {
    const e = env[envKey];
    if (e != null && String(e).trim() !== '') return String(e).trim();
    return f[fileKey] != null ? String(f[fileKey]).trim() : '';
  };
  const url = pick('RECEIPT_API_URL', 'url');
  const key = pick('RECEIPT_API_KEY', 'key');
  const model = pick('RECEIPT_MODEL', 'model');
  const format = pick('RECEIPT_FORMAT', 'format') || 'openai';
  let problem = '';
  let extra = {};
  const envExtra = env.RECEIPT_EXTRA;
  if (envExtra != null && String(envExtra).trim() !== '') {
    try {
      const v = JSON.parse(envExtra);
      if (v && typeof v === 'object' && !Array.isArray(v)) extra = v;
      else problem = 'RECEIPT_EXTRA 必须是 JSON 对象';
    } catch { problem = 'RECEIPT_EXTRA 不是合法的 JSON'; }
  } else if (f.extra && typeof f.extra === 'object' && !Array.isArray(f.extra)) {
    extra = f.extra;
  }
  if (!problem && !FORMATS.includes(format)) problem = `接口格式不支持，可选 ${FORMATS.join(' / ')}`;
  const missing = [['url', url], ['key', key], ['model', model]].filter(([, v]) => !v).map(([k]) => k);
  if (!problem && missing.length && missing.length < 3) problem = `识别服务配置不完整，缺少：${missing.join('、')}`;
  const t = Number(pick('RECEIPT_TIMEOUT_S', 'timeoutSec'));
  const timeoutSec = Number.isFinite(t) && t > 0 ? t : 60;
  const rawLimit = pick('RECEIPT_DAILY_LIMIT', 'dailyLimit');
  const n = Number(rawLimit);
  const dailyLimit = rawLimit !== '' && Number.isInteger(n) && n >= 0 ? n : 30;
  return { enabled: !problem && !missing.length, url, key, model, format, extra, timeoutSec, dailyLimit, problem };
}

// ---------- 请求 / 回复 ----------
function buildRequest(cfg, base64, mime) {
  const dataUrl = `data:${mime};base64,${base64}`;
  const json = { 'content-type': 'application/json' };
  if (cfg.format === 'anthropic') {
    return {
      url: cfg.url,
      headers: { ...json, 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: { max_tokens: 2000, ...cfg.extra, model: cfg.model, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: PROMPT },
      ] }] },
    };
  }
  const headers = { ...json, authorization: 'Bearer ' + cfg.key };
  if (cfg.format === 'responses') {
    return { url: cfg.url, headers, body: { ...cfg.extra, model: cfg.model, input: [{ role: 'user', content: [
      { type: 'input_image', image_url: dataUrl },
      { type: 'input_text', text: PROMPT },
    ] }] } };
  }
  return { url: cfg.url, headers, body: { ...cfg.extra, model: cfg.model, messages: [{ role: 'user', content: [
    { type: 'text', text: PROMPT },
    { type: 'image_url', image_url: { url: dataUrl } },
  ] }] } };
}

function extractReplyText(format, json) {
  if (!json || typeof json !== 'object') return '';
  if (format === 'anthropic') {
    return (Array.isArray(json.content) ? json.content : []).filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  }
  if (format === 'responses') {
    return (Array.isArray(json.output) ? json.output : []).filter(o => o && o.type === 'message')
      .flatMap(o => Array.isArray(o.content) ? o.content : [])
      .filter(c => c && c.type === 'output_text' && typeof c.text === 'string').map(c => c.text).join('');
  }
  const c = json.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

// ---------- 回复解析 ----------
function parseItems(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) return null;
  const items = [];
  for (const it of obj.items) {
    if (items.length >= MAX_ITEMS) break;
    if (!it || typeof it !== 'object') continue;
    const name = typeof it.name === 'string' ? it.name.trim().slice(0, 60) : '';
    if (!name) continue;
    let quantity = Number(it.quantity);
    quantity = Number.isFinite(quantity) && quantity > 0 ? Math.max(0.01, round2(quantity)) : 1;
    const unit = typeof it.unit === 'string' ? it.unit.trim().slice(0, 8) : '';
    items.push({ name, quantity, unit });
  }
  return { store: typeof obj.store === 'string' ? obj.store.trim().slice(0, 40) : '', items };
}

// ---------- 名称处理 ----------
// 去掉「数字 + 重量/容量单位」及其附带写法（/盒、*12、×12、*24罐）。
// 单位区分大小写且后面不能紧跟字母：64GB、5G 不是重量；5KG、1.5L 是。
const SPEC_RE = /\s*\d+(?:\.\d+)?\s*(?:kg|KG|Kg|g|ml|mL|ML|l|L|克|千克|毫升|升|斤)(?![a-zA-Z])(?:\s*[/*×xX]\s*[^\s\d]{0,2}\d*[^\s\d]{0,2})?/g;
function cleanName(name) {
  const orig = String(name ?? '').trim();
  const cleaned = orig.replace(SPEC_RE, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || orig;
}
// 匹配库存用的键：去规格后再去掉开头的英文品牌前缀（如 "NB "）
function matchKey(name) {
  const c = cleanName(name);
  return c.replace(/^[A-Za-z]{1,6}\s+/, '').trim() || c;
}
const normName = name => cleanName(name).replace(/\s+/g, '').toLowerCase();
// 单位「相同」：一边为空，或文字完全相同；不做换算
const unitsOk = (a, b) => !a || !b || a === b;

// ---------- 生成录入意图 ----------
function buildIntents(items, stock) {
  const out = [];
  const byStock = new Map();   // 库存物品 id -> { intent, unit（小票上的单位）, names（与库存名不同的小票原文）, unitWarning }
  const adds = [];             // { intent, key }
  // 补货行只显示库存里的名字，所以子串误匹配（鸡蛋面 ≈ 鸡蛋）要靠警告把小票原文告诉用户
  const noteName = (entry, rawName) => {
    const n = cleanName(rawName);
    if (normName(n) !== normName(entry.intent.name) && !entry.names.includes(n)) entry.names.push(n);
  };
  const addNew = (name, quantity, unit, warning) => {
    const key = normName(name);
    const hit = adds.find(a => a.key === key && unitsOk(a.intent.unit, unit));
    if (hit) {
      hit.intent.quantity = round2(hit.intent.quantity + quantity);
      if (!hit.intent.unit) hit.intent.unit = unit;
      return;
    }
    const intent = { action: 'add', name, quantity, unit, category: guessCategory(name) || '' };
    if (warning) intent.warning = warning;
    adds.push({ intent, key });
    out.push(intent);
  };
  for (const it of items) {
    const unit = it.unit || '';
    const ex = stock.length ? matchItem(matchKey(it.name), stock) : null;
    if (!ex) { addNew(cleanName(it.name), it.quantity, unit); continue; }
    const prev = byStock.get(ex.id);
    if (prev) {
      if (unitsOk(prev.unit, unit)) {
        prev.intent.quantity = round2(prev.intent.quantity + it.quantity);
        if (!prev.unit) prev.unit = unit;
        noteName(prev, it.name);
      } else {
        addNew(cleanName(it.name), it.quantity, unit, `和已有「${ex.name}」单位不同，已作为新物品`);
      }
      continue;
    }
    const stockUnit = ex.unit || '';
    let outUnit = stockUnit, unitWarning = '';
    if (!stockUnit) outUnit = unit;
    else if (unit && unit !== stockUnit) unitWarning = `小票单位「${unit}」和库存单位「${stockUnit}」不同，请核对数量`;
    const intent = { action: 'restock', name: ex.name, quantity: it.quantity, unit: outUnit, existing: ex };
    const entry = { intent, unit, names: [], unitWarning };
    noteName(entry, it.name);
    byStock.set(ex.id, entry);
    out.push(intent);
  }
  for (const { intent, names, unitWarning } of byStock.values()) {
    const parts = [];
    if (names.length) parts.push(`小票上是${names.map(n => `「${n}」`).join('、')}，请确认是同一件物品`);
    if (unitWarning) parts.push(unitWarning);
    if (parts.length) intent.warning = parts.join('；');
  }
  return out;
}

// ---------- 指纹（疑似重复检测） ----------
function fingerprint(items) {
  const lines = items.map(i => `${normName(i.name)}|${i.quantity}|${String(i.unit || '').trim()}`).sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

module.exports = { PROMPT, resolveConfig, buildRequest, extractReplyText, parseItems, cleanName, buildIntents, fingerprint };
