// 语音识别的纯逻辑：配置解析、请求构造、回复解析、识别文字规范化。
// 不做任何网络和磁盘操作，方便离线测试。
'use strict';

const PROMPT = `请把这段语音逐字转写成文字，只返回转写出来的文字，不要加任何解释、引号或前缀。
这是在家里口头录入物品的口语，例如：买了两盒酸奶放冷藏；把电钻放到车库的工具架上；创可贴用完了。
如果说了几件互相独立的事，每件事之间用句号「。」隔开。不要在句子中间加空格。数字一律用阿拉伯数字。`;

const FORMATS = ['responses'];
const MAX_SECONDS_LIMIT = 60; // 2 MiB 的请求体大约装得下 60 秒的 16kHz 单声道 WAV
const MAX_TEXT_CHARS = 200;

// ---------- 配置 ----------
// 逐项合并，环境变量优先；ASR_EXTRA 整体替换文件里的 extra。problem 绝不包含 key。
function resolveConfig(fileCfg, env = {}) {
  const f = fileCfg && typeof fileCfg === 'object' ? fileCfg : {};
  const pick = (envKey, fileKey) => {
    const e = env[envKey];
    if (e != null && String(e).trim() !== '') return String(e).trim();
    return f[fileKey] != null ? String(f[fileKey]).trim() : '';
  };
  const url = pick('ASR_API_URL', 'url');
  const key = pick('ASR_API_KEY', 'key');
  const model = pick('ASR_MODEL', 'model');
  const format = pick('ASR_FORMAT', 'format') || 'responses';
  let problem = '';
  let extra = {};
  const envExtra = env.ASR_EXTRA;
  if (envExtra != null && String(envExtra).trim() !== '') {
    try {
      const v = JSON.parse(envExtra);
      if (v && typeof v === 'object' && !Array.isArray(v)) extra = v;
      else problem = 'ASR_EXTRA 必须是 JSON 对象';
    } catch { problem = 'ASR_EXTRA 不是合法的 JSON'; }
  } else if (f.extra && typeof f.extra === 'object' && !Array.isArray(f.extra)) {
    extra = f.extra;
  }
  if (!problem && !FORMATS.includes(format)) problem = `语音识别的接口格式不支持，可选 ${FORMATS.join(' / ')}`;
  const missing = [['url', url], ['key', key], ['model', model]].filter(([, v]) => !v).map(([k]) => k);
  if (!problem && missing.length && missing.length < 3) problem = `语音识别配置不完整，缺少：${missing.join('、')}`;
  const t = Number(pick('ASR_TIMEOUT_S', 'timeoutSec'));
  const timeoutSec = Number.isFinite(t) && t > 0 ? t : 30;
  const rawLimit = pick('ASR_DAILY_LIMIT', 'dailyLimit');
  const lim = Number(rawLimit);
  const dailyLimit = rawLimit !== '' && Number.isInteger(lim) && lim >= 0 ? lim : 100;
  const rawMax = pick('ASR_MAX_SECONDS', 'maxSeconds');
  const mx = Number(rawMax);
  const maxSeconds = rawMax !== '' && Number.isInteger(mx) && mx > 0 ? Math.min(mx, MAX_SECONDS_LIMIT) : 30;
  return { enabled: !problem && !missing.length, url, key, model, format, extra, timeoutSec, dailyLimit, maxSeconds, problem };
}

// ---------- 请求 / 回复 ----------
function buildRequest(cfg, base64) {
  return {
    url: cfg.url,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
    body: { ...cfg.extra, model: cfg.model, input: [{ role: 'user', content: [
      { type: 'input_text', text: PROMPT },
      { type: 'input_audio', audio_url: `data:audio/wav;base64,${base64}` },
    ] }] },
  };
}

// output 不是数组（结构不对）返回 null；结构对但没有文字返回 ''
function extractReplyText(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.output)) return null;
  return json.output.filter(o => o && o.type === 'message')
    .flatMap(o => Array.isArray(o.content) ? o.content : [])
    .filter(c => c && c.type === 'output_text' && typeof c.text === 'string').map(c => c.text).join('');
}

// ---------- 识别文字规范化 ----------
// 模型在两句话之间常用空格或换行，这里统一成「。」，好让 parseMulti 拆句；
// 数字或字母旁边的空白不动（「买了 2 盒」不能被拆开）。
const MARKS = '。！!？?；;';
const MARK_AROUND = new RegExp(`[ \\t\\u3000]*([${MARKS}])[ \\t\\u3000]*`, 'g');
const MARK_RUN = new RegExp(`([${MARKS}])[${MARKS}]+`, 'g');
const MARK_EDGE = new RegExp(`^[${MARKS}]+|[${MARKS}]+$`, 'g');
const WRAP_PAIRS = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"], ['‘', '’']];
const PREFIX = /^(?:识别结果|转写结果|转写|识别)[:：]\s*/;
// 模型有时会给整句加引号或「识别结果：」前缀，去掉，否则「买了」不在句首，解析会错
function stripWrap(s) {
  s = s.replace(PREFIX, '');
  for (const [a, b] of WRAP_PAIRS) {
    if (s.length >= 2 && s.startsWith(a) && s.endsWith(b)) { s = s.slice(1, -1).trim(); break; }
  }
  return s;
}
// 返回 { text, cut }：超过 200 字时优先退回到最后一个句子分隔符（不留半句话），cut 告诉调用方被截断了
function normalizeTranscriptEx(text) {
  if (typeof text !== 'string') return { text: '', cut: false };
  let s = stripWrap(text.replace(/\r\n?/g, '\n').trim());
  if (!s) return { text: '', cut: false };
  s = s.replace(/[ \t　]*\n[ \t　\n]*/g, '。');                          // 换行 = 句子分隔
  s = s.replace(/(?<=[一-鿿])[ \t　]+(?=[一-鿿])/g, '。');       // 两个汉字之间的空白
  s = s.replace(MARK_AROUND, '$1').replace(MARK_RUN, '$1').replace(MARK_EDGE, '');
  if (s.length <= MAX_TEXT_CHARS) return { text: s, cut: false };
  const head = s.slice(0, MAX_TEXT_CHARS);
  if (MARKS.includes(s[MAX_TEXT_CHARS])) return { text: head.replace(MARK_EDGE, ''), cut: true }; // 正好停在句子边界
  const k = Math.max(...[...MARKS].map(m => head.lastIndexOf(m)));
  const kept = k >= MAX_TEXT_CHARS / 2 ? head.slice(0, k) : head; // 最后一个分隔符太靠前就硬截断，免得丢太多
  return { text: kept.replace(MARK_EDGE, ''), cut: true };
}
function normalizeTranscript(text) { return normalizeTranscriptEx(text).text; }

module.exports = { PROMPT, resolveConfig, buildRequest, extractReplyText, normalizeTranscript, normalizeTranscriptEx };
