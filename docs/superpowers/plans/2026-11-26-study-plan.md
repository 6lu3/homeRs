# 学习计划 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「日常工具」里增加「学习计划」：大计划 → 带起止日期的学习项，按日期显示「今天要学什么」，可逐日勾选，可按月查看。

**Architecture:** 纯逻辑放 `lib/study.js`（无 I/O，离线测试）；`server.js` 新增三张表和 `/api/study/*` 接口（照每周菜单的写法）；前端在 `index.html` 加 `#view-study`，`app.js` 加「学习计划」一节，工具页加第二张入口卡片。

**Tech Stack:** Node ≥ 22 + `node:sqlite`，原生 JS，零第三方依赖。

**Spec:** `docs/superpowers/specs/2026-11-26-study-plan-design.md`

## Global Constraints

- 零第三方依赖；沿用 `lib/`（纯逻辑）+ `test/*.test.js`（离线）+ `server.js` 路由的结构。
- 日期一律 `YYYY-MM-DD` 字符串；「今天」按服务器本地时间（`lib/provider-guard.js` 的 `localDate()`）；前端「今天」用 `app.js` 已有的 `todayStr()`。
- 错误统一 `{error: "中文提示"}`，用 `HttpError`；非法日期提示固定为「日期格式应为 YYYY-MM-DD」，结束早于开始提示「结束日期不能早于开始日期」，名称空提示「名称不能为空」。
- 旧库升级靠 `CREATE TABLE IF NOT EXISTS`；外键级联删除（`PRAGMA foreign_keys = ON` 已开启）。
- 不做自动清理、不做自动重排、不做连续打卡统计、不接 AI。
- 不要启动测试服务器或浏览器去验证前端；前端靠 `node --check` 和人工在真机验证（用户自己跑）。冒烟测试只写，不由执行者启动服务运行。
- 「即将开始」最多 3 项。

## Review Focus

- 一天跨年 / 跨月 / 闰年的日期：`2026-12-31`→`2027-01-01`、`2028-02-29` 的天数和 `monthLayout` 要对。
- 单日项（起止同一天）：`total` 为 1，`dayIndex` 为 1。
- 改日期把已有勾选挤出范围：勾选保留在库，但不计入 `done`；日期改回来又计入。
- 勾选日期不在项范围内：400，且不写库；重复勾选不产生重复行；取消没勾过的不报错。
- 删除大计划后其学习项和勾选全部消失；删除学习项后其勾选消失；不影响其他计划。
- 非法输入：空名称、不存在的 `plan_id`、非法日期、`month` 格式错误，都应是 400/404，不能 500。

---

### Task 1: 纯逻辑 `lib/study.js`

**Files:**
- Create: `lib/study.js`
- Create: `test/study.test.js`

**Interfaces:**
- Produces（`module.exports`）：
  - `isDate(s: string): boolean` — 严格 `YYYY-MM-DD` 且是真实日历日期。
  - `daysBetween(start: string, end: string): number` — 含首尾；`start == end` 为 1；`end < start` 返回 0。
  - `itemsOnDate(items: {start_date,end_date}[], date: string): item[]` — 覆盖该日期的项，保持输入顺序。
  - `upcoming(items, date: string, limit: number = 3): item[]` — `start_date > date` 的项，按 `start_date` 升序（同日按输入顺序），最多 `limit` 项。
  - `progress(item: {start_date,end_date}, checkedDates: string[], date: string, today: string): {total, done, dayIndex, missed}`
    - `total = daysBetween(start, end)`；
    - `done` = `checkedDates` 去重后落在 `[start, end]` 内的个数；
    - `dayIndex` = `date` 在范围内则为第几天（从 1 起），否则 `null`；
    - `missed` = 范围内日期 `< today` 且不在 `checkedDates` 的天数。
  - `monthLayout(items, month: string /* YYYY-MM */): {id, days: number[]}[]` — 只含与该月有交集的项，`days` 为该项在该月占的日号（升序，从 1 起），保持输入顺序。`month` 非法时抛 `Error('月份格式应为 YYYY-MM')`。
  - 非法日期参数一律抛 `Error('日期格式应为 YYYY-MM-DD')`。

- [ ] **Step 1: 写失败的测试 `test/study.test.js`**（沿用 `test/menu.test.js` 的 `check`/`eq`/`throws` 写法，末尾打印通过数并在有失败时 `process.exit(1)`）。用例名与断言：
  - `isDate`：`'2026-11-26'` 真；`'2026-02-30'`、`'2026-1-1'`、`''`、`null` 假；`'2028-02-29'` 真，`'2027-02-29'` 假。
  - `daysBetween`：`('2026-12-01','2026-12-10') = 10`；单日 `= 1`；跨年 `('2026-12-31','2027-01-01') = 2`；闰年 `('2028-02-28','2028-03-01') = 3`；`end < start` 为 0。
  - `itemsOnDate`：含边界（等于 start、等于 end 都算），范围外不算，顺序保持。
  - `upcoming`：只取 `start_date > date`，按开始日升序，默认最多 3 项，`limit` 生效；开始日等于 `date` 的不算「即将」。
  - `progress`：`total/dayIndex` 正确（第 3 天 / 共 10 天）；`dayIndex` 在范围外为 `null`；范围外的勾选不计入 `done`；重复日期只算一次；`missed`：10 天项、`today` 在第 5 天、勾了第 1、2 天 → 第 3、4 天落下，`missed = 2`（今天和未来不算落下）。
  - `monthLayout`：跨月项（`2026-11-28`~`2026-12-03`）在 `2026-11` 得 `[28,29,30]`、在 `2026-12` 得 `[1,2,3]`；与该月无交集的项不出现；整月覆盖的项在 `2028-02` 得 1..29；非法 `month`（`'2026-13'`、`'2026-1'`）抛错。
  - 非法日期参数抛 `日期格式应为 YYYY-MM-DD`。

- [ ] **Step 2: 运行确认失败**

Run: `node test/study.test.js`
Expected: FAIL，报 `Cannot find module '../lib/study'`。

- [ ] **Step 3: 实现 `lib/study.js`** — 用 `Date.UTC` 做日期运算（与 `lib/menu.js` 相同的思路，用真实日历校验，不要用本地时区），文件头注释写明「无 I/O」。

- [ ] **Step 4: 运行确认通过**

Run: `node test/study.test.js`
Expected: 全部 `ok`，无 `FAIL`，退出码 0。

- [ ] **Step 5: 提交**

```bash
git add lib/study.js test/study.test.js
git commit -m "feat(study): 学习计划纯逻辑（天数、覆盖、进度、按月布局）"
```

---

### Task 2: 数据库表与接口，加冒烟测试

**Files:**
- Modify: `server.js`（在菜单的建表块之后加建表；在菜单接口之后、`// 首次运行` 之前或菜单路由段末尾加 `/api/study/*` 路由）
- Modify: `test/smoke.js`（在「清理」之前、菜单测试之后加学习计划检查块）

**Interfaces:**
- Consumes: Task 1 的 `lib/study.js`；`server.js` 里已有的 `route`、`HttpError`、`readJson`、`json`、`db`；`lib/provider-guard.js` 的 `localDate`（若 server.js 尚未引入则 `require`，不改它的导出）。
- Produces（HTTP，均需登录）：
  - 表：`study_plans(id, name, start_date, end_date, sort, created_at)`；`study_items(id, plan_id→study_plans ON DELETE CASCADE, name, start_date, end_date, note DEFAULT '', sort)`；`study_checks(item_id→study_items ON DELETE CASCADE, date, PRIMARY KEY(item_id, date))`；索引 `study_items(plan_id)`、`study_items(start_date, end_date)`、`study_checks(date)`。
  - `GET /api/study/plans` → `[{id,name,start_date,end_date,item_count}]`（按 `start_date, id` 排序）。
  - `POST /api/study/plans` `{name,start_date,end_date}` → 201/200 返回新建行；`PUT /api/study/plans/:id`（同字段，整体更新）；`DELETE /api/study/plans/:id` → `{removed: <其下学习项数>}`。
  - `GET /api/study/items?plan=<id>` → `[{id,plan_id,name,start_date,end_date,note,checked:[YYYY-MM-DD…]}]`（`plan` 省略则全部）。
  - `POST /api/study/items` `{plan_id,name,start_date,end_date,note?}`；`PUT /api/study/items/:id`（同字段整体更新，**不动勾选**）；`DELETE /api/study/items/:id`。
  - `GET /api/study/day?date=` → `{date, items:[{id,plan_id,plan_name,name,note,start_date,end_date,checked:boolean,dayIndex,total,done,missed}], upcoming:[{id,plan_id,plan_name,name,start_date,end_date}]}`；`date` 缺省或非法 → 400。`items` 排序：`end_date` 升序再 `id`。`missed` 以服务器 `localDate()` 为「今天」。
  - `GET /api/study/month?month=YYYY-MM` → `{month, daysInMonth, items:[{id,plan_id,plan_name,name,start_date,end_date,days:[日号…],checked:[日号…]}]}`；`month` 非法 → 400。
  - `PUT /api/study/check` `{item_id,date,checked:boolean}` → `{item_id,date,checked}`；项不存在 404；`date` 非法或不在项的 `[start_date,end_date]` 内 → 400（提示「这一天不在该学习项的日期范围内」）；`checked:true` 用 `INSERT OR IGNORE`；`false` 用 `DELETE`，没勾过也不报错。
  - 校验规则：名称 `trim()` 后非空；`start_date`/`end_date` 用 `study.isDate`；`end_date >= start_date`；`plan_id` 必须存在（否则 400「大计划不存在」）；`:id` 不存在 → 404。

- [ ] **Step 1: 写失败的冒烟检查**（`test/smoke.js`，沿用该文件里 `json(...)`/`call(...)`/`assert(...)`，用独立的远期日期如 2031 避免撞数据；块末尾自己清理创建的计划）。断言：
  - 建计划成功；空名称 → 400；结束早于开始 → 400；非法日期 → 400。
  - 建学习项成功；`plan_id` 不存在 → 400；项日期可超出计划范围（仍成功）。
  - `GET /api/study/day?date=` 在项范围内：返回该项，`dayIndex`/`total` 正确；范围外：不在 `items`；开始日在后的出现在 `upcoming`；缺 `date` → 400。
  - 勾选：范围内成功；再勾一次不重复（`done` 仍为 1）；范围外 → 400 且不改变 `done`；取消勾选后 `done` 为 0；对未勾选的取消不报错；不存在的 `item_id` → 404。
  - 改项日期把已勾选日挤出范围后，`done` 为 0；改回后 `done` 恢复为 1（勾选保留）。
  - `GET /api/study/month`：返回的 `days` 与 `checked` 正确；非法 `month`（`2031-13`）→ 400。
  - 删除计划：返回的 `removed` 等于其下项数；之后 `GET /api/study/items` 里没有这些项；对已删项勾选 → 404；另一个计划的项不受影响。

- [ ] **Step 2: 确认冒烟脚本语法通过，且该块在没有实现时会失败**

Run: `node --check test/smoke.js`
Expected: 无输出（语法通过）。**不要启动服务运行**；失败行为由代码审阅确认（接口尚不存在时这些请求会得到 404）。

- [ ] **Step 3: 实现建表和路由** — 建表放在菜单建表块之后，用 `db.exec` 与 `CREATE TABLE IF NOT EXISTS`。路由风格照搬菜单段（`route(method, /正则/, handler)`、`HttpError`）。`PUT /api/study/items/:id` 与计划的 PUT 为整体更新，用同一套校验函数。多表写入（如有）用 `BEGIN/COMMIT/ROLLBACK`，沿用菜单的写法。

- [ ] **Step 4: 语法检查与纯逻辑回归**

Run: `node --check server.js && node test/study.test.js`
Expected: 无语法错误；`study.test.js` 全部 `ok`。

- [ ] **Step 5: 在 `package.json` 的 `test` 脚本里加入 `node test/study.test.js`**（放在 `node test/menu-cal.test.js` 之后、`node test/receipt.test.js` 之前），再运行：

Run: `node test/study.test.js && node test/menu.test.js`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add server.js test/smoke.js package.json
git commit -m "feat(study): 学习计划表与接口，补冒烟检查"
```

---

### Task 3: 前端视图、入口与样式

**Files:**
- Modify: `public/index.html`（工具页加卡片；新增 `#view-study`；如需图标，在 SVG 精灵表里加 `i-book`，线性风格，24×24，和现有 `i-utensils` 同款描边）
- Modify: `public/app.js`（新增「学习计划」一节，放在「每周菜单」一节之后、「首页仪表盘」之前；`switchView` 加 `study`；工具页返回按钮）
- Modify: `public/style.css`（学习计划样式，沿用 `tool-card`、`menu-nav`、`badge`、现有颜色变量）

**Interfaces:**
- Consumes: Task 2 的接口；`app.js` 已有的 `api`、`postJson`、`toast`、`esc`、`dialog`、`askText`、`askConfirm`、`todayStr`、`addDaysStr`、`parseLocalDate`、`mdLabel`、`WEEKDAYS`、`hideSubviews`、`$`/`$$`；`PUT`/`DELETE` 用 `api(url, {method, ...})` 的现有写法（先看 `api` 与 `postJson` 的实现再用）。
- Produces: 视图 `#view-study`（`class="screen subview hidden"`），`switchView('study')`；工具页卡片 `data-tool="study"`。

- [ ] **Step 1: 工具页与视图骨架。** `#view-tools` 的 `.tool-list` 里在每周菜单卡片后加：`data-tool="study"`，标题「学习计划」，副标题「按日期安排每天要学的内容」。`#view-study` 含：返回按钮 `#study-back`（回 `tools`）、标题、三个切换按钮（今天 / 按月看 / 大计划，用 `data-pane`）、三个面板 `#study-day`、`#study-month`、`#study-plans`。`app.js` 里 `#study-back` 点击 `switchView('tools')`；`switchView` 里 `if (view === 'study') { $('#view-study').classList.remove('hidden'); enterStudy(); }`。`.tool-card` 的现有点击绑定已覆盖新卡片（`switchView(b.dataset.tool)`），不要重复绑定。

- [ ] **Step 2: 「今天」面板。** 顶部 `.menu-nav` 同款导航：前一天 / 日期标签（如「11月26日 周四」，今天时加「今天」徽章）/ 后一天 / 「今天」按钮。数据来自 `GET /api/study/day?date=`。每个学习项一行：勾选框（点击调用 `PUT /api/study/check`，成功后更新该行状态，不整页重绘闪烁；失败 `toast` 并还原），名称，「第 N 天 / 共 M 天」，备注（有则显示），所属大计划名，`missed > 0` 时显示「已落下 X 天」（橙色）。已勾选的行名称加删除线或变淡。下方「即将开始」列出 `upcoming`（最多 3 项，显示开始日期）。没有任何项时显示空状态文案「这一天没有安排，去「大计划」里添加学习项」。用 `seq` 计数丢弃过期响应（照 `loadMenuWeek`）。所有用户文本经 `esc()`。

- [ ] **Step 3: 「按月看」面板。** 月份导航（上月 / 「2026年11月」/ 下月 / 「本月」）。数据来自 `GET /api/study/month?month=`。每个学习项一块：标题行（名称 + 所属大计划），下方一行按该月天数排开的小方格（`daysInMonth` 个，占到的日号有色，已勾选的实心，今天的方格加描边；手机窄屏允许换行或横向收紧，不得横向溢出页面）。没有项时显示「这个月没有安排」。

- [ ] **Step 4: 「大计划」面板。** 列出大计划卡片（名称、起止日期、项数），「＋ 新建大计划」。点卡片展开/进入其学习项列表（名称、起止日期、备注），每项有编辑和删除，「＋ 添加学习项」。新建/编辑用现有的弹层或 `dialog` 风格表单（名称、开始日期 `<input type="date">`、结束日期 `<input type="date">`、备注），提交前前端先检查名称非空与结束不早于开始，服务端错误用 `toast` 显示。学习项日期超出所属大计划范围时，在列表该项旁显示「超出计划范围」提示（不禁止保存）。删除学习项 `askConfirm`；删除大计划 `askConfirm`，文案写明「会同时删除其下 N 个学习项及全部勾选记录」。操作成功后刷新当前面板（以及「今天」「按月看」的缓存）。

- [ ] **Step 5: 样式。** 在 `style.css` 里新增 `#view-study` 相关规则，复用现有变量；勾选框触控区域不小于 40px；宽屏（≥ 720px）限制内容最大宽度居中，参考 `#view-menu` 现有的断点写法。

- [ ] **Step 6: 静态检查**

Run: `node --check public/app.js`
Expected: 无输出。再用 `grep -n "view-study\|data-tool=\"study\"" public/index.html public/app.js` 确认骨架、入口、`switchView` 三处都已接上。不要启动浏览器。

- [ ] **Step 7: 提交**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat(study): 学习计划界面（今天、按月看、大计划管理）"
```

---

### Task 4: 文档与验收清单

**Files:**
- Modify: `README.md`（功能说明里在「每周菜单」后加「学习计划」一节；首页提到「日常工具」处的描述补上学习计划）
- Modify: `docs/结构框架.md`（数据库表清单、接口清单、`lib/` 模块表、测试表、目录树里的 `lib/study.js` / `test/study.test.js`）
- Modify: `验收清单.md`（新增学习计划的待真机验证项，格式照现有条目）

**Interfaces:** 无新增代码接口；文档内容必须与 Task 1、2、3 的实际实现一致（接口路径、字段、错误码以代码为准，写之前对照 `server.js`）。

- [ ] **Step 1: 更新三份文档**，内容覆盖：功能怎么用（大计划 → 学习项 → 今天 / 按月看 / 勾选）、数据表、接口表、纯逻辑模块与测试、「落下只提示不重排」和「不自动清理」的说明。验收清单加：今天面板勾选与翻日期、按月看色块、大计划/学习项增删改、跨月跨年项、手机宽度不横向溢出、删除大计划的确认文案。

- [ ] **Step 2: 校对** — 对照 `server.js` 的路由逐条核对文档里写的路径和错误码；对照 `package.json` 确认测试脚本里有 `study.test.js`。

Run: `grep -n "api/study" server.js docs/结构框架.md`
Expected: 两处列出的路径一一对应，没有遗漏或多写。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/结构框架.md 验收清单.md
git commit -m "docs: 学习计划的功能说明、结构和验收项"
```
