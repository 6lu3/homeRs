// WAV 编码器回归测试：node test/wav.test.js
const { encode } = require('../public/wav');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const view = u8 => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const tag = (u8, at) => String.fromCharCode(...u8.subarray(at, at + 4));
const sine = (rate, seconds, freq = 440) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * freq * i / rate));

// 48kHz 的 1 秒正弦波 → 16kHz 单声道 16 位 WAV
{
  const w = encode(sine(48000, 1), 48000), dv = view(w);
  check('输出是 Uint8Array', w instanceof Uint8Array);
  check('长度是 44 字节头 + 16000 个采样 × 2 字节', w.length === 44 + 16000 * 2);
  check('RIFF / WAVE / fmt / data 标记正确', tag(w, 0) === 'RIFF' && tag(w, 8) === 'WAVE' && tag(w, 12) === 'fmt ' && tag(w, 36) === 'data');
  check('头：总长度−8、fmt 块长 16、PCM、单声道', dv.getUint32(4, true) === w.length - 8 && dv.getUint32(16, true) === 16 && dv.getUint16(20, true) === 1 && dv.getUint16(22, true) === 1);
  check('头：采样率 16000、字节率 32000、块对齐 2、位深 16、数据长度 32000', dv.getUint32(24, true) === 16000 && dv.getUint32(28, true) === 32000 && dv.getUint16(32, true) === 2 && dv.getUint16(34, true) === 16 && dv.getUint32(40, true) === 32000);
}

// 16kHz 输入不重采样，值按 round(x*32767) 对应
{
  const w = encode(Float32Array.from([0, 0.25, -0.25, 1, -1]), 16000), dv = view(w);
  check('16kHz：采样数不变（5 个 → 数据长度 10）', w.length === 44 + 10 && dv.getUint32(40, true) === 10);
  check('16kHz：0、0.25、-0.25、1 的值正确', dv.getInt16(44, true) === 0 && dv.getInt16(46, true) === 8192 && dv.getInt16(48, true) === -8192 && dv.getInt16(50, true) === 32767);
  check('16kHz：-1 对应 -32768 或 -32767', [-32768, -32767].includes(dv.getInt16(52, true)));
}

// 其他采样率
{
  const w = encode(sine(44100, 0.5), 44100);
  check('44.1kHz 的 0.5 秒 → 约 8000 个采样（±2）', Math.abs((w.length - 44) / 2 - 8000) <= 2);
  const c = encode(new Float32Array(48000).fill(0.5), 48000), dv = view(c);
  let max = 0; for (let i = 0; i < (c.length - 44) / 2; i++) max = Math.max(max, Math.abs(dv.getInt16(44 + i * 2, true) - 16384));
  check('降采样不改变恒定信号的幅度（0.5 → 16384，误差 ≤ 2）', max <= 2);
  const up = encode(new Float32Array(8000).fill(0.5), 8000), du = view(up);
  check('8kHz 升采样到 16kHz：采样数翻倍，幅度不变', (up.length - 44) / 2 === 16000 && Math.abs(du.getInt16(44 + 100 * 2, true) - 16384) <= 2);
}

// 限幅、空输入、异常值
{
  const dv = view(encode(Float32Array.from([2, -2]), 16000));
  check('超出范围的值被限幅，不会溢出回绕', dv.getInt16(44, true) === 32767 && [-32768, -32767].includes(dv.getInt16(46, true)));
  const dn = view(encode(Float32Array.from([NaN, 0.25]), 16000));
  check('NaN 按 0 处理', dn.getInt16(44, true) === 0 && dn.getInt16(46, true) === 8192);
  const e = encode(new Float32Array(0), 48000), de = view(e);
  check('空输入：只有 44 字节头，数据长度 0，总长度−8 为 36', e.length === 44 && de.getUint32(40, true) === 0 && de.getUint32(4, true) === 36);
}

// 最长秒数：超过的部分被截掉，保证上传不会超过请求体上限
{
  const w = encode(new Float32Array(160000).fill(0.1), 16000, 5);
  check('maxSeconds：10 秒的输入截成 5 秒（数据长度 160000）', view(w).getUint32(40, true) === 160000 && w.length === 44 + 160000);
  const w2 = encode(new Float32Array(48000 * 3).fill(0.1), 48000, 1.5);
  check('maxSeconds：按输入采样率换算，48kHz 的 3 秒截成 1.5 秒（约 24000 个 16kHz 采样）', Math.abs(view(w2).getUint32(40, true) / 2 - 24000) <= 2);
  check('maxSeconds：没超过时不截', view(encode(new Float32Array(16000).fill(0.1), 16000, 5)).getUint32(40, true) === 32000);
  check('maxSeconds：不传时不截', view(encode(new Float32Array(160000).fill(0.1), 16000)).getUint32(40, true) === 320000);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
