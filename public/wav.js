// 把录音采样编码成 16kHz 单声道 16 位 WAV（纯函数，浏览器和 Node 通用）。
// 输入是已经混成单声道的 Float32 采样；采样率不是 16000 时先重采样：
// 降采样用区间平均（相当于一个简单的低通，避免混叠），升采样用线性插值。
(function (root) {
  'use strict';
  const TARGET = 16000;

  function resample(samples, rate) {
    if (rate === TARGET || samples.length === 0) return samples;
    const n = Math.max(1, Math.round(samples.length * TARGET / rate));
    const out = new Float32Array(n);
    const ratio = rate / TARGET;
    const last = samples.length - 1;
    for (let i = 0; i < n; i++) {
      if (ratio > 1) { // 降采样：取 [i*ratio, (i+1)*ratio) 内采样的平均值
        const a = Math.min(Math.floor(i * ratio), last);
        const b = Math.max(a + 1, Math.min(Math.ceil((i + 1) * ratio), samples.length));
        let sum = 0;
        for (let j = a; j < b; j++) sum += samples[j];
        out[i] = sum / (b - a);
      } else { // 升采样：线性插值
        const pos = i * ratio, i0 = Math.min(Math.floor(pos), last), i1 = Math.min(i0 + 1, last), f = pos - i0;
        out[i] = samples[i0] * (1 - f) + samples[i1] * f;
      }
    }
    return out;
  }

  function encode(samples, sampleRate) {
    const pcm = resample(samples, sampleRate);
    const dataLen = pcm.length * 2;
    const out = new Uint8Array(44 + dataLen);
    const dv = new DataView(out.buffer);
    const str = (at, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, TARGET, true); dv.setUint32(28, TARGET * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, dataLen, true);
    for (let i = 0; i < pcm.length; i++) {
      let s = pcm[i];
      if (s !== s) s = 0; // NaN
      s = Math.max(-1, Math.min(1, s)); // 限幅，避免溢出回绕
      dv.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    }
    return out;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { encode };
  else root.WavEnc = { encode };
})(typeof window !== 'undefined' ? window : globalThis);
