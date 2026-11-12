// 向数据库塞几条示例数据后截图：node test/seed-demo.js
const BASE = 'http://localhost:3000';
let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return res.json();
}
(async () => {
  await call('POST', '/api/login', { password: 'home1234' });
  const locs = await call('GET', '/api/locations');
  const id = n => locs.find(l => l.name === n).id;
  const d = (days) => { const x = new Date(); x.setDate(x.getDate() + days); return x.toISOString().slice(0, 10); };
  const items = [
    { name: '布洛芬缓释胶囊', category: '药品', quantity: 1, unit: '盒', location_id: id('镜柜'), expires_at: d(-3), note: '0.3g×20粒' },
    { name: '创可贴', category: '药品', quantity: 2, unit: '盒', location_id: id('镜柜'), expires_at: d(20) },
    { name: '5 号电池', category: '日用', quantity: 12, unit: '节', location_id: id('茶几抽屉') },
    { name: '速冻水饺', category: '食品', quantity: 2, unit: '袋', location_id: id('冰箱冷冻'), expires_at: d(120), note: '三鲜馅' },
    { name: '电钻', category: '工具', quantity: 1, unit: '把', location_id: id('储物柜'), note: '配套钻头在同一盒子里' },
    { name: '冬季羽绒被', category: '寝具', quantity: 1, unit: '床', location_id: id('衣柜'), note: '顶层真空袋' },
  ];
  for (const i of items) await call('POST', '/api/items', i);
  console.log('seeded', items.length, 'cookie=', cookie);
})();
