# 自动拆分一串物品 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一句话录入把没有分隔符的一串物品自动拆成多项（「牛肉猪肉猪肉丝排骨」→ 4 项），并让「数量 + 单位」成组的（「两斤牛肉三斤排骨」）每组一项；语音识别的提示词要求模型在不同物品之间加「、」。

**Architecture:** 在 `lib/parse.js` 里给 `mkItems` 增加两步预处理：先按「数量 + 单位」成组切分（不需要词表），再对不含数量的段做词表切分（词表 = 内置常见物品 `lib/vocab.js` ∪ 库存物品名，动态规划取词数最少的完整切分，切不完就不拆）；`lib/asr.js` 的提示词加一条规则。全部是纯规则、离线。

**Tech Stack:** 原生 Node，零依赖；测试沿用 `test/*.test.js` 的断言风格。

**Spec:** `docs/superpowers/specs/2026-11-24-split-items-design.md`（执行者必须一并阅读）。

## Global Constraints

- 零第三方依赖；解析仍是纯规则、不联网。
- 不触发新规则的句子，`parse()` 的返回必须与改动前完全一致：`test/parse.test.js` 里所有现有用例保持通过（它们还会自动检查 `parseMulti` 与 `parse` 一致）。
- 宁可不拆，也不把整体物品名拆坏：「三鲜水饺」「牛肉面」「羊肉面」「5号电池」都保持一项。
- 单字词只允许：鱼、虾、蛋、米、葱、姜、蒜、梨、桃、枣、盐、糖、醋、酒、茶；不要加「面」「粉」这类容易构成合成词的字。
- 界面文字和注释用中文。

## Review Focus

1. 一串里夹着词表没有的词（「牛肉火星肉」）：整串不拆，保持一项。
2. 词表里有合成词（「牛肉面」「猪肉丝」）：取词数最少的切法，不会被拆开；词数相同时靠前的词更长。
3. 带数量的段（「牛肉猪肉两斤」）：不做词表切分，保持一项。
4. 「5号电池」「三鲜水饺」「3M胶带」这类含数字或数量字样但不是数量的名称：不被误切。
5. 库存里的名字参与切分，但长度 1 的库存名不加入词表；库存名里的空白被去掉。
6. 现有用例全部不变（回归）。

---

## File Structure

- Create `lib/vocab.js` —— 内置常见物品词表 `COMMON_ITEMS`。
- Modify `lib/parse.js` —— 新增并导出 `buildVocab`、`segmentNames`、`splitQuantityGroups`，`mkItems` 接入。
- Modify `lib/asr.js` —— `PROMPT` 加一条规则。
- Create `test/vocab.test.js`；Modify `test/parse.test.js`、`test/asr.test.js`、`package.json`、`README.md`、`验收清单.md`。

---

### Task 1: 词表切分

**Files:**
- Create: `lib/vocab.js`
- Modify: `lib/parse.js`（新增 `buildVocab`、`segmentNames`；`parse()` 开头构造词表，`mkItems` 里接入）、`package.json`（仅 `scripts.test` 一行；文件开头有 1 个字符的 BOM 且 `description` 有乱码，都不要动，用精确替换只改这一行）
- Test: `test/vocab.test.js`、`test/parse.test.js`

**Interfaces:**
- Produces（Task 2 使用）：
  - `lib/vocab.js` 导出 `COMMON_ITEMS: string[]`（至少 300 个、不重复、不含空白；单字词只能来自上面 Global Constraints 里的那 15 个字；覆盖 Spec「内置词表」里列的各个类别；必须包含 牛肉、猪肉、猪肉丝、排骨、西红柿、鸡蛋、青菜、牛肉面）。
  - `lib/parse.js` 导出 `buildVocab(items: {name: string}[]): Set<string>`：`COMMON_ITEMS` 加上库存物品名（去掉所有空白后长度 ≥ 2 的才加入）。
  - `lib/parse.js` 导出 `segmentNames(text: string, vocab: Set<string>): string[] | null`：能被词表完整切开且至少 2 个词时返回切出的词（保持原顺序）；否则返回 `null`（包括非字符串、空串、只有 1 个词、有任何一段不在词表里）。多种完整切法时：词数最少优先；词数相同时，从前往后比较，每个位置上更长的词优先。

- [ ] **Step 1: 写失败的测试。** `test/vocab.test.js`（风格同 `test/receipt.test.js`：自带 `check`，有失败则退出码 1）：
  - 词表：`COMMON_ITEMS` 长度 ≥ 300、无重复、无空白字符；包含 `['牛肉','猪肉','猪肉丝','排骨','西红柿','鸡蛋','青菜','牛肉面','酸奶','洗衣液']`；所有单字词都属于「鱼虾蛋米葱姜蒜梨桃枣盐糖醋酒茶」。
  - `buildVocab`：对 `[{name:'5 号电池'},{name:'电钻'},{name:'饼'}]`：`has('5号电池')`、`has('电钻')`、`has('牛肉')` 为真；`has('5 号电池')` 为假；`has('饼')` 为假（长度 1 的库存名不加入）。
  - `segmentNames`（用 `new Set(COMMON_ITEMS)`）：`'牛肉猪肉猪肉丝排骨'` → `['牛肉','猪肉','猪肉丝','排骨']`；`'西红柿鸡蛋青菜'` → `['西红柿','鸡蛋','青菜']`；`'牛肉面'` → `null`（词数最少的切法只有 1 个词）；`'牛肉火星肉'` → `null`（有一段不在词表里）；`'牛肉'` → `null`；`''`、`null` → `null`。自定义小词表：`new Set(['猪肉','猪肉丝','丝','排骨'])` 切 `'猪肉丝排骨'` → `['猪肉丝','排骨']`（词数最少）；`new Set(['牛肉丝','牛肉','丝瓜','瓜'])` 切 `'牛肉丝瓜'` → `['牛肉丝','瓜']`（词数相同，前面的词更长优先）；`new Set(['鱼','虾'])` 切 `'鱼虾'` → `['鱼','虾']`。
  
  `test/parse.test.js`（用文件里已有的 `check(text, expect)`，它会顺带检查 `parseMulti` 一致性）：
  - `'今天买了牛肉猪肉猪肉丝排骨'` → `[{action:'add',name:'牛肉'},{action:'add',name:'猪肉'},{action:'add',name:'猪肉丝'},{action:'add',name:'排骨'}]`
  - `'买了西红柿鸡蛋青菜'` → 三项 `西红柿`、`鸡蛋`、`青菜`
  - `'买了牛肉猪肉放冷藏'` → 两项 `牛肉`、`猪肉`，且 `loc` 都是 `'厨房 / 冰箱冷藏'`
  - `'买了牛肉面'` → 一项 `牛肉面`；`'买了羊肉面'` → 一项 `羊肉面`；`'买了三鲜水饺'` → 一项 `三鲜水饺`
  - `'买了牛肉火星肉'` → 一项 `牛肉火星肉`
  - `'买了牛肉猪肉两斤'` → 一项，`name:'牛肉猪肉'`、`quantity:2`、`unit:'斤'`
  - `'买了创可贴电钻'` → 两项，`[{action:'restock',name:'创可贴'},{action:'restock',name:'电钻'}]`（库存里的名字参与切分）
  - `'买了牛肉、猪肉丝还有排骨'` → 三项 `牛肉`、`猪肉丝`、`排骨`（原有分隔符规则不变）
- [ ] **Step 2: 运行确认失败。** `node test/vocab.test.js`（缺 `lib/vocab`）；`node test/parse.test.js`（新增用例失败，原有用例仍通过）。
- [ ] **Step 3: 实现。** 整理 `lib/vocab.js` 的词表（按 Spec 的类别，宁缺勿滥，不要收「面」「粉」之类的单字）；在 `lib/parse.js` 里实现 `buildVocab`、`segmentNames`（动态规划，输入最长几十个字）；`parse()` 开头用 `buildVocab(items)` 构造一次词表；`mkItems` 里对 `splitItems(phrase)` 的每一段：如果段里没有「数量 + 单位」（可用 `extractQuantity(p).quantity === null` 判断），并且 `segmentNames(p, vocab)` 不是 `null`，就用切出的词替换这一段。其余行为不变。
- [ ] **Step 4: 运行确认通过。** `node test/vocab.test.js`、`node test/parse.test.js`，期望全部通过、退出码 0；再运行 `node test/asr.test.js`、`node test/receipt.test.js` 确认不受影响。
- [ ] **Step 5: 把 `package.json` 的 `scripts.test` 里 `node test/parse.test.js` 之后加上 `node test/vocab.test.js`，用 `node -p "JSON.parse(require('fs').readFileSync('package.json','utf8').slice(1)).scripts.test.split(' && ').length"` 确认仍是合法 JSON。**
- [ ] **Step 6: Commit** —— `git add lib/vocab.js lib/parse.js test/vocab.test.js test/parse.test.js package.json` + `git commit -m "feat(parse): 没有分隔符的一串物品按词表自动拆项"`（说明末尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）。

---

### Task 2: 数量成组切分

**Files:**
- Modify: `lib/parse.js`（新增并导出 `splitQuantityGroups`，`mkItems` 里在词表切分之前调用）
- Test: `test/parse.test.js`

**Interfaces:**
- Consumes: `lib/parse.js` 现有的 `NUM_RE`、`UNIT_RE`、`NOT_QTY_AFTER`、`extractQuantity`；Task 1 的词表切分接入点。
- Produces: `splitQuantityGroups(piece: string): string[]`：在一段文字里找出所有有效的「数量 + 单位」（沿用 `extractQuantity` 的判定：`NUM_RE` 后接 `UNIT_RE`，且后面紧跟的字不属于 `NOT_QTY_AFTER`）。少于 2 处返回 `[piece]`；段首就是一处数量时，从每处数量开始切一段，若某一段在数量之后没有名称就返回 `[piece]`；段首不是数量且最后一处数量正好在段尾时，每段到一处数量为止，若某一段在数量之前没有名称就返回 `[piece]`；其他布局返回 `[piece]`。

- [ ] **Step 1: 写失败的测试（`test/parse.test.js`，直接导入 `splitQuantityGroups`，并加解析级用例）。** 直接测试：`'两斤牛肉三斤排骨'` → `['两斤牛肉','三斤排骨']`；`'牛肉两斤排骨三斤'` → `['牛肉两斤','排骨三斤']`；`'一个苹果两个梨'` → `['一个苹果','两个梨']`；`'两盒酸奶一袋面包'` → `['两盒酸奶','一袋面包']`；`'半斤牛肉半斤排骨'` → `['半斤牛肉','半斤排骨']`；以下保持原样（返回 `[原文]`）：`'两斤牛肉'`（只有一处）、`'两斤牛肉三斤'`（最后一处后面没有名称）、`'两斤牛肉排骨三斤'`、`'5号电池三节'`（「5号」不是数量，只有一处）、`'三鲜水饺两袋'`、`'牛肉猪肉'`、`''`。解析级（用 `check`）：
  - `'买了两斤牛肉三斤排骨'` → `[{name:'牛肉',quantity:2,unit:'斤'},{name:'排骨',quantity:3,unit:'斤'}]`
  - `'买了牛肉两斤排骨三斤'` → 同上
  - `'买了两盒酸奶一袋面包放冷藏'` → `[{name:'酸奶',quantity:2,unit:'盒',loc:'厨房 / 冰箱冷藏'},{name:'面包',quantity:1,unit:'袋',loc:'厨房 / 冰箱冷藏'}]`
  - `'买了一个苹果两个梨'` → `[{name:'苹果',quantity:1,unit:'个'},{name:'梨',quantity:2,unit:'个'}]`
  - `'买了三鲜水饺两袋'` → 一项 `三鲜水饺`、`quantity:2`、`unit:'袋'`（不被误切）
- [ ] **Step 2: 运行确认失败。** `node test/parse.test.js`，期望新增用例失败（缺 `splitQuantityGroups`），原有用例仍通过。
- [ ] **Step 3: 实现 `splitQuantityGroups` 并导出；`mkItems` 里对 `splitItems(phrase)` 的每一段先调用它，再对得到的每一小段做 Task 1 的词表切分。**
- [ ] **Step 4: 运行确认通过。** `node test/parse.test.js`、`node test/vocab.test.js`，期望全部通过；再运行全部单元测试（`menu`、`menu-cal`、`receipt`、`receipt-service`、`provider-guard`、`asr`、`asr-service`、`img-scale`、`wav`）确认不受影响。
- [ ] **Step 5: Commit** —— `git add lib/parse.js test/parse.test.js` + `git commit -m "feat(parse): 数量加单位成组的物品自动拆项"`（说明末尾加署名行）。

---

### Task 3: 语音提示词与文档

**Files:**
- Modify: `lib/asr.js`（`PROMPT`）、`test/asr.test.js`、`README.md`、`验收清单.md`

- [ ] **Step 1: 写失败的测试（`test/asr.test.js`）。** 把 `PROMPT` 那条检查的词表里加上 `'顿号'` 和 `'牛肉、猪肉'`；再加一条：`normalizeTranscript('买了牛肉、猪肉、排骨')` 的结果保持 `'买了牛肉、猪肉、排骨'`（「、」不是句子分隔符，不被改动）。
- [ ] **Step 2: 运行确认失败。** `node test/asr.test.js`，期望「PROMPT 包含…」失败。
- [ ] **Step 3: 实现。** 在 `PROMPT` 里加一条规则：一次说了多种物品时，物品之间用顿号「、」隔开（给例子「买了牛肉、猪肉、排骨」）。
- [ ] **Step 4: 文档。** `README.md` 的「一句话录入」那一行末尾补一句：一次说多种物品可以不加停顿，常见物品会自动拆开；词表里没有的词不拆，在确认卡上手动改。`验收清单.md` 末尾追加「自动拆项（待验收）」小节，未勾选：说「今天买了牛肉猪肉猪肉丝排骨」得到 4 项；说「买了两斤牛肉三斤排骨」得到牛肉 2 斤和排骨 3 斤；说「买了牛肉面」仍是 1 项；库存里有的名字也能参与拆分；词表里没有的词整串保持一项，可在确认卡上手动改。
- [ ] **Step 5: 检查。** 运行全部单元测试（`parse`、`vocab`、`menu`、`menu-cal`、`receipt`、`receipt-service`、`provider-guard`、`asr`、`asr-service`、`img-scale`、`wav`），再 `node --check server.js`。
- [ ] **Step 6: Commit** —— `git add lib/asr.js test/asr.test.js README.md 验收清单.md` + `git commit -m "feat(asr): 提示词要求不同物品之间加顿号；补充文档"`（说明末尾加署名行）。
