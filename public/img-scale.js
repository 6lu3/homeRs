// 上传小票前的缩放比例（纯函数，浏览器和 Node 通用）。
// 普通照片：最长边缩到 1800。长截图（长宽比 ≥ 2.5，如 App 订单长图）：
// 一律按像素预算缩，保留可读的宽度，否则 1080×6000 会被压成 324×1800，字就看不清了。
(function (root) {
  'use strict';
  function scaleFor(w, h) {
    if (!(w > 0) || !(h > 0)) return 1;
    const long = Math.max(w, h), short = Math.min(w, h);
    if (long / short < 2.5) return Math.min(1, 1800 / long);
    return Math.min(1, Math.sqrt(8e6 / (w * h)), 6000 / long);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { scaleFor };
  else root.ImgScale = { scaleFor };
})(typeof window !== 'undefined' ? window : globalThis);
