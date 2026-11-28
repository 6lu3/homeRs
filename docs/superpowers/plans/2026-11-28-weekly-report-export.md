# 正式周报导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「每周工作」页增加「整理成正式周报」：把本周记录和待办交给 AI 整理成草稿，用户预览修改后，套用用户上传的公司 Word 模板导出 `.docx`；日期按大小周规则由程序计算。

**Architecture:** 全部纯逻辑放 `lib/`（`zip` 读写 → `report-docx` 解析和填充模板 → `report-dates` 大小周日期 → `report-ai` 配置 / 提示词 / 草稿校验 → `report-store` 文件存储 → `report-service` 调 AI），每个都能用假数据离线测试；`server.js` 只做接线；前端在设置页加一节、在每周工作页加按钮和两个弹层。

**Tech Stack:** Node ≥ 22（`node:zlib`、`node:crypto`），原生 JS，零第三方依赖。

**Spec:** `docs/superpowers/specs/2026-11-28-weekly-report-export-design.md`（接口、规则、文案以它为准；它写的 `test/report.test.js` 在本计划里拆成 `report-dates.test.js` 和 `report-ai.test.js`，覆盖内容不变）

## Global Constraints

- 零第三方依赖；错误统一 `{error: "中文提示"}` + `HttpError`；服务类错误用 `ServiceError` 子类，在路由里转成 `HttpError`（沿用 `receipt` 的写法）。
- **仓库、测试、文档里不得出现用户真实周报的内容**（公司项目名、客户名、姓名）。测试用的 docx 由测试代码现场构造，姓名用「测试员」之类的假名。用户的真实文件在 `C:\Users\Admin\Desktop\1\`，只允许在 Task 2 的「真实模板核对」那一步**只读**使用，输出只能写到 `D:\tmp\stubs\`，**绝不复制进仓库、绝不提交**。
- 模板、示例、用量、设置只存 `data/report/`（`data/` 已在 `.gitignore`）。日志里不得出现提示词内容、周报内容、key；错误提示固定为中文，不回显服务端响应原文。
- 上传限制：模板和示例 docx 各 ≤ 5 MB；zip 解压后总大小 ≤ 30 MB、条目 ≤ 200。
- 日期格式：展示用 `YYYY.M.D`（月日不补零），内部用 `YYYY-MM-DD`；「今天」一律用浏览器传来的日期，不用服务器日期；周起点复用 `lib/menu.js` 的 `weekStart` / `addDays`。
- 不启动测试服务器或浏览器；冒烟测试只写不跑；前端只做 `node --check`。**无法在真实 Word 里验证**，所以 Task 2 要用真实模板产出一份样例给用户用 Word 打开确认。
- 文案固定：「不是有效的 docx 文件」「模板结构不认识：找不到「…」」「请先在设置里上传周报模板」「内容在预览之后有变化，请重新预览」「这一周还没有记录」「AI 返回了无法理解的内容，请重试」「周报配置不完整，缺少：…」。
- 每个任务结束前，对改动过的 JS 文件跑 `node --check`；纯逻辑任务要跑它自己的测试文件，并把测试加进 `package.json` 的 `test` 脚本（紧跟在 `node test/work-db.test.js` 之后）。

## Review Focus

- **docx 输出能被 Word 打开**：zip 结构合法（CRC、UTF-8 文件名标志、没有目录条目也能开）、`[Content_Types].xml` 排第一且原样保留、`document.xml` 标签配对、克隆行去掉了重复的 `w14:paraId`、新增的 `<w:num>` 放在 `numbering.xml` 末尾且带 `startOverride`、行高 `exact` 改成 `atLeast`。
- **模板识别**：关键字找不到、单元格数不是 3、`gridSpan` 不是 1/3/2、样板内容格没有「标题段 + 编号细节段」、签名行找不到日期、有多张表——都要在**上传时**以固定文案拒绝，而不是填充时才崩。
- **大小周日期**：周六 ⇒ 单休 ⇒ 下周计划一到五；周五 ⇒ 双休 ⇒ 一到六；其他日子 / `today` 不在该周内 ⇒ 按与基准周的奇偶；手动指定 `kind` 优先；跨月、跨年；文件名与计划日期一致。
- **key 不外泄**：周报单独配了 `url` 时绝不沿用图片识别的 key；任何错误信息、日志、接口响应里都没有 key 和提示词。
- **发送内容 = 预览内容**：`hash` 不一致返回 409 且**没有调用 AI**；`generate` 不接受前端传来的提示词。
- **上传与存储**：非 zip、超大、压缩炸弹、损坏 CRC、加密条目都被拒绝；示例 id 只接受纯数字，不能拼出路径；文件写入先写临时文件再改名，损坏的示例文件被跳过而不是让接口 500。
- **前端**：AI 返回的文字只通过 `.value` / `.textContent` 进入页面；弹层打开期间重复点击不会重复发送或重复导出；导出失败时错误显示在弹层里、弹层不关闭；`hash` 409 时回到预览；下载文件名取自响应头，取不到时用草稿里的文件名。

---

### Task 1: zip 读写 `lib/zip.js`

**Files:**
- Create: `lib/zip.js`
- Create: `test/zip.test.js`
- Modify: `package.json`（加 `node test/zip.test.js`）

**Interfaces:**
- Produces（`module.exports`）：
  - `crc32(buf: Buffer): number` — 无符号 32 位，自己实现（查表），不用 `zlib.crc32`。
  - `readZip(buf: Buffer, opts?: { maxEntries?: number /*默认200*/, maxTotal?: number /*默认30*1024*1024*/ }): Map<string, Buffer>` — 按中央目录顺序返回；目录条目（名字以 `/` 结尾）跳过；支持压缩方法 0 和 8；逐条校验 CRC，不符抛 `Error('压缩包已损坏')`；找不到结尾记录 / 魔数不对抛 `Error('不是有效的压缩包')`；加密条目（通用标志位 bit0）抛 `Error('不支持加密的压缩包')`；zip64 抛 `Error('不支持 zip64')`；条目数超限抛 `Error('压缩包条目过多')`；累计解压大小超限抛 `Error('压缩包解压后过大')`（解压时用 `zlib.inflateRawSync(data, { maxOutputLength })` 防炸弹，把 zlib 的超限错误转成这条）。文件名按 UTF-8 解码（标志位 bit11 置位时一定是 UTF-8，没置位也按 UTF-8 处理）。
  - `writeZip(entries: Map<string, Buffer> | Array<[string, Buffer]>): Buffer` — 按给定顺序写；方法 8（deflate），压缩后更大就改用方法 0；CRC 自己算；通用标志位置 bit11（UTF-8 文件名）；不使用数据描述符；`version needed` 为 20；时间戳固定为 `1980-01-01 00:00`（输出可重复）；写中央目录和结尾记录。

- [ ] **Step 1: 写失败的测试 `test/zip.test.js`**（沿用 `test/work.test.js` 的 `check` / `eq` / `throws` 写法，结尾打印通过数并在有失败时 `process.exit(1)`）。用例：
  - `crc32`：空 buffer 为 `0`；`Buffer.from('123456789')` 为 `0xCBF43926`；与 `zlib.crc32`（若存在）一致可不测。
  - 往返：多个条目（含中文文件名 `word/文档.xml`、空内容、可压缩的长文本、不可压缩的随机字节）`writeZip` → `readZip` 内容和**顺序**都一致。
  - 输出对标准读取器友好：`writeZip` 的结果前 4 字节是 `50 4B 03 04`；结尾记录签名 `50 4B 05 06` 在末尾 22 字节处；每个本地头的标志位 bit11 为 1。
  - 目录条目：手工构造一个含 `a/` 目录条目的 zip（用 `writeZip` 写一个名字以 `/` 结尾的空条目即可），`readZip` 结果里没有它。
  - 错误：非 zip 的随机字节 / 空 buffer ⇒ `不是有效的压缩包`；改坏某个条目的数据字节 ⇒ `压缩包已损坏`；条目数超过 `maxEntries`（传 `{maxEntries: 2}` 写 3 个）⇒ `压缩包条目过多`；`maxTotal` 传 100 而内容更大 ⇒ `压缩包解压后过大`；一个 1 MiB 全零的条目压缩后很小，`maxTotal` 传 1000 时同样 ⇒ `压缩包解压后过大`（炸弹）；手工置位加密标志 ⇒ `不支持加密的压缩包`。
- [ ] **Step 2: 运行确认失败** — Run: `node test/zip.test.js`；Expected: 报 `Cannot find module '../lib/zip'`。
- [ ] **Step 3: 实现 `lib/zip.js`**（文件头注释写「无 I/O」）。
- [ ] **Step 4: 运行确认通过，并加进 `package.json`** — Run: `node test/zip.test.js`；Expected: 全部 `ok`，退出码 0。
- [ ] **Step 5: 提交**

```bash
git add lib/zip.js test/zip.test.js package.json
git commit -m "feat(report): 自带的 zip 读写（CRC、防压缩炸弹），供 docx 使用"
```

---

### Task 2: docx 解析与填充模板 `lib/report-docx.js`

**Files:**
- Create: `lib/report-docx.js`
- Create: `test/helpers/report-template.js`（测试用的合成模板生成器；**不含任何真实内容**）
- Create: `test/report-docx.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 的 `readZip` / `writeZip`。
- Produces（`lib/report-docx.js`）：
  - `extractText(docx: Buffer): string` — 取 `word/document.xml`；表格外的段落各占一行；表格每个**行**占一行，行内各单元格用 ` | ` 连接，单元格里的多个段落用 ` / ` 连接，空单元格和空段落省略；段落文字是该段所有 `<w:t>` 的拼接（解开 XML 实体）。不是有效 docx（不是 zip 或没有 `word/document.xml`）抛 `Error('不是有效的 docx 文件')`。
  - `checkTemplate(docx: Buffer): { name: string }` — 校验模板结构并返回抬头「姓名」右边那格的文字（没有则 `''`）。任何不满足都抛 `Error`，消息以 `模板结构不认识：` 开头，如 `模板结构不认识：找不到「工作内容」表头`。校验项（顺序即抛错优先级）：是合法 docx；恰好 1 张 `<w:tbl>`；能找到抬头「时间」格且它右边有一格；工作项表头行（同时含单元格文字「工作内容」「解决方案及结果」）；问题标题行（某单元格含「本周工作需协调解决的问题或者建议」）且其后有一行；计划表头行（含「工作计划」「日期」）；「部门经理批阅」行且其后有一行，且该行文字里含形如 `日期：2026.11.28`（冒号中英文均可，日期 `YYYY.M.D`）的片段；上述各行按这个先后顺序出现；工作项区（表头行与问题标题行之间）和计划区（计划表头行与批阅行之间）各**至少 1 行**；两个区的第一行各**恰好 3 个单元格**且 `gridSpan` 依次为 1 / 3 / 2（没写 `gridSpan` 视为 1）；工作项样板的内容格含「第一段（标题）」和「至少一个带 `<w:numPr>` 的段落」；若样板用了 `numId`，则 `word/numbering.xml` 必须存在且能找到该 `numId` 对应的 `<w:num>` 及其 `abstractNumId`。
  - `fillTemplate(docx: Buffer, data: { time: string, items: {title: string, lines: string[], progress: number}[], issues: string, plan: string[], planRange: string }): Buffer` — 先调用与 `checkTemplate` 相同的校验；再按设计文档「模板」一节填充：
    - 「时间」右边的格改成 `data.time`；签名行里 `日期：` 后面的日期改成 `data.time`（只改日期，其余文字原样）。
    - 工作项区：以第一行为样板，区内原有行全部丢弃，生成 `items.length` 行：第 1 格序号 `1..N`；第 2 格：标题段 + 每条 `lines` 一个细节段；第 3 格：`${progress}%`。每个工作项行的细节段用**它自己的新 `numId`**：在 `numbering.xml` 末尾（`</w:numbering>` 之前）追加 `<w:num w:numId="X"><w:abstractNumId w:val="A"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`，`X` 为现有最大 `numId` + 1 起递增，`A` 为样板所用 `numId` 的 `abstractNumId`。
    - 问题行：把该格重建为一个段落，文字为 `data.issues`（空白则「无」）。
    - 计划区：以第一行为样板，原有行全部丢弃，生成 `plan.length` 行（序号 `1..N`、计划文字、`data.planRange`）；`plan` 为空时保留**一行**，三格文字都为空。
    - 工作项行和计划行里的 `w:hRule="exact"` 一律改成 `w:hRule="atLeast"`。
    - 段落重建规则：保留样板段落的 `<w:pPr>…</w:pPr>`（标题段、细节段、序号段、各格各用各自的样板）和样板第一个 `<w:r>` 的 `<w:rPr>`，输出 `<w:p>` + pPr + `<w:r>` + rPr + `<w:t xml:space="preserve">转义后的文字</w:t></w:r></w:p>`（`<w:p>` 不带任何属性）。文字转义 `& < > " '`，去掉 XML 1.0 不允许的控制字符，换行替换成空格。克隆的行里去掉 `w14:paraId`、`w14:textId` 属性。
    - 输出 zip：保留所有非目录条目的原有顺序和内容，只替换 `word/document.xml` 和（有改动时）`word/numbering.xml`；`[Content_Types].xml` 等其余条目原样。
  - 错误统一为 `Error`（中文消息）；`data` 里的数量和长度**不在这里校验**（由 `report-ai.validateDraft` 负责）。
- Produces（`test/helpers/report-template.js`）：`buildTemplate(opts?: { name?: string /*默认'测试员'*/, workRows?: number /*默认3*/, planRows?: number /*默认3*/, omit?: 'time'|'workHeader'|'issueTitle'|'planHeader'|'approve'|'signDate'|'numbering'|'detailPara', extraTable?: boolean, badSpan?: boolean, fourCells?: boolean }): Buffer` — 现场构造一个与真实模板**结构相同**的 docx：6 列网格（`1168,1692,1692,1853,2054,2280`）、A4、页边距 567；表格顺序：标题段「工 作 周 报」→ 抬头行（部门｜值｜姓名｜值｜时间｜值）→ 「本周工作内容」跨 6 列 → 表头行（序号｜跨 3 列「工作内容」｜跨 2 列「解决方案及结果」）→ `workRows` 个工作项行（序号｜跨 3 列：1 个标题段 + 2 个带 `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="N"/></w:numPr>` 的细节段｜跨 2 列「100%」），`trHeight … hRule="exact"`，第 k 行用 `numId=k` → 问题标题行 → 问题行（跨 6 列，文字「无」）→ 计划表头行（序号｜跨 3 列「工作计划」｜跨 2 列「日期」）→ `planRows` 个计划行（序号｜跨 3 列文字｜跨 2 列日期）→ 「部门经理批阅」行 → 签名行（跨 6 列，三个段落，最后一个是「签名：某某   日期： 2026.1.1」）；每个段落一个 `<w:r>`，带 `<w:rPr>`（宋体）；部分段落、行带 `w14:paraId` 属性；`word/numbering.xml` 含 4 个 `<w:abstractNum>` 的十进制 `%1.` 列表和 `numId` 1–4 的 `<w:num>`；其余条目：`[Content_Types].xml`（排第一）、`_rels/.rels`、`word/_rels/document.xml.rels`。`omit` 等选项用来构造「缺了某一块」的坏模板。所有文字用假内容（「事项甲」「细节一」「计划一」之类）。

- [ ] **Step 1: 写生成器 `test/helpers/report-template.js`**（用 Task 1 的 `writeZip` 打包；文件头注明「合成数据，不含真实周报内容」）。
- [ ] **Step 2: 写失败的测试 `test/report-docx.test.js`**（`check` / `eq` / `throws` 风格）。用例：
  - `extractText`：对默认模板，行顺序为 标题 → 抬头行（`部门 | … | 姓名 | 测试员 | 时间 | …`）→ … → 工作项行（`1 | 事项甲 / 细节一 / 细节二 | 100%`）…；表格外的段落单独成行；空单元格省略；非 zip 抛 `不是有效的 docx 文件`；zip 里没有 `word/document.xml` 同样抛。
  - `checkTemplate`：默认模板返回 `{name: '测试员'}`；`omit` 每一项各一条用例，消息都以 `模板结构不认识：` 开头且含对应关键字（时间 / 工作内容 / 本周工作需协调 / 工作计划 / 部门经理批阅 / 日期）；`omit:'numbering'` 报找不到编号；`omit:'detailPara'` 报样板缺少细节段；`extraTable:true` 报只能有一张表；`fourCells:true` 与 `badSpan:true` 各报单元格数 / 跨列不对；非 zip 报 `不是有效的 docx 文件`。
  - `fillTemplate` 基本：填 1 项、5 项（其中一项没有细节行）后，用 `extractText` 读回：序号为 `1..N`、标题、细节、`N%` 都在；模板里原有的 3 个工作项行的假内容（「事项甲」等默认文字）**全部消失**；问题行文字为 `data.issues`，空白时为「无」；抬头「时间」格和签名里的日期都变成 `data.time`，签名里的姓名部分原样；计划区 0 条（一行全空，序号也空）/ 1 条 / 5 条，每行日期都是 `planRange`，原有的假计划行全部消失。
  - 行高与编号：输出的 `document.xml` 里工作项行和计划行都没有 `hRule="exact"`、有 `hRule="atLeast"`；其他行（如抬头行）的行高设置未被改动；`numbering.xml` 里新增了 N 个 `<w:num>`，每个带 `startOverride`，`numId` 互不相同且都大于原有最大值；第 k 个工作项行的细节段使用第 k 个新 `numId`。
  - 文字安全：标题 / 细节 / 问题 / 计划里含 `<>&"'` 和控制字符（`\u0001`）和换行时，输出 XML 里已转义 / 去掉，且 `extractText` 读回的文字是转义前的内容（换行变空格）。
  - 结构完整性：输出能被 `readZip` 解开；条目名和顺序与模板一致（目录条目不在内）；`[Content_Types].xml` 内容逐字节不变；`document.xml` 里 `<w:tr>`、`<w:tc>`、`<w:p>` 的开闭标签数量相等；克隆后文档里没有重复的 `w14:paraId`；输出再喂给 `checkTemplate` 仍通过（填过的文档可以当模板）。
  - `fillTemplate` 对坏模板抛和 `checkTemplate` 相同的错误。
- [ ] **Step 3: 运行确认失败** — Run: `node test/report-docx.test.js`；Expected: 报 `Cannot find module '../lib/report-docx'`。
- [ ] **Step 4: 实现 `lib/report-docx.js`**（文件头注释写「无 I/O」；XML 用字符串和正则处理，只改文中规定的部分，别的原样）。
- [ ] **Step 5: 运行确认通过，并加进 `package.json`** — Run: `node test/report-docx.test.js`；Expected: 全部 `ok`。
- [ ] **Step 6: 真实模板核对（只读，不提交）。** 写一个**临时脚本** `D:\tmp\stubs\verify_real_template.js`（不进仓库）：读 `C:\Users\Admin\Desktop\1\徐晨凯11.23-11.28-周报.docx`，调用 `checkTemplate`（打印 `name`，**不打印其他内容**），再用假数据 `{time:'2026.11.30', items:[{title:'事项甲',lines:['细节一','细节二','细节三'],progress:100},{title:'事项乙',lines:['细节一'],progress:50}], issues:'无', plan:['计划一','计划二'], planRange:'2026.11.30-2026.12.4'}` 调 `fillTemplate`，把结果写到 `D:\tmp\stubs\report-sample.docx`，再用 `readZip` + `extractText` 读回并打印（内容全是假数据）。Expected: `checkTemplate` 通过；读回的文字正确。**如果真实模板被拒绝，说明合成模板和真实结构有出入：以真实文件为准修正 `lib/report-docx.js` 和 `test/helpers/report-template.js`，再重跑 Step 5。** 完成后把 `D:\tmp\stubs\report-sample.docx` 的路径记在 ledger / 报告里，请用户用 Word 打开确认版式、编号、行高。
- [ ] **Step 7: 提交**

```bash
git add lib/report-docx.js test/helpers/report-template.js test/report-docx.test.js package.json
git commit -m "feat(report): 解析并填充公司周报 docx 模板（行克隆、编号重置、行高改最小行高）"
```

---

### Task 3: 大小周日期规则 `lib/report-dates.js`

**Files:**
- Create: `lib/report-dates.js`
- Create: `test/report-dates.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `lib/menu.js` 的 `weekStart(date)`、`addDays(date, n)`（非法日期抛 `Error('日期格式应为 YYYY-MM-DD')`）。
- Produces：
  - `DEFAULT_ANCHOR = '2026-11-23'`。
  - `fmtDot(date: string): string` — `2026-11-28` → `2026.11.28`；月日不补零：`2026-12-04` → `2026.12.4`。
  - `restKind({ start, today, anchor }): 'single' | 'double'` — `start` 归一到周一；若 `today` 落在 `start` 起的 7 天内：周六 ⇒ `single`，周五 ⇒ `double`；其他情况按奇偶：`start` 与 `anchor`（先归一到周一）相差的整周数为偶数 ⇒ `single`，奇数 ⇒ `double`（负数也要对：`-1` 为奇）。
  - `reportDates({ start, today, anchor, kind, name }): { kind, from, to, time, planRange, filename }` — `kind` 给了（`'single'` / `'double'`）就用它，否则用 `restKind`；`from` 为周一（`YYYY-MM-DD`）；`to` 为本周最后一个工作日：`single` ⇒ 周六，`double` ⇒ 周五；`time = fmtDot(today)`；`planRange`：本周 `single` ⇒ `fmtDot(下周一)-fmtDot(下周五)`，`double` ⇒ `fmtDot(下周一)-fmtDot(下周六)`（两端都带年份，如 `2026.11.30-2026.12.4`）；`filename = ${name}${M.D}-${M.D}-周报.docx`（`M.D` 是 `from` 和 `to` 的月日，不补零，`name` 缺省为空串）。非法日期抛 `Error('日期格式应为 YYYY-MM-DD')`；`kind` 不是这两个值抛 `Error('本周类型无效')`。

- [ ] **Step 1: 写失败的测试 `test/report-dates.test.js`**，用例（以 `anchor = 2026-11-23` 为单休周）：
  - `fmtDot`：`2026-11-28` → `2026.11.28`；`2026-12-04` → `2026.12.4`；`2027-01-05` → `2027.1.5`；非法抛错。
  - `restKind`：周六在该周内（`start=2026-11-23, today=2026-11-28`）⇒ `single`；周五（`start=2026-11-16, today=2026-11-20`）⇒ `double`；周日补生成（`start=2026-11-23, today=2026-11-29`）⇒ 按奇偶 `single`；周一（`start=2026-11-30, today=2026-11-30`）⇒ 奇偶 `double`；`today` 是周六但不在该周内（`start=2026-11-16, today=2026-11-28`）⇒ 奇偶 `double`；奇偶：`2026-11-09`（相差 -2）⇒ `single`，`2026-11-16`（-1）⇒ `double`，`2026-12-07`（+2）⇒ `single`，`2026-12-14`（+3）⇒ `double`；`start` 不是周一（`2026-11-26`）也按那周的周一算；`anchor` 不是周一（`2026-11-25`）也归一。
  - `reportDates`：周六生成 `{start:'2026-11-23', today:'2026-11-28', name:'测试员'}` ⇒ `kind:'single'`、`from:'2026-11-23'`、`to:'2026-11-28'`、`time:'2026.11.28'`、`planRange:'2026.11.30-2026.12.4'`、`filename:'测试员11.23-11.28-周报.docx'`；周五生成 `{start:'2026-11-16', today:'2026-11-20'}` ⇒ `kind:'double'`、`to:'2026-11-20'`、`planRange:'2026.11.23-2026.11.28'`、文件名 `…11.16-11.20-周报.docx`；手动 `kind:'double'` 覆盖周六生成的结果（`to` 变周五，计划变一到六）；跨月（`start:'2026-11-30'`，`kind:'single'`）`to:'2026-12-05'`、文件名 `…11.30-12.5-…`；跨年（`start:'2026-12-28'`，`kind:'single'`）`planRange:'2027.1.4-2027.1.8'`；`name` 缺省文件名以数字开头；非法 `start` / `today` / `kind` 抛对应错误。
- [ ] **Step 2: 运行确认失败** — Run: `node test/report-dates.test.js`；Expected: `Cannot find module`。
- [ ] **Step 3: 实现 `lib/report-dates.js`**（无 I/O）。
- [ ] **Step 4: 运行确认通过，加进 `package.json`** — Run: `node test/report-dates.test.js`；Expected: 全部 `ok`。
- [ ] **Step 5: 提交**

```bash
git add lib/report-dates.js test/report-dates.test.js package.json
git commit -m "feat(report): 大小周日期规则（周五/周六以当天为准，其余按单双周交替）"
```

---

### Task 4: AI 配置、提示词与草稿校验 `lib/report-ai.js`

**Files:**
- Create: `lib/report-ai.js`
- Create: `test/report-ai.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `lib/receipt.js` 的 `extractReplyText(format, json)`（直接 `require` 并重新导出，不要复制）；`node:crypto`。
- Produces：
  - `LIMITS = { items: 12, title: 60, lines: 10, text: 200, issues: 200, plan: 12, example: 6000, examples: 4 }`。
  - `resolveConfig(fileCfg: object|undefined, env: object, receiptCfg: object): { enabled, url, key, model, format, extra, timeoutSec, dailyLimit, problem, inherited }`，`receiptCfg` 是 `receipt.resolveConfig(...)` 的返回值。环境变量 `REPORT_API_URL` / `REPORT_API_KEY` / `REPORT_MODEL` / `REPORT_FORMAT` / `REPORT_EXTRA`（JSON 对象）/ `REPORT_TIMEOUT_S` / `REPORT_DAILY_LIMIT`，环境变量优先于文件，空串视为未设置；`format` 只能是 `openai` / `anthropic` / `responses`。规则（逐条见设计文档「AI 整理」）：①周报**没有 `url`**：`url`、`key`、`format`、`extra` 取自 `receiptCfg`，周报自己配了的项覆盖之；`model` 周报自己的优先、否则取 `receiptCfg.model`；`inherited = true`（只要有一项取自图片识别）。若 `receiptCfg.enabled` 为假而周报什么都没配 ⇒ `enabled:false`、`problem:''`。②周报**有 `url`**：不沿用任何东西，`key`、`model` 必须自己配，缺了 ⇒ `problem: '周报配置不完整，缺少：key、model'`（按缺的项列出），`format` 缺省 `openai`，`extra` 缺省 `{}`，`inherited:false`。③`timeoutSec`（正数，缺省 90）和 `dailyLimit`（非负整数，缺省 20，`0` 表示不限）**只读周报自己的配置**。④`extra` 无效（不是对象 / 非法 JSON）⇒ `problem`；`format` 不支持 ⇒ `problem`。`problem` 里绝不出现 key。`enabled = !problem && url && key && model`。
  - `buildTextRequest(cfg, prompt: string): { url, headers, body }` — 三种格式的**纯文本**请求：`openai`：`messages:[{role:'user',content: prompt}]`，Bearer；`anthropic`：`x-api-key` + `anthropic-version: 2023-06-01`，`max_tokens: 4000`，`messages:[{role:'user',content: prompt}]`；`responses`：`input:[{role:'user',content:[{type:'input_text',text: prompt}]}]`，Bearer；各格式都把 `cfg.extra` 展开在 `model` 之前（与 `receipt.buildRequest` 一致）。
  - `buildPrompt({ weekLabel: string, entries: {date,text}[], doneTodos: {date,text}[], openTodos: {due_date,text}[], examples: string[] }): string` — 确定性输出（同样输入逐字相同）。内容按顺序：任务说明与规则（见设计文档：按项目归类、标题和细节参照示例、只使用记录里出现的事实不得编造、完成度为 0–100 整数、计划来自未完成待办和记录里看得出的后续工作、不写日期、**只返回** JSON `{"items":[{"title":"","lines":[""],"progress":100}],"issues":"无","plan":[""]}`）；`## 示例周报`（每份以 `### 示例 N` 开头，文字超过 `LIMITS.example` 的截断，只取最后 `LIMITS.examples` 份；没有示例时写一行「（没有示例）」）；`## 本周（${weekLabel}）记录`（每条 `M.D 周X：文字`，按日期升序，同日按输入顺序）；`## 本周完成的待办`（`M.D 完成：文字`）；`## 还没做完的待办`（`文字（M.D）` 或 `文字（没选日期）`）；某一节没有内容时写「（无）」。
  - `promptHash(prompt: string): string` — `sha256` 十六进制的前 32 位。
  - `parseDraft(text: string): { items, issues, plan } | null` — 容错取出 JSON（取第一个 `{` 到最后一个 `}`，`JSON.parse`）；字段规整：`items` 必须是非空数组，每项 `title` 去空白后非空（空标题的项丢弃）、截到 `LIMITS.title`，`lines` 缺省 `[]`、每条去空白后非空、截到 `LIMITS.text`、最多 `LIMITS.lines` 条，`progress` 取整并夹到 0–100（非数字按 `0`）；`items` 最多 `LIMITS.items` 项；`issues` 去空白、截到 `LIMITS.issues`，缺省或空 ⇒ `'无'`；`plan` 缺省 `[]`，每条去空白非空、截到 `LIMITS.text`、最多 `LIMITS.plan` 条；规整后 `items` 为空，或根本不是 JSON ⇒ `null`。
  - `validateDraft(draft: any): { items, issues, plan }` — 供导出用的**严格**校验（不截断，超限就报错）：`items` 为 1–`LIMITS.items` 项的数组（否则 `Error('至少要有一个工作项')` / `Error('工作项最多 12 个')`）；每项 `title` 非空且 ≤ 60 字（`Error('项目标题不能为空')` / `Error('项目标题最长 60 字')`），`lines` 是数组（可空）、每条非空 ≤ 200 字、最多 10 条（`Error('细节最多 10 条')` / `Error('每条最长 200 字')`），`progress` 为 0–100 的整数（`Error('完成度应为 0–100 的整数')`）；`issues` 是字符串 ≤ 200 字（空白 ⇒ `'无'`）；`plan` 是数组（可空）、每条非空 ≤ 200 字、最多 12 条（`Error('计划最多 12 条')`）；字符串先 `trim`。非对象 / 缺字段抛 `Error('草稿格式不对')`。另导出 `validateDotDate(s)`（`YYYY.M.D` 且是真实日期）和 `validateDotRange(s)`（`YYYY.M.D-YYYY.M.D` 且起不晚于止），不合格抛 `Error('日期格式不对')`。

- [ ] **Step 1: 写失败的测试 `test/report-ai.test.js`**，用例：
  - `resolveConfig`（`receiptCfg` 用手写对象，key 用 `RK-SECRET` 之类的假值）：周报什么都没配 + 图片识别可用 ⇒ 全部沿用、`enabled:true`、`inherited:true`、`timeoutSec:90`、`dailyLimit:20`（即使 `receiptCfg.timeoutSec` 是 60、`dailyLimit` 是 30）；只配 `model` ⇒ `model` 用自己的、其余沿用；只配 `format` / `extra` ⇒ 覆盖沿用值；**配了 `url` 但没配 `key`** ⇒ `enabled:false`、`problem` 含「缺少：key」、`key` 为空（没有拿图片识别的 key），且 `problem` 字符串里不含 `RK-SECRET`；配了 `url`+`key`+`model` ⇒ 可用、`inherited:false`、`format` 缺省 `openai`；环境变量覆盖文件、空串环境变量不覆盖；`REPORT_EXTRA` 非法 JSON / 数组 ⇒ `problem`；`format` 非法 ⇒ `problem`；`timeoutSec` / `dailyLimit` 的合法值、`0`、负数、非数字；图片识别不可用且周报没配 ⇒ `enabled:false`、`problem:''`。
  - `buildTextRequest`：三种格式各一条，断言 URL、请求头（Bearer / `x-api-key`）、body 结构、`extra` 被展开、提示词原样在请求里、`anthropic` 的 `max_tokens` 为 4000。
  - `buildPrompt`：同样输入两次逐字相同；含「示例」「本周」「还没做完」各节；记录行形如 `11.23 周一：…`；待办日期为空时显示「没选日期」；示例超过 6000 字被截断、超过 4 份只取最后 4 份；没有示例 / 没有某类内容时出现「（没有示例）」「（无）」；提示词里含「不得编造」和 JSON 格式要求，**不含任何 key**。
  - `promptHash`：同输入同输出、差一个字就不同、长度 32 的十六进制。
  - `parseDraft`：标准 JSON；被 ``` 围栏 / 前后有说明文字包着；`progress` 为 `99.6` ⇒ `100`、`-5` ⇒ `0`、`"abc"` ⇒ `0`、`150` ⇒ `100`；空标题的项被丢弃；项目 / 细节 / 计划超限被截断到上限；`issues` 缺省 ⇒ `'无'`；`items` 为空数组 / 缺失 / 全是空标题 ⇒ `null`；完全不是 JSON ⇒ `null`；`lines` 里夹杂非字符串被忽略。
  - `validateDraft`：合法草稿原样通过（并 `trim`）；`items` 为空 / 13 项 / 空标题 / 标题 61 字 / 细节 11 条 / 单条 201 字 / `progress` 为 `50.5` 或 `'50'` / 计划 13 条 / `issues` 201 字 各一条用例，消息与上面一致；`lines` 为空数组、`plan` 为空数组通过；`issues` 空白 ⇒ `'无'`；传 `null` / 字符串抛 `草稿格式不对`。`validateDotDate`：`2026.11.28`、`2026.1.5` 通过，`2026.13.1`、`2026-11-28`、`26.11.28` 不通过；`validateDotRange`：`2026.11.30-2026.12.4` 通过，起晚于止、缺一半不通过。
- [ ] **Step 2: 运行确认失败** — Run: `node test/report-ai.test.js`；Expected: `Cannot find module`。
- [ ] **Step 3: 实现 `lib/report-ai.js`**（无 I/O；提示词措辞自行决定，但必须满足上面的内容要求）。
- [ ] **Step 4: 运行确认通过，加进 `package.json`** — Run: `node test/report-ai.test.js`；Expected: 全部 `ok`。
- [ ] **Step 5: 提交**

```bash
git add lib/report-ai.js test/report-ai.test.js package.json
git commit -m "feat(report): AI 配置继承规则、提示词、草稿校验"
```

---

### Task 5: 文件存储与调用服务 `lib/report-store.js`、`lib/report-service.js`

**Files:**
- Create: `lib/report-store.js`、`lib/report-service.js`
- Create: `test/report-store.test.js`、`test/report-service.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 4 的 `buildTextRequest`、`promptHash`、`parseDraft`；`lib/receipt.js` 的 `extractReplyText`；`lib/provider-guard.js` 的 `ServiceError`、`localDate`、`callProvider`、`createUsage`；`node:fs`、`node:path`。
- Produces：
  - `createReportStore(dir: string)`（`dir` 是 `data/report`，不存在时按需创建）返回：`getTemplate(): Buffer|null`；`setTemplate(buf)`；`getSettings(): { anchor: string }`（缺省 `{anchor:'2026-11-23'}`，文件损坏按缺省）；`setSettings({ anchor })`；`listExamples(): {id: number, title: string, chars: number}[]`（按 id 升序）；`readExamples(): string[]`（按 id 升序，取文字）；`addExample({ title, text }): number`（`text` 截到 6000 字；同 `title` 的旧示例被替换；超过 4 份丢最旧的；返回新 id，id = `Date.now()`，若不大于现有最大 id 则取最大 id + 1）；`removeExample(id): boolean`。示例存为 `examples/<id>.json`（`{title, text}`）；所有写入先写 `*.tmp` 再 `rename`；读取时损坏 / 缺字段的示例文件被跳过；`removeExample` 的 `id` 必须是正整数，否则返回 `false`（不拼路径）。
  - `createReportService({ getConfig, dataDir, fetchImpl = fetch, today = localDate, log = console.log })` 返回 `{ status(), generate({ prompt, hash }) }`：`status()` ⇒ `{ enabled }`；`generate`：配置不可用 ⇒ `ReportError(503, '周报整理未配置')`；`promptHash(prompt) !== hash` ⇒ `ReportError(409, '内容在预览之后有变化，请重新预览')`（**在任何 `fetch` 和计数之前**）；正在整理 ⇒ `ReportError(429, '正在整理上一份，请稍等')`；用量已达上限 ⇒ `ReportError(429, '今天的整理次数用完了')`（用量文件 `path.join(dataDir, 'usage.json')`，`label: '周报整理'`）；然后 `callProvider`（`ErrorClass: ReportError`、`unreadable: '没有读懂 AI 的回复，请重试'`、`label: '周报整理'`），`extractReplyText` + `parseDraft`，`parseDraft` 为 `null` ⇒ `ReportError(502, 'AI 返回了无法理解的内容，请重试')`；成功返回草稿 `{items, issues, plan}`。`ReportError extends ServiceError`。**日志里不得出现提示词、回复内容、key。**

- [ ] **Step 1: 写失败的测试**。
  - `test/report-store.test.js`（用 `fs.mkdtempSync(os.tmpdir()…)` 的临时目录，结束删除）：模板读写往返、没有模板为 `null`；`setSettings`/`getSettings` 往返，文件损坏 / 不存在返回缺省；示例：添加 5 份 ⇒ 只剩最新 4 份且按 id 升序；同标题替换（份数不增加、文字是新的）；`title` / `chars` 正确；超过 6000 字被截断；`readExamples` 顺序；损坏的示例 json 被跳过、`listExamples` 不抛错；`removeExample`：存在 ⇒ `true`，不存在 ⇒ `false`，`'../x'`、`'1a'`、`0`、`-1`、`1.5` ⇒ `false` 且不碰文件；连续两次 `addExample` 的 id 严格递增（即使 `Date.now()` 相同，可用注入或在同一毫秒内连续调用验证）；目录里没有遗留的 `.tmp` 文件。
  - `test/report-service.test.js`（假 `fetch`，沿用 `test/receipt-service.test.js` 的写法；注意该文件里为防 `AbortSignal.timeout` 的定时器被 `unref` 而加的 keepAlive）：未配置 ⇒ 503；`hash` 不一致 ⇒ 409 且**假 fetch 没被调用、用量没增加**；成功路径返回规整后的草稿（用三种 `format` 各一个假回复）；回复不是 JSON / `items` 为空 ⇒ 502 固定文案；并发（第一个未结束时第二个）⇒ 429；每日限额（`dailyLimit: 2`，第三次 ⇒ 429；用量文件持久化：新建一个 service 实例继续计数；跨天归零）；上游 401 ⇒ 502 且消息提示检查 key、但消息**不含 key 字符串**；上游 500 / 超时（504）/ 网络错误 ⇒ 对应固定文案；响应超过 2 MiB ⇒ 502；日志收集器里**没有**提示词中的任意一段文字和 key。
- [ ] **Step 2: 运行确认失败** — Run: `node test/report-store.test.js`；`node test/report-service.test.js`；Expected: 都是 `Cannot find module`。
- [ ] **Step 3: 实现两个模块。**
- [ ] **Step 4: 运行确认通过，加进 `package.json`** — Run: 两个测试文件；Expected: 全部 `ok`。
- [ ] **Step 5: 提交**

```bash
git add lib/report-store.js lib/report-service.js test/report-store.test.js test/report-service.test.js package.json
git commit -m "feat(report): 模板 / 示例 / 设置的文件存储，AI 整理服务（限额、并发、预览指纹校验）"
```

---

### Task 6: 接口接线与冒烟检查

**Files:**
- Modify: `server.js`（在「每周工作」接口段之后、「服务器」段之前新增「正式周报导出」段）
- Modify: `test/smoke.js`（每周工作块之后、「清理」之前加一块）

**Interfaces:**
- Consumes: Tasks 1–5 的全部模块；`server.js` 已有的 `route`、`HttpError`、`readBody`、`readJson`、`json`、`send`、`workPersonId`、`workWeekStart`、`workEntriesBetween`、`db`、`DATA_DIR`、`config`、`process.env`、`resolveReceiptConfig`、`ServiceError`、`menu`、`study.isDate`。
- Produces（HTTP，均需登录；契约以设计文档「接口」一节为准，下面只补接线细节）：
  - 模块级：`const reportStore = createReportStore(path.join(DATA_DIR, 'report'))`；`const reportCfg = () => reportAi.resolveConfig(config.report, process.env, resolveReceiptConfig(config.receipt, process.env))`；`const reportService = createReportService({ getConfig: reportCfg, dataDir: path.join(DATA_DIR, 'report') })`。启动时若 `reportCfg().problem` 有值打印 `周报整理配置有问题：…`，否则若可用打印 `周报整理已启用（沿用图片识别的配置）` 或 `周报整理已启用（单独配置）`——**只打印这些，不打印模型名以外的任何配置**。
  - `GET /api/report/status` → `{ enabled, hasTemplate, examples: store.listExamples(), anchor, problem }`（`problem` 即配置问题文字，没有则 `''`）。
  - `PUT /api/report/settings` `{anchor}`：`study.isDate`，否则 400「日期格式应为 YYYY-MM-DD」；用 `menu.weekStart` 归到周一后保存 → `{anchor}`。
  - `POST /api/report/template`：`readBody(req, 5*1024*1024)`，空 ⇒ 400「文件为空」；`checkTemplate`（失败 ⇒ 400，消息即错误消息）；再用示例数据 `fillTemplate` 试填一次（失败 ⇒ 400「模板结构不认识：试填失败」）；通过后 `setTemplate`，返回 `{ ok: true, name }`。`Content-Type` 不作要求（以内容为准）。
  - `POST /api/report/examples`：`readBody(5MB)`，`extractText`（失败 ⇒ 400「不是有效的 docx 文件」）；文字为空 ⇒ 400「没有读到文字」；`title` 取自请求头 `X-Report-Title`（URL 编码，缺省「示例」，截 40 字），`addExample` → `{ id, chars, truncated }`。
  - `DELETE /api/report/examples/:id`：路由正则只接受 `\d+`；不存在 404「示例不存在」。
  - `GET /api/report/dates?start=&today=&kind=`：`start`、`today` 必填且为真实日期（否则 400）；`kind` 可选；没有模板时 `name=''`，有模板用 `checkTemplate(...).name`；返回 `reportDates(...)` 的结果。
  - 内部函数 `reportInputs(person, start)`：返回 `{ weekStart, entries: workEntriesBetween(...).map({date,text}), doneTodos: （该人 done=1 且 done_date 在本周内，按 done_date,id）map({date,text}), openTodos: （该人 done=0，按 id）map({due_date,text}), examples: store.readExamples(), empty: entries 与 doneTodos 都为空 }`。
  - `POST /api/report/prepare` `{person, start}`：`workPersonId`、`workWeekStart`；无模板 ⇒ 409「请先在设置里上传周报模板」；`empty` ⇒ 返回 `{ empty: true }`；否则 `prompt = buildPrompt({ weekLabel: 'M.D-M.D', ... })` → `{ empty:false, prompt, hash: promptHash(prompt), chars: prompt.length, examples: 示例份数 }`。
  - `POST /api/report/generate` `{person, start, hash}`：先校验（无模板 409；`empty` ⇒ 400「这一周还没有记录」；`hash` 必须是 32 位十六进制字符串，否则 400）；服务端用同一函数**重新组装**提示词，调用 `reportService.generate({ prompt, hash })`，`ServiceError` 转 `HttpError` → 草稿。
  - `POST /api/report/export` `{draft, time, planRange, kind, start}`：无模板 409；`validateDraft`、`validateDotDate(time)`、`validateDotRange(planRange)`，任一失败 ⇒ 400 带其消息；`kind` 必须是 `single`/`double`（400「本周类型无效」）；`start` 经 `workWeekStart`；`fillTemplate` 失败 ⇒ 500 前先 `console.log('周报导出：填充失败')`（不记内容）并返回 400「导出失败：模板和内容对不上，请重新上传模板」；成功 ⇒ `send(res, 200, buf, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': 'attachment; filename="report.docx"; filename*=UTF-8\'\'' + encodeURIComponent(filename), 'Cache-Control': 'no-store' })`，`filename` 由 `reportDates({ start, today: 今天, kind, name: 模板姓名 })` 的 `filename` 得到（其中 `today` 用 `time` 对应的日期，只为取文件名，`kind` 已显式给出所以不影响）；导出成功后 `addExample({ title, text: extractText(输出) })`，其中 `title` 取本周范围字符串 `M.D-M.D`（即 `reportDates` 结果里 `from` 和 `to` 的月日，如 `11.23-11.28`），**添加示例失败不影响导出**（捕获并只记「周报导出：保存示例失败」）。
  - 所有读请求体的接口：`readJson`（1 MB）；二进制上传 5 MB，超限 413。

- [ ] **Step 1: 先写冒烟检查**（`test/smoke.js`；沿用 `json` / `call` / `assert`；用 `require('../lib/zip')` 和 `require('./helpers/report-template')` 在冒烟里现场构造 docx）。**这些会修改服务端的 `data/report/`，所以只在 `GET /api/report/status` 返回 `hasTemplate === false` 时才执行写入类断言，否则只做只读断言并打印一行「跳过：服务器上已有周报模板」。** 断言：
  - 只读：`status` 结构（`enabled` 为布尔、`examples` 数组、`anchor` 为日期、响应体里没有任何形如 key 的字段）；`dates` 缺 `start` / `today` 非法 400；`dates?start=2032-03-01&today=2032-03-06` 返回 `kind:'single'`（先 `PUT settings` 前不改动设置，所以用显式 `&kind=single` 与 `&kind=double` 各测一次并核对 `planRange`）；未登录访问 `status` 返回 401（沿用文件开头的未登录检查风格，补一条）。
  - 无模板时：`prepare` / `generate` / `export` 都 409「请先在设置里上传周报模板」；`prepare` 缺 `person` / 非法 `person` 400「人员不存在」。
  - 上传：随机字节 400「不是有效的 docx 文件」；用 `buildTemplate({ omit: 'workHeader' })` 上传 400 且消息含「模板结构不认识」；空请求体 400；用 `buildTemplate()` 上传成功并返回 `name:'测试员'`，随后 `status.hasTemplate` 为 `true`。
  - 有模板后：`prepare`（用「冒烟人员」或第一位人员、一个没有任何记录的远期周 `2032-06-07`）返回 `{empty:true}`；`generate` 同一周 400「这一周还没有记录」；`generate` 的 `hash` 缺失 / 不是 32 位十六进制 400；构造有记录的一周（用 `POST /api/work/entries` 在 2032-03-03 建一条，用完删除）后 `prepare` 返回 `prompt`（含该记录文字）和 32 位 `hash`；服务器未配置 AI 时 `generate` 返回 503（假定冒烟时没有配置 `RECEIPT_*` / `REPORT_*`）；`export`：合法草稿返回 200，`Content-Type` 为 docx，`Content-Disposition` 含 `filename*=UTF-8''`，响应体用 `readZip` 能解开且 `extractText` 含草稿里的标题和计划文字；`export` 草稿 `items` 为空 400「至少要有一个工作项」、`time` 非法 400「日期格式不对」、`kind` 非法 400；导出后 `status.examples` 增加了一份。
  - 示例：上传合成 docx 成功返回 `id`；`status.examples` 里能看到；`DELETE` 它成功，再删 404「示例不存在」；`DELETE /api/report/examples/abc` 不匹配路由（得到 404）。
  - 设置：`PUT /api/report/settings {anchor:'2032-03-03'}` 返回归一到周一的 `2032-03-01`，随后改回 `status` 里原来的 `anchor`；非法日期 400。
  - 写入类断言结束后**尽量清理**：删除本块建的示例和工作记录；模板无法删除（没有这个接口），在注释里写明「冒烟会留下一份合成模板，请只在临时数据目录上运行」。
  - Run: `node --check test/smoke.js` — Expected: 无输出。
- [ ] **Step 2: 实现接线**（沿用现有路由风格；`ReportError`/`ServiceError` 转 `HttpError`：`catch (e) { if (e instanceof ServiceError) throw new HttpError(e.status, e.message); throw e; }`；`person`、`start` 的解析复用 `workPersonId` / `workWeekStart`）。
- [ ] **Step 3: 检查** — Run: `node --check server.js && node --check test/smoke.js`；Expected: 无输出。再依次跑 Task 1–5 的测试文件确认仍全绿。
- [ ] **Step 4: 提交**

```bash
git add server.js test/smoke.js
git commit -m "feat(report): 正式周报导出的接口（模板/示例/设置/预览/整理/导出），补冒烟检查"
```

---

### Task 7: 前端（设置页 + 每周工作页）

**Files:**
- Modify: `public/index.html`（设置页新增「周报导出」一节，放在「修改密码」之前；每周工作页新增按钮；新增两个弹层 `#report-prepare`、`#report-draft`）
- Modify: `public/app.js`（在「每周工作」一节之后、「首页仪表盘」之前新增「正式周报」一节；`enterWork` 里加载状态；设置页的初始化）
- Modify: `public/style.css`

**Interfaces:**
- Consumes: Task 6 的接口；`app.js` 已有的 `api`、`postJson`、`toast`、`esc`、`askConfirm`、`todayStr`、`mdLabel`、`$` / `$$`、`work`（`work.person`、`work.start`）；设置页现有的结构（`.pad`、`h3`、`.btn.block`、`.muted`）。
- Produces：`report` 状态对象（`status`、`prep`、`draft`、`kind`、`dates`、`busy`）；函数 `loadReportStatus()`、`openReportPrepare()`、`sendReportPrompt()`、`openReportDraft(draft)`、`exportReport()`。

- [ ] **Step 1: HTML 骨架。**
  - 设置页：`<h3>周报导出</h3>` + `<p id="rp-status" class="muted">` + 上传模板 `<label class="btn block">上传周报模板（.docx）<input type="file" id="rp-template-file" accept=".docx" hidden></label>` + 上传示例 `<label class="btn block">上传示例周报（.docx，可多选）<input type="file" id="rp-example-file" accept=".docx" multiple hidden></label>` + `<div id="rp-examples">`（每份一行：标题、字数、「删除」）+ 基准单休周 `<input type="date" id="rp-anchor">` 与「保存」按钮 + 说明文字：「模板和示例只保存在你的服务器上；整理周报时，示例和本周记录会发给图片识别用的那个 AI 服务。老式 .doc 请先在 Word 里另存为 .docx。」
  - 每周工作页：在「生成周报」所在的 `.pad` 里加 `<button type="button" id="wk-report2-btn" class="btn block">整理成正式周报</button>` 和 `<p id="wk-report2-hint" class="muted hidden"></p>`。
  - 弹层 `#report-prepare`（沿用 `.sheet` 结构）：标题「将发送给 AI 的内容」、说明（字数、示例份数）、只读 `<textarea id="rpp-text" readonly rows="14">`、「取消」「发送」。
  - 弹层 `#report-draft`：标题「正式周报草稿」；本周类型（`#rpd-kind-single` / `#rpd-kind-double` 两个互斥按钮）；「时间」`#rpd-time`（文本框，`YYYY.M.D`）；`#rpd-items`（项目列表容器）+「＋ 添加项目」；「需协调的问题」`#rpd-issues`；`#rpd-plan`（计划列表容器）+「＋ 添加计划」；「计划日期」`#rpd-plan-range`；`<p id="rpd-filename">`；`<p id="rpd-err" class="err">`；按钮「重新整理」「取消」「导出 docx」。
- [ ] **Step 2: 设置页逻辑。** 进入设置视图时（`switchView('settings')`）调用 `loadReportStatus()` → `GET /api/report/status`，`#rp-status` 显示：AI 是否可用（不可用时附 `problem` 文字或「未配置」）、是否已有模板、示例份数；`#rp-anchor` 填入 `anchor`。上传模板：`api('/api/report/template', { method:'POST', headers:{'Content-Type':'application/octet-stream'}, body: file })`，成功 `toast('模板已上传')` 并刷新状态，失败 `toast(err.message)`；上传示例：对每个选中的文件依次 `POST /api/report/examples`（请求头 `X-Report-Title: encodeURIComponent(文件名去扩展名)`），全部完成后 `toast('已上传 N 份示例')`（失败的单独提示文件名），`input.value = ''` 以便再次选择同一文件；示例列表每行的「删除」带 `askConfirm`；保存基准日调用 `PUT /api/report/settings`。示例标题用 `textContent`，不经 `innerHTML`。
- [ ] **Step 3: 每周工作页按钮状态。** `enterWork` 里（人员加载成功之后）调用 `loadReportStatus()`；按钮 `#wk-report2-btn` 在 `status.enabled && status.hasTemplate` 时可点，否则 `disabled` 并在 `#wk-report2-hint` 显示原因（「AI 没配置」/「请先在设置里上传周报模板」）。
- [ ] **Step 4: 预览与发送。** 点按钮 ⇒ `POST /api/report/prepare {person: work.person, start: work.start}`：409/其他错误 ⇒ `toast`；`empty` ⇒ `toast('这一周还没有记录')`；否则 `#rpp-text.value = prompt`，显示字数和示例份数，保存 `report.prep = {hash}`，打开 `#report-prepare`。「发送」⇒ `POST /api/report/generate {person, start, hash}`，期间两个按钮禁用并显示「整理中…」（防重复点击，`report.busy`）；返回 409（内容变了）⇒ `toast` 并回到预览（重新 `prepare`）；其他错误 ⇒ 弹层内显示错误、按钮复位；成功 ⇒ 关闭预览弹层、调用 `openReportDraft(draft)`。
- [ ] **Step 5: 草稿弹层。** `openReportDraft(draft)`：`GET /api/report/dates?start=&today=${todayStr()}` 得到 `{kind, time, planRange, filename, from, to}`，填入 `#rpd-time`、`#rpd-plan-range`、`#rpd-filename`、本周类型按钮高亮；`#rpd-items` 为每个项目渲染一块：标题 `<input>`、细节 `<textarea>`（**每行一条**，提交时按换行拆分并去掉空行）、完成度 `<input type="number" min="0" max="100">`、「删除」；`#rpd-plan` 每条计划一个 `<input>` + 「删除」；「＋」添加空块；至少保留一个项目（只剩一个时「删除」置灰）。**所有来自 AI 的文字只通过 `.value` / `.textContent` 写入**，容器骨架用 `innerHTML` 时不得带任何用户 / AI 文字。切换本周类型 ⇒ 带 `&kind=` 重新请求 `dates`，只更新 `#rpd-plan-range`、`#rpd-filename`（`#rpd-time` 不动）。「重新整理」⇒ 关闭草稿弹层并走 Step 4（先 `prepare`）。
- [ ] **Step 6: 导出。** 「导出 docx」⇒ 读取表单拼出 `draft`（项目 / 细节 / 完成度 / 问题 / 计划），`POST /api/report/export {draft, time, planRange, kind, start}`（用 `fetch` 直接发，`credentials: 'same-origin'`，以便拿到二进制；`401` 沿用 `showLogin()` 的处理）；`!res.ok` ⇒ 读 JSON 的 `error` 显示在 `#rpd-err`，**弹层不关闭**；成功 ⇒ `res.blob()`，文件名取 `Content-Disposition` 的 `filename*=UTF-8''…`（`decodeURIComponent`），取不到用 `#rpd-filename`，用临时 `<a download>` 触发下载并 `URL.revokeObjectURL`，`toast('已导出')` 并关闭弹层。导出期间按钮禁用（`report.busy`）。任何弹层关闭 / 取消都要复位 `report.busy` 和按钮状态。
- [ ] **Step 7: 样式。** 沿用现有变量与 `.sheet` / `.btn` / `.err`；草稿里的项目块有边框分隔；`textarea` 宽度占满；两个弹层在手机上可滚动、不横向溢出；宽屏沿用现有弹层居中规则。
- [ ] **Step 8: 检查** — Run: `node --check public/app.js`；Expected: 无输出。再 `grep -n "report-prepare\|report-draft\|rp-template-file\|wk-report2-btn\|api/report/" public/index.html public/app.js` 确认骨架、设置页、按钮、弹层、接口调用都接上；`grep -n "innerHTML" public/app.js` 里「正式周报」一节的每处 `innerHTML` 都不含 AI / 用户文字（人工核对并在 ledger 里记一句）。
- [ ] **Step 9: 提交**

```bash
git add public
git commit -m "feat(report): 设置页上传模板和示例，每周工作页整理并导出正式周报"
```

---

### Task 8: 文档

**Files:**
- Modify: `README.md`、`docs/结构框架.md`、`docs/配置步骤.md`、`验收清单.md`

**Interfaces:** 无新增代码接口；内容必须与 Tasks 1–7 的实际实现一致（接口路径、文案、规则以 `server.js` 和 `lib/` 为准）。

- [ ] **Step 1: 更新文档。**
  - README：「每周工作」一节后新增「正式周报导出」——怎么用（设置页上传 `.docx` 模板和示例 → 记录页点「整理成正式周报」→ 看将发送的内容 → 草稿里改 → 导出）；大小周规则（周六生成 = 本周单休，下周计划为下周一到下周五；周五生成 = 本周双休，下周计划为一到六；其他日子按单双周交替推，基准日可改，草稿里可手动切换）；老式 `.doc` 要先在 Word 里另存为 `.docx`；导出的文件是在你的模板上复制行填内容，只有一处改动（填过的行从固定行高改成最小行高）；隐私（模板和示例只存服务器 `data/report/`，整理时示例和本周记录会发给图片识别用的 AI，每次发送前都会让你预览）；每天默认最多整理 20 次。
  - 结构框架：目录树加 `lib/zip.js`、`lib/report-docx.js`、`lib/report-dates.js`、`lib/report-ai.js`、`lib/report-store.js`、`lib/report-service.js`、`test/helpers/report-template.js`；数据目录表加 `data/report/`（`template.docx`、`settings.json`、`examples/`、`usage.json`）；接口清单新增「正式周报导出」一节（9 个接口，含错误码和 `hash` 机制）；模块表、测试表（6 个新测试文件）；数据流新增「正式周报」一节（上传 → prepare → generate → 草稿 → export）；已知限制补「无法在真实 Word 里自动验证」「不支持老式 .doc」「模板里的姓名不随人员变」。
  - 配置步骤：新增「周报整理（可选）」——默认沿用图片识别的配置，什么都不用填；想换文字模型只配 `report.model`；单独配 `url` 时必须同时配 `key` 和 `model`；`config.json` 示例和 `REPORT_*` 环境变量表；字段说明（`timeoutSec` 默认 90、`dailyLimit` 默认 20 且不沿用图片识别的值）；nginx 的 `client_max_body_size` 要不小于 5M（已有 20M，写明即可）。
  - 验收清单：新增「正式周报导出」一节：设置页上传模板（成功 / 传 `.doc` 或别的文件被拒 / 结构不对被拒并说明缺什么）、上传示例、删除示例；记录页按钮在没配置 / 没模板时置灰并有提示；点按钮先看到将发送的内容；发送后草稿里项目 / 细节 / 完成度 / 问题 / 计划都能改、能增删；本周类型切换后计划日期和文件名跟着变（周六生成 = 单休 = 下周一到五；周五生成 = 双休 = 下周一到六）；导出的 docx 用 **Word 打开不提示修复**、版式和原模板一致、每个项目的编号从 1 开始、行高不截断多出的细节、签名姓名保持原样只换了日期、序号正确；没有任何记录的一周提示「这一周还没有记录」；预览之后在另一台设备改了记录再点发送，会提示内容有变化并重新预览；导出后示例份数增加；次数用完的提示；页面和接口响应里看不到 key。
- [ ] **Step 2: 校对** — Run: `grep -n "api/report" server.js docs/结构框架.md`；Expected: 两处列出的路径一一对应（9 个）；`grep -n "report-" package.json docs/结构框架.md` 确认 6 个测试文件都在脚本里和文档里。
- [ ] **Step 3: 提交**

```bash
git add README.md docs/结构框架.md docs/配置步骤.md 验收清单.md
git commit -m "docs: 正式周报导出的功能说明、配置、结构和验收项"
```
