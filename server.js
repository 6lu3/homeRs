'use strict';
// 家庭物资清点表 —— 零依赖 Node.js 服务（node >= 22.5，内置 SQLite）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`当前 Node.js 为 v${process.versions.node}，本程序需要 Node.js 22.13 或更高版本（内置 SQLite）。请参阅 DEPLOY.md 升级。`);
    process.exit(1);
  }
}
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = process.env.INVENTORY_DATA || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const COOKIE = 'inv_session';
const SESSION_DAYS = 180;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- 配置 / 密码 ----------
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  const a = crypto.scryptSync(String(pw), salt, 32);
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
let config;
if (fs.existsSync(CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} else {
  const initial = process.env.INVENTORY_PASSWORD || 'home1234';
  config = { passwordHash: hashPassword(initial), secret: crypto.randomBytes(32).toString('hex') };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`首次启动：已生成 ${CONFIG_FILE}，初始密码为 "${initial}"，登录后可在「设置」中修改。`);
}
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
function sessionToken() {
  return crypto.createHmac('sha256', config.secret).update(config.passwordHash).digest('hex');
}

// ---------- 数据库 ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'inventory.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '',
    location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_location ON items(location_id);
  CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  );
`);
// 升级旧库：位置可以标记在图纸上（plan_id + 百分比坐标 x/y）
{
  const cols = db.prepare('PRAGMA table_info(locations)').all().map(c => c.name);
  if (!cols.includes('plan_id')) {
    db.exec(`
      ALTER TABLE locations ADD COLUMN plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL;
      ALTER TABLE locations ADD COLUMN x REAL;
      ALTER TABLE locations ADD COLUMN y REAL;
    `);
  }
}
// 升级旧库：最低库存（购物清单）、软删除（回收站）、变动日志
{
  const cols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
  if (!cols.includes('min_quantity')) db.exec("ALTER TABLE items ADD COLUMN min_quantity REAL NOT NULL DEFAULT 0");
  if (!cols.includes('deleted_at')) db.exec("ALTER TABLE items ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at);
    CREATE TABLE IF NOT EXISTS stock_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      action TEXT NOT NULL,          -- create | update | quantity | move | delete | restore | purge
      delta REAL,                    -- 数量变化（quantity 动作）
      quantity REAL,                 -- 变化后的数量
      detail TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '', -- manual | quick | import | list
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_log_item ON stock_log(item_id);
    CREATE INDEX IF NOT EXISTS idx_log_time ON stock_log(created_at);
    CREATE TABLE IF NOT EXISTS shopping_extra (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
}

// 首次运行：预置常见位置，方便直接上手
if (db.prepare('SELECT COUNT(*) AS n FROM locations').get().n === 0) {
  const ins = db.prepare('INSERT INTO locations(name, parent_id, sort) VALUES (?, ?, ?)');
  const seed = [
    ['客厅', ['电视柜', '茶几抽屉']],
    ['厨房', ['冰箱冷藏', '冰箱冷冻', '吊柜', '地柜']],
    ['卧室', ['衣柜', '床头柜']],
    ['卫生间', ['镜柜']],
    ['阳台', ['储物柜']],
    ['玄关', ['鞋柜']],
  ];
  seed.forEach(([room, subs], i) => {
    const roomId = ins.run(room, null, i).lastInsertRowid;
    subs.forEach((s, j) => ins.run(s, roomId, j));
  });
}

const now = () => new Date().toISOString();

function allLocations() {
  const rows = db.prepare('SELECT * FROM locations ORDER BY sort, id').all();
  const byId = new Map(rows.map(r => [r.id, r]));
  const children = new Map();
  rows.forEach(r => { if (!children.has(r.parent_id)) children.set(r.parent_id, []); children.get(r.parent_id).push(r); });
  const counts = new Map(db.prepare("SELECT location_id, COUNT(*) AS n FROM items WHERE location_id IS NOT NULL AND deleted_at = '' GROUP BY location_id").all().map(r => [r.location_id, r.n]));
  const pathOf = (id) => {
    const parts = [];
    let cur = byId.get(id);
    let guard = 0;
    while (cur && guard++ < 50) { parts.unshift(cur.name); cur = byId.get(cur.parent_id); }
    return parts.join(' / ');
  };
  const depthOf = (id) => { let d = 0, cur = byId.get(id); while (cur && cur.parent_id != null && d < 50) { d++; cur = byId.get(cur.parent_id); } return d; };
  const totalOf = (id, guard = 0) => (counts.get(id) || 0) + (guard > 50 ? 0 : (children.get(id) || []).reduce((s, c) => s + totalOf(c.id, guard + 1), 0));
  // 深度优先排序，便于前端直接按树形缩进显示
  const ordered = [];
  const walk = (parentId) => { (children.get(parentId) || []).forEach(r => { ordered.push(r); walk(r.id); }); };
  walk(null);
  return ordered.map(r => ({ ...r, path: pathOf(r.id), depth: depthOf(r.id), item_count: counts.get(r.id) || 0, item_count_total: totalOf(r.id) }));
}
function descendantIds(rootId) {
  const rows = db.prepare('SELECT id, parent_id FROM locations').all();
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++) rows.filter(r => r.parent_id === ids[i]).forEach(r => ids.push(r.id));
  return ids;
}
function findOrCreateLocationPath(pathStr) {
  const parts = String(pathStr || '').split(/[\/／>›]/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let parentId = null;
  for (const name of parts) {
    let row = parentId == null
      ? db.prepare('SELECT id FROM locations WHERE name = ? AND parent_id IS NULL').get(name)
      : db.prepare('SELECT id FROM locations WHERE name = ? AND parent_id = ?').get(name, parentId);
    if (!row) {
      const sort = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS s FROM locations WHERE parent_id IS ?').get(parentId).s;
      row = { id: db.prepare('INSERT INTO locations(name,parent_id,sort) VALUES(?,?,?)').run(name, parentId, sort).lastInsertRowid };
    }
    parentId = row.id;
  }
  return parentId;
}

const ITEM_SELECT = 'SELECT i.*, l.name AS location_name FROM items i LEFT JOIN locations l ON l.id = i.location_id';
const LIVE = "i.deleted_at = ''";
function withPath(items) {
  const paths = new Map(allLocations().map(l => [l.id, l.path]));
  return items.map(i => ({ ...i, location_path: i.location_id != null ? (paths.get(i.location_id) || '') : '' }));
}
function getItem(id) { return withPath([db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(Number(id))].filter(Boolean))[0] || null; }
function logStock(item, action, { delta = null, quantity = null, detail = '', source = '' } = {}) {
  db.prepare('INSERT INTO stock_log(item_id,item_name,action,delta,quantity,detail,source,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(item.id, item.name, action, delta, quantity, detail, source, now());
}
function cleanItem(body, existing = {}) {
  const name = String(body.name ?? existing.name ?? '').trim();
  if (!name) throw new HttpError(400, '物品名称不能为空');
  let qty = body.quantity ?? existing.quantity ?? 1;
  qty = Number(qty);
  if (!Number.isFinite(qty) || qty < 0) throw new HttpError(400, '数量必须是非负数字');
  let min_quantity = body.min_quantity === undefined ? (existing.min_quantity ?? 0) : (body.min_quantity === '' || body.min_quantity == null ? 0 : Number(body.min_quantity));
  if (!Number.isFinite(min_quantity) || min_quantity < 0) throw new HttpError(400, '最低库存必须是非负数字');
  let location_id = body.location_id === undefined ? (existing.location_id ?? null) : body.location_id;
  if (location_id === '' || location_id === null) location_id = null;
  else {
    location_id = Number(location_id);
    if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(location_id)) throw new HttpError(400, '位置不存在');
  }
  let expires_at = String(body.expires_at ?? existing.expires_at ?? '').trim();
  if (expires_at && !/^\d{4}-\d{2}-\d{2}$/.test(expires_at)) throw new HttpError(400, '到期日格式应为 YYYY-MM-DD');
  return {
    name,
    category: String(body.category ?? existing.category ?? '').trim(),
    quantity: qty,
    min_quantity,
    unit: String(body.unit ?? existing.unit ?? '').trim(),
    location_id,
    note: String(body.note ?? existing.note ?? '').trim(),
    expires_at,
  };
}

// ---------- CSV ----------
const CSV_HEADER = ['名称', '分类', '数量', '单位', '位置', '到期日', '备注', '最低库存'];
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
const HEADER_ALIASES = {
  name: ['名称', '物品', '物品名称', 'name', 'item'],
  category: ['分类', '类别', 'category'],
  quantity: ['数量', 'quantity', 'qty'],
  unit: ['单位', 'unit'],
  location: ['位置', '存放位置', 'location'],
  expires_at: ['到期日', '保质期', '过期日', 'expires', 'expires_at', 'expiry'],
  note: ['备注', '说明', 'note', 'notes'],
  min_quantity: ['最低库存', '最低数量', '安全库存', 'min', 'min_quantity', 'minimum'],
};

// ---------- HTTP 工具 ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, '请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'JSON 格式错误'); }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isAuthed(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return false;
  const a = Buffer.from(t), b = Buffer.from(sessionToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setSessionCookie(res, clear = false) {
  const v = clear ? '' : sessionToken();
  const maxAge = clear ? 0 : SESSION_DAYS * 86400;
  res.setHeader('Set-Cookie', `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
function serveFile(res, baseDir, rel, cache) {
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep) && file !== baseDir) throw new HttpError(403, 'Forbidden');
  let st;
  try { st = fs.statSync(file); } catch { throw new HttpError(404, 'Not Found'); }
  if (!st.isFile()) throw new HttpError(404, 'Not Found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

// ---------- 路由 ----------
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('GET', /^\/api\/me$/, (req, res) => json(res, 200, { authed: isAuthed(req) }));
route('POST', /^\/api\/login$/, async (req, res) => {
  const { password } = await readJson(req);
  if (!verifyPassword(password || '', config.passwordHash)) { await new Promise(r => setTimeout(r, 400)); throw new HttpError(401, '密码错误'); }
  setSessionCookie(res);
  json(res, 200, { ok: true });
});
route('POST', /^\/api\/logout$/, (req, res) => { setSessionCookie(res, true); json(res, 200, { ok: true }); });

// 以下接口均需登录
route('POST', /^\/api\/password$/, async (req, res) => {
  const { oldPassword, newPassword } = await readJson(req);
  if (!verifyPassword(oldPassword || '', config.passwordHash)) throw new HttpError(400, '原密码错误');
  if (!newPassword || String(newPassword).length < 4) throw new HttpError(400, '新密码至少 4 位');
  config.passwordHash = hashPassword(newPassword);
  saveConfig();
  setSessionCookie(res); // 换了密码会话令牌随之变化，这里刷新当前设备
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/locations$/, (req, res) => json(res, 200, allLocations()));
route('POST', /^\/api\/locations$/, async (req, res) => {
  const b = await readJson(req);
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, '位置名称不能为空');
  const parent_id = b.parent_id == null || b.parent_id === '' ? null : Number(b.parent_id);
  if (parent_id != null && !db.prepare('SELECT 1 FROM locations WHERE id = ?').get(parent_id)) throw new HttpError(400, '上级位置不存在');
  const sort = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS s FROM locations WHERE parent_id IS ?').get(parent_id).s;
  const id = db.prepare('INSERT INTO locations(name,parent_id,sort) VALUES(?,?,?)').run(name, parent_id, sort).lastInsertRowid;
  json(res, 201, allLocations().find(l => l.id === Number(id)));
});
route('PUT', /^\/api\/locations\/(\d+)$/, async (req, res, [id]) => {
  id = Number(id);
  const cur = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, '位置不存在');
  const b = await readJson(req);
  const name = String(b.name ?? cur.name).trim();
  if (!name) throw new HttpError(400, '位置名称不能为空');
  let parent_id = b.parent_id === undefined ? cur.parent_id : (b.parent_id == null || b.parent_id === '' ? null : Number(b.parent_id));
  if (parent_id != null && descendantIds(id).includes(parent_id)) throw new HttpError(400, '不能移动到自己的下级');
  // 图纸标记：plan_id + x/y（图片宽高的百分比，0~100）；plan_id 传 null 表示从图纸上移除
  let { plan_id, x, y } = cur;
  if (b.plan_id !== undefined) {
    if (b.plan_id == null || b.plan_id === '') { plan_id = null; x = null; y = null; }
    else {
      plan_id = Number(b.plan_id);
      if (!db.prepare('SELECT 1 FROM plans WHERE id = ?').get(plan_id)) throw new HttpError(400, '图纸不存在');
    }
  }
  if (plan_id != null && (b.x !== undefined || b.y !== undefined)) {
    x = Number(b.x); y = Number(b.y);
    if (![x, y].every(v => Number.isFinite(v) && v >= 0 && v <= 100)) throw new HttpError(400, '坐标应为 0~100 的百分比');
  }
  db.prepare('UPDATE locations SET name = ?, parent_id = ?, plan_id = ?, x = ?, y = ? WHERE id = ?').run(name, parent_id, plan_id, x, y, id);
  json(res, 200, allLocations().find(l => l.id === id));
});
route('DELETE', /^\/api\/locations\/(\d+)$/, (req, res, [id]) => {
  id = Number(id);
  if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(id)) throw new HttpError(404, '位置不存在');
  const ids = descendantIds(id);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM items WHERE deleted_at = '' AND location_id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
  if (n > 0) throw new HttpError(400, `该位置（含下级）还有 ${n} 件物品，请先移走或删除`);
  db.prepare(`UPDATE items SET location_id = NULL WHERE location_id IN (${ids.map(() => '?').join(',')})`).run(...ids); // 回收站里的物品解除位置引用
  db.prepare('DELETE FROM locations WHERE id = ?').run(id); // 下级随 CASCADE 删除
  json(res, 200, { ok: true });
});

// ---------- 快速录入：一句话 → 结构化意图（纯规则，见 lib/parse.js） ----------
const { parse: parseCommand } = require('./lib/parse');
route('POST', /^\/api\/parse$/, async (req, res) => {
  const { text } = await readJson(req);
  if (!String(text || '').trim()) throw new HttpError(400, '请输入一句话');
  if (String(text).length > 200) throw new HttpError(400, '太长了，请一次说一件事');
  const items = withPath(db.prepare(`${ITEM_SELECT} WHERE ${LIVE}`).all()).map(i => ({ id: i.id, name: i.name, quantity: i.quantity, unit: i.unit, category: i.category, location_id: i.location_id, location_path: i.location_path }));
  json(res, 200, parseCommand(text, { locations: allLocations(), items }));
});
// 按路径创建（或查找）位置："书房 / 书架" → 逐级创建，返回末级位置
route('POST', /^\/api\/locations\/path$/, async (req, res) => {
  const { path: p } = await readJson(req);
  const id = findOrCreateLocationPath(p);
  if (id == null) throw new HttpError(400, '位置路径不能为空');
  json(res, 200, allLocations().find(l => l.id === Number(id)));
});

// ---------- 图纸（户型图 / 平面图） ----------
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
async function readImage(req, limitMB) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim();
  const ext = IMAGE_EXT[ct];
  if (!ext) throw new HttpError(415, '仅支持 JPEG / PNG / WebP 图片');
  const buf = await readBody(req, limitMB * 1024 * 1024);
  if (!buf.length) throw new HttpError(400, '图片为空');
  return { buf, ext };
}
function removeUpload(name) { if (name) fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {}); }
function allPlans() {
  const pins = new Map(db.prepare('SELECT plan_id, COUNT(*) AS n FROM locations WHERE plan_id IS NOT NULL GROUP BY plan_id').all().map(r => [r.plan_id, r.n]));
  return db.prepare('SELECT * FROM plans ORDER BY sort, id').all().map(p => ({ ...p, pins: pins.get(p.id) || 0 }));
}
route('GET', /^\/api\/plans$/, (req, res) => json(res, 200, allPlans()));
// 上传新图纸：body 为图片二进制，名称放在 ?name= 里
route('POST', /^\/api\/plans$/, async (req, res, _m, url) => {
  const name = (url.searchParams.get('name') || '').trim() || `图纸 ${allPlans().length + 1}`;
  const { buf, ext } = await readImage(req, 20);
  const sort = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS s FROM plans').get().s;
  const id = db.prepare("INSERT INTO plans(name, image, sort) VALUES(?, '', ?)").run(name, sort).lastInsertRowid;
  const file = `plan-${id}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  db.prepare('UPDATE plans SET image = ? WHERE id = ?').run(file, id);
  json(res, 201, allPlans().find(p => p.id === Number(id)));
});
route('PUT', /^\/api\/plans\/(\d+)$/, async (req, res, [id]) => {
  id = Number(id);
  const cur = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, '图纸不存在');
  const b = await readJson(req);
  const name = String(b.name ?? cur.name).trim();
  if (!name) throw new HttpError(400, '图纸名称不能为空');
  db.prepare('UPDATE plans SET name = ? WHERE id = ?').run(name, id);
  json(res, 200, allPlans().find(p => p.id === id));
});
// 更换图片（保留已标记的位置；若新图比例不同，标记可拖动调整）
route('POST', /^\/api\/plans\/(\d+)\/image$/, async (req, res, [id]) => {
  id = Number(id);
  const cur = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, '图纸不存在');
  const { buf, ext } = await readImage(req, 20);
  const file = `plan-${id}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  removeUpload(cur.image);
  db.prepare('UPDATE plans SET image = ? WHERE id = ?').run(file, id);
  json(res, 200, allPlans().find(p => p.id === id));
});
route('DELETE', /^\/api\/plans\/(\d+)$/, (req, res, [id]) => {
  id = Number(id);
  const cur = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, '图纸不存在');
  db.prepare('UPDATE locations SET plan_id = NULL, x = NULL, y = NULL WHERE plan_id = ?').run(id);
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  removeUpload(cur.image);
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/categories$/, (req, res) => {
  json(res, 200, db.prepare("SELECT category, COUNT(*) AS n FROM items WHERE category <> '' AND deleted_at = '' GROUP BY category ORDER BY n DESC, category").all());
});

route('GET', /^\/api\/items$/, (req, res, _m, url) => {
  const q = (url.searchParams.get('q') || '').trim();
  const category = url.searchParams.get('category') || '';
  const loc = url.searchParams.get('location');
  const expiring = url.searchParams.get('expiring'); // 天数：返回 N 天内到期或已过期
  const low = url.searchParams.get('low');           // 1：低于最低库存
  const where = [LIVE]; const args = [];
  if (q) { where.push('(i.name LIKE ? OR i.note LIKE ? OR i.category LIKE ? OR l.name LIKE ?)'); const p = `%${q}%`; args.push(p, p, p, p); }
  if (category) { where.push('i.category = ?'); args.push(category); }
  if (loc === 'none') where.push('i.location_id IS NULL');
  else if (loc) { const ids = descendantIds(Number(loc)); where.push(`i.location_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  if (expiring) {
    const d = new Date(); d.setDate(d.getDate() + Number(expiring));
    where.push("i.expires_at <> '' AND i.expires_at <= ?"); args.push(d.toISOString().slice(0, 10));
  }
  if (low) where.push('i.min_quantity > 0 AND i.quantity < i.min_quantity');
  const sql = `${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.updated_at DESC`;
  json(res, 200, withPath(db.prepare(sql).all(...args)));
});
const sourceOf = (url) => (url.searchParams.get('source') || 'manual').slice(0, 20);
route('POST', /^\/api\/items$/, async (req, res, _m, url) => {
  const v = cleanItem(await readJson(req));
  const t = now();
  const id = db.prepare('INSERT INTO items(name,category,quantity,min_quantity,unit,location_id,note,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(v.name, v.category, v.quantity, v.min_quantity, v.unit, v.location_id, v.note, v.expires_at, t, t).lastInsertRowid;
  const item = getItem(id);
  logStock(item, 'create', { quantity: item.quantity, detail: item.location_path, source: sourceOf(url) });
  json(res, 201, item);
});
route('PUT', /^\/api\/items\/(\d+)$/, async (req, res, [id], url) => {
  const cur = db.prepare(`SELECT * FROM items WHERE id = ? AND deleted_at = ''`).get(Number(id));
  if (!cur) throw new HttpError(404, '物品不存在');
  const v = cleanItem(await readJson(req), cur);
  db.prepare('UPDATE items SET name=?,category=?,quantity=?,min_quantity=?,unit=?,location_id=?,note=?,expires_at=?,updated_at=? WHERE id=?')
    .run(v.name, v.category, v.quantity, v.min_quantity, v.unit, v.location_id, v.note, v.expires_at, now(), cur.id);
  const item = getItem(cur.id);
  const source = sourceOf(url);
  // 只记录有意义的变化：数量、位置、其他字段
  if (v.quantity !== cur.quantity) logStock(item, 'quantity', { delta: v.quantity - cur.quantity, quantity: v.quantity, source });
  if (v.location_id !== cur.location_id) logStock(item, 'move', { quantity: v.quantity, detail: item.location_path || '（无位置）', source });
  if (v.name !== cur.name || v.category !== cur.category || v.unit !== cur.unit || v.note !== cur.note || v.expires_at !== cur.expires_at || v.min_quantity !== cur.min_quantity) {
    const changed = [];
    if (v.name !== cur.name) changed.push(`名称 ${cur.name}→${v.name}`);
    if (v.category !== cur.category) changed.push(`分类 ${cur.category || '无'}→${v.category || '无'}`);
    if (v.unit !== cur.unit) changed.push(`单位 ${cur.unit || '无'}→${v.unit || '无'}`);
    if (v.expires_at !== cur.expires_at) changed.push(`到期 ${cur.expires_at || '无'}→${v.expires_at || '无'}`);
    if (v.min_quantity !== cur.min_quantity) changed.push(`最低库存 ${cur.min_quantity}→${v.min_quantity}`);
    if (v.note !== cur.note) changed.push('备注');
    logStock(item, 'update', { quantity: v.quantity, detail: changed.join('，'), source });
  }
  // 数量归零 = 用完了 → 自动进回收站（toast 可撤销，回收站 30 天内可恢复）
  if (v.quantity <= 0) {
    db.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').run(now(), cur.id);
    logStock(item, 'delete', { quantity: 0, detail: '用完自动删除', source });
    return json(res, 200, { ...getItem(cur.id), auto_deleted: true });
  }
  json(res, 200, item);
});
// 启动时把历史上数量已为 0 的物品也移进回收站
{
  const zero = db.prepare("SELECT id, name FROM items WHERE deleted_at = '' AND quantity <= 0").all();
  for (const z of zero) { db.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').run(now(), z.id); logStock(z, 'delete', { quantity: 0, detail: '用完自动删除' }); }
  if (zero.length) console.log(`已把 ${zero.length} 件数量为 0 的物品移入回收站：${zero.map(z => z.name).join('、')}`);
}
// 删除 = 进回收站（可撤销）；回收站里再删 = 彻底删除
route('DELETE', /^\/api\/items\/(\d+)$/, (req, res, [id], url) => {
  const cur = getItem(id);
  if (!cur) throw new HttpError(404, '物品不存在');
  if (cur.deleted_at && !url.searchParams.get('purge')) throw new HttpError(400, '物品已在回收站');
  if (url.searchParams.get('purge')) {
    db.prepare('DELETE FROM items WHERE id = ?').run(cur.id);
    if (cur.image) fs.rm(path.join(UPLOAD_DIR, cur.image), { force: true }, () => {});
    logStock(cur, 'purge', { source: sourceOf(url) });
  } else {
    db.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').run(now(), cur.id);
    logStock(cur, 'delete', { quantity: cur.quantity, detail: cur.location_path, source: sourceOf(url) });
  }
  json(res, 200, { ok: true });
});
route('POST', /^\/api\/items\/(\d+)\/restore$/, (req, res, [id]) => {
  const cur = getItem(id);
  if (!cur) throw new HttpError(404, '物品不存在');
  if (!cur.deleted_at) throw new HttpError(400, '物品不在回收站');
  db.prepare("UPDATE items SET deleted_at = '', updated_at = ? WHERE id = ?").run(now(), cur.id);
  logStock(cur, 'restore', { quantity: cur.quantity });
  json(res, 200, getItem(cur.id));
});
route('GET', /^\/api\/trash$/, (req, res) => {
  purgeOldTrash();
  json(res, 200, withPath(db.prepare(`${ITEM_SELECT} WHERE i.deleted_at <> '' ORDER BY i.deleted_at DESC`).all()));
});
route('DELETE', /^\/api\/trash$/, (req, res) => {
  const rows = db.prepare("SELECT * FROM items WHERE deleted_at <> ''").all();
  for (const r of rows) { if (r.image) fs.rm(path.join(UPLOAD_DIR, r.image), { force: true }, () => {}); }
  db.prepare("DELETE FROM items WHERE deleted_at <> ''").run();
  json(res, 200, { purged: rows.length });
});
const TRASH_DAYS = 30;
function purgeOldTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 86400e3).toISOString();
  const rows = db.prepare("SELECT * FROM items WHERE deleted_at <> '' AND deleted_at < ?").all(cutoff);
  if (!rows.length) return;
  for (const r of rows) { if (r.image) fs.rm(path.join(UPLOAD_DIR, r.image), { force: true }, () => {}); }
  db.prepare("DELETE FROM items WHERE deleted_at <> '' AND deleted_at < ?").run(cutoff);
}
purgeOldTrash();
setInterval(purgeOldTrash, 6 * 3600e3).unref();

// 变动日志：?item=<id> 看单件；?limit=
route('GET', /^\/api\/log$/, (req, res, _m, url) => {
  const item = url.searchParams.get('item');
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
  const rows = item
    ? db.prepare('SELECT * FROM stock_log WHERE item_id = ? ORDER BY id DESC LIMIT ?').all(Number(item), limit)
    : db.prepare('SELECT * FROM stock_log ORDER BY id DESC LIMIT ?').all(limit);
  json(res, 200, rows);
});

// 购物清单 = 低于最低库存的物品 + 手动添加的条目
route('GET', /^\/api\/shopping$/, (req, res) => {
  const low = withPath(db.prepare(`${ITEM_SELECT} WHERE ${LIVE} AND i.min_quantity > 0 AND i.quantity < i.min_quantity ORDER BY i.category, i.name`).all())
    .map(i => ({ id: i.id, name: i.name, quantity: i.quantity, min_quantity: i.min_quantity, unit: i.unit, category: i.category, location_path: i.location_path, need: Math.max(0, i.min_quantity - i.quantity) }));
  const extra = db.prepare('SELECT * FROM shopping_extra ORDER BY done, id DESC').all();
  json(res, 200, { low, extra });
});
route('POST', /^\/api\/shopping$/, async (req, res) => {
  const b = await readJson(req);
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, '请输入要买的东西');
  const id = db.prepare('INSERT INTO shopping_extra(name,note,created_at) VALUES(?,?,?)').run(name, String(b.note || '').trim(), now()).lastInsertRowid;
  json(res, 201, db.prepare('SELECT * FROM shopping_extra WHERE id = ?').get(id));
});
route('PUT', /^\/api\/shopping\/(\d+)$/, async (req, res, [id]) => {
  const cur = db.prepare('SELECT * FROM shopping_extra WHERE id = ?').get(Number(id));
  if (!cur) throw new HttpError(404, '条目不存在');
  const b = await readJson(req);
  db.prepare('UPDATE shopping_extra SET name = ?, note = ?, done = ? WHERE id = ?')
    .run(String(b.name ?? cur.name).trim() || cur.name, String(b.note ?? cur.note).trim(), b.done === undefined ? cur.done : (b.done ? 1 : 0), cur.id);
  json(res, 200, db.prepare('SELECT * FROM shopping_extra WHERE id = ?').get(cur.id));
});
route('DELETE', /^\/api\/shopping\/(\d+)$/, (req, res, [id]) => {
  db.prepare('DELETE FROM shopping_extra WHERE id = ?').run(Number(id));
  json(res, 200, { ok: true });
});
route('DELETE', /^\/api\/shopping$/, (req, res) => { // 清掉已勾选
  const n = db.prepare('DELETE FROM shopping_extra WHERE done = 1').run().changes;
  json(res, 200, { removed: n });
});
// 买回来了：数量补到最低库存（或指定数量）
route('POST', /^\/api\/items\/(\d+)\/bought$/, async (req, res, [id]) => {
  const cur = db.prepare(`SELECT * FROM items WHERE id = ? AND deleted_at = ''`).get(Number(id));
  if (!cur) throw new HttpError(404, '物品不存在');
  const b = await readJson(req);
  const add = b.quantity === undefined ? Math.max(0, cur.min_quantity - cur.quantity) || 1 : Number(b.quantity);
  if (!Number.isFinite(add) || add <= 0) throw new HttpError(400, '数量应为正数');
  const q = cur.quantity + add;
  db.prepare('UPDATE items SET quantity = ?, updated_at = ? WHERE id = ?').run(q, now(), cur.id);
  const item = getItem(cur.id);
  logStock(item, 'quantity', { delta: add, quantity: q, detail: '购物清单：已买', source: 'list' });
  json(res, 200, item);
});
route('POST', /^\/api\/items\/(\d+)\/image$/, async (req, res, [id]) => {
  const cur = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
  if (!cur) throw new HttpError(404, '物品不存在');
  const ct = (req.headers['content-type'] || '').split(';')[0].trim();
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[ct];
  if (!ext) throw new HttpError(415, '仅支持 JPEG / PNG / WebP 图片');
  const buf = await readBody(req, 15 * 1024 * 1024);
  if (!buf.length) throw new HttpError(400, '图片为空');
  const file = `${cur.id}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  if (cur.image) fs.rm(path.join(UPLOAD_DIR, cur.image), { force: true }, () => {});
  db.prepare('UPDATE items SET image = ?, updated_at = ? WHERE id = ?').run(file, now(), cur.id);
  json(res, 200, { image: file });
});
route('DELETE', /^\/api\/items\/(\d+)\/image$/, (req, res, [id]) => {
  const cur = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
  if (!cur) throw new HttpError(404, '物品不存在');
  if (cur.image) fs.rm(path.join(UPLOAD_DIR, cur.image), { force: true }, () => {});
  db.prepare("UPDATE items SET image = '', updated_at = ? WHERE id = ?").run(now(), cur.id);
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/export\.csv$/, (req, res) => {
  const items = withPath(db.prepare(`${ITEM_SELECT} WHERE ${LIVE} ORDER BY i.location_id, i.name`).all());
  const lines = [CSV_HEADER.join(',')];
  for (const i of items) lines.push([i.name, i.category, i.quantity, i.unit, i.location_path, i.expires_at, i.note, i.min_quantity || ''].map(csvEscape).join(','));
  const stamp = new Date().toISOString().slice(0, 10);
  send(res, 200, '\uFEFF' + lines.join('\r\n') + '\r\n', {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="inventory-${stamp}.csv"; filename*=UTF-8''${encodeURIComponent('家庭物资-' + stamp + '.csv')}`,
  });
});
route('POST', /^\/api\/import$/, async (req, res) => {
  const text = (await readBody(req, 10 * 1024 * 1024)).toString('utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'CSV 没有数据行');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = header.findIndex(h => aliases.includes(h));
    if (idx >= 0) col[key] = idx;
  }
  if (col.name === undefined) throw new HttpError(400, 'CSV 需要包含「名称」列');
  const get = (r, k) => (col[k] === undefined ? '' : (r[col[k]] ?? '')).trim();
  const ins = db.prepare('INSERT INTO items(name,category,quantity,min_quantity,unit,location_id,note,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  let imported = 0; const errors = [];
  db.exec('BEGIN');
  try {
    rows.slice(1).forEach((r, idx) => {
      try {
        const location_id = findOrCreateLocationPath(get(r, 'location'));
        const v = cleanItem({ name: get(r, 'name'), category: get(r, 'category'), quantity: get(r, 'quantity') || 1, min_quantity: get(r, 'min_quantity') || 0, unit: get(r, 'unit'), location_id, note: get(r, 'note'), expires_at: normalizeDate(get(r, 'expires_at')) });
        const t = now();
        const id = ins.run(v.name, v.category, v.quantity, v.min_quantity, v.unit, v.location_id, v.note, v.expires_at, t, t).lastInsertRowid;
        logStock({ id, name: v.name }, 'create', { quantity: v.quantity, detail: get(r, 'location'), source: 'import' });
        imported++;
      } catch (e) { errors.push(`第 ${idx + 2} 行：${e.message}`); }
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  json(res, 200, { imported, errors });
});
function normalizeDate(s) {
  if (!s) return '';
  const m = s.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?$/);
  if (!m) return s;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

route('GET', /^\/api\/stats$/, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(); soon.setDate(soon.getDate() + 30);
  json(res, 200, {
    items: db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at = ''").get().n,
    locations: db.prepare('SELECT COUNT(*) AS n FROM locations').get().n,
    expired: db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at = '' AND expires_at <> '' AND expires_at < ?").get(today).n,
    expiringSoon: db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at = '' AND expires_at <> '' AND expires_at >= ? AND expires_at <= ?").get(today, soon.toISOString().slice(0, 10)).n,
    low: db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at = '' AND min_quantity > 0 AND quantity < min_quantity").get().n,
    trash: db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at <> ''").get().n,
  });
});
// 首页仪表盘：一次拿齐
route('GET', /^\/api\/dashboard$/, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(); soon.setDate(soon.getDate() + 30);
  const pick = (i) => ({ id: i.id, name: i.name, quantity: i.quantity, min_quantity: i.min_quantity, unit: i.unit, category: i.category, location_path: i.location_path, expires_at: i.expires_at, image: i.image, updated_at: i.updated_at });
  const expiring = withPath(db.prepare(`${ITEM_SELECT} WHERE ${LIVE} AND i.expires_at <> '' AND i.expires_at <= ? ORDER BY i.expires_at LIMIT 10`).all(soon.toISOString().slice(0, 10))).map(pick);
  const low = withPath(db.prepare(`${ITEM_SELECT} WHERE ${LIVE} AND i.min_quantity > 0 AND i.quantity < i.min_quantity ORDER BY (i.quantity / i.min_quantity) LIMIT 10`).all()).map(pick);
  const recent = withPath(db.prepare(`${ITEM_SELECT} WHERE ${LIVE} ORDER BY i.created_at DESC LIMIT 6`).all()).map(pick);
  const log = db.prepare('SELECT * FROM stock_log ORDER BY id DESC LIMIT 12').all();
  const counts = {
    items: db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at = ''").get().n,
    expired: db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at = '' AND expires_at <> '' AND expires_at < ?").get(today).n,
    expiringSoon: db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at = '' AND expires_at <> '' AND expires_at >= ? AND expires_at <= ?").get(today, soon.toISOString().slice(0, 10)).n,
    low: db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at = '' AND min_quantity > 0 AND quantity < min_quantity").get().n,
    shoppingExtra: db.prepare('SELECT COUNT(*) AS n FROM shopping_extra WHERE done = 0').get().n,
  };
  json(res, 200, { today, counts, expiring, low, recent, log });
});

// ---------- 服务器 ----------
const PUBLIC_ROUTES = new Set(['/api/me', '/api/login', '/api/logout']);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!PUBLIC_ROUTES.has(url.pathname) && !isAuthed(req)) throw new HttpError(401, '请先登录');
      for (const r of routes) {
        const m = url.pathname.match(r.pattern);
        if (m && r.method === req.method) return await r.handler(req, res, m.slice(1), url);
      }
      throw new HttpError(404, '接口不存在');
    }
    if (url.pathname.startsWith('/uploads/')) {
      if (!isAuthed(req)) throw new HttpError(401, '请先登录');
      return serveFile(res, UPLOAD_DIR, decodeURIComponent(url.pathname.slice('/uploads/'.length)), 'private, max-age=31536000, immutable');
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    return serveFile(res, PUBLIC_DIR, rel, 'no-cache');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (url.pathname.startsWith('/api/')) json(res, status, { error: e.message || '服务器错误' });
    else send(res, status, e.message || 'Error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`家庭物资清点表已启动：`);
  console.log(`  本机：   http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  手机访问：http://${ip}:${PORT}  （需与本机在同一 WiFi）`));
  console.log(`数据目录：${DATA_DIR}`);
});
