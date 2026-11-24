# 语音录入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物品页加麦克风按钮：点一下录音、再点一下结束 → 浏览器转成 16kHz 单声道 WAV → 服务器转发给可配置的语音识别服务 → 文字填入一句话录入框并自动解析 → 弹出现有确认卡。同时让一句话解析器能处理「一口气说多件事」。

**Architecture:** 小票识别和语音识别共用的防护逻辑（响应读取上限、超时、错误映射、每日用量持久化）抽成 `lib/provider-guard.js`，两个服务各自维护自己的「进行中」状态；语音的纯逻辑放 `lib/asr.js`，带状态的流程放 `lib/asr-service.js`，全部可用注入的假 `fetch`、临时目录离线测试；`parseMulti` 先拆句再逐句交给现有 `parse`；WAV 编码是纯函数模块，浏览器和 Node 通用；`server.js` 只做薄胶水；前端复用现有确认卡。

**Tech Stack:** Node ≥ 22.5（自带 `fetch`、`AbortSignal.timeout`），原生 JS 前端（`MediaRecorder`、`AudioContext.decodeAudioData`），零第三方依赖；测试沿用 `test/*.test.js` 的 Node 断言风格。

**Spec:** `docs/superpowers/specs/2026-11-24-voice-input-design.md`（执行者必须一并阅读，尤其是「已定的设计」和末尾「我替用户做的决定」）。参考实现：`lib/receipt.js`、`lib/receipt-service.js` 及其测试，语音识别的结构与它们对称。

## Global Constraints

- 零第三方依赖；Node ≥ 22.5；用 Node 自带 `fetch`，不新增 npm 包。
- key 只存在于服务器配置（`config.json` 的 `asr` 字段或环境变量）；不通过任何接口返回，不写日志，错误信息和 `problem` 提示里也不能出现 key 或识别服务的响应原文。环境变量的值永远不写回 `config.json`；改密码重写配置后 `asr` 字段必须保留。
- 环境变量：`ASR_API_URL`、`ASR_API_KEY`、`ASR_MODEL`、`ASR_FORMAT`（第一版只有 `responses`，默认 `responses`）、`ASR_EXTRA`、`ASR_TIMEOUT_S`（默认 30，允许小数）、`ASR_DAILY_LIMIT`（默认 100，0 表示不限）、`ASR_MAX_SECONDS`（默认 30，正整数，最大 60；其他值回到 30）。
- 录音只上传 WAV（`audio/wav`），最大 2 MB；响应读取最多 2 MB（边读边限）；识别文字最长 200 字符；每次最多拆 5 句；用量计数存 `data/asr-usage.json`（服务器本地日期，失败也计数，415/413/上传中断不计数）。
- 语音与小票各自独立的「进行中」标志和用量，互不阻塞。
- 永远先弹确认卡，不直接改库存；没配置语音识别时其他功能不受影响；录音不保存。
- 界面文字和错误提示全部用中文；所有来自识别结果的文字渲染必须转义。

## Review Focus

1. 识别服务回复的各种形状：缺 `output`（→ 502「无法理解」）、`output` 在但没文字（→ 200 空文字）、被引号或「识别结果：」包着、超过 200 字、响应超过 2 MB、响应不是 JSON（Task 3、4 测试）。
2. 识别服务的错误响应回显了 key：客户端提示和日志里都不能出现（Task 1、4 测试）。
3. 多句话：句内的标点、超过 5 句、某一句解析不出意图、只有一句时必须与 `parse` 完全一致（Task 2 测试）。
4. 空白的处理：两个汉字之间当分隔，数字或字母旁边的空白不动，空白紧挨标点（Task 3 测试）。
5. 次数与并发：415/413/上传中断不计数，失败的调用计数，语音和小票可以同时进行（Task 4、5 测试）。
6. 前端：没有麦克风权限、没有麦克风、页面不是 HTTPS、浏览器解码失败、识别失败、点得太快：按钮恢复可用，没有残留的「录音中」或「识别中」状态（Task 7 手动验证）。

---

## File Structure

- Create `lib/provider-guard.js` —— 共用防护：`ServiceError`、响应读取、超时换算、错误映射的 `callProvider`、每日用量 `createUsage`。
- Modify `lib/receipt-service.js` —— 改用 `provider-guard.js`（行为不变，现有 54 项测试保持通过）。
- Modify `lib/parse.js` —— 新增 `parseMulti`。
- Create `lib/asr.js`、`lib/asr-service.js`。
- Create `public/wav.js` —— WAV 编码与重采样（纯函数）。
- Create tests：`test/provider-guard.test.js`、`test/asr.test.js`、`test/asr-service.test.js`、`test/wav.test.js`；Modify `test/parse.test.js`、`test/smoke.js`。
- Modify `server.js`、`public/index.html`、`public/app.js`、`public/style.css`、`package.json`、`README.md`、`DEPLOY.md`、`验收清单.md`。

---

### Task 1: 共用防护模块 `lib/provider-guard.js` 并让小票识别改用它

**Files:**
- Create: `lib/provider-guard.js`
- Test: `test/provider-guard.test.js`
- Modify: `lib/receipt-service.js`、`package.json`（仅 `scripts.test` 一行；文件开头有 1 个字符的 BOM，且 `description` 有乱码，都不要动，用精确替换只改这一行）

**Interfaces:**
- Produces（Task 4 与 `receipt-service` 使用）：
  - `class ServiceError extends Error`，字段 `status: number`，构造 `new ServiceError(status, message)`。
  - `MAX_RESPONSE_BYTES: number`（2 MiB）。
  - `localDate(): string`（服务器本地日期 `YYYY-MM-DD`）。
  - `timeoutMs(sec: number): number`（整数毫秒，至少 1，最多 2**31-1）。
  - `callProvider({ fetchImpl, url, headers, body, timeoutSec, log, unreadable, ErrorClass = ServiceError }): Promise<string>`：以 `POST` 转发 `JSON.stringify(body)`，带 `AbortSignal.timeout(timeoutMs(timeoutSec))`；成功返回响应文本。错误一律抛 `new ErrorClass(status, 消息)`：超时 → 504「识别超时」；其他网络错误 → 502「连不上识别服务，请稍后再试」；HTTP 401/403 → 502「识别服务拒绝了请求，请检查服务器上的 key」；其他非 2xx → 502「识别服务出错（HTTP <状态码>），请稍后再试」；响应超过 2 MiB（`content-length`、边读边限、或没有可读流时读完后检查）→ 502 + `unreadable`。HTTP 出错时必须丢弃响应体（`body.cancel()`），超限时必须取消流；`log` 只记录通用信息（如「识别服务返回 HTTP 500」），绝不记录响应原文、请求头或 key。
  - `createUsage({ file, today = localDate, log = console.log }): { tryConsume(limit: number): boolean }`：首次使用时从文件加载并缓存；文件不存在、内容损坏、日期不是今天都按今天 0 次处理；`limit > 0` 且今日已用 ≥ `limit` 返回 `false`（不计数）；否则计数 +1、同步写入文件（`{ date, count }`）、返回 `true`；写文件失败只 `log`，仍返回 `true`；`limit` 为 0 表示不限。
- 现有 `ReceiptError` 要改成 `class ReceiptError extends ServiceError`（继续从 `receipt-service.js` 导出，现有测试里的 `instanceof ReceiptError` 判断必须继续成立，`callProvider` 用 `ErrorClass: ReceiptError`）。

- [ ] **Step 1: 写失败的测试 `test/provider-guard.test.js`**（自带 `check`；临时目录用 `fs.mkdtempSync`；测试脚本里用 `setInterval` 保活，结束时清除，因为 `AbortSignal.timeout` 的定时器不会让进程保持运行；参考 `test/receipt-service.test.js` 里已有的假 `fetch`、流和断言写法）。用例：
  - `ServiceError`：是 `Error` 的实例，有 `status` 和 `message`；`class X extends ServiceError {}` 的实例也满足 `instanceof ServiceError`。
  - `timeoutMs`：`1.1` → 1100；`1e7` → 2147483647；`0` → 1。
  - `createUsage`：`limit 2` 时连续三次返回 `true,true,false`，文件内容是 `{date: today, count: 2}`；用同一文件新建实例（模拟重启）仍是 `false`；`today` 换成第二天返回 `true`、文件 `count:1`；`limit 0` 连续 5 次都 `true`；文件内容 `not json` 按 0 处理并被重写成合法 JSON；文件里是昨天的日期按 0 处理；目录不存在导致写文件失败时 `tryConsume` 仍返回 `true` 且 `log` 被调用。
  - `callProvider`：成功返回响应文本，假 `fetch` 收到 `method:'POST'`、传入的 `headers`、`JSON.stringify` 过的 `body` 和 `signal`；`timeoutSec:0.05` 且假 `fetch` 在 `signal` 中止时 reject → 抛 504「识别超时」；`timeoutSec:1.1` 正常；`fetch` reject `new TypeError('fetch failed')` → 502「连不上识别服务，请稍后再试」；状态码 401、403 → 502「识别服务拒绝了请求，请检查服务器上的 key」，500、429 → 502「识别服务出错（HTTP 500），请稍后再试」（429 同理），响应体里含 key `sk-secret-123` 和 `bad key` 时，抛出的消息和 `log` 收集到的内容都不含它们；超过 2 MiB 的流（每块 1 MiB）读到不超过 4 块就中止并 `cancel`，抛 502 + `unreadable`；`content-length` 超过 2 MiB 时不读响应体、直接 `cancel`；HTTP 出错时响应体被 `cancel`；中文 JSON 被切成 7 字节一块的流能正确拼回；没有 `body` 流的假响应（只有 `text()`）也能工作，且 `text()` 返回超过 2 MiB 的字符串时抛 502 + `unreadable`；传入 `ErrorClass` 时抛出的是该类的实例。
- [ ] **Step 2: 运行确认失败**：`node test/provider-guard.test.js`，期望 `Cannot find module '../lib/provider-guard'`。
- [ ] **Step 3: 实现 `lib/provider-guard.js`**：把 `lib/receipt-service.js` 里现有的 `discard`、`readLimited`、`timeoutMs`、`localDate`、用量加载/保存、以及 `forward` 里「发请求 + 读响应 + 错误映射」那一段按上面的接口搬过来（逻辑和消息不变，`callProvider` 里把 `ErrorClass`、`unreadable` 参数化）。
- [ ] **Step 4: 运行确认通过**：`node test/provider-guard.test.js`，期望全部 `ok`、退出码 0。
- [ ] **Step 5: 重构 `lib/receipt-service.js` 使用它**：删掉被搬走的函数，`createReceiptService` 内部用 `createUsage({ file: path.join(dataDir, 'receipt-usage.json'), today, log })` 的 `tryConsume(cfg.dailyLimit)` 和 `callProvider({ …, unreadable: UNREADABLE, ErrorClass: ReceiptError })`；「未配置 → 并发 → 用量 → 转发」的顺序、`busy`/`finally` 清除、重复指纹逻辑、所有错误消息保持不变。运行 `node test/receipt-service.test.js` 与 `node test/receipt.test.js`，期望仍是 54 项和 64 项全部通过（它们是这次重构的安全网，不要改动这两个测试文件）。
- [ ] **Step 6: 把 `package.json` 的 `scripts.test` 里 `node test/receipt-service.test.js` 之后加上 `node test/provider-guard.test.js`，用 `node -p "JSON.parse(require('fs').readFileSync('package.json','utf8').slice(1)).scripts.test"` 确认仍是合法 JSON。**
- [ ] **Step 7: Commit** —— `git add lib/provider-guard.js lib/receipt-service.js test/provider-guard.test.js package.json` + `git commit -m "refactor(receipt): 抽出共用防护模块 provider-guard"`（说明末尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）。

---

### Task 2: 多句话解析 `parseMulti`

**Files:**
- Modify: `lib/parse.js`（新增并导出 `parseMulti`）、`server.js`（`/api/parse` 路由）
- Test: `test/parse.test.js`

**Interfaces:**
- Consumes: 现有 `parse(text, ctx)`，返回 `{ text, intents, confidence }`。
- Produces（Task 7 使用）：`parseMulti(text: string, ctx): { text, intents, confidence, truncated?: true }`。
  - 先按 `[。！!？?；;\n]+` 把原文拆成句子，每句去首尾空白，丢弃空句；超过 5 句时只取前 5 句并在返回里加 `truncated: true`（不超过时不出现这个键）。
  - 对每句调用 `parse(句子, ctx)`，按顺序合并所有意图；`text` 返回原文。
  - 只有一句（或没有任何分隔符）时，返回必须与 `parse(text, ctx)` 完全一致（深度相等，且没有 `truncated` 键）。
  - `confidence`：取各句里最低的（`none` < `low` < `medium` < `high`）；某一句没有解析出意图时整体至多为 `low`；全部都没有意图为 `none`。
  - `/api/parse` 改为调用 `parseMulti`，原样透传 `truncated`；200 字限制不变。

- [ ] **Step 1: 写失败的测试（改 `test/parse.test.js`）。** ① 在文件里现有的 `check(text, expect)` 函数末尾增加一条断言：对同一个 `text`，`JSON.stringify(parseMulti(text, ctx)) === JSON.stringify(parse(text, ctx))`（作为额外的一次 `pass`/`fail` 计数，失败时打印该句子），这样所有现有句子自动成为兼容性回归用例；文件顶部同时 `require` 出 `parseMulti`。② 新增用例（沿用文件里的 `ctx`，库存里有 `创可贴`、`速冻水饺`、`电钻`、`5 号电池`，没有鸡蛋、五花肉）：
  - `'把鸡蛋放入冰箱冷藏。买了五花肉一盒'` → 2 条：`add 鸡蛋`（位置 `厨房 / 冰箱冷藏`）、`add 五花肉`（`quantity:1`、`unit:'盒'`）。
  - `'买了两盒酸奶放冷藏；创可贴用完了'` → `add 酸奶`（2 盒、`厨房 / 冰箱冷藏`）和 `deplete 创可贴`。
  - 用 `\n`、`!`、`?`、`;` 分隔的各一例（如 `'买了牛奶!买了鸡蛋'`）都得到 2 条。
  - `'买了牛奶。。 。买了鸡蛋。'`（含空句）→ 2 条。
  - 7 句 → 只有前 5 句的意图，且 `truncated === true`；恰好 5 句 → 没有 `truncated` 键。
  - `confidence`：`'买了牛奶。买了鸡蛋'` 为 `high`；`'买了牛奶。哈哈'`（后一句走兜底）为 `low`；`'买了牛奶。嗯'`（后一句没有意图）为 `low` 且意图数为 1；`'嗯'` 为 `none`。
  - 返回的 `text` 是原文（含句号）。
- [ ] **Step 2: 运行确认失败**：`node test/parse.test.js`，期望 `parseMulti is not a function` 之类的失败（或新增用例失败）。
- [ ] **Step 3: 实现 `parseMulti` 并导出**；改 `server.js` 的 `/api/parse` 调用它（`parseCommand` 的引用换成 `parseMulti`）。
- [ ] **Step 4: 运行确认通过**：`node test/parse.test.js`，期望全部通过（原有用例数加上每个用例的等价断言再加新用例）；再运行 `node --check server.js`。
- [ ] **Step 5: Commit** —— `git add lib/parse.js server.js test/parse.test.js` + `git commit -m "feat(parse): 一句话解析支持用句号隔开的多件事"`（说明末尾加署名行）。

---

### Task 3: 语音识别纯逻辑 `lib/asr.js`

**Files:**
- Create: `lib/asr.js`
- Test: `test/asr.test.js`
- Modify: `package.json`（`scripts.test` 一行）

**Interfaces:**
- Produces（Task 4 使用）：
  - `PROMPT: string`
  - `resolveConfig(fileCfg: object | undefined, env: object): Config`，`Config = { enabled, url, key, model, format, extra, timeoutSec, dailyLimit, maxSeconds, problem }`；规则与 `lib/receipt.js` 的 `resolveConfig` 相同（逐项合并、环境变量优先、`ASR_EXTRA` 整体替换、非法值回到默认、`problem` 绝不含 key），差别：默认 `timeoutSec` 30、`dailyLimit` 100、`format` 只接受 `responses`（其他值 → 未配置并给 `problem`）、新增 `maxSeconds`（正整数，上限 60，其他值回到 30）。
  - `buildRequest(cfg: Config, base64: string): { url, headers, body }`：头 `authorization: Bearer <key>`、`content-type: application/json`；体 `{ ...cfg.extra, model: cfg.model, input: [{ role:'user', content:[{ type:'input_text', text: PROMPT }, { type:'input_audio', audio_url: 'data:audio/wav;base64,<base64>' }] }] }`（`extra` 不能覆盖 `model` 与 `input`）。
  - `extractReplyText(json: any): string | null`：`json.output` 不是数组（或 `json` 不是对象）返回 `null`；否则取所有 `type:'message'` 项的 `content` 中 `type:'output_text'` 的文字拼接，没有文字返回 `''`。
  - `normalizeTranscript(text: any): string`：非字符串或空白 → `''`；换行当句子分隔；两个汉字（`一-鿿`）之间的空白（含全角空格）替换为「。」，数字或字母旁边的空白不动；紧挨句子分隔符「。！!？?；;」的空白去掉；连续的句子分隔符只留第一个；去掉首尾的分隔符；最长保留 200 个字符；其他标点（如「，」）不动。
- `PROMPT` 必须包含 Spec 里列出的规则：逐字转写、只返回文字不要解释、家庭物品录入的口语并给例句、几件互相独立的事用「。」隔开、不要在句子中间加空格、数字用阿拉伯数字。

- [ ] **Step 1: 写失败的测试 `test/asr.test.js`**（风格同 `test/receipt.test.js`）。用例：
  - `PROMPT`：包含 `。`、`空格`、`阿拉伯数字`、`酸奶`（例句）、`只返回`。
  - `resolveConfig`：空配置未启用且无 `problem`；文件 `{url,key:'sk-secret-123',model}` 启用，默认 `format==='responses'`、`timeoutSec===30`、`dailyLimit===100`、`maxSeconds===30`、`extra` 为 `{}`；环境变量逐项覆盖文件；`ASR_EXTRA` 整体替换文件里的 `extra`；`ASR_EXTRA` 为 `not json` 或 `[1]` → 未配置、`problem` 含 `ASR_EXTRA` 且不含 key；`ASR_FORMAT='openai'` → 未配置且 `problem` 非空；`ASR_TIMEOUT_S` `'5'→5`、`'0.05'→0.05`、`'0'/'abc'→30`；`ASR_DAILY_LIMIT` `'0'→0`、`'10'→10`、`'-3'/'abc'→100`；`ASR_MAX_SECONDS` `'45'→45`、`'500'→60`、`'0'/'abc'/'-1'/'1.5'→30`；三项只配了两项 → 未配置且 `problem` 提到缺哪一项、不含 key。
  - `buildRequest`（base64 用 `'QUJD'`）：`url` 原样；`authorization === 'Bearer sk-x'`；`body.input[0].content[0]` 是 `{type:'input_text', text: PROMPT}`；`content[1]` 深度等于 `{type:'input_audio', audio_url:'data:audio/wav;base64,QUJD'}`；`extra:{thinking:{type:'disabled'}}` 合并进 `body.thinking`；`extra:{model:'evil', input:'evil'}` 不能覆盖。
  - `extractReplyText`：`{output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text:'x'},{type:'output_text',text:'y'}]}]}` → `'xy'`；`{output:[]}` → `''`；`{}`、`null`、`{output:'no'}` → `null`。
  - `normalizeTranscript`：`'把鸡蛋放入冰箱冷藏 买了五花肉一盒'` → `'把鸡蛋放入冰箱冷藏。买了五花肉一盒'`；`'买了 2 盒酸奶'` 不变；`'买了牛奶\n买了鸡蛋'` → `'买了牛奶。买了鸡蛋'`；`'买了牛奶　买了鸡蛋'` → `'买了牛奶。买了鸡蛋'`；`'买了牛奶 。 买了鸡蛋'` → `'买了牛奶。买了鸡蛋'`；`'买了牛奶。。买了鸡蛋'` → `'买了牛奶。买了鸡蛋'`；`'。买了牛奶。'` → `'买了牛奶'`；`'买了牛奶，放冷藏'` 不变；250 个汉字 → 长度 200；`''`、`'   '`、`null`、`123` → `''`。
- [ ] **Step 2: 运行确认失败**：`node test/asr.test.js`，期望 `Cannot find module '../lib/asr'`。
- [ ] **Step 3: 实现 `lib/asr.js`**（CommonJS，导出上面五个符号；`resolveConfig` 的结构可参照 `lib/receipt.js`，但不要从它 `require`，两者的默认值和格式集合不同）。
- [ ] **Step 4: 运行确认通过**：`node test/asr.test.js`，期望全部 `ok`、退出码 0。
- [ ] **Step 5: 把 `package.json` 的 `scripts.test` 里 `node test/provider-guard.test.js` 之后加上 `node test/asr.test.js`（同样只改这一行，改完确认仍是合法 JSON）。**
- [ ] **Step 6: Commit** —— `git add lib/asr.js test/asr.test.js package.json` + `git commit -m "feat(asr): 语音识别纯逻辑"`（说明末尾加署名行）。

---

### Task 4: 语音识别服务 `lib/asr-service.js`

**Files:**
- Create: `lib/asr-service.js`
- Test: `test/asr-service.test.js`
- Modify: `package.json`（`scripts.test` 一行）

**Interfaces:**
- Consumes: Task 1 的 `ServiceError`、`callProvider`、`createUsage`、`localDate`；Task 3 的 `buildRequest`、`extractReplyText`、`normalizeTranscript`；`lib/receipt-service.js` 里「未配置 → 并发 → 用量 → 转发，`finally` 清除进行中」的结构可作参考。
- Produces（Task 5 使用）：
  - `class AsrError extends ServiceError`。
  - `createAsrService({ getConfig, dataDir, fetchImpl = fetch, today = localDate, log = console.log }): { status(): { enabled: boolean, maxSeconds: number }, transcribe(buf: Buffer): Promise<{ text: string }> }`。`status()` 里 `maxSeconds` 取自当前配置（未配置时给默认 30）。
  - `transcribe` 的顺序与错误（`AsrError`，消息原文）：① 未配置 → 503「语音识别未配置」；② 进行中 → 429「正在识别上一段，请稍等」；③ `createUsage(...).tryConsume(cfg.dailyLimit)` 为 false → 429「今天的语音识别次数用完了」；④ 置进行中并转发（`callProvider`，`unreadable` 用「识别服务返回了无法理解的内容，请再说一遍」，`ErrorClass: AsrError`），`finally` 清除进行中；⑤ 响应文本不是合法 JSON 或 `extractReplyText` 返回 `null` → 502「识别服务返回了无法理解的内容，请再说一遍」；⑥ 成功返回 `{ text: normalizeTranscript(回复文字) }`，文字为空时返回 `{ text: '' }`（200，不是错误）。
  - 用量文件是 `dataDir/asr-usage.json`；进行中标志只属于这个服务实例（与小票服务互不影响）。检查进行中与置位之间不能有 `await`。

- [ ] **Step 1: 写失败的测试 `test/asr-service.test.js`**（风格同 `test/receipt-service.test.js`：临时目录、假 `fetch`、保活定时器、`log` 收集数组、`isErr(e,status,msg)` 判断 `e instanceof AsrError`）。用例：
  - 未配置：`status()` 为 `{enabled:false, maxSeconds:30}`；`transcribe` 抛 503「语音识别未配置」；没有转发、没有用量文件。
  - 已配置：`status()` 为 `{enabled:true, maxSeconds: <配置值>}`；回复 `output[0].content[0].text` 为 `'把鸡蛋放入冰箱冷藏 买了五花肉一盒'` → `transcribe` 返回 `{text:'把鸡蛋放入冰箱冷藏。买了五花肉一盒'}`；假 `fetch` 恰好被调用一次，参数里有 `Bearer <key>`、请求体含 `data:audio/wav;base64,` 和传入的 `signal`；`log` 不含 key。
  - 空文字：回复 `{output:[{type:'message',content:[{type:'output_text',text:''}]}]}` → `{text:''}`；回复里没有 `output`、回复不是 JSON、回复超过 2 MiB → 都是 502「识别服务返回了无法理解的内容，请再说一遍」。
  - 用量：`dailyLimit:2`，第三次 429「今天的语音识别次数用完了」，文件 `asr-usage.json` 为 `{date, count:2}`；用同一目录新建服务（模拟重启）仍 429；`today` 换成第二天可用；`dailyLimit:0` 连续 5 次成功；识别服务返回 500 的调用也计数；用量文件损坏按 0 处理；文件名是 `asr-usage.json`（不是 `receipt-usage.json`）。
  - 并发：第一个请求的假 `fetch` 挂起时，第二个 `transcribe` 立即抛 429「正在识别上一段，请稍等」且不再转发、不额外计数；第一个完成后第三个成功；第一个失败后「进行中」也被清除。
  - 超时：`timeoutSec:0.05` → 504「识别超时」；网络错误 → 502「连不上识别服务，请稍后再试」；401、403 → 502「识别服务拒绝了请求，请检查服务器上的 key」；500 → 502「识别服务出错（HTTP 500），请稍后再试」；响应体里回显了 key 时，消息和 `log` 都不含 key。
  - 独立性：用同一个目录同时创建 `createAsrService` 和 `createReceiptService`（引用 `lib/receipt-service.js`），让两者的假 `fetch` 都挂起，各自发起一次请求：两个请求都没有被 429 拒绝（都在进行中），放行后都成功；两者的用量文件互不干扰。
- [ ] **Step 2: 运行确认失败**：`node test/asr-service.test.js`，期望 `Cannot find module '../lib/asr-service'`。
- [ ] **Step 3: 实现 `lib/asr-service.js`**（CommonJS，导出 `createAsrService`、`AsrError`）。
- [ ] **Step 4: 运行确认通过**：`node test/asr-service.test.js`，期望全部 `ok`、退出码 0；再运行 `node test/receipt-service.test.js`、`node test/provider-guard.test.js`、`node test/asr.test.js`。
- [ ] **Step 5: 把 `package.json` 的 `scripts.test` 里 `node test/asr.test.js` 之后加上 `node test/asr-service.test.js`（只改这一行，确认仍是合法 JSON）。**
- [ ] **Step 6: Commit** —— `git add lib/asr-service.js test/asr-service.test.js package.json` + `git commit -m "feat(asr): 语音识别服务（限额、并发、超时、错误映射）"`（说明末尾加署名行）。

---

### Task 5: 服务器接口

**Files:**
- Modify: `server.js`（`/api/parse` 附近的小票路由之后新增语音路由；小票路由的错误转换）、`test/smoke.js`

**Interfaces:**
- Consumes: Task 3 的 `resolveConfig`；Task 4 的 `createAsrService`；Task 1 的 `ServiceError`；`server.js` 里已有的 `route`、`json`、`readBody(req, limit)`、`HttpError`、`config`、`DATA_DIR`。
- Produces（Task 7 使用）：`GET /api/asr/status` → `{ enabled, maxSeconds }`；`POST /api/asr/transcribe` → `{ text }`，错误统一为 `{ error: '<中文消息>' }`，状态码见 Task 4。

- [ ] **Step 1: 在 `server.js` 里接线。** 引入 `./lib/asr` 的 `resolveConfig`（改名避免和小票的冲突，如 `resolveAsrConfig`）和 `./lib/asr-service`；创建 `const asr = createAsrService({ getConfig: () => resolveAsrConfig(config.asr, process.env), dataDir: DATA_DIR })`（环境变量只在读取时合并，绝不写进 `config`）；启动时调用一次 `resolveAsrConfig(config.asr, process.env)`：`problem` 非空就打印「语音识别配置有问题：<problem>」，`enabled` 就打印「语音识别已启用（模型 <model>）」，不打印 key 和地址。新增路由：`GET /api/asr/status`（返回 `asr.status()`）；`POST /api/asr/transcribe`：未启用 → `HttpError(503, '语音识别未配置')`（先于读取请求体）→ `Content-Type` 不是 `audio/wav`（也接受 `audio/x-wav`）→ `HttpError(415, '仅支持 WAV 录音')` → `readBody(req, 2 * 1024 * 1024)`，超限（413）改写成 `HttpError(413, '录音太长')`，空请求体 → `HttpError(400, '录音为空')` → `json(res, 200, await asr.transcribe(buf))`；把捕获到的 `ServiceError` 转成 `HttpError(e.status, e.message)`（统一错误处理只认 `HttpError`）。同时把小票路由里现有的 `ReceiptError` 判断改成 `ServiceError`（`ReceiptError` 是它的子类，行为不变）。
- [ ] **Step 2: 追加冒烟用例到 `test/smoke.js`**（沿用其 `call`、`json`、`assert` 辅助；假定服务启动时没有任何 `ASR_*` 环境变量和 `asr` 配置）：未登录 `GET /api/asr/status` → 401；登录后 → 200 且 `enabled===false`；`POST /api/asr/transcribe`（小字节，`content-type: audio/wav`）→ 503，`error` 含「语音识别未配置」；`POST /api/parse` 发送 `{text:'买了牛奶。买了鸡蛋'}` → 200 且 `intents.length === 2`。
- [ ] **Step 3: 检查。** `node --check server.js`、`node --check test/smoke.js`；运行全部单元测试（`parse`、`menu`、`menu-cal`、`receipt`、`receipt-service`、`provider-guard`、`asr`、`asr-service`、`img-scale`）；用 Grep 确认两个新路由存在，且 `saveConfig()` 周围没有把环境变量塞进 `config`、`config.asr` 只被读取。冒烟测试需要运行中的服务，本机无法运行，在报告里写明「冒烟用例未运行，交给用户在服务器上跑」。
- [ ] **Step 4: Commit** —— `git add server.js test/smoke.js` + `git commit -m "feat(asr): 语音识别接口"`（说明末尾加署名行）。

---

### Task 6: WAV 编码器 `public/wav.js`

**Files:**
- Create: `public/wav.js`
- Test: `test/wav.test.js`
- Modify: `package.json`（`scripts.test` 一行）

**Interfaces:**
- Produces（Task 7 使用）：`WavEnc.encode(samples: Float32Array, sampleRate: number): Uint8Array`（浏览器里是 `window.WavEnc`，Node 里 `require('../public/wav').encode`，写法同 `public/menu-cal.js`）。输入是已混成单声道的采样；输出是 16kHz、单声道、16 位小端 PCM 的 WAV 字节：44 字节头（`RIFF`、总长度−8、`WAVE`、`fmt `、16、格式 1、声道 1、采样率 16000、字节率 32000、块对齐 2、位深 16、`data`、数据长度）+ 数据；采样率不是 16000 时先线性插值重采样；采样值限幅到 [-1, 1]；输入为空返回只有头的 WAV（数据长度 0）。

- [ ] **Step 1: 写失败的测试 `test/wav.test.js`**。用例：48000Hz 的 1 秒正弦波 → 输出长度 `44 + 16000*2`，头里各字段（用 `DataView` 读）正确（`RIFF`/`WAVE`/`fmt `/`data` 标记、采样率 16000、声道 1、位深 16、字节率 32000、数据长度 32000、总长度−8）；16000Hz 输入不改变采样数（`n` 个采样 → 数据长度 `2n`），且值按 `round(x*32767)` 对应；44100Hz 的 0.5 秒 → 数据长度约 `2*8000`（允许 ±2 个采样）；超出范围的值 `2`、`-2` 被限幅为 `32767`、`-32768`（或 `-32767`，二者都可接受，但必须不溢出回绕）；空数组 → 长度 44、数据长度 0；输出是 `Uint8Array`。
- [ ] **Step 2: 运行确认失败**：`node test/wav.test.js`，期望 `Cannot find module '../public/wav'`。
- [ ] **Step 3: 实现 `public/wav.js`**。
- [ ] **Step 4: 运行确认通过**：`node test/wav.test.js`，期望全部 `ok`、退出码 0。
- [ ] **Step 5: 把 `package.json` 的 `scripts.test` 里 `node test/img-scale.test.js` 之后加上 `node test/wav.test.js`（只改这一行，确认仍是合法 JSON）。**
- [ ] **Step 6: Commit** —— `git add public/wav.js test/wav.test.js package.json` + `git commit -m "feat(asr): WAV 编码与重采样"`（说明末尾加署名行）。

---

### Task 7: 前端与文档

**Files:**
- Modify: `public/index.html`（`i-mic` 图标 symbol、`#asr-btn` 按钮、加载 `wav.js`）、`public/app.js`、`public/style.css`、`README.md`、`DEPLOY.md`、`验收清单.md`

**Interfaces:**
- Consumes: Task 5 的接口；Task 2 的 `truncated` 字段；Task 6 的 `WavEnc.encode`；现有 `api(url, opts)`、`toast(msg, ms)`、`showConfirm(r)`（已支持 `r.notice`）、`#quick-form`、`#quick-text`、`loadReceiptStatus`（照它的写法加 `loadAsrStatus`）。
- Produces: 无（终端任务）。

- [ ] **Step 1: `index.html`。** 增加 `i-mic` 图标 symbol（24×24 描线风格，同现有图标）；在 `#quick-form` 里相机按钮之后、「录入」按钮之前放 `<button type="button" id="asr-btn" class="btn small hidden" title="语音录入" aria-label="语音录入">`（只含麦克风图标）；在 `<script src="/img-scale.js">` 之后、`app.js` 之前加载 `<script src="/wav.js"></script>`。
- [ ] **Step 2: `app.js` —— 共用解析流程与截断提示。** 把现有的 `#quick-form` 提交处理里「解析并弹出确认卡」的部分抽成一个可重复调用的函数 `runQuick(text)`（含按钮禁用/恢复、`没听懂` 提示、错误 toast），提交处理改为调用它，行为不变；`runQuick` 里如果 `r.truncated` 为真，给 `showConfirm` 传 `notice: '只处理了前 5 句，后面的没有录入，请分开说。'`。
- [ ] **Step 3: `app.js` —— 麦克风流程。** 写 `loadAsrStatus()`（`enterApp` 里在 `loadReceiptStatus()` 旁调用，失败当作未启用）：只有 `/api/asr/status` 返回已启用，且 `window.isSecureContext`、`navigator.mediaDevices?.getUserMedia`、`window.MediaRecorder`、`window.AudioContext || window.webkitAudioContext` 都存在时才显示 `#asr-btn`，并记下 `maxSeconds`。点击：空闲 → 开始录音（`getUserMedia({ audio: true })` + `MediaRecorder`；按钮变成录音状态并显示已录秒数；到 `maxSeconds` 秒自动结束）；录音中 → 结束；结束后进入「识别中」（按钮禁用并有提示）：用 `AudioContext.decodeAudioData` 解码录音，把各声道平均成单声道，`WavEnc.encode(samples, audioBuffer.sampleRate)` 得到 WAV，`api('/api/asr/transcribe', { method:'POST', headers:{ 'Content-Type':'audio/wav' }, body: wavBlob })`；成功且 `text` 非空 → 把 `#quick-text` 的内容**替换**为 `text`（限制在输入框的 200 字内）并调用 `runQuick(text)`；`text` 为空 → toast「没听清，再说一遍试试」。必须处理并给中文 toast：用户拒绝权限或没有麦克风（「没有麦克风权限，请在浏览器设置里允许」）、解码失败（「这个浏览器暂时不支持语音录入」）、服务器错误（显示服务器返回的消息）；无论哪种情况都要释放麦克风（停止所有 `track`）、清掉计时器和提示、让按钮恢复可用；录音中途切换页面或再次点击不能留下残留状态。
- [ ] **Step 4: `style.css`。** 麦克风按钮与相机按钮同高同风格；录音状态（红色、可带轻微脉动，显示秒数）、识别中状态（禁用）；宽屏下 `#app > .quick` 的布局不被破坏。
- [ ] **Step 5: 文档。** `README.md` 功能表加一行「语音录入（可选）」（入口在物品页麦克风按钮，需要 HTTPS 和服务器上配置语音识别，识别后先弹确认卡，录音不保存，可以一口气说多件事）。`DEPLOY.md` 在「小票识别（可选）」小节之后加「语音识别（可选）」小节：`config.json` 的 `asr` 示例（`url`、`key`、`model`、`format`、`extra`、`timeoutSec`、`dailyLimit`、`maxSeconds`）与环境变量对照表（与小票的写法一致：推荐 `config.json` 并 `chmod 600`，或 root 专属的环境变量文件）；强调**页面必须是 HTTPS 才有麦克风按钮**；与小票识别是两套独立的配置和次数；方舟 Responses 接口的 `extra` 示例 `{"thinking":{"type":"disabled"}}`；`maxSeconds` 最大 60，识别服务拒绝较长录音时调小；隐私说明（录音只发给配置的服务，不保存）。`验收清单.md` 末尾追加「语音录入（待浏览器验收）」小节，逐项为未勾选的 `- [ ]`：不是 HTTPS 或未配置时看不到麦克风按钮；配置好并在 HTTPS 下出现；第一次点击浏览器请求权限；拒绝权限有中文提示且按钮恢复；说一句「买了两盒酸奶放冷藏」得到正确的确认卡；一口气说两件事得到两条意图；超过 5 句有提示；说话时间接近最长时自动结束且识别成功（用真机验证识别服务是否接受这么长的录音）；识别不出文字提示「没听清」；识别失败有中文提示且按钮恢复；iPhone Safari 和安卓 Chrome 都能录音和识别；每天次数用完有提示；页面和接口响应里看不到 key。
- [ ] **Step 6: 检查。** `node --check public/app.js`；运行全部单元测试；用 Grep 确认 `index.html` 里有 `asr-btn`、`i-mic`，且 `wav.js` 在 `app.js` 之前；`app.js` 里没有遗漏的重复解析逻辑。浏览器里的完整流程（Review Focus 第 6 条）需要用户在自己的服务器和手机上验证，报告里写明「未在浏览器验证」，不要声称已验证。
- [ ] **Step 7: Commit** —— `git add public README.md DEPLOY.md 验收清单.md` + `git commit -m "feat(asr): 物品页麦克风按钮与语音录入流程"`（说明末尾加署名行）。
