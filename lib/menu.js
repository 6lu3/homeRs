'use strict';
// 每周菜单纯逻辑：周计算、清理截止日、采购计算（无 IO，便于测试）

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

// 解析 YYYY-MM-DD 为 UTC 毫秒；用真实日历校验，非法则抛错
function parseDate(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) throw new Error('日期格式应为 YYYY-MM-DD');
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const c = new Date(t);
  if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d) {
    throw new Error('日期格式应为 YYYY-MM-DD');
  }
  return t;
}

function fmt(t) {
  const d = new Date(t);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// 该日期所在周的周一
function weekStart(dateStr) {
  const t = parseDate(dateStr);
  const dow = new Date(t).getUTCDay(); // 0=周日
  return fmt(t - ((dow + 6) % 7) * DAY_MS);
}

function addDays(dateStr, n) {
  return fmt(parseDate(dateStr) + n * DAY_MS);
}

// 早于返回值（一个周一）的菜单应删除：今天往前 3 个自然月再减 1 天，取所在周周一
function purgeBefore(todayStr) {
  const t = new Date(parseDate(todayStr));
  const y = t.getUTCFullYear(), m = t.getUTCMonth() - 3, d = t.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // 目标月最后一天
  const cutoff = Date.UTC(y, m, Math.min(d, last)) - DAY_MS;
  return weekStart(fmt(cutoff));
}

const norm = s => String(s == null ? '' : s).trim().toLowerCase();
const round = n => Math.round(n * 1e6) / 1e6;

// 采购计算。dishes 每个元素是菜在本周的一次出现
function computePurchase({ dishes = [], items = [], shopping = [] } = {}) {
  const byId = new Map(items.map(i => [i.id, i]));
  const byName = new Map();
  for (const it of items) {
    const k = norm(it.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(it);
  }
  // item_id 命中优先；否则按名称，仅唯一匹配才算
  const matchStock = ing => {
    if (ing.item_id != null && byId.has(ing.item_id)) return byId.get(ing.item_id);
    const list = byName.get(norm(ing.name));
    return list && list.length === 1 ? list[0] : null;
  };

  const groups = new Map();
  for (const dish of dishes) {
    for (const ing of dish.ingredients || []) {
      const stock = matchStock(ing);
      const unit = String(ing.unit == null ? '' : ing.unit).trim();
      const hasQty = typeof ing.quantity === 'number' && isFinite(ing.quantity) && ing.quantity > 0;
      const isQty = hasQty && (!stock || String(stock.unit == null ? '' : stock.unit).trim() === unit);
      const kind = isQty ? 'qty' : 'servings';
      const key = (stock ? 'id:' + stock.id : 'name:' + norm(ing.name)) + '|' + kind;
      let g = groups.get(key);
      if (!g) {
        g = {
          name: String(ing.name).trim(), item_id: stock ? stock.id : null, kind,
          quantity: kind === 'qty' ? 0 : null, unit: kind === 'qty' ? unit : '',
          servings: 0, dishes: [], stock: stock ? { quantity: stock.quantity, unit: stock.unit } : null, note: '',
        };
        groups.set(key, g);
      }
      g.servings += 1;
      if (kind === 'qty') g.quantity = round(g.quantity + ing.quantity);
      const dn = g.dishes.find(x => x.name === dish.name);
      if (dn) dn.count += 1; else g.dishes.push({ name: dish.name, count: 1 });
    }
  }

  const listed = new Set(shopping.map(s => norm(s.name)));
  const out = { need: [], enough: [], exists: [] };
  for (const g of groups.values()) {
    const have = g.stock && g.stock.quantity > 0 ? g.stock.quantity : 0;
    let bucket;
    if (g.kind === 'qty') {
      if (have >= g.quantity) bucket = 'enough';
      else { bucket = 'need'; g.quantity = round(g.quantity - have); }
    } else {
      bucket = have > 0 ? 'enough' : 'need';
    }
    if (bucket === 'need' && listed.has(norm(g.name))) bucket = 'exists';
    g.note = buildNote(g);
    out[bucket].push(g);
  }
  return out;
}

// 例：来自本周菜单：番茄炒蛋×2 · 共 2 份
function buildNote(line) {
  const names = line.dishes.map(d => d.count > 1 ? `${d.name}×${d.count}` : d.name).join('、');
  const total = line.kind === 'qty' ? `${line.quantity}${line.unit}` : `${line.servings} 份`;
  return `来自本周菜单：${names} · 共 ${total}`;
}

module.exports = { weekStart, addDays, purgeBefore, computePurchase, buildNote };
