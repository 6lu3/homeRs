# 每周工作：待办单独成清单、每天可直接添加删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「每周工作」里的待办移成单独的清单（可选日期、可查「还没做」），记录页每一天能直接添加、删除；周报按新规则生成；旧待办自动迁移。

**Architecture:** 新表 `work_todos`，建表和迁移放进可离线测试的 `lib/work-db.js`（`server.js` 只调用它）；`lib/work.js` 的 `buildReport` 改签名；`server.js` 加 `/api/work/todos` 并收紧记录接口；前端先改记录页（每天 ＋ / ×），再加「待办」标签。

**Tech Stack:** Node ≥ 22 + `node:sqlite`，原生 JS，零第三方依赖。

**Spec:** `docs/superpowers/specs/2026-11-28-work-todos-design.md`（接口、界面、规则以它为准；原功能见 `2026-11-27-work-log-design.md`，未提及处保持原样）

## Global Constraints

- 零第三方依赖；错误统一 `{error: "中文提示"}` + `HttpError`；日期一律 `YYYY-MM-DD`，校验用 `study.isDate`（`server.js` 里已有 `workDate`）。
- 文案固定：「待办不存在」「filter 无效」「done 应为 true 或 false」，其余沿用已有的「人员不存在」「内容不能为空」「内容最长 200 字」「类型无效」「日期格式应为 YYYY-MM-DD」。
- 待办 `text` 去首尾空白后非空、最长 200 字（复用 `workText`）；`due_date` 空串表示没选日期；`done_date` 未完成时恒为空串。
- 迁移必须：单个事务、可重复执行、执行后 `work_entries` 里没有 `kind='todo'`、已完成的待办 `done_date` = 原 `date`。
- 不启动测试服务器或浏览器；冒烟测试只写不跑；前端靠 `node --check`；每个任务结束前对改动过的 JS 文件跑 `node --check`。
- 前端：所有拼进 `innerHTML` 的用户文本必须经 `esc()`；翻页 / 切换人员 / 切换标签时旧请求回包用 seq 丢弃；新增 CSS 类名**不要**与学习计划的 `.study-tab` / `.study-tabs` 重名（`app.js` 里有按这些类名绑定的点击处理，会被劫持）。
- 不做：待办语音、优先级、重复、提醒、数量角标、手动改完成日期。

## Review Focus

- 迁移：重复启动不再改动任何数据；其他人员的待办保留各自归属；已完成待办的完成日期 = 原日期；`kind='done'` 的记录原样保留；全新库（没有旧表）不报错且只预置一个人员。
- 旧页面兼容：`POST /api/work/entries`（含 `batch`、`PUT`）传 `kind: 'todo'` 必须 400「类型无效」且**什么都没写入**。
- 周报：完成的待办按 `done_date` 落在对应日子（周日 / 周一边界）；取消勾选后从周报消失；下周计划含没日期的（排最后）和已过期的；本周没有记录也没有完成的待办时不生成。
- 待办接口：`done` 变 true 缺省取服务器本地日期、变 false 清空 `done_date`；`due_date` 传 `''` 清除而不传则不变；`filter` / `person` 非法 400 而不是 500；「已完成」最多 200 条；撤销式重建（`POST` 带 `done`+`done_date`）原样恢复。
- 前端：每天行内输入记到**那一天**而不是顶部的「记到」；重绘后行内输入框保持展开并保留未提交的文字；撤销删除记录 / 待办恢复到原日期和原完成状态；切标签、切人员后没有上一个人 / 上一个标签的残留内容；「挪到下周」用「原日期和今天较晚者」。

---

### Task 1: 周报新签名、待办表与迁移（纯逻辑，离线测试）

**Files:**
- Modify: `lib/work.js`（只改 `buildReport`）
- Create: `lib/work-db.js`
- Modify: `test/work.test.js`（替换 `buildReport` 相关用例）
- Create: `test/work-db.test.js`
- Modify: `package.json`（`test` 脚本里在 `node test/work.test.js` 之后加 `&& node test/work-db.test.js`）

**Interfaces:**
- Consumes: `lib/menu.js` 的 `addDays`；`node:sqlite` 的 `DatabaseSync`（测试用 `new DatabaseSync(':memory:')`）。
- Produces:
  - `buildReport({ start: string, entries: {date,text}[], doneTodos: {date,text}[], openTodos: {due_date,text}[] }): { text: string, empty: boolean }`
    - `entries` 是本周记录（按 id 顺序）；`doneTodos` 是**本周完成**的待办，`date` 为其完成日期（按 id 顺序）；`openTodos` 是**全部**未完成待办，`due_date` 空串表示没选日期（按 id 顺序）。
    - `entries` 与 `doneTodos` 都为空 ⇒ `{ text: '', empty: true }`（不管有没有 `openTodos`）。
    - 「做了什么」每天先列记录再列完成的待办；没内容的日子省略。「下周计划」= `openTodos`：`due_date` 非空者按日期升序（同日保持输入顺序）在前，空者按输入顺序在后；没有则整节省略。文字格式与现在完全相同（标题 `本周工作（M/D – M/D）`，`U+2013`，星期名，`- ` 前缀，`\n` 连接，末尾无换行）。
  - `initWorkSchema(db: DatabaseSync): void` — `CREATE TABLE IF NOT EXISTS`：`work_people(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0)`；`work_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES work_people(id) ON DELETE CASCADE, date TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`（与现有定义一致）；`work_todos(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES work_people(id) ON DELETE CASCADE, text TEXT NOT NULL, due_date TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, done_date TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`；索引 `idx_work_entries_person_date ON work_entries(person_id, date)` 与 `idx_work_todos_person_done ON work_todos(person_id, done)`；`work_people` 为空时插入一行「我」(sort 0)；最后调用 `migrateTodos`。
  - `migrateTodos(db: DatabaseSync): number` — 返回迁移的行数；规则见 Global Constraints，一个事务，失败回滚并抛出。

- [ ] **Step 1: 改 `test/work.test.js`（先写失败的测试）。** 保留 `splitSpoken`、`nextMonday` 的用例，删掉旧的 `buildReport` 用例，换成（沿用文件里的 `check` / `eq`）：
  - 完整示例逐字比较：`start='2026-11-23'`；`entries`：周一「对接 A 项目接口」、周二「修了登录 bug」「开周会」；`doneTodos`：周二「写方案」；`openTodos`：`{due_date:'2026-11-27', text:'整理测试报告'}`、`{due_date:'', text:'联系供应商'}`。期望文字行依次为：`本周工作（11/23 – 11/29）`、`周一`、`- 对接 A 项目接口`、`周二`、`- 修了登录 bug`、`- 开周会`、`- 写方案`、`下周计划`、`- 整理测试报告`、`- 联系供应商`。
  - `entries` 和 `doneTodos` 都空、`openTodos` 非空 ⇒ `{text:'',empty:true}`。
  - 只有 `doneTodos`（没有记录）⇒ 正常生成，该日下只有待办一行。
  - `openTodos` 排序：输入 `[{'2026-12-02','c'},{'','u1'},{'2026-11-30','b'},{'2026-11-30','b2'},{'','u2'},{'2026-11-20','过期'}]` ⇒ 顺序 `过期, b, b2, c, u1, u2`。
  - `openTodos` 为空 ⇒ 文字里没有「下周计划」。
  - 同一天内先记录后完成的待办；周日（`2026-11-29`）正确显示「周日」。
  - 跨月标题 `本周工作（11/30 – 12/6）`、跨年 `本周工作（12/28 – 1/3）`。

- [ ] **Step 2: 写 `test/work-db.test.js`（先写失败的测试）。** 用 `require('node:sqlite').DatabaseSync(':memory:')`，打印风格同 `test/work.test.js`，有失败时 `process.exit(1)`。用例：
  - **迁移**：先手工建**旧结构**的 `work_people`、`work_entries`（DDL 同上），插入：人员 1「我」、人员 2「乙」；人员 1 的记录：`done` 记录（`2032-03-02`，text「修了bug」）、未完成待办（`2032-03-04`「写方案」done=0）、已完成待办（`2032-03-05`「评审」done=1）；人员 2 的未完成待办（`2032-03-06`「乙的事」）。调用 `initWorkSchema(db)` 后断言：`work_todos` 共 3 行；「写方案」`due_date='2032-03-04'`、`done=0`、`done_date=''`；「评审」`due_date='2032-03-05'`、`done=1`、`done_date='2032-03-05'`；「乙的事」归人员 2；`work_entries` 只剩 1 行（那条 `done` 记录）且没有 `kind='todo'`；`created_at` 被保留。
  - **幂等**：再调一次 `initWorkSchema(db)`，`work_todos` 与 `work_entries` 行数不变、内容不变，`migrateTodos(db)` 返回 0。
  - **全新库**：空的内存库调用 `initWorkSchema` 不抛错，`work_people` 恰有 1 行「我」，`work_todos` 为空；再调一次，`work_people` 仍是 1 行。
  - **回滚**：用 `db.exec('DROP TABLE work_todos')` 之后再让 `migrateTodos` 在有 `kind='todo'` 的旧数据上执行（表不存在会抛错），断言抛出且 `work_entries` 里的待办**没有被删**。

- [ ] **Step 3: 运行确认失败**

Run: `node test/work.test.js`；`node test/work-db.test.js`
Expected: 第一个因 `buildReport` 新用例失败；第二个报 `Cannot find module '../lib/work-db'`。

- [ ] **Step 4: 实现 `buildReport`（`lib/work.js`）和 `lib/work-db.js`**（文件头注释写明 `work-db.js` 只依赖传入的 `db`、不 `require` 任何 I/O 之外的东西；迁移用 `BEGIN` / `COMMIT` / `ROLLBACK`，先 `INSERT … SELECT` 再 `DELETE`）。`nextMonday`、`splitSpoken` 保持不变并继续导出。

- [ ] **Step 5: 运行确认通过，并加进 `package.json`**

Run: `node test/work.test.js && node test/work-db.test.js`
Expected: 全部 `ok`，退出码 0。

- [ ] **Step 6: 提交**

```bash
git add lib/work.js lib/work-db.js test/work.test.js test/work-db.test.js package.json
git commit -m "feat(work): 周报新规则、待办表与可离线测试的迁移"
```

---

### Task 2: 服务端接口与冒烟检查

**Files:**
- Modify: `server.js`（用 `initWorkSchema` 替换每周工作建表块；改记录接口；新增待办接口；改周报接口）
- Modify: `test/smoke.js`（每周工作块）

**Interfaces:**
- Consumes: Task 1 的 `initWorkSchema(db)`、`buildReport`；`server.js` 里已有的 `workDate`、`workText`、`workPersonId`、`workWeekStart`、`workEntryRow`、`route`、`HttpError`、`readJson`、`json`、`localDate`（`provider-guard`，学习计划段已引入）、`menu.addDays`。
- Produces（HTTP，均需登录；形状以设计文档「接口」一节为准）：
  - 记录：`GET /api/work/week` 每条返回 `{id, date, text}`；`POST /api/work/entries`、`POST /api/work/entries/batch`、`PUT /api/work/entries/:id` 的 `kind` 可省略（默认 `done`），给了必须是 `done` 否则 400「类型无效」，且校验在写入之前；`PUT` 不再接受 `done`（忽略）；`workEntryRow` 返回 `{id, person_id, date, text}`；写入时 `kind` 一律存 `'done'`。
  - 待办：`GET /api/work/todos?person=&filter=open|done|all`、`POST /api/work/todos`、`PUT /api/work/todos/:id`、`DELETE /api/work/todos/:id`。返回的每条待办为 `{id, text, due_date, done: boolean, done_date}`（`POST` / `PUT` 另含 `person_id`）。排序、上限、校验、`done_date` 规则完全按设计文档；`POST` 的 `due_date` 不传或 `''` 表示没选日期，`done:true` 时 `done_date` 缺省取 `localDate()`，`done:false` 时 `done_date` 强制 `''`；`PUT` 里 `due_date: ''` 清除日期、不传则不变，`done` 必须布尔，`done` 变 true 且未给 `done_date` 时：原本已完成则保持原 `done_date`，否则取 `localDate()`；`done` 变 false 时清空；`done_date` 只在同时 `done:true` 时才被采用。
  - `GET /api/work/report?start=&person=`：`entries` = 本周记录 `{date,text}`（`date,id` 序）；`doneTodos` = 该人 `done=1` 且 `done_date` 在本周内的待办 `{date: done_date, text}`（`done_date,id` 序）；`openTodos` = 该人全部 `done=0` 的待办 `{due_date,text}`（`id` 序）；交给 `buildReport`。

- [ ] **Step 1: 先改 `test/smoke.js` 的每周工作块**（沿用 `json` / `call` / `assert`；日期仍用 2032 年；仍用 `try/finally` 清理，`created` 拆成 `createdEntries`、`createdTodos` 两个数组，清理时记录用 `POST /api/work/entries/delete`（每批 ≤ 20，先 `.filter(Number.isInteger)`）、待办逐条 `DELETE /api/work/todos/:id`；每次新建后先断言 `status === 200` 再 push；不要删除任何真实 id）。把依赖旧待办的断言替换，**保留**人员、`person` 缺失 / 非法、新增校验（空内容、超长、非法日期、人员不存在）、批量、撤销（`entries/delete` 用 `2000000000+i` 这类不存在的 id 测 21 个上限）、隔离、删除 404 等不涉及待办的断言。新增 / 改写：
  - 记录：`POST /api/work/entries` 传 `kind:'todo'` ⇒ 400「类型无效」，之后 `week` 里没有该文字（确认什么都没写）；`batch` 传 `kind:'todo'` 同样 400 且没有写入；不传 `kind` 成功，返回体含 `id`、`date`、`text`；`week` 里每条形如 `{id,date,text}`；`PUT` 改文字 / 改日期（旧周消失、新周出现）；`PUT` 带 `kind:'todo'` ⇒ 400。
  - 待办新建：有日期、没日期（不传 `due_date`）、`due_date:''` 三种；空内容 400、超长 400、`due_date:'2032-02-30'` 400、`person_id` 不存在 400。
  - 待办列表：`person` 缺失 / `abc` / `999999` 各 400「人员不存在」；`filter=bad` 400「filter 无效」；`filter=open`（默认）排序为有日期的按日期升序、没日期的在后；勾选后它从 `open` 消失、出现在 `done`，`done_date` 等于请求里给的日期；不给 `done_date` 勾选时 `done_date` 是 `YYYY-MM-DD` 格式；`all` 先未完成后已完成。
  - 待办修改：改文字、改日期、`due_date:''` 清除日期、`done:'true'` 400、取消勾选后 `done_date===''`、不存在 404「待办不存在」；已完成的待办再次 `PUT {done:true}`（不带 `done_date`）`done_date` 保持不变。
  - 撤销式重建：`POST /api/work/todos` 带 `{done:true, done_date:'2032-03-03', due_date:'2032-03-01', text}` 后读回与传入一致；带 `done:false, done_date:'2032-03-03'` 时读回 `done_date===''`。
  - 隔离：给「冒烟人员」建一条待办，第一位人员的 `todos` 不含它。
  - 周报：构造「本周有记录 + 本周完成的待办（`done_date` 在本周）+ 本周之外完成的待办 + 有日期的未完成待办 + 没日期的未完成待办」，断言：完成的待办出现在 `done_date` 那天下、本周之外完成的不出现、下周计划里含两条未完成待办且有日期的在没日期的前面；取消勾选那条后它从周报「做了什么」里消失；一周只有未完成待办、没有记录和完成待办时 `empty` 为 true 且 `text` 为空。
  - 删除待办后再 `PUT` / `DELETE` 都 404。
  - Run: `node --check test/smoke.js` — Expected: 无输出。

- [ ] **Step 2: 实现服务端。** 用 `require('./lib/work-db').initWorkSchema(db)` 替换现有每周工作建表块和默认人员预置（删掉原来的 `db.exec(...)` 与 `if (!db.prepare('SELECT 1 FROM work_people…` 两段）。记录接口按上面的契约改；`workKind` 改为「省略 → `'done'`，`'done'` → `'done'`，其他 → 400 类型无效」；新增待办路由，风格沿用现有的小函数 + `HttpError`（`workDueDate(v)`：`undefined` 或 `''` ⇒ `''`，否则必须是真实日期；`workTodoRow(id)`）；周报接口按契约取三组数据。

- [ ] **Step 3: 检查**

Run: `node --check server.js && node test/work.test.js && node test/work-db.test.js`
Expected: 无语法错误；测试全部 `ok`。

- [ ] **Step 4: 提交**

```bash
git add server.js test/smoke.js
git commit -m "feat(work): 待办接口、记录接口收紧、周报按新规则，补冒烟检查"
```

---

### Task 3: 记录页——每天直接添加、删除，去掉「已做/待办」开关

**Files:**
- Modify: `public/index.html`（`#wk-form` 去掉 `.wk-kinds`；`#work-editor` 去掉「类型」一行）
- Modify: `public/app.js`（「每周工作」一节）
- Modify: `public/style.css`

**Interfaces:**
- Consumes: Task 2 的记录接口（`GET /api/work/week` 返回 `{id,date,text}`；`POST /api/work/entries {person_id,date,text}`；`DELETE /api/work/entries/:id`）；`app.js` 已有的 `api`、`postJson`、`toast(msg, ms, {label,onClick})`、`esc`、`askConfirm`、`todayStr`、`addDaysStr`、`mondayOf`、`mdLabel`、`WEEKDAYS`、`parseLocalDate`、`$` / `$$`，以及本节已有的 `work` 状态、`loadWorkWeek`、`renderWorkWeek`、`workEntryHtml`、`findWorkEntry`、`addWorkEntries`、`openWorkEditor`、`renderWorkHead`、`switchWorkPerson`、`enterWork`。
- Produces: 状态字段 `work.addDate`（`string | null`，当前展开行内输入的那天）；删除 `work.kind`；`asr.snap` 变为 `{person, date}`（不再含 `kind`）；`addWorkEntries(text, note, snap)` 的请求体不再带 `kind`。

- [ ] **Step 1: 改 HTML。** `#wk-form` 里删掉 `<span class="wk-kinds">…</span>`；`#work-editor` 里删掉含 `#we-kind` 的 `<label>类型…</label>`。

- [ ] **Step 2: 改 JS。**
  - 删除 `work.kind` 字段、`.wk-kind` 点击处理；所有 `POST /api/work/entries` / `batch` 请求体里去掉 `kind`；`asr.snap` 只留 `{ person, date }`，`addWorkEntries` 里相应去掉 `kind`；记录编辑弹层提交体只带 `text`、`date`。
  - `workEntryHtml`：只剩「圆点 + 文字按钮（点开编辑，`data-act="edit"`）+ 「×」删除按钮（`data-act="del"`，`aria-label` 含记录文字且经 `esc`）」，去掉待办 / 勾选 / 「挪到下周」分支；`#wk-body` 的点击处理里删掉 `check` / `next`，新增 `del`、`day-add`。
  - 每一天的标题行改成一个容器：左边仍是原来的标题按钮（点它改「记到」），右边是「＋」按钮（`data-act="day-add" data-date`，不要把按钮嵌套进按钮）。
  - 点「＋」：若该天已展开则收起（`work.addDate = null`），否则展开并聚焦；同一时间只展开一天。展开的那天在记录列表下方渲染一个 `<form class="wk-day-add" data-date="…">`：文本框（`maxlength="200"`，`placeholder="在这一天记一条…"`）+ 「记」按钮。提交（在 `#wk-body` 上做事件委托）：`POST /api/work/entries {person_id, date: form.dataset.date, text}`；成功后**保持展开**、清空并聚焦、重新加载本周；空文字不提交；复用 `work.adding` 防重复；失败 `toast`。重绘时（`renderWorkWeek`）保留展开状态、聚焦并恢复该输入框里尚未提交的文字。翻周 / 回到本周 / 切换人员 / 重新进入页面时把 `work.addDate` 置 `null`。
  - 点「×」：先 `DELETE /api/work/entries/:id`，成功后重新加载本周并 `toast('已删除', 7000, {label:'撤销', onClick})`，`onClick` 用被删记录当时的 `date`、`text` 和**当时的人员**重新 `POST /api/work/entries`，仅当当前人员仍是那个人时才刷新本周，失败 `toast` 错误。找不到该记录（数据已过期）时 `toast('这条记录已经不存在了')` 并刷新。编辑弹层里的「删除」保持原有（带确认）。

- [ ] **Step 3: 样式。** 标题行容器 flex（标题按钮占满、「＋」固定宽、触控区域 ≥ 40px）；「×」按钮、行内输入行的样式沿用现有变量，窄屏不得横向溢出；宽屏沿用现有的居中规则。

- [ ] **Step 4: 检查**

Run: `node --check public/app.js`
Expected: 无输出。再 `grep -n "work\.kind\|wk-kind\|we-kind\|kind:" public/app.js public/index.html` — Expected: 每周工作一节里不再有这些（`kind:` 若出现在其他功能里不算）。

- [ ] **Step 5: 提交**

```bash
git add public
git commit -m "feat(work): 记录页每天可直接添加、一键删除（带撤销），去掉已做/待办开关"
```

---

### Task 4: 「待办」标签与清单

**Files:**
- Modify: `public/index.html`（新增标签栏、把记录页的元素包进 `#wk-records`、新增 `#wk-todos` 面板和 `#todo-editor` 弹层）
- Modify: `public/app.js`（「每周工作」一节）
- Modify: `public/style.css`

**Interfaces:**
- Consumes: Task 2 的待办接口；Task 3 之后的 `work` 状态和函数（`enterWork`、`switchWorkPerson`、`loadWorkWeek`、`renderWorkPeople`）；`app.js` 已有的 `api`、`postJson`、`toast`、`esc`、`askConfirm`、`todayStr`、`addDaysStr`、`mondayOf`、`mdLabel`、`$` / `$$`。
- Produces: `work.tab`（`'records' | 'todos'`，进入页面时重置为 `'records'`）、`work.todoFilter`（`'open' | 'done' | 'all'`，默认 `'open'`）、`work.todos`、`work.todoSeq`；函数 `showWorkTab(tab)`、`loadWorkTodos()`、`renderWorkTodos()`；标签按钮用类名 `.wk-tab` / `.wk-tabs`（**不要**用 `.study-tab`）。

- [ ] **Step 1: 骨架。** 在 `#work-people` 之后加标签栏 `<div class="wk-tabs">` 两个按钮（`data-wtab="records"` 文字「记录」，`data-wtab="todos"` 文字「待办」，默认记录为 `active`）；把 `#wk-prev` 所在的 `.menu-nav`、`#wk-target`、`#wk-form`、`#wk-body`、含「生成周报」的 `.pad` 一起包进 `<div id="wk-records">`（保持各自 id 和顺序不变）。新增 `<div id="wk-todos" class="hidden">`：过滤按钮组（`data-filter="open|done|all"`，文字「还没做 / 已完成 / 全部」）、添加表单 `#td-form`（文本框 `#td-text` `maxlength="200"` `placeholder="添加待办…"`、日期 `#td-due` `type="date"`、提交按钮「添加」）、列表容器 `#td-body`。新增弹层 `#todo-editor`（沿用 `#work-editor` 的结构）：`#td-edit-text`、`#td-edit-due`（`type="date"`）、`#td-clear-due`（「清除日期」按钮）、`#td-edit-err`、取消 / 保存（`#td-edit-save`）、删除（`#td-edit-del`）。

- [ ] **Step 2: 标签与加载。** `showWorkTab(tab)`：切换两个面板和标签高亮、记下 `work.tab`；`'records'` 时若已有周数据就不重复请求，`'todos'` 时调用 `loadWorkTodos()`。`enterWork` 里重置为记录标签；`switchWorkPerson` 在待办标签时重载待办（并作废在途请求、先清空列表）。`loadWorkTodos()`：`GET /api/work/todos?person=<id>&filter=<work.todoFilter>`，用 `work.todoSeq` 丢弃过期回包，失败时清空列表并显示「加载失败」文字 + `toast`。人员未加载（`work.person == null`）时不请求。

- [ ] **Step 3: 渲染与操作。**
  - 每行：圆圈勾选（40px 触控区）、文字（点开编辑）、日期标签（有日期显示 `M/D`，没有显示「没选日期」；没完成且 `due_date < todayStr()` 时显示「M/D 已过期」并用橙色）、已完成显示「完成于 M/D」、未完成且有日期的行有「挪到下周」按钮、每行有「×」。已完成行变淡并带删除线。空列表显示提示文字（「还没有待办」「没有没做完的待办」等按过滤区分）。全部文本经 `esc`。
  - 添加：`POST /api/work/todos {person_id, text, due_date: #td-due 的值 || ''}`；成功后清空文字和日期、聚焦文字框、重载；若当前过滤是「已完成」则切回「还没做」；空文字不提交；`work.todoAdding` 防重复。
  - 勾选 / 取消：`PUT /api/work/todos/:id {done: !done, done_date: todayStr()}`（取消时不带 `done_date`）；失败 `toast` 并恢复按钮。
  - 挪到下周：新日期 = `addDaysStr(mondayOf(max(due_date, todayStr())), 7)`（日期字符串直接比较大小）；`PUT {due_date}`；成功 `toast('已挪到下周一')`。
  - 删除「×」：`DELETE` 成功后重载并 `toast('已删除', 7000, {label:'撤销', onClick})`，`onClick` 用被删待办当时的 `text`、`due_date`、`done`、`done_date` 和当时的人员 `POST /api/work/todos` 原样恢复（仅当前人员仍是那个人时才刷新列表）。
  - 编辑弹层：打开时填入文字和日期；「清除日期」把日期框清空；保存发 `PUT {text, due_date}`（日期框为空发 `''`），保存期间禁用保存 / 删除并禁止关闭（沿用记录编辑弹层的 `saving` 标志做法，错误显示在弹层里）；删除带 `askConfirm`；找不到对象时 `toast` 并刷新。
  - 找不到点击的待办（数据已过期）统一：`toast('这条待办已经不存在了')` 并重载。

- [ ] **Step 4: 样式。** 标签栏沿用 `.study-tab` 的外观但用 `.wk-tab` / `.wk-tabs` 类名；过滤按钮组、添加表单（窄屏文本框一行、日期和按钮一行，不横向溢出）、待办行、过期橙色、完成态；宽屏居中规则并入现有的 `#view-work > …` 选择器（`#wk-records`、`#wk-todos` 与标签栏同宽居中）。

- [ ] **Step 5: 检查**

Run: `node --check public/app.js`
Expected: 无输出。再 `grep -n "wk-tabs\|data-wtab\|wk-todos\|todo-editor\|work.todoFilter" public/index.html public/app.js` 确认骨架、标签、编辑弹层、状态都已接上；`grep -n "study-tab" public/index.html` 确认没有给新标签误用该类。

- [ ] **Step 6: 提交**

```bash
git add public
git commit -m "feat(work): 待办标签——可选日期、还没做/已完成/全部、勾选、挪到下周、撤销删除"
```

---

### Task 5: 文档

**Files:**
- Modify: `README.md`（「每周工作」一节）、`docs/结构框架.md`（数据库表、7.10 接口、模块表、9.6 数据流、测试表、前端分区、目录树）、`验收清单.md`（「每周工作」一节）

**Interfaces:** 无新增代码接口；内容必须与 Task 1–4 的实际实现一致（接口路径、字段、错误文案以 `server.js` 为准）。

- [ ] **Step 1: 更新三份文档。** README：改写「待办」「生成周报」相关说明——两个标签、待办可选日期 / 还没做 / 已完成 / 全部、每天「＋」直接记、「×」一键删除带撤销、周报新规则（做了什么 = 本周记录 + 本周完成的待办按完成日；下周计划 = 全部没做完的待办，没日期的排最后；本周没有「做了什么」不生成）、旧待办自动迁移、顶部输入框和语音只记「已做」。结构框架：新增 `work_todos` 表和 `lib/work-db.js`（建表 + 迁移，离线测试）、`work_entries` 不再有待办、7.10 补待办接口并改记录接口说明（`kind` 只接受 `done`、`week` 返回 `{id,date,text}`）、周报说明、9.6 数据流、测试表加 `work-db.test.js`、前端分区加待办标签与每天行内添加。验收清单：删掉「待办勾选与挪到下周」旧条目，换成新的——标签切换、待办添加（有 / 没日期）、还没做 / 已完成 / 全部、过期标橙、勾选与取消、挪到下周、编辑与清除日期、一键删除与撤销（记录和待办）、每天「＋」记到那一天、周报含完成的待办与下周计划（含没日期的）、升级后旧待办还在、手机和宽屏排版。

- [ ] **Step 2: 校对**

Run: `grep -n "api/work" server.js docs/结构框架.md`
Expected: 两处列出的路径一一对应（含新增的 `/api/work/todos*`）；`grep -n "work-db" package.json docs/结构框架.md` 确认测试脚本和文档都有。

- [ ] **Step 3: 提交**

```bash
git add README.md docs/结构框架.md 验收清单.md
git commit -m "docs: 每周工作的待办清单、每天添加删除和新周报规则"
```
