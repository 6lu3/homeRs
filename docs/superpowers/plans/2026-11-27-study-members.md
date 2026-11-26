# 学习计划：区分是谁的计划 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 学习计划增加「成员」（固定两位，可改名），每个大计划属于一位成员；页面按选中成员只显示其计划。

**Architecture:** `study_members` 新表 + `study_plans.member_id` 新列（旧库自动升级）；`/api/study/*` 增加成员接口并给 `day`/`month` 加必填的 `member`；前端加成员切换，选择存 `localStorage`。

**Tech Stack:** Node ≥ 22 + `node:sqlite`，原生 JS，零第三方依赖。

**Spec:** `docs/superpowers/specs/2026-11-27-study-members-design.md`（接口和界面细节以它为准；原功能见 `2026-11-26-study-plan-design.md`）

## Global Constraints

- 零第三方依赖；错误统一 `{error: "中文提示"}` + `HttpError`。
- 固定两位成员，默认名「我」「TA」，只能改名，名字去首尾空白后非空、最长 20 字。
- `day`/`month` 的 `member` 必填：缺失或不是存在的成员 → 400「成员不存在」。
- 旧库升级后，所有 `member_id = 0` 的计划归第一位成员（`sort` 最小）；重复启动不改动已分配的计划。
- 不启动测试服务器或浏览器；冒烟测试只写不跑，前端只做 `node --check`。
- 不做账号 / 权限 / 「我们俩」合并视图 / 成员增删。

## Review Focus

- 旧库升级：已有计划在加列后归第一位成员，第二次启动不变（幂等）。
- `member` 缺失、非数字、不存在：`day`/`month` 400，`plans`/`items` 的可选过滤非法值 400，不能 500。
- 两位成员各有计划时，`day`/`month`/`plans`/`items` 只返回各自的；「即将开始」也只含自己的。
- 把计划转给另一位成员后，原成员看不到、新成员看得到，勾选记录跟着计划走不丢。
- 前端：切换成员后不会残留上一位的内容（用 seq 丢弃过期响应）；`localStorage` 里存的成员已不存在时回退到第一位；所有成员名经 `esc()`。

---

### Task 1: 数据库、成员接口、计划归属、冒烟测试

**Files:**
- Modify: `server.js`（学习计划建表块、学习计划路由段）
- Modify: `test/smoke.js`（学习计划块）

**Interfaces:**
- Consumes: 现有 `studyFields`、`studyPlanRow`、`studyItemRow`、`checkedByItem`、`route`、`HttpError`、`readJson`、`json`、`db`。
- Produces（HTTP）：
  - 表 `study_members(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0)`；`study_plans` 加列 `member_id INTEGER NOT NULL DEFAULT 0`（用 `PRAGMA table_info` 检查后 `ALTER TABLE ADD COLUMN`，与文件里其他升级写法一致）。
  - 启动时：`study_members` 为空则插入「我」(sort 0)、「TA」(sort 1)；然后 `UPDATE study_plans SET member_id = <第一位成员 id> WHERE member_id = 0`。
  - `GET /api/study/members` → `[{id, name}]` 按 `sort, id`。
  - `PUT /api/study/members/:id` `{name}` → `{id, name}`；空名 400「名称不能为空」；超过 20 字 400「名称最长 20 字」；不存在 404「成员不存在」。
  - `GET /api/study/plans?member=` → 每项含 `member_id`；`member` 给出但非正整数 → 400「成员不存在」；不给则全部。
  - `POST`/`PUT /api/study/plans` 请求体需 `member_id`，须为存在的成员，否则 400「成员不存在」；返回行含 `member_id`。`studyPlanRow` 的 SELECT 加上 `member_id`。
  - `GET /api/study/items?plan=&member=`：`member` 可选，给出时只含属于该成员计划的学习项；非正整数 400。
  - `GET /api/study/day?date=&member=`、`GET /api/study/month?month=&member=`：`member` 必填；缺失、非正整数或不存在的成员 → 400「成员不存在」；查询的 SQL 加 `WHERE p.member_id = ?`，`upcoming` 随之只含该成员的。

- [ ] **Step 1: 改 `test/smoke.js` 学习计划块（先写测试）。** 在现有块里：
  - 开头取成员：`GET /api/study/members` 断言有 2 个，记 `m1`、`m2`；`PUT /api/study/members/:id` 改名成功、空名 400、`'x'.repeat(21)` 400、不存在 id 404；测完把名字改回原值。
  - 所有已有的 `POST /api/study/plans` 请求体加 `member_id: m1.id`；新增一条「缺 `member_id` / `member_id: 999999` → 400 且 `error === '成员不存在'`」。
  - 所有已有 `GET /api/study/day?date=…` 和 `/api/study/month?month=…` 请求补 `&member=${m1.id}`；新增：缺 `member`、`member=abc`、`member=999999` 各 400。
  - 新增隔离检查：用 `m2` 建一个计划和一个覆盖 2031-03-03 的学习项；断言 `m1` 的 `day` 不含它、`m2` 的 `day` 含它；`m1` 的 `plans?member=` 不含 m2 的计划；`m2` 的计划把 `member_id` 改成 `m1.id` 后 `m1` 的 `day` 含它、勾选保留（先在它上面勾选一天，转移后 `done === 1`）。
  - 清理时把本块新建的所有计划删除。
  - Run: `node --check test/smoke.js` — Expected: 无输出。

- [ ] **Step 2: 实现建表、升级、种子、成员接口、`plans`/`items`/`day`/`month` 的 `member` 处理**（沿用现有路由风格和校验函数；成员 id 解析写成一个小函数，非正整数或不存在统一抛 `HttpError(400, '成员不存在')`，但 `PUT /members/:id` 对不存在的 id 用 404）。

- [ ] **Step 3: 检查**

  Run: `node --check server.js && node test/study.test.js`
  Expected: 无语法错误；`study.test.js` 全部 `ok`。

- [ ] **Step 4: 提交**

```bash
git add server.js test/smoke.js
git commit -m "feat(study): 区分成员——成员表、计划归属、按成员过滤"
```

---

### Task 2: 前端成员切换与计划归属

**Files:**
- Modify: `public/index.html`、`public/app.js`、`public/style.css`

**Interfaces:**
- Consumes: Task 1 的接口；`app.js` 里已有的 `study` 状态对象、`loadStudyDay`/`loadStudyMonth`/`loadStudyPlans`/`showStudyPane`/`openStudyEditor`、`askText`、`esc`、`toast`。
- Produces: `study.member`（当前成员 id）、`study.members`（`[{id,name}]`）；`localStorage` 键 `study_member`。

- [ ] **Step 1: 骨架。** `#view-study` 的标题栏下、`.study-tabs` 之上加一行 `#study-members`（成员按钮容器）；大计划编辑弹层 `#study-editor` 里加 `<label id="se-member-wrap">谁的计划<select id="se-member"></select></label>`（仅编辑大计划时显示）。

- [ ] **Step 2: 成员加载与切换。** 进入学习计划页时先 `GET /api/study/members`，读 `localStorage.study_member`，不在成员列表里则回退第一位；渲染两个按钮（名字经 `esc`，选中高亮）和一个「改名」小按钮（`askText` 改选中成员的名字，调用 `PUT /api/study/members/:id`，成功后刷新成员行）。点另一位成员：写 `localStorage`、更新 `study.member`、重新加载当前面板。`localStorage` 读写用 try/catch 包裹（隐私模式可能抛错）。成员加载失败时 `toast` 并不渲染三个面板。

- [ ] **Step 3: 面板带上成员。** `loadStudyDay`、`loadStudyMonth` 请求加 `&member=${study.member}`；`loadStudyPlans` 请求 `plans?member=` 和 `items?plan=` 同样过滤。切换成员或加载过程中沿用现有 `seq` 丢弃过期响应，切换时先清空当前面板的旧内容再加载，避免残留上一位的数据。

- [ ] **Step 4: 大计划编辑。** 新建 / 编辑大计划时显示「谁的计划」下拉（选项为两位成员，新建默认当前选中，编辑默认该计划当前归属）；提交体带 `member_id`。若保存后计划不属于当前选中的成员，`toast('已转给「名字」')`（名字取自 `study.members`，不经 innerHTML）。学习项编辑弹层隐藏该下拉。

- [ ] **Step 5: 样式。** 成员行的按钮沿用 `.study-tab` 风格（或同风格的 `.study-member`），选中高亮；宽屏与 `.study-tabs` 同宽居中。

- [ ] **Step 6: 检查与提交**

  Run: `node --check public/app.js`
  Expected: 无输出。再用 `grep -n "study_member\|study-members\|se-member" public/app.js public/index.html` 确认三处都已接上。

```bash
git add public
git commit -m "feat(study): 学习计划页成员切换与大计划归属"
```

---

### Task 3: 文档

**Files:**
- Modify: `README.md`、`docs/结构框架.md`、`验收清单.md`

**Interfaces:** 无代码接口；内容必须与 Task 1、2 的实际实现一致（对照 `server.js` 的路由和错误文案）。

- [ ] **Step 1: 更新三份文档。** README「学习计划」一节加「两个人各用各的」：固定两位成员可改名、计划选所属人、页面顶部切换、选择记在本机、不是权限隔离。结构框架：数据库表清单加 `study_members` 和 `study_plans.member_id`，§7.9 接口表补成员接口和 `member` 参数，§9.5 补一句。验收清单「学习计划」一节加：切换成员只显示各自的计划；改名后显示更新；新建计划选所属人；把计划转给对方后各自视图正确；刷新后仍记住上次选的人；旧数据归第一位成员。

- [ ] **Step 2: 校对与提交**

  Run: `grep -n "api/study" server.js docs/结构框架.md`
  Expected: 两处列出的路径一一对应。

```bash
git add README.md docs/结构框架.md 验收清单.md
git commit -m "docs: 学习计划成员功能的说明、结构和验收项"
```
