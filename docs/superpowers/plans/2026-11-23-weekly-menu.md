# 日常工具页 + 每周菜单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在家庭物资清点应用里新增「工具」页和第一个工具「每周菜单」（按周一到周日、早/午/晚编辑，可翻周，可按菜单生成采购并写入购物清单）。

**Architecture:** 纯逻辑（周计算、清理截止日、采购计算、备注格式）放进新文件 `lib/menu.js`，用 Node 断言脚本测试；`server.js` 增加三张表和菜单相关接口；前端在 `public/app.js` 里增加两个视图（工具页、菜单页）和两个弹层（编辑某一餐、采购确认）。

**Tech Stack:** Node ≥ 22.5（`node:sqlite`），零第三方依赖；原生 JS 单页前端；测试沿用 `test/parse.test.js`（纯函数）和 `test/smoke.js`（需服务运行的 API 冒烟）。

**Spec:** `docs/superpowers/specs/2026-11-23-weekly-menu-design.md`（执行者必须一并阅读，尤其是末尾"我替用户做的决定"1–12 条）。

## Global Constraints

- 零第三方依赖；Node ≥ 22.5；不新增 npm 包。
- 不新增底部标签；`tools`、`menu` 两个视图不在底部标签栏里，进入时没有任何标签高亮，底部栏保持显示。
- 沿用「温润家居极简」样式和现有标题栏（`.topbar`）、`.sheet`、`.tile` 等已有样式类。
- 不自动扣库存；确认采购只写 `shopping_extra`，不改 `items`。
- 菜单不接入 `stock_log` 和回收站。
- 数据库升级用启动时 `CREATE TABLE IF NOT EXISTS`，不破坏旧库；外键依赖已开启的 `PRAGMA foreign_keys = ON`。
- 每餐 `meal` 取值固定为 `breakfast` / `lunch` / `dinner`；日期格式 `YYYY-MM-DD`；一周从周一开始。
- 一道菜每出现一次算 1 份；3 个月清理只删整周早于截止日期的周，截止日期留一天余量。
- 用户界面文字全部用中文。所有来自用户输入的文字渲染时必须用现有的 `esc()`。

## Review Focus

1. 本周一道菜都没有时点「生成采购」：提示"本周还没有菜单"，不弹空的确认卡（Task 2 接口返回三个空数组，Task 5 前端判断）。
2. `start` / `date` 参数不是合法日期（如 `2026-13-45`、空、`abc`）：接口返回 400，不抛 500（Task 2）。
3. 菜名或食材名全是空格、数量为负或不是数字：空名被忽略，坏数量返回 400（Task 2）。
4. 食材关联的物品被删除后（`item_id` 置空，或指向回收站里的物品）：采购仍按名称工作，不报错（Task 1、Task 2）。
5. 菜名含 `<script>` 或引号：页面上原样显示成文字，不执行（Task 4）。

---

## File Structure

- Create `lib/menu.js` —— 纯函数：周计算、清理截止日、采购计算、备注格式。无 I/O，可在 Node 里直接 `require`。
- Create `test/menu.test.js` —— `lib/menu.js` 的断言测试。
- Modify `server.js` —— 新表、`purgeOldMenus`、`/api/menu/*` 接口。
- Modify `test/smoke.js` —— 追加菜单接口的冒烟用例。
- Modify `package.json` —— `test` 脚本加上 `node test/menu.test.js`。
- Modify `public/index.html` —— 新图标、`view-tools`、`view-menu`、两个弹层。
- Modify `public/app.js` —— `switchView`、首页卡片、工具页、菜单页逻辑。
- Modify `public/style.css` —— 新视图样式。
- Modify `README.md` —— 功能表加一行。

---

### Task 1: 菜单纯逻辑 `lib/menu.js`

**Files:**
- Create: `lib/menu.js`
- Test: `test/menu.test.js`
- Modify: `package.json`（`scripts.test`）

**Interfaces:**
- Produces（Task 2 使用）：
  - `weekStart(dateStr: string): string` —— 返回该日期所在周的周一，`YYYY-MM-DD`；非法日期抛 `Error('日期格式应为 YYYY-MM-DD')`（用真实日历校验，`2026-02-30` 也算非法）。
  - `addDays(dateStr: string, n: number): string`。
  - `purgeBefore(todayStr: string): string` —— 返回一个周一；`date` 早于它的菜单应删除。算法：`cutoff` = 今天往前 3 个自然月（日号超出则取该月最后一天）再减 1 天；结果 = `weekStart(cutoff)`。
  - `computePurchase({ dishes, items, shopping }): { need: Line[], enough: Line[], exists: Line[] }`
    - `dishes: { name: string, ingredients: { name: string, item_id: number|null, quantity: number|null, unit: string }[] }[]` —— 每个元素是菜在本周的**一次出现**（出现 2 次就是 2 个元素）。
    - `items: { id: number, name: string, quantity: number, unit: string }[]` —— 仅未删除的物品。
    - `shopping: { name: string }[]` —— 购物清单里**未勾选**的手动条目。
    - `Line = { name: string, item_id: number|null, kind: 'qty'|'servings', quantity: number|null, unit: string, servings: number, dishes: { name: string, count: number }[], stock: { quantity: number, unit: string } | null, note: string }`；`kind==='qty'` 时 `quantity` 是需要买的差额（`need` 组）或合计需求（`enough` 组），`kind==='servings'` 时 `quantity` 为 `null`。
  - `buildNote(line): string` —— 格式 `来自本周菜单：番茄炒蛋×2 · 共 2 份`（`servings` 行），`qty` 行为 `… · 共 {quantity}{unit}`；多道菜用 `、` 连接；某道菜只出现 1 次时不写 `×1`。

- [ ] **Step 1: 写失败的测试 `test/menu.test.js`**（风格同 `test/parse.test.js`：自带小 `check` 函数，失败时 `process.exit(1)`）。用例名与断言：
  - `weekStart('2026-11-23') === '2026-11-23'`（周一）、`weekStart('2026-11-29') === '2026-11-23'`（周日）、`weekStart('2026-12-01') === '2026-11-30'`；`weekStart('2026-02-30')`、`weekStart('abc')`、`weekStart('')` 都抛错。
  - `addDays('2026-11-30', 7) === '2026-12-07'`，`addDays('2026-01-01', -1) === '2025-12-31'`。
  - `purgeBefore('2026-11-23') === '2026-08-17'`（cutoff = 2026-08-22，周一为 08-17）；`purgeBefore('2026-05-31') === '2026-02-23'`（往前 3 个月是 2 月，日号取 2 月最后一天 02-28，再减 1 天 = 02-27，周一为 02-23）。
  - `computePurchase` 用一组固定数据，断言以下每条（每条一个独立 `check`）：
    1. 同一道"番茄炒蛋"出现 2 次，食材"番茄"无数量，库存无番茄 → `need` 里有一行 `{name:'番茄', kind:'servings', servings:2}`，`dishes` 为 `[{name:'番茄炒蛋', count:2}]`。
    2. 无数量的"鸡蛋"，库存有鸡蛋 6 个 → 在 `enough`，不在 `need`。
    3. 无数量的"猪肉"，库存里有一条数量为 0 的猪肉 → 在 `need`（数量 0 视为没有）。
    4. 写了"牛奶 2 瓶"，库存牛奶 1 瓶 → `need` 里 `{kind:'qty', quantity:1, unit:'瓶'}`；库存牛奶 5 瓶 → 在 `enough`。
    5. 写了"面粉 2 袋"，库存面粉单位是"kg" → 单位不一致，走 `servings` 规则：库存有面粉 → `enough`。
    6. 写了"葱 2 把"且库存无葱 → `need` 里 `{kind:'qty', quantity:2, unit:'把'}`。
    7. 同名"鸡蛋"一条写了"4 个"（库存 6 个，单位"个"）、另一条没写数量 → 分成两行（`qty` 一行、`servings` 一行）。
    8. 手写名"  鸡蛋 "（首尾空格、与库存名一致）无 `item_id` → 匹配到库存；库存里有两个都叫"青菜"的物品 → 匹配不唯一，视为库存没有，进 `need`。
    9. `item_id` 指向一个不在 `items` 里的 id → 回退到按名称匹配，不抛错。
    10. `shopping` 里已有未勾选的"番茄"，本应进 `need` 的"番茄" → 改放进 `exists`，不在 `need`。
  - `buildNote`：2 次出现 → `'来自本周菜单：番茄炒蛋×2 · 共 2 份'`；两道菜各 1 次 → `'来自本周菜单：番茄炒蛋、青椒肉丝 · 共 2 份'`；`qty` 行 → `'来自本周菜单：牛奶泡饭 · 共 1瓶'`。
- [ ] **Step 2: 运行确认失败**：`node test/menu.test.js`，期望报 `Cannot find module '../lib/menu'`。
- [ ] **Step 3: 实现 `lib/menu.js`**（CommonJS，导出上述五个函数）。日期运算用 UTC（`Date.UTC`）避免本地时区和夏令时影响。匹配名称时对名称做 `trim().toLowerCase()`；`item_id` 命中 `items` 时优先；未命中则按名称，仅唯一匹配才算命中。`qty` 行只由"有数量，且（无库存匹配，或匹配到的物品单位 trim 后与食材单位完全相同）"的出现产生；其余出现都进 `servings` 行。分组键 = `(命中物品 id 或 小写名称) + kind`。
- [ ] **Step 4: 运行确认通过**：`node test/menu.test.js`，期望全部 `ok` 且退出码 0。
- [ ] **Step 5: 把 `package.json` 的 `scripts.test` 改为 `node test/parse.test.js && node test/menu.test.js && node test/smoke.js`。**
- [ ] **Step 6: Commit** —— `git add lib/menu.js test/menu.test.js package.json` + `git commit -m "feat(menu): 周计算、清理截止日与采购计算纯逻辑"`

---

### Task 2: 数据表与菜单接口

**Files:**
- Modify: `server.js`（表：约第 117 行 `shopping_extra` 之后的 `db.exec`；接口：购物清单接口之后）
- Test: `test/smoke.js`

**Interfaces:**
- Consumes: Task 1 的 `weekStart`、`addDays`、`purgeBefore`、`computePurchase`、`buildNote`（`const menu = require('./lib/menu')`）。
- Produces（前端使用）：
  - 表 `menu_meals(id, date, meal, UNIQUE(date, meal))`、`menu_dishes(id, meal_id→menu_meals ON DELETE CASCADE, name, sort)`、`menu_ingredients(id, dish_id→menu_dishes ON DELETE CASCADE, name, item_id→items ON DELETE SET NULL, quantity REAL NULL, unit TEXT DEFAULT '')`，另给 `menu_meals(date)` 建索引。
  - `GET /api/menu/week?start=YYYY-MM-DD` → `{ start, end, days: [{ date, meals: { breakfast: Dish[], lunch: Dish[], dinner: Dish[] } }] }`（7 天；`start` 先归一成周一；`Dish = { id, name, ingredients: { id, name, item_id, quantity, unit }[] }`）。
  - `PUT /api/menu/meal` 请求体 `{ date, meal, dishes: { name, ingredients?: { name, item_id?, quantity?, unit? }[] }[] }` → 返回保存后该餐的 `Dish[]`。整餐替换；空名菜/空名食材丢弃；丢弃后没有菜则删除该餐记录并返回 `[]`。
  - `GET /api/menu/suggest?q=` → 最多 8 条 `{ name, ingredients: { name, item_id, quantity, unit }[] }`：菜名包含 `q`（空 `q` 则不过滤）的不同菜名，按最近出现日期倒序，带出**最近一次**出现时的食材。
  - `POST /api/menu/purchase/preview` 请求体 `{ start }` → `{ need: Line[], enough: Line[], exists: Line[] }`（`Line` 见 Task 1）。
  - `POST /api/menu/purchase` 请求体 `{ lines: { name, note }[] }` → `{ added: number, skipped: number }`；名称（trim、不分大小写）与现有未勾选 `shopping_extra` 相同的行跳过并计入 `skipped`。
  - `purgeOldMenus(): number` —— 删除 `date < menu.purgeBefore(今天)` 的 `menu_meals`，返回删除条数；启动时调一次，之后 `setInterval(…, 6 * 3600e3).unref()`，写法同 `purgeOldTrash`。"今天"用服务端本地日期。

- [ ] **Step 1: 写失败的冒烟用例**（追加到 `test/smoke.js`，沿用其 `json` / `call` / `assert` 辅助，放在最后一个用例之后、收尾之前）。用 `date` = 下一个远期周一，如 `2030-01-07`，避免被清理逻辑影响：
  - 未登录 `GET /api/menu/week?start=2030-01-07` → 401。
  - `GET /api/menu/week?start=2030-01-10`（周四）→ `start === '2030-01-07'`、`days.length === 7`、`days[0].meals.lunch` 为 `[]`。
  - `GET /api/menu/week?start=abc` → 400；`PUT /api/menu/meal` 的 `date: '2030-13-45'` → 400；`meal: 'brunch'` → 400。
  - `PUT /api/menu/meal` `{date:'2030-01-07', meal:'lunch', dishes:[{name:'番茄炒蛋', ingredients:[{name:'番茄'},{name:'鸡蛋', quantity:4, unit:'个'}]},{name:'   '}]}` → 200，返回 1 道菜、2 个食材（空名菜被丢弃）。
  - 再 `GET week` → `days[0].meals.lunch[0].name === '番茄炒蛋'`。
  - `PUT` 食材 `quantity: -1` → 400；`quantity: 'abc'` → 400。
  - 同一餐再次 `PUT` 只含 `{name:'青菜'}` → 返回 1 道菜，原来的番茄炒蛋被替换掉。
  - 再 `PUT` 一次 `dishes: []` → 返回 `[]`，`GET week` 该餐为 `[]`。
  - 建立"番茄炒蛋×2"（周一午、周二晚各一次）后：`GET /api/menu/suggest?q=番茄` → 第 1 条 `name === '番茄炒蛋'` 且食材含"番茄"；`POST /api/menu/purchase/preview` `{start:'2030-01-07'}` → `need` 含 `name==='番茄'`、`servings===2`（预先确认库存里没有番茄）。
  - `POST /api/menu/purchase` `{lines:[{name:'番茄', note:'来自本周菜单：番茄炒蛋×2 · 共 2 份'}]}` → `{added:1, skipped:0}`；再发一次 → `{added:0, skipped:1}`；`GET /api/shopping` 的 `extra` 中有该条目。
  - 空周（`start:'2030-02-04'`）的 `preview` → 三个数组都是空。
  - 删除一个被某食材引用的物品（先建物品、写进菜单食材 `item_id`，再 `DELETE /api/items/:id?purge=1`）→ `GET week` 仍 200，该食材 `item_id === null`。
- [ ] **Step 2: 运行确认失败**：先 `INVENTORY_DATA=<新建的临时目录> PORT=3000 node --no-warnings server.js`（另开后台），再 `node test/smoke.js`，期望新用例 404/失败。
- [ ] **Step 3: 在 `server.js` 里实现**上述表、五个接口和 `purgeOldMenus`。接口沿用现有 `route(method, pattern, handler)`、`readJson`、`HttpError`、`json`。校验：`date`、`start` 用 `menu.weekStart` 的抛错转成 `HttpError(400, …)`；`meal` 不在三值内 → 400「餐次无效」；`quantity` 提供时必须是有限且 ≥ 0 的数，否则 400「数量必须是非负数字」；`item_id` 不存在于 `items` 时存为 `NULL`。`purchase/preview` 取该周全部菜品展开为"每次出现一个元素"，物品只取 `deleted_at = ''`，`shopping` 取 `done = 0`，每个返回的 `Line` 补上 `note: menu.buildNote(line)`。`PUT /api/menu/meal` 在一个事务里完成替换。
- [ ] **Step 4: 重启服务，运行 `node test/smoke.js`**，期望全部 `ok`，包括新增用例。
- [ ] **Step 5: 补一个清理验证**：在 `test/smoke.js` 里不好直接造过期数据，改为在 `server.js` 末尾旁的注释里不要留代码；用一次性命令验证——`node -e` 打开临时库插入 `date='2020-01-06'` 的 `menu_meals` 并带一道菜，重启服务后确认该行及其 `menu_dishes` 已被删除（命令与观察到的结果写进提交说明即可）。
- [ ] **Step 6: Commit** —— `git add server.js test/smoke.js` + `git commit -m "feat(menu): 菜单数据表、接口与三个月自动清理"`

---

### Task 3: 工具页、首页入口与视图切换

**Files:**
- Modify: `public/index.html`（图标 symbol；`view-tools`、`view-menu` 两个空壳 section）
- Modify: `public/app.js`（`switchView`、`renderHome`）
- Modify: `public/style.css`

**Interfaces:**
- Consumes: 现有 `switchView(view)`、`hideSubviews()`、首页 `#home-body` 的 `[data-go]` 点击处理。
- Produces（Task 4、5 使用）：
  - 视图 `tools`（`#view-tools`）和 `menu`（`#view-menu`），均为 `class="screen subview hidden"`；`switchView('menu')` 时调用 `enterMenu()`（Task 4 实现，本 Task 先放空函数）。
  - 新增图标 symbol：`i-wrench`（工具）、`i-utensils`（餐具/菜单）、`i-chevron-left`、`i-chevron-right`，风格同现有描线图标。
  - `#view-menu` 内预留：`#menu-prev`、`#menu-next`、`#menu-range`、`#menu-today`、`#menu-body`、`#menu-purchase`（Task 4、5 使用；本 Task 只放结构）。

- [ ] **Step 1: `index.html` 增加四个图标 symbol 与两个视图。** `#view-tools`：标题栏（`.topbar`，`h2` 含 `i-wrench`「日常工具」，左侧返回按钮 `#tools-back` 回首页）+ 一个入口卡片按钮 `<button class="tool-card" data-tool="menu">`（图标 + 「每周菜单」+ 一行说明「安排一周三餐，一键生成采购」）。`#view-menu`：标题栏（返回按钮 `#menu-back` 回工具页、`h2` 含 `i-utensils`「每周菜单」）+ 周导航行（`#menu-prev` `#menu-range` `#menu-next`、`#menu-today`）+ `#menu-body` + 底部 `#menu-purchase` 按钮「按本周菜单生成采购」。
- [ ] **Step 2: `app.js` 修改。** `switchView` 里为 `tools`、`menu` 各加一行显示对应视图（沿用 `shopping`/`plans` 的写法）；`menu` 时调用 `enterMenu()`（先定义为空函数）。给 `#tools-back`、`#menu-back`、`.tool-card` 绑定点击：`switchView('home')`、`switchView('tools')`、`switchView('menu')`。`renderHome` 在 `tiles` 之后加一张 `data-go="tools"` 的卡片「日常工具」（含 `i-wrench` 图标和一行说明），复用现有 `[data-go]` 点击处理。
- [ ] **Step 3: `style.css` 增加 `.tool-card` 和首页「工具」卡片的样式**，用现有变量（`--card`、`--radius`、`--shadow-card`、`--primary`），悬停效果同 `.tile`。
- [ ] **Step 4: 手动验证**：用 `INVENTORY_DATA=<临时目录> node --no-warnings server.js` 启动，浏览器（390×844 手机视口）登录后检查：首页出现「日常工具」卡片 → 点击进入工具页（底部 6 个标签都没有高亮）→ 点「每周菜单」进入菜单页（标题栏、周导航占位可见）→ 返回按钮依次回到工具页、首页；点底部任一标签能正常离开这两个页面。
- [ ] **Step 5: Commit** —— `git add public && git commit -m "feat(tools): 工具页、首页入口与菜单视图框架"`

---

### Task 4: 菜单页——查看与编辑某一餐

**Files:**
- Modify: `public/app.js`、`public/index.html`（编辑弹层）、`public/style.css`

**Interfaces:**
- Consumes: Task 2 的 `GET /api/menu/week`、`PUT /api/menu/meal`；Task 3 的 `enterMenu()` 占位与 `#menu-*` 元素；现有 `api()`、`postJson()`、`toast()`、`esc()`、`ICO()`。
- Produces（Task 5 使用）：`menuState = { start: 'YYYY-MM-DD', week: <GET week 的返回> }`；`loadMenuWeek(start: string): Promise<void>`（拉取并渲染）；弹层 `#menu-editor`（`.sheet`）和 `openMealEditor(date: string, meal: 'breakfast'|'lunch'|'dinner'): void`，其中每道菜的菜名输入框 class `dish-name`、食材输入框 class `ing-name`、数量输入框 class `ing-qty`、单位输入框 class `ing-unit`（Task 5 在这些输入框上挂联想）。

- [ ] **Step 1: 实现 `enterMenu()` 与 `loadMenuWeek(start)`。** 首次进入用手机本地日期算出本周周一（本地日期运算，不用 `toISOString`，避免时区差一天）；服务端接受任意日期并归一，所以前端只需会"加减 7 天"和"算本周周一"。渲染：`#menu-range` 显示「11/23 – 11/29」，本周时加「本周」标记；周一到周日 7 张卡片，每张含日期（如「周一 11/23」，今天高亮）和早/午/晚三行，每行显示菜名（用 `、` 连接，空则显示灰色「点击添加」）；`#menu-prev` / `#menu-next` 翻 ±7 天，`#menu-today` 回本周。所有菜名走 `esc()`。
- [ ] **Step 2: 在 `index.html` 加 `#menu-editor` 弹层**（结构仿 `#confirm`：取消 / 标题 / 保存；内容区放菜列表和「＋ 添加一道菜」按钮）。
- [ ] **Step 3: 实现 `openMealEditor(date, meal)`。** 打开时用 `menuState.week` 里该餐现有的菜预填；每道菜一块：菜名输入、食材行（名称 / 数量 / 单位，数量单位可空）、「＋ 食材」、删除菜按钮。保存时收集成 `dishes` 数组 `PUT /api/menu/meal`，成功后关弹层、`toast('已保存')`、刷新当周。保存失败（如 400）用 `toast` 显示服务端错误信息，弹层保持打开。点遮罩或「取消」关闭，不保存。
- [ ] **Step 4: `style.css` 增加周卡片、餐行、编辑弹层内部的样式**，宽屏（`@media (min-width: 720px)`）下周卡片用两列网格，其余沿用现有风格。
- [ ] **Step 5: 手动验证**：进入菜单页能看到本周 7 天并标出今天和「本周」；点周一午餐，添加「番茄炒蛋」+ 食材「番茄」（无数量）和「鸡蛋 4 个」，保存后卡片上出现该菜名；再次打开能看到已存内容，清空后保存卡片恢复「点击添加」；翻到上周、下周再点「回到本周」；在菜名里输入 `<b>x</b>"` 保存后页面显示原文而不是加粗；故意给数量填负数，看到服务端错误提示且弹层未关闭；刷新页面后数据仍在。
- [ ] **Step 6: Commit** —— `git add public && git commit -m "feat(menu): 每周菜单页与单餐编辑"`

---

### Task 5: 菜名/食材联想与采购确认

**Files:**
- Modify: `public/app.js`、`public/index.html`（采购确认弹层）、`public/style.css`

**Interfaces:**
- Consumes: Task 2 的 `GET /api/menu/suggest`、`POST /api/menu/purchase/preview`、`POST /api/menu/purchase`；现有物品列表 `state.items`（用于食材名联想，字段 `id`、`name`）；Task 4 的 `.dish-name`/`.ing-name`/`.ing-qty`/`.ing-unit` 输入框、`menuState`、`loadMenuWeek`。
- Produces: 编辑弹层里的联想行为；`#menu-purchase` 点击后的确认弹层 `#menu-purchase-sheet`。

- [ ] **Step 1: 食材名联想。** 在 `.ing-name` 输入时，用 `state.items`（按名称包含匹配，最多 6 条）显示联想列表；点选后填入名称并把该物品 id 记在输入框上（如 `dataset.itemId`），保存时作为 `item_id` 提交；用户再手动改了名称，则清除这个 `item_id`。
- [ ] **Step 2: 菜名联想。** 在 `.dish-name` 输入时（250ms 防抖）调 `GET /api/menu/suggest?q=`，列表显示最多 8 个菜名；点选后填入菜名，并**用该菜的食材替换**这一块里目前的食材行（复制，不共享）；仅当这一块的食材行当前全为空时才自动带出，已有内容则不覆盖，避免冲掉用户刚写的东西。
- [ ] **Step 3: 采购确认弹层。** `index.html` 增加 `#menu-purchase-sheet`（结构仿 `#confirm`）。点 `#menu-purchase`：调 `preview`（`start = menuState.start`）；三组都为空 → `toast('本周还没有菜单')` 并不弹层。否则分三组显示：「需要买」（默认勾选）、「库存里有，默认够用」（默认不勾选）、「清单里已有」（不勾选且禁用）。每行显示食材名、需要量（`servings` 行显示「N 份」，`qty` 行显示「数量+单位」）、库存信息（如「库存 6 个」）和涉及的菜名；名称可编辑、可取消勾选。「加入购物清单」把勾选行的 `{ name, note }` 发给 `POST /api/menu/purchase`，成功后关闭并 `toast` 提示「已加入 N 项，跳过 M 项已有」；取消则不发请求。无勾选行时按钮禁用。
- [ ] **Step 4: 样式**：联想列表（绝对定位于输入框下方，点击外部收起）、确认弹层分组标题和行。
- [ ] **Step 5: 手动验证**：先在物品页建「鸡蛋 6 个」；周一午写「番茄炒蛋」（食材番茄、鸡蛋，都不填数量），周二晚再写同一道菜（输入菜名时联想出现并带出食材）；点「生成采购」→ 确认卡里「需要买」有番茄「2 份」，「库存里有」里有鸡蛋，涉及菜名都是「番茄炒蛋×2」；加入后到购物清单页看到「番茄」和备注「来自本周菜单：番茄炒蛋×2 · 共 2 份」；再生成一次，番茄出现在「清单里已有」且不可勾选；换到一个没有任何菜的周点生成，只出现「本周还没有菜单」提示；手写食材名带空格和大小写变化，仍能匹配库存。
- [ ] **Step 6: Commit** —— `git add public && git commit -m "feat(menu): 联想输入与按菜单生成采购"`

---

### Task 6: 文档与整体验收

**Files:**
- Modify: `README.md`（功能表加「每周菜单」一行，说明入口在首页「日常工具」卡片）；`验收清单.md`（如其格式是逐项勾选，则追加菜单相关的几项，沿用其现有格式）。

- [ ] **Step 1: 更新上述两份文档。**
- [ ] **Step 2: 完整运行测试**：用全新临时数据目录启动服务，`npm test`，期望 `parse`、`menu`、`smoke` 三部分全部通过。
- [ ] **Step 3: 跑一遍 Task 4、Task 5 的手动验证清单中最关键的路径**（新增菜、重复菜、生成采购、再次生成、空周）并确认无控制台报错。
- [ ] **Step 4: Commit** —— `git add README.md 验收清单.md && git commit -m "docs: 补充每周菜单说明与验收项"`
