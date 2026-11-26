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
  // 下面正则里是一个看不见的 BOM 字符（U+FEFF），用来兼容 Windows 记事本保存的带 BOM 的文件
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '')); }
  catch {
    // 不要把 JSON.parse 的原始报错打出来：它会带上附近的原文，可能是 secret 或识别服务的 key
    console.error(`${CONFIG_FILE} 不是合法的 JSON，请检查括号、逗号和引号（要用英文半角的 "）。`);
    process.exit(1);
  }
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
// 每周菜单：餐 → 菜 → 食材（级联删除；食材引用的物品被删时置空）
db.exec(`
  CREATE TABLE IF NOT EXISTS menu_meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    meal TEXT NOT NULL,            -- breakfast | lunch | dinner
    UNIQUE(date, meal)
  );
  CREATE INDEX IF NOT EXISTS idx_menu_meals_date ON menu_meals(date);
  CREATE TABLE IF NOT EXISTS menu_dishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_id INTEGER NOT NULL REFERENCES menu_meals(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS menu_ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dish_id INTEGER NOT NULL REFERENCES menu_dishes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
    quantity REAL,
    unit TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_menu_dishes_meal ON menu_dishes(meal_id);
  CREATE INDEX IF NOT EXISTS idx_menu_ing_dish ON menu_ingredients(dish_id);
  CREATE INDEX IF NOT EXISTS idx_menu_ing_item ON menu_ingredients(item_id);
`);

// 学习计划：大计划 → 学习项（起止日期）→ 每天的勾选（级联删除）
db.exec(`
  CREATE TABLE IF NOT EXISTS study_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS study_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS study_checks (
    item_id INTEGER NOT NULL REFERENCES study_items(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    PRIMARY KEY (item_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_study_items_plan ON study_items(plan_id);
  CREATE INDEX IF NOT EXISTS idx_study_items_dates ON study_items(start_date, end_date);
  CREATE INDEX IF NOT EXISTS idx_study_checks_date ON study_checks(date);
`);

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
const { parseMulti } = require('./lib/parse');
// 供「一句话」和「小票」匹配库存用的物品列表（只含未删除的）
function stockItemsForMatch() {
  return withPath(db.prepare(`${ITEM_SELECT} WHERE ${LIVE}`).all()).map(i => ({ id: i.id, name: i.name, quantity: i.quantity, unit: i.unit, category: i.category, location_id: i.location_id, location_path: i.location_path }));
}
route('POST', /^\/api\/parse$/, async (req, res) => {
  const { text } = await readJson(req);
  if (!String(text || '').trim()) throw new HttpError(400, '请输入一句话');
  if (String(text).length > 200) throw new HttpError(400, '太长了，请一次说一件事');
  json(res, 200, parseMulti(text, { locations: allLocations(), items: stockItemsForMatch() }));
});

// ---------- 拍小票录入：图片 → 识别服务 → 录入意图（见 lib/receipt.js、lib/receipt-service.js） ----------
const { resolveConfig: resolveReceiptConfig } = require('./lib/receipt');
const { createReceiptService } = require('./lib/receipt-service');
const { ServiceError } = require('./lib/provider-guard'); // 小票和语音服务的错误都是它的子类
const receipt = createReceiptService({
  getConfig: () => resolveReceiptConfig(config.receipt, process.env), // 环境变量只在读取时合并，绝不写进 config
  getStock: stockItemsForMatch,
  dataDir: DATA_DIR,
});
{
  const c = resolveReceiptConfig(config.receipt, process.env);
  if (c.problem) console.log(`小票识别配置有问题：${c.problem}`);
  else if (c.enabled) console.log(`小票识别已启用（模型 ${c.model}）`);
}
route('GET', /^\/api\/receipt\/status$/, (req, res) => json(res, 200, receipt.status()));
route('POST', /^\/api\/receipt\/scan$/, async (req, res) => {
  if (!receipt.status().enabled) throw new HttpError(503, '识别服务未配置'); // 先于读取请求体
  const { buf } = await readImage(req, 8);
  const mime = (req.headers['content-type'] || '').split(';')[0].trim();
  try { json(res, 200, await receipt.scan(buf, mime)); }
  catch (e) { if (e instanceof ServiceError) throw new HttpError(e.status, e.message); throw e; } // 统一错误处理只认 HttpError
});

// ---------- 语音录入：WAV 录音 → 语音识别服务 → 文字（见 lib/asr.js、lib/asr-service.js；配置与小票完全独立） ----------
const { resolveConfig: resolveAsrConfig } = require('./lib/asr');
const { createAsrService } = require('./lib/asr-service');
const asr = createAsrService({
  getConfig: () => resolveAsrConfig(config.asr, process.env), // 环境变量只在读取时合并，绝不写进 config
  dataDir: DATA_DIR,
});
{
  const c = resolveAsrConfig(config.asr, process.env);
  if (c.problem) console.log(`语音识别配置有问题：${c.problem}`);
  else if (c.enabled) console.log(`语音识别已启用（模型 ${c.model}）`);
}
route('GET', /^\/api\/asr\/status$/, (req, res) => json(res, 200, asr.status()));
route('POST', /^\/api\/asr\/transcribe$/, async (req, res) => {
  if (!asr.status().enabled) throw new HttpError(503, '语音识别未配置'); // 先于读取请求体
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'audio/wav' && ct !== 'audio/x-wav') throw new HttpError(415, '仅支持 WAV 录音');
  let buf;
  try { buf = await readBody(req, 2 * 1024 * 1024); }
  catch (e) { if (e instanceof HttpError && e.status === 413) throw new HttpError(413, '录音太长'); throw e; }
  if (!buf.length) throw new HttpError(400, '录音为空');
  try { json(res, 200, await asr.transcribe(buf)); }
  catch (e) { if (e instanceof ServiceError) throw new HttpError(e.status, e.message); throw e; }
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
// ---------- 每周菜单（纯逻辑见 lib/menu.js） ----------
const menu = require('./lib/menu');
const MEALS = ['breakfast', 'lunch', 'dinner'];
function menuDate(s) {
  try { menu.weekStart(s); return s; } catch (e) { throw new HttpError(400, e.message); }
}
function menuWeekStart(s) {
  try { return menu.weekStart(s); } catch (e) { throw new HttpError(400, e.message); }
}
// 某些餐的菜（含食材），按 menu_dishes 行给出；meals 为 menu_meals 行
function dishesOfMeals(mealIds) {
  if (!mealIds.length) return new Map();
  const ph = mealIds.map(() => '?').join(',');
  const dishes = db.prepare(`SELECT id, meal_id, name FROM menu_dishes WHERE meal_id IN (${ph}) ORDER BY sort, id`).all(...mealIds);
  const byDish = new Map();
  if (dishes.length) {
    const dph = dishes.map(() => '?').join(',');
    for (const g of db.prepare(`SELECT id, dish_id, name, item_id, quantity, unit FROM menu_ingredients WHERE dish_id IN (${dph}) ORDER BY id`).all(...dishes.map(d => d.id))) {
      if (!byDish.has(g.dish_id)) byDish.set(g.dish_id, []);
      byDish.get(g.dish_id).push({ id: g.id, name: g.name, item_id: g.item_id, quantity: g.quantity, unit: g.unit });
    }
  }
  const byMeal = new Map();
  for (const d of dishes) {
    if (!byMeal.has(d.meal_id)) byMeal.set(d.meal_id, []);
    byMeal.get(d.meal_id).push({ id: d.id, name: d.name, ingredients: byDish.get(d.id) || [] });
  }
  return byMeal;
}
function weekMeals(start, end) {
  return db.prepare('SELECT id, date, meal FROM menu_meals WHERE date >= ? AND date <= ? ORDER BY date, id').all(start, end);
}
route('GET', /^\/api\/menu\/week$/, (req, res, _m, url) => {
  const start = menuWeekStart(url.searchParams.get('start'));
  const end = menu.addDays(start, 6);
  const rows = weekMeals(start, end);
  const dishes = dishesOfMeals(rows.map(r => r.id));
  const days = Array.from({ length: 7 }, (_, i) => ({ date: menu.addDays(start, i), meals: { breakfast: [], lunch: [], dinner: [] } }));
  for (const r of rows) {
    const day = days.find(d => d.date === r.date);
    if (day && day.meals[r.meal]) day.meals[r.meal] = dishes.get(r.id) || [];
  }
  json(res, 200, { start, end, days });
});
route('PUT', /^\/api\/menu\/meal$/, async (req, res) => {
  const b = (await readJson(req)) || {};
  const date = menuDate(b.date);
  if (!MEALS.includes(b.meal)) throw new HttpError(400, '餐次无效');
  if (!Array.isArray(b.dishes)) throw new HttpError(400, '菜品格式错误');
  // 先整理校验，再开事务
  const clean = [];
  for (const d of b.dishes) {
    const name = String((d && d.name) ?? '').trim();
    if (!name) continue;
    const ings = [];
    for (const g of Array.isArray(d.ingredients) ? d.ingredients : []) {
      const gname = String((g && g.name) ?? '').trim();
      if (!gname) continue;
      let quantity = null;
      if (g.quantity !== undefined && g.quantity !== null && g.quantity !== '') {
        quantity = typeof g.quantity === 'number' || (typeof g.quantity === 'string' && g.quantity.trim() !== '') ? Number(g.quantity) : NaN;
        if (!Number.isFinite(quantity) || quantity < 0) throw new HttpError(400, '数量必须是非负数字');
      }
      let item_id = g.item_id == null || g.item_id === '' ? null : Number(g.item_id);
      if (item_id != null && !db.prepare('SELECT 1 FROM items WHERE id = ?').get(item_id)) item_id = null;
      ings.push({ name: gname, item_id, quantity, unit: String(g.unit ?? '').trim() });
    }
    clean.push({ name, ings });
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM menu_meals WHERE date = ? AND meal = ?').run(date, b.meal);
    if (clean.length) {
      const mealId = db.prepare('INSERT INTO menu_meals(date, meal) VALUES(?, ?)').run(date, b.meal).lastInsertRowid;
      const insDish = db.prepare('INSERT INTO menu_dishes(meal_id, name, sort) VALUES(?, ?, ?)');
      const insIng = db.prepare('INSERT INTO menu_ingredients(dish_id, name, item_id, quantity, unit) VALUES(?, ?, ?, ?, ?)');
      clean.forEach((d, i) => {
        const dishId = insDish.run(mealId, d.name, i).lastInsertRowid;
        for (const g of d.ings) insIng.run(dishId, g.name, g.item_id, g.quantity, g.unit);
      });
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const meal = db.prepare('SELECT id FROM menu_meals WHERE date = ? AND meal = ?').get(date, b.meal);
  json(res, 200, meal ? (dishesOfMeals([meal.id]).get(meal.id) || []) : []);
});
// 菜名联想：不同菜名按最近出现日期倒序，带出最近一次的食材
route('GET', /^\/api\/menu\/suggest$/, (req, res, _m, url) => {
  const q = (url.searchParams.get('q') || '').trim();
  const rows = db.prepare('SELECT d.id, d.name FROM menu_dishes d JOIN menu_meals m ON m.id = d.meal_id WHERE (? = \'\' OR instr(d.name, ?) > 0) ORDER BY m.date DESC, d.id DESC').all(q, q);
  const seen = new Set(); const picked = [];
  for (const r of rows) {
    if (seen.has(r.name)) continue;
    seen.add(r.name); picked.push(r);
    if (picked.length >= 8) break;
  }
  const ings = new Map();
  if (picked.length) {
    for (const g of db.prepare(`SELECT dish_id, name, item_id, quantity, unit FROM menu_ingredients WHERE dish_id IN (${picked.map(() => '?').join(',')}) ORDER BY id`).all(...picked.map(p => p.id))) {
      if (!ings.has(g.dish_id)) ings.set(g.dish_id, []);
      ings.get(g.dish_id).push({ name: g.name, item_id: g.item_id, quantity: g.quantity, unit: g.unit });
    }
  }
  json(res, 200, picked.map(p => ({ name: p.name, ingredients: ings.get(p.id) || [] })));
});
route('POST', /^\/api\/menu\/purchase\/preview$/, async (req, res) => {
  const b = (await readJson(req)) || {};
  const start = menuWeekStart(b.start);
  const rows = weekMeals(start, menu.addDays(start, 6));
  const byMeal = dishesOfMeals(rows.map(r => r.id));
  const dishes = rows.flatMap(r => byMeal.get(r.id) || []);
  const items = db.prepare("SELECT id, name, quantity, unit FROM items WHERE deleted_at = ''").all();
  const shopping = db.prepare('SELECT name FROM shopping_extra WHERE done = 0').all();
  const out = menu.computePurchase({ dishes, items, shopping });
  for (const k of Object.keys(out)) for (const line of out[k]) line.note = menu.buildNote(line);
  json(res, 200, out);
});
route('POST', /^\/api\/menu\/purchase$/, async (req, res) => {
  const b = (await readJson(req)) || {};
  if (!Array.isArray(b.lines)) throw new HttpError(400, '格式错误');
  const norm = s => String(s ?? '').trim().toLowerCase();
  const listed = new Set(db.prepare('SELECT name FROM shopping_extra WHERE done = 0').all().map(r => norm(r.name)));
  const ins = db.prepare('INSERT INTO shopping_extra(name,note,created_at) VALUES(?,?,?)');
  let added = 0, skipped = 0;
  // 同一请求里同名（规范化后）的行合并成一条，备注用「；」连接
  const merged = new Map();
  for (const l of b.lines) {
    const name = String((l && l.name) ?? '').trim();
    if (!name) { skipped++; continue; }
    const note = String((l && l.note) ?? '').trim();
    const k = norm(name);
    if (merged.has(k)) { if (note) merged.get(k).notes.push(note); }
    else merged.set(k, { name, notes: note ? [note] : [] });
  }
  db.exec('BEGIN');
  try {
    for (const [k, m] of merged) {
      if (listed.has(k)) { skipped++; continue; }
      ins.run(m.name, m.notes.join('；'), now());
      listed.add(k);
      added++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  json(res, 200, { added, skipped });
});
// 三个月前的菜单自动清理（日期用服务端本地日期）；启动时一次，之后每 6 小时
function purgeOldMenus() {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return Number(db.prepare('DELETE FROM menu_meals WHERE date < ?').run(menu.purgeBefore(today)).changes);
}
purgeOldMenus();
setInterval(purgeOldMenus, 6 * 3600e3).unref();

// ---------- 学习计划（纯逻辑见 lib/study.js；长期记录，不自动清理） ----------
const study = require('./lib/study');
const { localDate } = require('./lib/provider-guard');
function studyDate(s) {
  if (!study.isDate(s)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
  return s;
}
// 名称 + 起止日期的通用校验（大计划和学习项共用）
function studyFields(b) {
  b = b || {};
  const name = String(b.name ?? '').trim();
  if (!name) throw new HttpError(400, '名称不能为空');
  const start_date = studyDate(b.start_date), end_date = studyDate(b.end_date);
  if (end_date < start_date) throw new HttpError(400, '结束日期不能早于开始日期');
  return { name, start_date, end_date };
}
function studyItemFields(b) {
  const f = studyFields(b);
  const plan_id = Number(b.plan_id);
  if (!Number.isInteger(plan_id) || !db.prepare('SELECT 1 FROM study_plans WHERE id = ?').get(plan_id)) throw new HttpError(400, '大计划不存在');
  return { ...f, plan_id, note: String(b.note ?? '').trim() };
}
const studyPlanRow = id => db.prepare('SELECT id, name, start_date, end_date FROM study_plans WHERE id = ?').get(id);
const studyItemRow = id => db.prepare('SELECT id, plan_id, name, note, start_date, end_date FROM study_items WHERE id = ?').get(id);
function checkedByItem(ids) {
  const map = new Map(ids.map(id => [id, []]));
  if (!ids.length) return map;
  for (const c of db.prepare(`SELECT item_id, date FROM study_checks WHERE item_id IN (${ids.map(() => '?').join(',')}) ORDER BY date`).all(...ids)) map.get(c.item_id).push(c.date);
  return map;
}

route('GET', /^\/api\/study\/plans$/, (req, res) => {
  json(res, 200, db.prepare(`SELECT p.id, p.name, p.start_date, p.end_date, (SELECT COUNT(*) FROM study_items i WHERE i.plan_id = p.id) AS item_count FROM study_plans p ORDER BY p.start_date, p.id`).all());
});
route('POST', /^\/api\/study\/plans$/, async (req, res) => {
  const f = studyFields(await readJson(req));
  const id = db.prepare('INSERT INTO study_plans(name, start_date, end_date, created_at) VALUES(?, ?, ?, ?)').run(f.name, f.start_date, f.end_date, new Date().toISOString()).lastInsertRowid;
  json(res, 200, studyPlanRow(id));
});
route('PUT', /^\/api\/study\/plans\/(\d+)$/, async (req, res, [id]) => {
  const f = studyFields(await readJson(req));
  if (!studyPlanRow(id)) throw new HttpError(404, '大计划不存在');
  db.prepare('UPDATE study_plans SET name = ?, start_date = ?, end_date = ? WHERE id = ?').run(f.name, f.start_date, f.end_date, id);
  json(res, 200, studyPlanRow(id));
});
route('DELETE', /^\/api\/study\/plans\/(\d+)$/, (req, res, [id]) => {
  if (!studyPlanRow(id)) throw new HttpError(404, '大计划不存在');
  const removed = db.prepare('SELECT COUNT(*) AS n FROM study_items WHERE plan_id = ?').get(id).n;
  db.prepare('DELETE FROM study_plans WHERE id = ?').run(id);  // 外键级联删除学习项和勾选
  json(res, 200, { removed });
});

route('GET', /^\/api\/study\/items$/, (req, res, _m, url) => {
  const plan = url.searchParams.get('plan');
  const rows = plan ? db.prepare('SELECT id, plan_id, name, note, start_date, end_date FROM study_items WHERE plan_id = ? ORDER BY start_date, id').all(Number(plan))
    : db.prepare('SELECT id, plan_id, name, note, start_date, end_date FROM study_items ORDER BY start_date, id').all();
  const checked = checkedByItem(rows.map(r => r.id));
  json(res, 200, rows.map(r => ({ ...r, checked: checked.get(r.id) })));
});
route('POST', /^\/api\/study\/items$/, async (req, res) => {
  const f = studyItemFields(await readJson(req));
  const id = db.prepare('INSERT INTO study_items(plan_id, name, start_date, end_date, note) VALUES(?, ?, ?, ?, ?)').run(f.plan_id, f.name, f.start_date, f.end_date, f.note).lastInsertRowid;
  json(res, 200, studyItemRow(id));
});
route('PUT', /^\/api\/study\/items\/(\d+)$/, async (req, res, [id]) => {
  const f = studyItemFields(await readJson(req));
  if (!studyItemRow(id)) throw new HttpError(404, '学习项不存在');
  db.prepare('UPDATE study_items SET plan_id = ?, name = ?, start_date = ?, end_date = ?, note = ? WHERE id = ?').run(f.plan_id, f.name, f.start_date, f.end_date, f.note, id);
  json(res, 200, studyItemRow(id));  // 不动勾选：范围外的旧勾选保留，只是不计入进度
});
route('DELETE', /^\/api\/study\/items\/(\d+)$/, (req, res, [id]) => {
  if (!studyItemRow(id)) throw new HttpError(404, '学习项不存在');
  db.prepare('DELETE FROM study_items WHERE id = ?').run(id);
  json(res, 200, { ok: true });
});

// 某一天要学的 + 即将开始的
route('GET', /^\/api\/study\/day$/, (req, res, _m, url) => {
  const date = studyDate(url.searchParams.get('date'));
  const today = localDate();
  const rows = db.prepare('SELECT i.id, i.plan_id, p.name AS plan_name, i.name, i.note, i.start_date, i.end_date FROM study_items i JOIN study_plans p ON p.id = i.plan_id ORDER BY i.end_date, i.id').all();
  const today_items = study.itemsOnDate(rows, date);
  const later = study.upcoming(rows, date, 3);
  const checked = checkedByItem(today_items.map(r => r.id));
  json(res, 200, {
    date,
    items: today_items.map(r => {
      const dates = checked.get(r.id);
      return { ...r, checked: dates.includes(date), ...study.progress(r, dates, date, today) };
    }),
    upcoming: later.map(({ id, plan_id, plan_name, name, start_date, end_date }) => ({ id, plan_id, plan_name, name, start_date, end_date })),
  });
});
// 某个月里每个学习项占哪几天、哪几天已勾选
route('GET', /^\/api\/study\/month$/, (req, res, _m, url) => {
  const month = url.searchParams.get('month') || '';
  let layout;
  const rows = db.prepare('SELECT i.id, i.plan_id, p.name AS plan_name, i.name, i.start_date, i.end_date FROM study_items i JOIN study_plans p ON p.id = i.plan_id ORDER BY i.start_date, i.id').all();
  try { layout = study.monthLayout(rows, month); } catch (e) { throw new HttpError(400, e.message); }
  const [y, mo] = month.split('-').map(Number);
  const byId = new Map(rows.map(r => [r.id, r]));
  const checked = checkedByItem(layout.map(l => l.id));
  json(res, 200, {
    month,
    daysInMonth: new Date(Date.UTC(y, mo, 0)).getUTCDate(),
    items: layout.map(l => ({
      ...byId.get(l.id), days: l.days,
      checked: checked.get(l.id).filter(d => d.startsWith(month + '-')).map(d => Number(d.slice(8))).filter(d => l.days.includes(d)),
    })),
  });
});
route('PUT', /^\/api\/study\/check$/, async (req, res) => {
  const b = (await readJson(req)) || {};
  const item = studyItemRow(Number(b.item_id));
  if (!item) throw new HttpError(404, '学习项不存在');
  const date = studyDate(b.date);
  if (date < item.start_date || date > item.end_date) throw new HttpError(400, '这一天不在该学习项的日期范围内');
  const checked = b.checked === true;
  if (checked) db.prepare('INSERT OR IGNORE INTO study_checks(item_id, date) VALUES(?, ?)').run(item.id, date);
  else db.prepare('DELETE FROM study_checks WHERE item_id = ? AND date = ?').run(item.id, date);
  json(res, 200, { item_id: item.id, date, checked });
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
