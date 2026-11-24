// 图片缩放比例回归测试：node test/img-scale.test.js
const { scaleFor } = require('../public/img-scale');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name); }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

check('普通照片：最长边缩到 1800（4000×3000 → 0.45）', near(scaleFor(4000, 3000), 0.45));
check('小图不放大（800×600 → 1）', scaleFor(800, 600) === 1);
check('接近但不算长图（1000×2400，长宽比 2.4）仍按 1800 缩（0.75）', near(scaleFor(1000, 2400), 0.75));
check('长截图（1080×6000）不缩小，保留可读的宽度', scaleFor(1080, 6000) === 1);
check('长截图（1000×2600，长宽比 2.6）不缩小', scaleFor(1000, 2600) === 1);
check('横向长图（3000×1000）不缩小', scaleFor(3000, 1000) === 1);
check('超长截图（1080×12000）最长边限制在 6000（0.5）', near(scaleFor(1080, 12000), 0.5));
check('异常尺寸返回 1（0×0、NaN）', scaleFor(0, 0) === 1 && scaleFor(NaN, 100) === 1);

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
