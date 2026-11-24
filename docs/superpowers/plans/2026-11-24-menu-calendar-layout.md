# 每周菜单日历式横排 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把菜单页的「7 张卡片竖叠」改成「7 天横排 × 早/午/晚」的日历式网格，手机上整周一屏显示。

**Architecture:** 渲染逻辑抽成一个无依赖的小模块 `public/menu-cal.js`（浏览器里挂 `window.MenuCal`，Node 里 `require`），因此可以用 Node 断言测试转义、「+N」、`aria-label`、今天高亮等；`public/app.js` 只负责调用它；版面全部由 `public/style.css` 里的媒体查询决定（手机压缩、宽屏完整），同一份 HTML 两种断点共用。

**Tech Stack:** 原生 JS / CSS；零第三方依赖；测试沿用 `test/*.test.js` 的 Node 断言风格。

**Spec:** `docs/superpowers/specs/2026-11-24-menu-calendar-layout-design.md`（视觉依据是仓库根目录未提交的临时文件 `preview-menu-calendar.html` 里的方案 A 和宽屏版，执行者先打开读一遍它的 CSS）。

## Global Constraints

- 零第三方依赖，不引入外部字体或任何外部资源。
- 只改菜单页排版：不动数据表、接口、编辑弹层、联想、采购确认；`#menu-prev`、`#menu-range`、`#menu-next`、`#menu-today`、`#menu-body`、`#menu-purchase` 这些 id 不变。
- 手机（`max-width: 719px`）：行标签列 24px，标签只写「早/午/晚」；表头写「一…日」加日期号；格子最小高 84px；菜名 11px，每道独占一行、最多折 2 行；一格最多显示 3 道，超出显示「+N」；空格显示淡色「＋」。
- 宽屏（`min-width: 720px`，沿用现有断点）：行标签列 74px，写「早餐/午餐/晚餐」；表头写「周一…周日」和「月.日」；格子显示全部菜名，不折叠、不加「+N」；今天那一列加「今天」小标。
- 每天主题色（周一到周日）：`#7D9B76`、`#C1795A`、`#C29A3F`、`#6C8BA0`、`#B57B8E`、`#8D7FB0`、`#A67C52`。
- 所有菜名渲染必须转义（`& < > " '`），包括放进 `aria-label` 属性的文字。
- 每格是一个按钮，保留 `data-date`、`data-meal`，点击仍打开现有的 `openMealEditor(date, meal)`。
- 每格按钮的 `aria-label` 写完整内容，如「周二 午餐：番茄炒蛋、清炒时蔬」，空格写「周二 午餐：未安排」。
- 旧版面（`.menu-week`、`.menu-day*`、`.menu-meal*` 及 `@media (min-width: 720px) { .menu-week … }`）全部删除，不留死代码。
- 用户界面文字全部用中文。

## Review Focus

1. 一格里有 4 道以上的菜：手机上只显示前 3 道和「+N」，但 `aria-label` 和宽屏要有全部菜名（Task 1 测试，Task 2 手动看）。
2. 超长菜名（20 个汉字、一长串英文无空格）：不撑破格子、不让整页出现横向滚动（Task 2 CSS 要求 `minmax(0, 1fr)` 加 `word-break: break-all`，手动验证）。
3. 菜名里有 `<b>"x"&'`：页面显示成文字，`aria-label` 不被引号截断（Task 1 测试）。
4. 整周一道菜都没有：21 格都显示「＋」且都可点击进入编辑窗（Task 1 测试）。
5. 显示的周不含今天（过去或未来的周）：没有任何一列高亮；今天是周日时高亮最后一列（Task 1 测试）。
6. 某天的 `meals` 缺少某餐的键：按空处理，不抛错（Task 1 测试）。

---

## File Structure

- Create `public/menu-cal.js` —— 纯渲染：把周数据变成日历网格的 HTML 字符串。无 DOM、无网络。
- Create `test/menu-cal.test.js` —— 上述模块的 Node 断言测试。
- Modify `public/index.html` —— 在 `app.js` 之前加载 `menu-cal.js`。
- Modify `public/app.js` —— `renderMenuWeek` 调用 `MenuCal.render`；点击处理改用新类名。
- Modify `public/style.css` —— 删旧版面，加日历网格样式。
- Modify `package.json` —— `scripts.test` 加上新测试。
- Modify `README.md`、`验收清单.md` —— 一句话更新。

---

### Task 1: 日历渲染模块 `public/menu-cal.js`

**Files:**
- Create: `public/menu-cal.js`
- Test: `test/menu-cal.test.js`
- Modify: `package.json`（仅 `scripts.test` 一行；文件里 `description` 字段有乱码，不要改动或"修复"，用精确替换只改这一行，其余字节原样保留）

**Interfaces:**
- Produces（Task 2 使用）：`MenuCal.render(week, today): string`
  - `week = { start, end, days: [{ date: 'YYYY-MM-DD', meals: { breakfast?: Dish[], lunch?: Dish[], dinner?: Dish[] } }] }`，`days[0]` 是周一；`Dish` 只用到 `name`。
  - `today: string`，`'YYYY-MM-DD'`（本地日期）。
  - 返回的 HTML 结构（类名是 Task 2 样式的契约，必须一致）：
    ```html
    <div class="mc">
      <div class="mc-corner"></div>
      <!-- ×7，周一到周日；日期等于 today 的加 today 类 -->
      <div class="mc-head today" style="--accent:#C1795A">
        <span class="mc-cn"><span class="mc-s">二</span><span class="mc-l">周二</span></span>
        <span class="mc-dt"><span class="mc-s">24</span><span class="mc-l">11.24</span></span>
      </div>
      <!-- ×3 行：早、午、晚；每行先一个行标签，再 7 个格子 -->
      <div class="mc-rl"><span class="mc-s">早</span><span class="mc-l">早餐</span></div>
      <div class="mc-cell today" style="--accent:#C1795A">
        <button type="button" class="mc-entry" data-date="2026-11-24" data-meal="lunch" aria-label="周二 午餐：番茄炒蛋、清炒时蔬">
          <span class="mc-dish">番茄炒蛋</span><span class="mc-dish">清炒时蔬</span><span class="mc-more">+1</span>
        </button>
      </div>
    </div>
    ```
    - `.mc-s` 是手机短标签，`.mc-l` 是宽屏长标签（显示哪个由 CSS 决定，本模块两个都输出）。
    - 短日期是不补零的日号（`5`），长日期是 `月.日` 且日补零（`12.05`）。
    - 所有菜名都输出为 `.mc-dish`（是否隐藏第 4 道起由 CSS 决定）；超过 3 道时额外输出一个 `<span class="mc-more">+N</span>`，N = 总数 − 3。
    - 空餐输出 `<span class="mc-plus">＋</span>`，不输出 `.mc-dish`。
    - 行顺序 breakfast、lunch、dinner，每行的 7 个格子按周一到周日排列。
  - 浏览器里模块挂 `window.MenuCal = { render }`；Node 里 `module.exports = { render }`（UMD 写法，同一文件两用）。
- 模块自带一个转义函数（`& < > " '`），不依赖 `app.js` 里的 `esc`。

- [ ] **Step 1: 写失败的测试 `test/menu-cal.test.js`**（风格同 `test/menu.test.js`：自带 `check(name, cond)`，有失败则 `process.exit(1)`；开头 `const { render } = require('../public/menu-cal')`）。固定数据：`start: '2026-11-23'`（周一），7 天 `2026-11-23`…`2026-11-29`。用例名与断言：
  - `结构`：输出里 `class="mc-head` 出现 7 次、`class="mc-entry"` 出现 21 次、`class="mc-rl"` 出现 3 次；`data-meal` 出现的顺序是 7 个 `breakfast`、7 个 `lunch`、7 个 `dinner`；前 7 个 `data-date` 依次是 `2026-11-23`…`2026-11-29`。
  - `今天高亮`：`today = '2026-11-25'` → `mc-head today` 恰出现 1 次、`mc-cell today` 恰出现 3 次，且 `mc-head today` 是第 3 个表头；`today = '2026-12-31'`（不在本周）→ 0 次；`today = '2026-11-29'`（周日）→ `mc-head today` 是第 7 个表头。
  - `主题色`：第 1 个表头含 `--accent:#7D9B76`，第 7 个含 `--accent:#A67C52`；第 3 个表头所在列的 3 个格子也带 `--accent:#C29A3F`。
  - `标签`：`2026-11-24` 所在表头含 `<span class="mc-s">二</span><span class="mc-l">周二</span>`、`<span class="mc-s">24</span><span class="mc-l">11.24</span>`；另造一周含 `2026-12-05`，其日期含 `<span class="mc-s">5</span><span class="mc-l">12.05</span>`；行标签含 `<span class="mc-s">早</span><span class="mc-l">早餐</span>`、`午`/`午餐`、`晚`/`晚餐`。
  - `aria-label`：2026-11-24 的午餐菜为 `番茄炒蛋`、`清炒时蔬` → 该格含 `aria-label="周二 午餐：番茄炒蛋、清炒时蔬"`；空餐含 `aria-label="周一 早餐：未安排"`（2026-11-23 早餐空）。
  - `超过 3 道`：某餐 4 道菜 → 该格 `mc-dish` 出现 4 次、含 `<span class="mc-more">+1</span>`，`aria-label` 含全部 4 道（用 `、` 连接）；恰好 3 道 → 无 `mc-more`；5 道 → `+2`。
  - `空周`：整周所有餐为 `[]` → `mc-plus` 出现 21 次、`mc-dish` 0 次、`mc-entry` 仍是 21 个。
  - `转义`：菜名 `<b>"x"&'` → 输出不含 `<b>"x"`；含 `&lt;b&gt;&quot;x&quot;&amp;&#39;`（各出现在 `.mc-dish` 里和 `aria-label` 里）；用正则 `aria-label="([^"]*)"` 对该格能匹配到完整值（说明属性没有被引号截断）。
  - `缺键`：某天 `meals` 只有 `{ breakfast: [...] }`、没有 `lunch`/`dinner` → 不抛错，缺的餐按空处理（含 `mc-plus`）。
- [ ] **Step 2: 运行确认失败**：`node test/menu-cal.test.js`，期望 `Cannot find module '../public/menu-cal'`。
- [ ] **Step 3: 实现 `public/menu-cal.js`**，签名 `render(week, today)`，输出上面契约的 HTML 字符串。周几用本地日期（`new Date(y, m - 1, d).getDay()`，不用 `toISOString`）；周几名取「日一二三四五六」的短字和「周日…周六」的长字；格子的 `style` 与表头用同一个主题色。
- [ ] **Step 4: 运行确认通过**：`node test/menu-cal.test.js`，期望全部 `ok` 且退出码 0；再运行 `node test/menu.test.js` 与 `node test/parse.test.js` 确认不受影响。
- [ ] **Step 5: 把 `package.json` 的 `scripts.test` 改为 `node test/parse.test.js && node test/menu.test.js && node test/menu-cal.test.js && node test/smoke.js`，并运行 `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` 确认仍是合法 JSON。**
- [ ] **Step 6: Commit** —— `git add public/menu-cal.js test/menu-cal.test.js package.json` + `git commit -m "feat(menu): 日历网格渲染模块"`（提交说明末尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）

---

### Task 2: 接入页面、样式与文档

**Files:**
- Modify: `public/index.html`（在 `<script src="/app.js">` 之前加 `<script src="/menu-cal.js"></script>`）
- Modify: `public/app.js`（`renderMenuWeek`，约第 406–419 行；`#menu-body` 点击处理，约第 434–437 行）
- Modify: `public/style.css`（删除约第 591–599 行的旧版面规则和约第 619–621 行的 `@media (min-width: 720px) { .menu-week … }`；新增日历样式；保留 `.menu-nav`、`.menu-range`、`.menu-cur`）
- Modify: `README.md`（「每周菜单」那一行里把「周一到周日带日期，每天早/午/晚三餐」改为「日历式一屏横排周一到周日（带日期），每天早/午/晚三餐」，其余不动）
- Modify: `验收清单.md`（在末尾每周菜单小节里追加两项，未验证所以写成 `- [ ]`：「手机上整周 7 天 × 早/午/晚一屏显示，菜单区域无需上下滑动」；「手机上一餐菜超过 3 道显示「+N」，点开编辑窗能看到全部」）

**Interfaces:**
- Consumes: Task 1 的 `MenuCal.render(week, today)` 及其 HTML 契约（类名 `mc`、`mc-corner`、`mc-head`、`mc-cn`、`mc-dt`、`mc-rl`、`mc-cell`、`mc-entry`、`mc-dish`、`mc-more`、`mc-plus`、`mc-s`、`mc-l`、`today`）；现有 `menuState`、`todayStr()`、`mondayOf()`、`mdLabel()`、`openMealEditor(date, meal)`。
- Produces: 无（终端任务）。

- [ ] **Step 1: 接入。** `index.html` 加载脚本；`renderMenuWeek` 保留 `#menu-range` 的更新逻辑不变，把 `#menu-body` 的内容改为 `MenuCal.render(w, todayStr())`；`#menu-body` 的点击处理由 `.menu-meal` 改为 `.mc-entry`（`closest('.mc-entry')`），仍读 `dataset.date`、`dataset.meal` 调 `openMealEditor`。运行 `node --check public/app.js`。
- [ ] **Step 2: 样式。** 先通读 `preview-menu-calendar.html` 里 `.cal`、`.fit`、`.swipe`、`.wide` 的规则，把「方案 A 手机」和「宽屏」两套搬进 `style.css`，类名改成 `mc-*`，模式切换由媒体查询完成而不是类名：
  - 网格：`.mc { display: grid; gap: 1px; … }`；手机 `grid-template-columns: 24px repeat(7, minmax(0, 1fr))`；宽屏 `74px repeat(7, minmax(0, 1fr))`。
  - 手机显示 `.mc-s`、隐藏 `.mc-l`；宽屏相反。手机上 `.mc-dish:nth-child(n+4) { display: none }`，`.mc-more` 手机显示、宽屏隐藏。
  - 手机上 `.mc-dish` 11px、`-webkit-line-clamp: 2`；格子最小高 84px；`.mc-entry` 整格可点（`width: 100%; height: 100%`，去掉按钮默认边框背景）。
  - 手机的今天：该列表头和格子淡色背景，日期号 `.mc-dt .mc-s` 做成实心药丸；宽屏的今天：表头 `::after` 写「今天」小标。
  - 现有 `#menu-body` 带 `.pad` 类，手机上把左右内边距收到 4–6px 以便 7 列放得下；宽屏时把 `#view-menu > #menu-body` 和 `#view-menu .menu-nav` 的 `max-width` 放宽到 1120px（现有规则限制为 760px），底部「生成采购」按钮那一行保持 760px。
  - 不要引入新的颜色变量以外的外部资源；主题色用格子上的 `--accent`。
- [ ] **Step 3: 删除旧版面。** 删掉所有 `.menu-week`、`.menu-day`、`.menu-day.today`、`.menu-day-h`、`.menu-meal*` 规则和 720px 双列规则；用 Grep 确认 `menu-day`、`menu-meal`、`menu-week` 在 `public/` 里不再出现。
- [ ] **Step 4: 检查。** 运行 `node --check public/app.js`、`node test/menu-cal.test.js`、`node test/menu.test.js`、`node test/parse.test.js`，全部通过。再用 Grep 确认 `index.html` 里 `menu-cal.js` 在 `app.js` 之前。
- [ ] **Step 5: 手动验证（需要浏览器，由用户在自己的服务器上做；执行者无法验证时在报告里明说「未在浏览器验证」，不要声称已验证）**：手机竖屏打开菜单页，整周 7 天 × 3 餐不用下滑就能看全（底部「生成采购」按钮和标签栏可以在屏幕内）；今天那一列高亮；点任一格打开对应日期和餐次的编辑窗；一餐写 4 道菜，格子显示 3 道加「+1」，编辑窗里能看到 4 道；写一道很长的菜名，格子不被撑开、页面没有横向滚动；写菜名 `<b>x</b>` 显示成文字；翻到上周、下周，没有今天的那一周没有高亮；电脑宽屏下 7 列铺满，菜名完整，没有「+N」。
- [ ] **Step 6: Commit** —— `git add public/index.html public/app.js public/style.css README.md 验收清单.md` + `git commit -m "feat(menu): 菜单页改为日历式横排，手机一屏显示整周"`（说明末尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`）。临时预览文件 `preview-menu-calendar.html` 不提交，实现完成后删除。
