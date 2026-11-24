// 语音识别纯逻辑回归测试：node test/asr.test.js
const { PROMPT, resolveConfig, buildRequest, extractReplyText, normalizeTranscript, normalizeTranscriptEx } = require('../lib/asr');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const KEY = 'sk-secret-123';

// ---------- PROMPT ----------
check('PROMPT：包含提示词必须有的规则词', ['只返回', '。', '空格', '阿拉伯数字', '酸奶', '逐字', '顿号', '牛肉、猪肉'].every(w => PROMPT.includes(w)));

// ---------- resolveConfig ----------
{
  let c = resolveConfig(undefined, {});
  check('resolveConfig：空配置未启用且无问题', c.enabled === false && c.problem === '');
  c = resolveConfig({ url: 'https://a/x', key: KEY, model: 'm' }, {});
  check('resolveConfig：文件配置齐全即启用，默认值正确', c.enabled === true && c.format === 'responses' && c.timeoutSec === 30 && c.dailyLimit === 100 && c.maxSeconds === 30 && same(c.extra, {}));
  c = resolveConfig({ url: 'https://a/x', key: KEY, model: 'm' }, { ASR_API_URL: 'https://b/y' });
  check('resolveConfig：环境变量逐项覆盖文件', c.url === 'https://b/y' && c.key === KEY && c.enabled);
  c = resolveConfig({ url: 'u', key: KEY, model: 'm', extra: { a: 1 } }, { ASR_EXTRA: '{"thinking":{"type":"disabled"}}' });
  check('resolveConfig：ASR_EXTRA 整体替换文件里的 extra', same(c.extra, { thinking: { type: 'disabled' } }));
  for (const bad of ['not json', '[1]']) {
    c = resolveConfig({ url: 'u', key: KEY, model: 'm' }, { ASR_EXTRA: bad });
    check(`resolveConfig：ASR_EXTRA=${bad} 视为未配置，problem 提到它且不含 key`, c.enabled === false && c.problem.includes('ASR_EXTRA') && !c.problem.includes(KEY));
  }
  c = resolveConfig({ url: 'u', key: KEY, model: 'm' }, { ASR_FORMAT: 'openai' });
  check('resolveConfig：不支持的格式未启用且有 problem（不含 key）', c.enabled === false && c.problem !== '' && !c.problem.includes(KEY));
  c = resolveConfig({ url: 'u', key: KEY, model: 'm' }, { ASR_FORMAT: 'responses' });
  check('resolveConfig：responses 格式正常', c.enabled && c.format === 'responses');
  const t = v => resolveConfig({ url: 'u', key: KEY, model: 'm' }, { ASR_TIMEOUT_S: v }).timeoutSec;
  check('resolveConfig：超时秒数（5→5，0.05→0.05，0/abc→30）', t('5') === 5 && t('0.05') === 0.05 && t('0') === 30 && t('abc') === 30);
  const d = v => resolveConfig({ url: 'u', key: KEY, model: 'm' }, { ASR_DAILY_LIMIT: v }).dailyLimit;
  check('resolveConfig：每日上限（0→0，10→10，-3/abc→100）', d('0') === 0 && d('10') === 10 && d('-3') === 100 && d('abc') === 100);
  const m = v => resolveConfig({ url: 'u', key: KEY, model: 'm' }, { ASR_MAX_SECONDS: v }).maxSeconds;
  check('resolveConfig：录音最长秒数（45→45，500→60，0/abc/-1/1.5→30）', m('45') === 45 && m('500') === 60 && m('0') === 30 && m('abc') === 30 && m('-1') === 30 && m('1.5') === 30);
  c = resolveConfig({ url: 'u', key: KEY }, {});
  check('resolveConfig：只配了一部分时提示缺哪一项，且不含 key', c.enabled === false && c.problem.includes('model') && !c.problem.includes(KEY));
}

// ---------- buildRequest ----------
{
  const base = { url: 'https://a/x', key: 'sk-x', model: 'm', extra: {}, format: 'responses' };
  let r = buildRequest({ ...base, extra: { thinking: { type: 'disabled' } } }, 'QUJD');
  const c = r.body.input[0].content;
  check('buildRequest：地址、鉴权头、文字块、音频块', r.url === 'https://a/x' && r.headers.authorization === 'Bearer sk-x' && r.headers['content-type'] === 'application/json' && same(c[0], { type: 'input_text', text: PROMPT }) && same(c[1], { type: 'input_audio', audio_url: 'data:audio/wav;base64,QUJD' }));
  check('buildRequest：extra 合并进最外层', same(r.body.thinking, { type: 'disabled' }));
  r = buildRequest({ ...base, extra: { model: 'evil', input: 'evil' } }, 'QUJD');
  check('buildRequest：extra 不能覆盖 model 和 input', r.body.model === 'm' && Array.isArray(r.body.input));
}

// ---------- extractReplyText ----------
{
  check('extractReplyText：只取 message 里的 output_text 并拼接', extractReplyText({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'x' }, { type: 'output_text', text: 'y' }] }] }) === 'xy');
  check('extractReplyText：output 是空数组 → 空串', extractReplyText({ output: [] }) === '');
  check('extractReplyText：没有文字 → 空串', extractReplyText({ output: [{ type: 'message', content: [] }] }) === '');
  check('extractReplyText：结构不对 → null', [{}, null, { output: 'no' }, 5].every(j => extractReplyText(j) === null));
}

// ---------- normalizeTranscript ----------
{
  const n = normalizeTranscript;
  check('normalizeTranscript：两句之间的空格变成句号', n('把鸡蛋放入冰箱冷藏 买了五花肉一盒') === '把鸡蛋放入冰箱冷藏。买了五花肉一盒');
  check('normalizeTranscript：数字旁边的空白不动', n('买了 2 盒酸奶') === '买了 2 盒酸奶');
  check('normalizeTranscript：换行当作句子分隔', n('买了牛奶\n买了鸡蛋') === '买了牛奶。买了鸡蛋');
  check('normalizeTranscript：全角空格当作句子分隔', n('买了牛奶　买了鸡蛋') === '买了牛奶。买了鸡蛋');
  check('normalizeTranscript：紧挨句号的空白去掉', n('买了牛奶 。 买了鸡蛋') === '买了牛奶。买了鸡蛋');
  check('normalizeTranscript：连续句号合并', n('买了牛奶。。买了鸡蛋') === '买了牛奶。买了鸡蛋');
  check('normalizeTranscript：去掉首尾的句号', n('。买了牛奶。') === '买了牛奶');
  check('normalizeTranscript：逗号不动', n('买了牛奶，放冷藏') === '买了牛奶，放冷藏');
  check('normalizeTranscript：顿号不动（它不是句子分隔符）', n('买了牛肉、猪肉、排骨') === '买了牛肉、猪肉、排骨');
  check('normalizeTranscript：最长 200 个字符', n('菜'.repeat(250)).length === 200);
  check('normalizeTranscript：空白、空串、非字符串 → 空串', ['', '   ', null, 123, undefined].every(x => n(x) === ''));
  check('normalizeTranscript：字母和数字旁边的空白不动', n('iPhone 15 手机') === 'iPhone 15 手机' && n('买了 iPhone 手机') === '买了 iPhone 手机');
  check('normalizeTranscript：去掉整句外面的一对引号', n('“买了两盒酸奶放冷藏”') === '买了两盒酸奶放冷藏' && n('「买了牛奶」') === '买了牛奶' && n('"买了牛奶"') === '买了牛奶');
  check('normalizeTranscript：去掉「识别结果：」之类的前缀（和引号）', n('识别结果：买了牛奶') === '买了牛奶' && n('转写：买了牛奶') === '买了牛奶' && n('识别结果：“买了牛奶”') === '买了牛奶');
  check('normalizeTranscript：句子中间的引号不动', n('买了“牛奶”') === '买了“牛奶”');
  // 太长时按句子截断，并告诉调用方被截断了
  const sentence = '买了苹果一盒放冷藏';
  const long = Array.from({ length: 25 }, () => sentence).join('。'); // 249 个字符
  let r = normalizeTranscriptEx(long);
  check('normalizeTranscriptEx：超长时退回到最后一个句号，不留半句话，且标记被截断', r.cut === true && r.text.length <= 200 && r.text.split('。').length === 20 && r.text.endsWith('放冷藏'));
  r = normalizeTranscriptEx('菜'.repeat(250));
  check('normalizeTranscriptEx：没有句号可退时硬截断到 200，并标记被截断', r.cut === true && r.text.length === 200);
  r = normalizeTranscriptEx('买了牛奶。买了鸡蛋');
  check('normalizeTranscriptEx：没超长时 cut 为 false', r.cut === false && r.text === '买了牛奶。买了鸡蛋');
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
