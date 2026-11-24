# 拍小票录入库存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物品页加一个相机按钮：拍小票或选订单截图 → 服务器转发给可配置的多模态识别服务 → 弹出现有确认卡 → 确认后补货或新增。

**Architecture:** 纯逻辑（配置解析、请求构造、回复解析、去规格、匹配库存、合并、指纹）放进 `lib/receipt.js`；带状态的流程（限额与持久化、并发、超时、重复检测、错误映射）放进 `lib/receipt-service.js`，注入 `fetch`、时钟和目录，因此全部能用 Node 断言离线测试，不需要真实网络也不需要启动服务器；`server.js` 只做很薄的 HTTP 胶水；前端复用现有确认卡。

**Tech Stack:** Node ≥ 22.5（自带 `fetch`、`AbortSignal.timeout`），原生 JS 前端，零第三方依赖；测试沿用 `test/*.test.js` 的 Node 断言风格。

**Spec:** `docs/superpowers/specs/2026-11-24-receipt-scan-design.md`（执行者必须一并阅读，尤其是「已定的设计」和末尾「我替用户做的决定」）。

## Global Constraints

- 零第三方依赖；Node ≥ 22.5；用 Node 自带 `fetch`，不新增 npm 包。
- key 只存在于服务器配置（`config.json` 的 `receipt` 字段或环境变量）；不通过任何接口返回，不写日志，错误信息和 `problem` 提示里也不能出现 key 或识别服务的响应原文。
- 环境变量的值永远不写回 `config.json`；改密码重写配置后，文件里原有的 `receipt` 字段必须保留。
- 图片只在内存里转发，不写磁盘。
- 永远先弹确认卡，不直接改库存；没配置识别服务时，其他功能不受影响。
- 环境变量名：`RECEIPT_API_URL`、`RECEIPT_API_KEY`、`RECEIPT_MODEL`、`RECEIPT_FORMAT`（`openai` | `anthropic` | `responses`，默认 `openai`）、`RECEIPT_EXTRA`、`RECEIPT_TIMEOUT_S`（默认 60）、`RECEIPT_DAILY_LIMIT`（默认 30，0 表示不限）。
- 单张图最大 8 MB，类型 `image/jpeg` | `image/png` | `image/webp`；每天次数计数持久化到 `data/receipt-usage.json`；同一时间只处理一张；重复指纹内存保留 48 小时、最多 100 个；读取识别服务响应最多 2 MB。
- 界面文字和错误提示全部用中文；所有来自识别结果的文字渲染必须用现有的 `esc()`。

## Review Focus

1. 识别服务回复的各种形状：被 Markdown 代码块包住、前后有多余文字、`items` 缺失或不是数组、数量是文字或负数或极大、超过 60 个商品、响应超过 2 MB：都不能崩，要么清洗后继续，要么按规格返回 502（Task 1、Task 2 测试）。
2. 识别服务的错误响应体里回显了 key 或其他敏感内容：客户端收到的错误信息和服务端日志里都不能出现（Task 2 测试）。
3. 用量文件不存在、内容损坏、跨天、服务重启，以及失败的调用也计数（Task 2 测试）。
4. 同一张图连点两次：第二次因进行中返回 429；识别完成后再提交相同内容，确认卡提示疑似重复（Task 2 测试）。
5. 小票多行命中同一件库存物品（单位相同 / 不同 / 为空）、库存为空、识别出 0 件商品：不丢数量、不重复补货（Task 1、Task 2 测试）。
6. 前端：选了非图片文件、压缩失败、识别失败：按钮恢复可用并给出中文提示，不留下「识别中」的状态（Task 4 手动验证）。

---

## File Structure

- Create `lib/receipt.js` —— 纯函数：配置解析、请求构造、回复解析、去规格、生成录入意图、指纹。
- Create `lib/receipt-service.js` —— `createReceiptService` 与 `ReceiptError`：限额、并发、超时、重复检测、错误映射。依赖 `lib/receipt.js`。
- Create `test/receipt.test.js`、`test/receipt-service.test.js`。
- Modify `server.js` —— 抽出库存列表函数，接入两个路由和启动日志。
- Modify `test/smoke.js` —— 追加未配置场景的几条用例（需要运行中的服务，本机无法运行，交给用户在服务器上跑）。
- Modify `package.json` —— `scripts.test` 加上两个新测试。
- Modify `public/index.html`、`public/app.js`、`public/style.css` —— 相机按钮与流程。
- Modify `README.md`、`DEPLOY.md`、`验收清单.md`。

---

### Task 1: 纯逻辑 `lib/receipt.js`

**Files:**
- Create: `lib/receipt.js`
- Test: `test/receipt.test.js`
- Modify: `package.json`（仅 `scripts.test` 一行；文件开头有 BOM 且 `description` 字段有乱码，都不要动，用精确替换只改这一行）

**Interfaces:**
- Consumes: `lib/parse.js` 已有的 `matchItem(name, items)` 与 `guessCategory(name)`。
- Produces（Task 2 使用）：
  - `PROMPT: string`
  - `resolveConfig(fileCfg: object | undefined, env: object): Config`，`Config = { enabled: boolean, url: string, key: string, model: string, format: 'openai'|'anthropic'|'responses', extra: object, timeoutSec: number, dailyLimit: number, problem: string }`；逐项合并，环境变量优先；`RECEIPT_EXTRA` 整体替换文件里的 `extra`；`problem` 为空串表示没问题，非空时 `enabled` 必为 false，且内容绝不含 key。`timeoutSec` 允许小数（为了测试）。
  - `buildRequest(cfg: Config, base64: string, mime: string): { url: string, headers: object, body: object }`，`extra` 先展开、`model` 等固定字段后写（`extra` 不能覆盖 `model` 与消息字段）。
  - `extractReplyText(format: string, json: any): string`，取不到返回空串。
  - `parseItems(text: string): { store: string, items: { name: string, quantity: number, unit: string }[] } | null`，没有可解析的 JSON 对象或 `items` 不是数组时返回 `null`。
  - `cleanName(name: string): string`，去规格；去完为空则返回原名（已去首尾空白）。
  - `buildIntents(items, stock): Intent[]`，`stock: { id, name, quantity, unit, category, location_id, location_path }[]`；`Intent = { action: 'add'|'restock', name, quantity, unit, category?, existing?, warning? }`，`existing` 就是匹配到的那条库存对象本身。
  - `fingerprint(items): string`，64 位十六进制（sha256）。
- 请求格式、回复取值方式、提示词必须包含的规则，见 Spec「请求格式」「提示词必须包含的规则」。

- [ ] **Step 1: 写失败的测试 `test/receipt.test.js`**（风格同 `test/menu.test.js`：自带 `check(name, cond)`，有失败则 `process.exit(1)`）。用例与断言：
  - `PROMPT`：包含 `JSON`、`购物袋`、`折扣`、`小计`、`合计`、`运费`、`散称`、`kg` 这些词（对应 Spec 里提示词必须包含的规则）。
  - `resolveConfig`：
    - 空文件配置 + 空 env → `enabled === false`、`problem === ''`；
    - 文件 `{url:'https://a/x', key:'sk-secret-123', model:'m'}` → `enabled`，`format==='openai'`、`timeoutSec===60`、`dailyLimit===30`、`extra` 深度等于 `{}`；
    - env `RECEIPT_API_URL='https://b/y'` 覆盖文件的 url，key 仍取文件；
    - env `RECEIPT_EXTRA='{"thinking":{"type":"disabled"}}'` 整体替换文件里的 `extra:{a:1}`；
    - env `RECEIPT_EXTRA='not json'` 与 `'[1]'` → `enabled===false`，`problem` 含 `RECEIPT_EXTRA`，且 `problem` 不含 `sk-secret-123`；
    - `RECEIPT_FORMAT='foo'` → `enabled===false` 且 `problem` 非空；`'responses'` → 正常；
    - `RECEIPT_TIMEOUT_S='5'` → 5，`'0'`、`'abc'` → 60，`'0.05'` → 0.05；
    - `RECEIPT_DAILY_LIMIT='0'` → 0，`'10'` → 10，`'-3'`、`'abc'` → 30。
  - `buildRequest`（base64 用 `'QUJD'`）：
    - `openai`：`url` 原样，`headers.authorization === 'Bearer sk-x'`，`body.messages[0].content[0]` 是 `{type:'text', text: PROMPT}`，`content[1].image_url.url === 'data:image/jpeg;base64,QUJD'`；`extra:{temperature:0}` 合并到 `body.temperature`；`extra:{model:'evil'}` 不能覆盖 `body.model`；
    - `anthropic`：`headers['x-api-key']==='sk-x'`、`headers['anthropic-version']==='2023-06-01'`、无 `authorization`，`body.max_tokens===2000`，`content[0]` 是 `{type:'image', source:{type:'base64', media_type:'image/png', data:'QUJD'}}`，`content[1]` 是文本；
    - `responses`：`body.input[0].content[0]` 是 `{type:'input_image', image_url:'data:image/webp;base64,QUJD'}`，`content[1].type==='input_text'`，且没有 `body.messages`。
  - `extractReplyText`：openai `{choices:[{message:{content:'hi'}}]}` → `'hi'`；anthropic `content:[{type:'text',text:'a'},{type:'tool_use'},{type:'text',text:'b'}]` → `'ab'`；responses `output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text:'x'},{type:'output_text',text:'y'}]}]` → `'xy'`；`null`、`{}` → `''`。
  - `parseItems`：
    - 被 ```` ```json ```` 包住的、前后带多余文字的 JSON 都能解析；纯文字 `'抱歉'` → `null`；`{"store":"x"}`（无 items）→ `null`；`{"items":[]}` → `{store:'', items:[]}`；
    - 清洗：名称去首尾空白，空名丢弃，超过 60 字截到 60；`quantity` 为 `'abc'`、`0`、`-1`、`null` → 1，`2.456` → 2.46；`unit` 超过 8 字截到 8；70 个商品只保留 60 个；非对象元素丢弃；`store` 不是字符串 → `''`；结果里没有日期字段。
  - `cleanName`：`'大娃娃菜 500g'`→`'大娃娃菜'`；`'青虾仁 300g/盒'`→`'青虾仁'`；`'牛奶 250ml*12'`→`'牛奶'`；`'牛奶 250ml×12'`→`'牛奶'`；`'可乐 1.5L'`→`'可乐'`；`'苹果 2斤'`→`'苹果'`；`'陈克明圆挂面800g'`→`'陈克明圆挂面'`；`'大米 5KG'`→`'大米'`；`'NB 内酯豆腐 350g'`→`'NB 内酯豆腐'`；`'500g'`→`'500g'`（去完为空，回退原名）。
  - `buildIntents`（stock：`{id:1,name:'豆腐',quantity:2,unit:'盒',category:'食品',location_id:5,location_path:'厨房 / 冰箱冷藏'}`、`{id:2,name:'酸奶',quantity:6,unit:'瓶',category:'食品',location_id:null,location_path:''}`）：
    - `{name:'NB 内酯豆腐 350g',quantity:1,unit:'盒'}` → `restock`，`existing.id===1`，`quantity===1`，`unit==='盒'`，无 `warning`（品牌前缀只在匹配时去掉）；
    - `{name:'大娃娃菜 500g',quantity:1,unit:'份'}` → `add`，`name==='大娃娃菜'`，`unit==='份'`，`category==='食品'`，无 `existing`；
    - `{name:'NB 混合纯坚果 盐焗味 400g',quantity:1,unit:'罐'}` → `add`，`name==='NB 混合纯坚果 盐焗味'`（新增保留品牌前缀）；
    - 单位不同：`{name:'酸奶',quantity:2,unit:'盒'}` → `restock`，`unit==='瓶'`（预填库存单位），`warning==='小票单位「盒」和库存单位「瓶」不同，请核对数量'`；小票单位为空 → `unit==='瓶'`、无 `warning`；库存单位为空而小票为 `'盒'` → `unit==='盒'`、无 `warning`；
    - 合并：`豆腐 ×1盒` 与 `内酯豆腐 350g ×2盒` → 只有 1 条 `restock`，`quantity===3`；
    - 单位冲突：`豆腐 ×1盒` 与 `豆腐 ×1袋` → 第一条 `restock`（quantity 1，unit `盒`），第二条 `add`（name `豆腐`，unit `袋`），其 `warning==='和已有「豆腐」单位不同，已作为新物品'`；
    - 新增合并：`青菜 ×1份` 与 `青菜 ×2份`（库存无青菜）→ 1 条 `add`，`quantity===3`；`青菜 ×1份` 与 `青菜 ×1袋` → 2 条 `add`；
    - 库存为空 → 全是 `add`；输出顺序与首次出现的顺序一致；`items` 为空 → `[]`。
  - `fingerprint`：商品顺序不同、名称大小写和空格不同 → 相同；改一个数量 → 不同；长度 64 且全是十六进制。
- [ ] **Step 2: 运行确认失败**：`node test/receipt.test.js`，期望 `Cannot find module '../lib/receipt'`。
- [ ] **Step 3: 实现 `lib/receipt.js`**（CommonJS，导出上面列出的七个符号）。要点：回复解析取第一个 `{` 到最后一个 `}`；去规格的规则与测试用例一致（重量/容量单位 `g|kg|ml|l|克|千克|毫升|升|斤`，大小写不敏感，可带 `/盒`、`*12`、`×12` 这类后缀）；匹配库存用的键 = 去规格后的名称再去掉开头的英文品牌前缀（形如 `NB `），交给 `matchItem`；合并按「匹配到的库存物品 id」或「规范化名称」分组，单位比较规则：一边为空或去首尾空白后文字相同才算相同，不做换算。
- [ ] **Step 4: 运行确认通过**：`node test/receipt.test.js`，期望全部 `ok`、退出码 0；再运行 `node test/parse.test.js` 与 `node test/menu.test.js` 确认不受影响。
- [ ] **Step 5: 把 `package.json` 的 `scripts.test` 改为 `node test/parse.test.js && node test/menu.test.js && node test/menu-cal.test.js && node test/receipt.test.js && node test/smoke.js`，并运行 `node -p "JSON.parse(require('fs').readFileSync('package.json','utf8').slice(1)).scripts.test"` 确认仍是合法 JSON（文件开头有 1 个字符的 BOM）。**
- [ ] **Step 6: Commit** —— `git add lib/receipt.js test/receipt.test.js package.json` + `git commit -m "feat(receipt): 小票识别纯逻辑"`（说明末尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）。

---

### Task 2: 识别服务 `lib/receipt-service.js`

**Files:**
- Create: `lib/receipt-service.js`
- Test: `test/receipt-service.test.js`
- Modify: `package.json`（仅 `scripts.test` 一行，见 Step 5）

**Interfaces:**
- Consumes: Task 1 的 `buildRequest`、`extractReplyText`、`parseItems`、`buildIntents`、`fingerprint`（`Config` 形状见 Task 1）。
- Produces（Task 3 使用）：
  - `class ReceiptError extends Error`，字段 `status: number`，构造 `new ReceiptError(status, message)`。
  - `createReceiptService({ getConfig, getStock, dataDir, fetchImpl = fetch, today, nowMs = Date.now, log = console.log }): { status(): { enabled: boolean }, scan(buf: Buffer, mime: string): Promise<{ text: string, intents: Intent[], duplicate: boolean, count: number }> }`
    - `getConfig(): Config`（每次调用时取最新配置）；`getStock(): StockItem[]`；`today(): string`（`YYYY-MM-DD`，默认取服务器本地日期）。
    - `fetchImpl(url, { method:'POST', headers, body: <JSON 字符串>, signal })` 返回带 `ok`、`status`、`text()` 的对象。
  - `scan` 的执行顺序与错误（`ReceiptError`，消息原文如下）：
    1. 未配置 → 503「识别服务未配置」（不计数、不转发）；
    2. 有请求进行中 → 429「正在识别上一张，请稍等」；
    3. `dailyLimit > 0` 且今日已用 ≥ 上限 → 429「今天的识别次数用完了」；
    4. 计数 +1 并立即写入 `dataDir/receipt-usage.json`（`{ date, count }`，跨天自动归零；文件不存在或内容损坏按今日 0 次处理），置「进行中」，转发（带 `AbortSignal.timeout(timeoutSec * 1000)`）；无论成败，结束时清除「进行中」；
    5. 超时 → 504「识别超时」；网络错误 → 502「连不上识别服务，请稍后再试」；识别服务返回 401/403 → 502「识别服务拒绝了请求，请检查服务器上的 key」；其他非 2xx → 502「识别服务出错（HTTP <状态码>），请稍后再试」；响应文本超过 2 MB、回复里取不到文字、`parseItems` 返回 `null` → 502「识别服务返回了无法理解的内容，请重拍或手动录入」；
    6. 成功：`count = items.length`；`text` 为 `小票识别：<店名>，共 <count> 件`（无店名则 `小票识别：共 <count> 件`）；`intents = buildIntents(items, getStock())`；`duplicate`：`count > 0` 时，用 `fingerprint(items)` 查内存表（保留 48 小时、最多 100 个，超出丢最旧的），命中为 true，并刷新时间；`count === 0` 时 `duplicate` 为 false 且不记指纹。
  - 任何错误消息、`log` 调用都不得包含 key 或识别服务响应原文；`log` 只记录通用信息（如「识别服务返回 HTTP 500」）。

- [ ] **Step 1: 写失败的测试 `test/receipt-service.test.js`**（自带 `check`；用 `fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'))` 建临时目录；用假的 `fetchImpl` 记录调用并返回预设回复；用假的 `today`/`nowMs` 控制时间；`log` 用收集数组）。用例与断言：
  - `未配置`：`status()` 为 `{enabled:false}`；`scan` 抛 `ReceiptError`，`status===503`，消息为「识别服务未配置」，假 `fetchImpl` 未被调用，用量文件不存在。
  - `成功（openai）`：回复 `choices[0].message.content` 为 `{"store":"测试店","items":[{"name":"大娃娃菜 500g","quantity":1,"unit":"份"},{"name":"豆腐","quantity":2,"unit":"盒"}]}`，库存里有 `豆腐` → 返回 `count===2`、`text==='小票识别：测试店，共 2 件'`、`duplicate===false`、第一条 `add`、第二条 `restock`；假 `fetchImpl` 恰好被调用一次，参数里 `headers.authorization` 为 `Bearer <key>`、`body` 里含 `data:image/jpeg;base64,`、传入了 `signal`；无店名时 `text==='小票识别：共 2 件'`。
  - `用量`：`dailyLimit:2`，三次 `scan`（每次回复不同）→ 第三次 429「今天的识别次数用完了」，用量文件为 `{date: today, count: 2}`；用同一目录新建第二个 service → 同一天仍 429（持久化）；`today` 换成第二天 → 可以用，文件变为 `count:1`；`dailyLimit:0` → 连续 5 次都成功。
  - `失败也计数`：识别服务返回 500 一次后，文件 `count===1`。
  - `用量文件损坏`：文件内容为 `not json` → `scan` 成功，文件被重写为合法 JSON 且 `count===1`；文件内 `date` 是昨天 → 按 0 处理。
  - `并发`：第一个 `scan` 的假 `fetchImpl` 返回一个未完成的 Promise；此时第二个 `scan` 立即抛 429「正在识别上一张，请稍等」且假 `fetchImpl` 只被调用过一次、计数不增加；让第一个完成后，第三个 `scan` 成功；第一个失败（识别服务 500）后「进行中」同样被清除。
  - `超时`：`timeoutSec:0.05`，假 `fetchImpl` 在 `signal` 中止时 reject（用 `signal.reason`）→ 抛 504「识别超时」，之后「进行中」已清除。
  - `网络错误`：假 `fetchImpl` reject `new TypeError('fetch failed')` → 502「连不上识别服务，请稍后再试」。
  - `错误映射且不泄露`：key 为 `sk-secret-123`；识别服务返回 401，响应体 `{"error":"bad key sk-secret-123 and header x-secret"}` → 502「识别服务拒绝了请求，请检查服务器上的 key」；403 同；500 → 「识别服务出错（HTTP 500），请稍后再试」；429 → 「识别服务出错（HTTP 429），请稍后再试」；所有抛出的消息和 `log` 收集到的内容都不含 `sk-secret-123`、`bad key`、`x-secret`。成功路径的 `log` 同样不含 key。
  - `无法理解`：回复文字 `抱歉`、`{"store":"x"}`（无 items）、`{"items":"no"}`、回复里取不到文字（`choices` 缺失）、响应文本长度超过 2 MB → 全部 502「识别服务返回了无法理解的内容，请重拍或手动录入」；`{"items":[]}` → 成功，`count===0`、`intents` 为空数组、`duplicate===false`；被 Markdown 代码块包住的合法回复 → 成功。
  - `重复`：同一回复连续两次 → 第一次 `duplicate===false`、第二次 `true`；改一个数量 → `false`；`nowMs` 推进 49 小时后再提交同一回复 → `false`；依次提交 101 个互不相同的回复后，第一个回复再次提交 → `false`（最旧的已被丢弃）；`count===0` 的回复不产生指纹。
  - 三种格式各一条成功用例（`anthropic`、`responses` 的假回复用 Task 1 里同样的形状），确认 `extractReplyText` 接得上。
- [ ] **Step 2: 运行确认失败**：`node test/receipt-service.test.js`，期望 `Cannot find module '../lib/receipt-service'`。
- [ ] **Step 3: 实现 `lib/receipt-service.js`**（CommonJS，导出 `createReceiptService`、`ReceiptError`）。用量计数首次使用时从文件加载并缓存在内存，每次计数后同步写文件；「进行中」用 `try/finally` 清除；读取响应用 `await res.text()` 后用 `Buffer.byteLength` 检查是否超过 2 MB。
- [ ] **Step 4: 运行确认通过**：`node test/receipt-service.test.js`，期望全部 `ok`、退出码 0；再运行 `node test/receipt.test.js`、`node test/menu.test.js`、`node test/parse.test.js`。
- [ ] **Step 5: Commit** —— 先把 `package.json` 的 `scripts.test` 改为 `node test/parse.test.js && node test/menu.test.js && node test/menu-cal.test.js && node test/receipt.test.js && node test/receipt-service.test.js && node test/smoke.js`（同样只改这一行，改完用 Task 1 Step 5 的命令确认仍是合法 JSON），然后 `git add lib/receipt-service.js test/receipt-service.test.js package.json` + `git commit -m "feat(receipt): 识别服务（限额、并发、超时、重复检测）"`（说明末尾加署名行）。

---

### Task 3: 服务器接口

**Files:**
- Modify: `server.js`（`/api/parse` 路由约第 419–425 行；新路由放在它之后；启动日志在 `server.listen` 回调附近）
- Modify: `test/smoke.js`

**Interfaces:**
- Consumes: Task 1 的 `resolveConfig`；Task 2 的 `createReceiptService`、`ReceiptError`；`server.js` 里已有的 `route`、`json`、`readImage(req, limitMB)`、`HttpError`、`config`、`DATA_DIR`、`withPath`、`ITEM_SELECT`、`LIVE`。
- Produces（Task 4 使用）：`GET /api/receipt/status` → `{ enabled: boolean }`；`POST /api/receipt/scan` → `{ text, intents, duplicate, count }`，错误统一为 `{ error: '<中文消息>' }`，状态码见 Task 2。

- [ ] **Step 1: 在 `server.js` 里接线。**
  - 把 `/api/parse` 里构造库存匹配列表的那一行抽成函数 `stockItemsForMatch()`（返回 `{ id, name, quantity, unit, category, location_id, location_path }[]`，只含未删除的物品），`/api/parse` 改为调用它，行为不变。
  - 用 `createReceiptService({ getConfig: () => resolveConfig(config.receipt, process.env), getStock: stockItemsForMatch, dataDir: DATA_DIR })` 创建服务；绝不要把环境变量合并进 `config` 对象。
  - 新增路由 `GET /api/receipt/status`（返回 `receipt.status()`）和 `POST /api/receipt/scan`：先检查 `receipt.status().enabled`，未启用直接抛 `HttpError(503, '识别服务未配置')`（不读请求体）；然后 `readImage(req, 8)` 读图并取得 MIME；调用 `receipt.scan(buf, mime)` 并 `json(res, 200, 结果)`；把捕获到的 `ReceiptError` 转成 `HttpError(e.status, e.message)`（现有的统一错误处理只认 `HttpError`，其他错误会变成 500）。
  - 启动时调用一次 `resolveConfig(config.receipt, process.env)`：`problem` 非空就打印「小票识别配置有问题：<problem>」；`enabled` 就打印「小票识别已启用（模型 <model>）」，两条日志都不打印 key 和地址。
- [ ] **Step 2: 追加冒烟用例到 `test/smoke.js`**（沿用其 `call`、`json`、`assert` 辅助；这些用例假定服务启动时没有设置任何 `RECEIPT_*` 环境变量，也没有 `receipt` 配置）：未登录 `GET /api/receipt/status` → 401；登录后 → 200 且 `enabled === false`；`POST /api/receipt/scan`（任意小字节，`content-type: image/jpeg`）→ 503，`error` 含「识别服务未配置」。
- [ ] **Step 3: 检查。** 运行 `node --check server.js`、`node --check test/smoke.js`，再运行 `node test/receipt.test.js`、`node test/receipt-service.test.js`、`node test/menu.test.js`、`node test/parse.test.js`、`node test/menu-cal.test.js`；用 Grep 确认 `server.js` 里出现 `/api/receipt/status`、`/api/receipt/scan`，且改密码相关的 `saveConfig()` 周围没有把环境变量塞进 `config`。冒烟测试需要运行中的服务，在本机无法运行，在报告里写明「冒烟用例未运行，交给用户在服务器上跑」。
- [ ] **Step 4: Commit** —— `git add server.js test/smoke.js` + `git commit -m "feat(receipt): 小票识别接口"`（说明末尾加署名行）。

---

### Task 4: 前端与文档

**Files:**
- Modify: `public/index.html`（图标 symbol、相机按钮、隐藏文件框、提示文字）
- Modify: `public/app.js`（`SOURCE_TEXT` 约第 92 行；`enterApp` 约第 117 行；一句话录入与确认卡约第 281–365 行）
- Modify: `public/style.css`
- Modify: `README.md`、`DEPLOY.md`、`验收清单.md`

**Interfaces:**
- Consumes: Task 3 的两个接口；现有 `compressImage(file, max, quality)`、`api(url, opts)`、`toast(msg, ms)`、`esc()`、`showConfirm(r)`、`#quick-form`、`#quick-hint`、`#cf-list`、`#cf-note`、`cf-ok` 点击处理。
- Produces: 无（终端任务）。

- [ ] **Step 1: `index.html`。** 增加 `i-camera` 图标 symbol（24×24 描线风格，同现有图标）；在 `#quick-form` 里输入框与「录入」按钮之间放 `<button type="button" id="receipt-btn" class="btn small hidden" …>`（只含相机图标，带 `title` 与 `aria-label`「拍小票录入」），旁边放一个 `accept="image/*"` 的隐藏 `<input type="file" id="receipt-file">`（不加 `capture`）；在 `#quick-hint` 末尾加一个默认隐藏的 `<span id="receipt-hint">`，文字「也可以点相机拍小票。图片只发给识别服务，不会保存。」
- [ ] **Step 2: `app.js` —— 来源可传入。** 新增变量 `cfSource`（默认 `'quick'`）；`showConfirm(r)` 开头设置 `cfSource = r.source || 'quick'`，并支持两个可选字段：`r.notice`（非空时在 `#cf-list` 上方显示一条警告）和 `r.note`（非空时替换 `#cf-note` 的默认文字）；一句话录入提交时不带这些字段，行为不变。`cf-ok` 处理里所有写死的 `?source=quick` 改为 `?source=${cfSource}`；用 Grep 确认确认卡处理里不再有写死的 `source=quick`。`SOURCE_TEXT` 加 `receipt: '小票'`。
- [ ] **Step 3: `app.js` —— 相机流程。** `enterApp` 载入数据后请求 `/api/receipt/status`（失败当作未启用）：启用则显示 `#receipt-btn` 和 `#receipt-hint`，否则保持隐藏。点相机按钮打开文件框；选图后：先清空文件框的值（便于重复选同一张）；不是图片则 toast「请选择图片」；设置「识别中」状态（按钮禁用，并给出「识别中，请稍等…」的提示，识别结束要清掉该提示）；用 `compressImage(file, 1800, 0.85)` 压缩；`api('/api/receipt/scan', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob })`；`intents` 为空 → toast「没识别出商品，换张更清晰的图试试」；否则 `showConfirm({ text: r.text, intents: r.intents, source: 'receipt', notice: r.duplicate ? '这张小票好像已经录入过了，请确认不是重复。' : '', note: '按小票识别，请核对数量和单位；位置和到期日小票上没有，请自己选。' })`。任何失败（压缩失败、服务器错误）都 toast 服务器返回的中文消息，并保证按钮恢复可用、提示被清掉。所有展示识别结果的地方继续走现有确认卡里的 `esc()`。
- [ ] **Step 4: `style.css`。** 相机按钮的样式（与「录入」按钮同高，只有图标，宽屏下 `#app > .quick` 的布局不被破坏）；`notice` 警告沿用现有 `.warn` 样式。
- [ ] **Step 5: 文档。** `README.md` 功能表加一行「小票录入」（入口在物品页相机按钮；识别服务需自己配置；永远先确认；图片不保存）。`DEPLOY.md`「4. 可调配置」下加一个「小票识别（可选）」小节：`data/config.json` 的 `receipt` 示例（`url`、`key`、`model`、`format`、`extra`、`timeoutSec`、`dailyLimit`）与对应环境变量表；推荐写在 `config.json` 里并执行 `chmod 600 data/config.json`（systemd 单元文件通常所有人可读，不要把 key 写在里面）；改完配置要重启服务；说明三种 `format` 的适用场景和地址写法（`openai` 对应 `.../chat/completions`，`anthropic` 对应 `.../v1/messages`，`responses` 对应 `.../responses`）；说明 `extra` 可用来关闭思考（如 `{"thinking":{"type":"disabled"}}`）或设置 `max_tokens` / `max_completion_tokens` / `max_output_tokens`；提醒图片会发给所配置的服务，以及每日次数上限。`验收清单.md` 末尾追加「小票录入（待浏览器验收）」小节，逐项为未勾选的 `- [ ]`：未配置时看不到相机按钮；配置后出现；拍照或选相册图后弹出确认卡；库存里有的显示「补货」、没有的显示「新增」；单位不同时出现警告；同一张小票再次识别提示疑似重复；识别失败有中文提示且按钮恢复；确认后变动记录里来源显示「小票」；每日次数用完后有提示；key 不出现在页面和接口响应里。
- [ ] **Step 6: 检查。** 运行 `node --check public/app.js`，并运行全部单元测试（`node test/parse.test.js`、`node test/menu.test.js`、`node test/menu-cal.test.js`、`node test/receipt.test.js`、`node test/receipt-service.test.js`）。用 Grep 确认：`index.html` 里有 `receipt-btn`、`receipt-file`、`i-camera`；`app.js` 里 `SOURCE_TEXT` 含 `receipt`。浏览器里的完整流程（Review Focus 第 6 条）需要用户在自己的服务器上验证，报告里写明「未在浏览器验证」，不要声称已验证。
- [ ] **Step 7: Commit** —— `git add public README.md DEPLOY.md 验收清单.md` + `git commit -m "feat(receipt): 物品页相机按钮与确认流程"`（说明末尾加署名行）。
