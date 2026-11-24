# 家庭物资清点表

记录家里的物资、数量和存放位置，电脑和手机都能查看、修改。零第三方依赖，只需要 Node.js（≥ 22.5，自带 SQLite）。

## 启动

```
双击 start.bat        （或在本目录执行 node server.js）
```

启动后终端会打印访问地址，例如：

```
  本机：   http://localhost:3000
  手机访问：http://192.168.1.150:3000  （需与本机在同一 WiFi）
```

- 初始密码：`home1234`（首次启动时也可用环境变量 `INVENTORY_PASSWORD` 指定），登录后在「设置」里修改。
- 端口可用环境变量 `PORT` 修改。
- 手机浏览器打开后选择「添加到主屏幕」，即可像 App 一样全屏使用。
- 若手机连不上：检查 Windows 防火墙是否放行了 `node.exe` 的入站连接（首次启动通常会弹窗询问，选择“允许”）。

## 功能

| 功能 | 说明 |
|---|---|
| 首页仪表盘 | 打开就看到：物品总数 / 已过期 / 30 天内到期 / 待购买 四个数字，以及快到期、库存不足、最近添加、最近变动四个列表，点任意一行直接打开该物品 |
| 购物清单 | 给物品设「最低库存」，数量低于它就自动出现在清单里（按分类分组）；点「已买」把数量补到最低库存。也可手动添加条目、勾选、一键清除已买 |
| 每周菜单 | 首页「日常工具」卡片 → 工具页 → 每周菜单（不是底部 Tab）。日历式一屏横排周一到周日（带日期），每天早/午/晚三餐，可翻到上/下周、补录过去的周；每道菜可带食材（数量可不填），输入曾经用过的菜名会自动带出上次的食材。「按本周菜单生成采购」会对照库存（一道菜出现一次算 1 份；没写数量且库存里有的食材视为够用），缺的在确认卡里列出，确认后作为手动条目加入购物清单——在清单里点「已买」只是勾选，不会自动改库存；菜单本身也从不扣库存。超过约 3 个月的菜单自动删除 |
| 删除可撤销 | 删除物品后 toast 上有「撤销」；回收站（设置页）保留 30 天，可恢复或彻底删除。**数量减到 0（用完）会自动移入回收站**，同样可撤销 |
| 变动记录 | 每次新增 / 数量增减 / 移动位置 / 修改 / 删除都有记录，标注来源（手动 / 一句话 / 导入 / 购物清单）；物品编辑页底部显示该物品最近 8 条 |
| 一句话录入 | 物品页顶部输入框，手机上点键盘 🎤 说一句："买了两盒酸奶放冷藏，保质期到12月1日"、"把电钻放到车库的工具架上"、"创可贴用完了"、"电池还剩8节"。纯规则解析（不联网、不需要 AI），自动识别动作、数量单位、位置（可自动新建层级）、分类、到期日，**先弹确认卡、可改后再保存**。一次说多种物品可以不加停顿（如「买了牛肉猪肉排骨」「两斤牛肉三斤排骨」），常见物品会自动拆成多项，依据是内置词表（`lib/vocab.js`，可自行增删）和你库存里已有的名字；不在词表里的词不会被拆，整串保持一项，在确认卡上手动改即可 |
| 小票录入（可选） | 物品页相机按钮：拍购物小票或选一张 App 订单截图，交给你自己配置的多模态识别服务读出商品，弹出和一句话录入同样的确认卡（库存里有的「补货」，没有的「新增」），核对后一键入库。需要先在服务器上配置识别服务（见 `DEPLOY.md`），没配置就看不到相机按钮；图片只发给识别服务，不会保存，永远先确认再写库存 |
| 语音录入（可选） | 物品页麦克风按钮：点一下开始说话、再点一下结束，录音交给你自己配置的语音识别服务转成文字，自动填进一句话录入框并解析，弹出确认卡，核对后一键入库。**可以一口气说几件事**，用停顿或句号隔开（如「把鸡蛋放入冰箱冷藏，买了五花肉一盒」，最多处理 5 句）。需要页面是 **HTTPS**（浏览器只在安全页面允许录音），并先在服务器上配置语音识别（见 `DEPLOY.md`，与小票识别是两套独立的配置）；没配置或不是 HTTPS 就看不到麦克风按钮。录音只发给识别服务、不保存，永远先确认再写库存 |
| 物品管理 | 名称、数量 + 单位、分类、存放位置、到期日、备注、图片；列表上可直接 ＋/－ 数量 |
| 位置层级 | 房间 → 柜子 → 层/抽屉，层级不限；按上级位置筛选时自动包含下级 |
| 搜索筛选 | 关键字（名称/备注/分类/位置）、位置、分类、到期范围 |
| 过期提醒 | 顶部统计显示已过期 / 30 天内到期数量，点击即可筛选；列表中以红/橙标签高亮 |
| 户型图纸 | 上传家里的平面图（可多张，如一楼/二楼），把柜子、抽屉等位置「标记」在图上；点标记即可看到那里的物品数并跳转查看 / 添加；标记可拖动微调，支持放大缩小 |
| 图片 | 手机可直接拍照，上传前在浏览器内压缩到最长边 1280px |
| 导入导出 | 导出 CSV（Excel 可直接打开）；导入 CSV 只需「名称」列必填，位置写成 `厨房 / 吊柜` 会自动创建，自动识别 UTF-8 / GBK 编码 |
| 密码保护 | 单一家庭密码，登录状态保留 180 天；改密码后所有设备需重新登录 |

## 数据与备份

所有数据都在 `data/` 目录：

- `data/inventory.db` — SQLite 数据库（物品、位置）
- `data/uploads/` — 图片
- `data/config.json` — 密码哈希与会话密钥

备份时整个复制 `data/` 目录即可；也可在「设置」中导出 CSV。可用环境变量 `INVENTORY_DATA` 把数据目录放到别处（例如 NAS 的共享盘）。

## 部署到 Linux 开发板 / NAS

见 [DEPLOY.md](DEPLOY.md)：安装 Node ≥ 22.13、`git clone`、`sudo bash deploy/install.sh` 一键注册 systemd 服务，含数据迁移、备份、外网访问建议和故障排查。

## 开机自启（Windows，可选）

`Win + R` 输入 `shell:startup`，把 `start.bat` 的快捷方式放进去。

## 目录结构

```
server.js            后端（HTTP + SQLite + API）
lib/parse.js         "一句话录入"的中文规则解析器（分类词典、位置别名都在这里，可按自家习惯改）
public/              前端单页（无构建步骤，直接改即可）
  index.html / app.js / style.css
  manifest.webmanifest / icon.svg   添加到主屏幕用
deploy/              Linux 部署：systemd 模板、install.sh、backup.sh
test/smoke.js        API 冒烟测试：先启动服务，再运行 npm test
test/parse.test.js   解析器回归测试（28 句口语样例）：node test/parse.test.js
test/screenshot.js   手机视口截图 + 布局检查（需要 Edge/Chrome）
```

## 接口一览

所有 `/api/*`（除 login/logout/me）都需要登录 cookie。

```
POST /api/login {password}            POST /api/logout          GET /api/me
POST /api/password {oldPassword,newPassword}
GET  /api/locations                   POST /api/locations {name,parent_id}
PUT  /api/locations/:id {name,parent_id,plan_id,x,y}            DELETE /api/locations/:id
GET  /api/items?q=&category=&location=<id|none>&expiring=<days>&low=1
POST /api/items {...,min_quantity}    PUT /api/items/:id {...}   （可加 ?source=quick|list 标注来源）
DELETE /api/items/:id                 进回收站；?purge=1 彻底删除
POST /api/items/:id/restore           从回收站恢复
GET  /api/trash                       DELETE /api/trash（清空）
POST /api/items/:id/bought {quantity?} 购物清单「已买」：补到最低库存或指定数量
POST /api/items/:id/image (body=图片二进制, Content-Type=image/jpeg|png|webp)
DELETE /api/items/:id/image
GET  /api/plans                       POST /api/plans?name=  (body=图片二进制)
PUT  /api/plans/:id {name}            POST /api/plans/:id/image   DELETE /api/plans/:id
POST /api/parse {text}                一句话 → 意图列表（不写库，由前端确认后调用上面的接口）
POST /api/locations/path {path:"书房 / 书架"}   按路径逐级查找或创建位置
GET  /api/dashboard                   首页：计数 + 快到期 / 库存不足 / 最近添加 / 最近变动
GET  /api/shopping                    {low:[自动], extra:[手动]}
POST /api/shopping {name,note}        PUT /api/shopping/:id {done}   DELETE /api/shopping/:id   DELETE /api/shopping（清除已勾选）
GET  /api/log?item=<id>&limit=        变动记录
GET  /api/categories                  GET /api/stats
GET  /api/export.csv                  POST /api/import (body=CSV 文本；可含「最低库存」列)
```
