# 部署到 Linux 开发板

适用于常年开机的树莓派、Orange Pi、NanoPi、i.MX6ULL 等跑 Debian/Ubuntu/Armbian 的板子。整个服务只依赖 Node.js（≥ 22.13，自带 SQLite），不需要数据库、Docker 或 `npm install`。

> 流程概览：把源码推到 Git 仓库 → 开发板上 `git clone` → `sudo bash deploy/install.sh` → 手机访问 `http://开发板IP:3000`。

## 针对 i.MX6ULL（Cortex-A7 单核 800MHz / 512MB）的说明

| 项目 | 结论 |
|---|---|
| 架构 | `uname -m` 应为 **`armv7l`**（32 位硬浮点）。NodeSource 不提供这个架构，`install.sh` 会自动改为下载 Node 22 官方 `linux-armv7l` 二进制包（默认走 npmmirror 国内镜像） |
| 系统要求 | 需要 **glibc ≥ 2.28** 的 Linux（Debian 10+ / Ubuntu 20.04+ 的厂商镜像均满足）。如果板子跑的是 Buildroot/Yocto 精简系统且没有 `apt`，请先刷厂商提供的 Debian/Ubuntu 镜像；musl 系统不支持 |
| 资源占用 | 服务常驻约 50~70MB 内存；单核下冷启动 3~6 秒，之后每次请求几十毫秒。service 文件已把 V8 堆上限设为 160MB |
| 存储 | 4GB eMMC 足够（程序 + Node 约 120MB，数据和图片按量增长）；图片多的话把 `INVENTORY_DATA` 指到 TF 卡 |
| 本地 AI | 不可行（语音识别/大模型至少需要 1~2GB 内存 + 多核）。"一句话录入"功能是纯规则解析，完全不需要 AI，板子上照常可用；语音识别交给手机键盘 |
| 网络 | 用有线 RJ45 更稳；WiFi 下记得在路由器里给板子保留固定 IP |

---

## 0. 准备：把源码推到 Git 仓库

在 Windows 电脑的项目目录（`D:\test\home`）执行：

```powershell
git init
git add .
git commit -m "家庭物资清点表"
git remote add origin https://github.com/<你的用户名>/home-inventory.git   # Gitee / 自建 Gitea 均可
git push -u origin master
```

`.gitignore` 已排除 `data/`（数据库、图片、密码）和截图，所以仓库里不会带任何个人数据。

> 如果想把 Windows 上已经录入的数据一并迁过去，稍后用 `scp` 单独复制 `data/` 目录，见第 5 节。

---

## 1. 开发板基础检查

SSH 登录开发板后：

```bash
uname -m            # 架构：aarch64 / armv7l / x86_64 / armv6l
cat /etc/os-release # 系统版本
ldd --version | head -1   # glibc 版本，Node 22 需要 ≥ 2.28（Debian 10+ / Ubuntu 20.04+）
```

建议先给开发板**固定 IP**（在路由器里做 DHCP 地址保留），否则 IP 变了手机书签就失效。

---

## 2. 安装 Node.js ≥ 22.13

先看看有没有、够不够新：

```bash
node -v
```

### 方式 A：NodeSource 源（aarch64 / x86_64，最省事）

```bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # 应显示 v22.x（≥ 22.13）
```

### 方式 B：官方二进制包（armv7l 等 NodeSource 不覆盖的架构，或不想加软件源）

```bash
ARCH=$(uname -m); case $ARCH in aarch64) A=arm64;; armv7l) A=armv7l;; x86_64) A=x64;; *) echo "架构 $ARCH 见下方说明"; esac
VER=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -o 'node-v22\.[0-9]*\.[0-9]*-linux-'$A'\.tar\.xz' | head -1)
curl -fL "https://nodejs.org/dist/latest-v22.x/$VER" -o /tmp/node.tar.xz
sudo mkdir -p /usr/local/lib/nodejs && sudo tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
sudo ln -sf /usr/local/lib/nodejs/${VER%.tar.xz}/bin/node /usr/local/bin/node
sudo ln -sf /usr/local/lib/nodejs/${VER%.tar.xz}/bin/npm  /usr/local/bin/npm
node -v
```

国内下载慢可以把 `https://nodejs.org/dist` 换成 `https://npmmirror.com/mirrors/node`。

- **armv6l**（树莓派 Zero / 1 代）：官方不再提供，可用 <https://unofficial-builds.nodejs.org/download/release/> 里的 `linux-armv6l` 包，步骤同上。
- **不要用 `apt install nodejs`** 自带的版本，Debian/Ubuntu 仓库里的 Node 通常是 12/18，太旧。
- 版本太低时服务启动会直接提示："当前 Node.js 为 vXX，本程序需要 Node.js 22.13 或更高版本"。

---

## 3. 拉取代码并安装为系统服务

```bash
cd ~
git clone https://github.com/<你的用户名>/home-inventory.git
cd home-inventory
sudo bash deploy/install.sh
```

脚本会：
1. 检查 Node 版本（没有的话：`armv7l/armv6l` 自动下载官方二进制包，其他架构走 NodeSource）；
2. 创建 `data/` 目录并归属当前用户；
3. 根据 `deploy/home-inventory.service` 模板生成 systemd 服务（自动填入用户名、目录、node 路径），设为开机自启并立即启动；
4. 若启用了 ufw 防火墙，放行 3000 端口；
5. 打印手机访问地址。

验证：

```bash
systemctl status home-inventory     # Active: active (running)
curl -s http://localhost:3000/api/me   # 返回 {"authed":false}
```

手机连同一 WiFi，浏览器打开 `http://<开发板IP>:3000`，初始密码 `home1234`，**登录后立刻在「设置」里改掉**。
iPhone 用 Safari、Android 用 Chrome 打开后选「添加到主屏幕」，之后像 App 一样全屏使用。

### 手工安装（不想用脚本时）

```bash
sudo cp deploy/home-inventory.service /etc/systemd/system/
sudo sed -i "s|__USER__|$USER|g; s|__DIR__|$PWD|g; s|__NODE__|$(command -v node)|g" /etc/systemd/system/home-inventory.service
sudo systemctl daemon-reload
sudo systemctl enable --now home-inventory
```

---

## 4. 可调配置

全部在 `/etc/systemd/system/home-inventory.service` 的 `Environment=` 行里，改完 `sudo systemctl daemon-reload && sudo systemctl restart home-inventory`（**小票识别的 key 例外，不要写在这里**，见本节末尾「小票识别」）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口。想用 80 端口直接 `http://ip` 访问见下方 |
| `INVENTORY_DATA` | `<项目>/data` | 数据目录（数据库 + 图片 + 密码）。放到外接硬盘时改这里，并同步修改 `ReadWritePaths=` |
| `INVENTORY_PASSWORD` | `home1234` | 仅首次启动生成 `config.json` 时生效 |
| `NODE_OPTIONS` | `--max-old-space-size=256` | 内存 512MB 的板子可以留着；1GB 以上可删 |

**用 80 端口（省掉 `:3000`）**：普通用户默认不能绑 1024 以下端口，在 `[Service]` 段加一行 `AmbientCapabilities=CAP_NET_BIND_SERVICE`，再把 `PORT` 改为 `80`。

**用主机名访问（不用记 IP）**：

```bash
sudo apt-get install -y avahi-daemon
sudo hostnamectl set-hostname home
```

之后 iPhone / Mac / Windows 可直接访问 `http://home.local:3000`（部分 Android 浏览器不支持 `.local`，仍需用 IP）。

### 小票识别（可选）

物品页的相机按钮需要一个能读图的多模态模型。**没配置就不显示相机按钮，其他功能不受影响。**

**推荐写在数据目录的 `data/config.json` 里**（在原有的 `passwordHash`、`secret` 旁边加一个 `receipt` 对象），并限制权限：

```json
{
  "passwordHash": "…保持原样…",
  "secret": "…保持原样…",
  "receipt": {
    "url": "https://api.deepseek.com/chat/completions",
    "key": "你的 key",
    "model": "模型名",
    "format": "openai",
    "extra": {},
    "timeoutSec": 60,
    "dailyLimit": 30
  }
}
```

```bash
chmod 600 data/config.json
sudo systemctl restart home-inventory   # 改完配置要重启；启动日志会提示「小票识别已启用」或配置问题
```

不要把 key 直接写进 systemd 单元文件的 `Environment=`：单元文件和 `systemctl show` 通常所有用户都能读。想用环境变量的话，放进一个只有 root 能读的环境变量文件：

```bash
sudo install -m 600 -o root -g root /dev/null /etc/home-inventory.env
sudoedit /etc/home-inventory.env        # 每行一项，如 RECEIPT_API_KEY=你的key
# 再在单元文件的 [Service] 段加一行：EnvironmentFile=-/etc/home-inventory.env
sudo systemctl daemon-reload && sudo systemctl restart home-inventory
```

环境变量优先于配置文件，逐项覆盖：

| 环境变量 | 对应字段 | 说明 |
|---|---|---|
| `RECEIPT_API_URL` | `url` | 完整接口地址，写到最后的路径 |
| `RECEIPT_API_KEY` | `key` | 识别服务的 key。只存在于服务器，任何接口都不会返回它 |
| `RECEIPT_MODEL` | `model` | 能读图的模型名 |
| `RECEIPT_FORMAT` | `format` | `openai`（默认）、`anthropic` 或 `responses` |
| `RECEIPT_EXTRA` | `extra` | JSON 对象，合并进请求体最外层；用环境变量时整体替换文件里的 `extra`；不是合法 JSON 对象会视为未配置 |
| `RECEIPT_TIMEOUT_S` | `timeoutSec` | 超时秒数，默认 60 |
| `RECEIPT_DAILY_LIMIT` | `dailyLimit` | 每天最多识别几次，默认 30，`0` 表示不限（防止误操作烧钱） |

`url`、`key`、`model` 三项齐全才算已配置。三种 `format` 的地址写法：

| `format` | 适用 | 地址示例 |
|---|---|---|
| `openai` | OpenAI 兼容接口（DeepSeek 官方、多数中转站和国内模型） | `https://…/chat/completions` |
| `anthropic` | Anthropic 格式 | `https://…/v1/messages` |
| `responses` | 火山方舟的 Responses 接口 | `https://ark.cn-beijing.volces.com/api/v3/responses` |

**`extra` 的用法**：有的模型默认开着「深度思考」，会慢很多、花很多 token。方舟的模型可以关：`{"thinking":{"type":"disabled"}}`。需要限制输出长度也写在这里，参数名因服务商而异：`max_tokens`、`max_completion_tokens` 或 `max_output_tokens`。程序本身不设输出上限，主要靠每日次数上限控制花费。

**隐私与花费**：拍的小票图会发给你配置的识别服务，不会保存在服务器上。次数用量记在 `data/receipt-usage.json`，全家共用一个计数，重启不会清零。建议给这个功能单独申请一个 key，余额放少一点。

### 语音识别（可选）

物品页的麦克风按钮需要一个能听音频的识别服务。**它和小票识别是两套完全独立的配置、独立的次数计数，互不影响；没配置就不显示麦克风按钮，其他功能不受影响。**

**前提：页面必须是 HTTPS**（浏览器只在安全页面允许录音）。用 `http://IP:端口` 访问时，即使配置好了也看不到麦克风按钮。HTTPS 的配法见 `deploy/CLOUD.md`（域名 + Nginx + Let's Encrypt）。

在 `data/config.json` 里加一个 `asr` 对象（和 `receipt` 并列，JSON 里要用英文半角引号，前一项末尾别忘了逗号）：

```json
"asr": {
  "url": "https://ark.cn-beijing.volces.com/api/v3/responses",
  "key": "你的 key",
  "model": "能听音频的模型名",
  "format": "responses",
  "extra": { "thinking": { "type": "disabled" } },
  "timeoutSec": 30,
  "dailyLimit": 100,
  "maxSeconds": 30
}
```

改完同样 `chmod 600 data/config.json` 并重启服务；启动日志里会提示「语音识别已启用」或配置问题。也可以用环境变量（优先于配置文件，逐项覆盖；key 请放在只有 root 能读的环境变量文件里，写法同上面小票识别的说明）：

| 环境变量 | 对应字段 | 说明 |
|---|---|---|
| `ASR_API_URL` | `url` | 完整接口地址 |
| `ASR_API_KEY` | `key` | 识别服务的 key，只存在于服务器，任何接口都不会返回它 |
| `ASR_MODEL` | `model` | 能听音频的模型名 |
| `ASR_FORMAT` | `format` | 目前只支持 `responses`（火山方舟的 Responses 接口，音频用 `input_audio` 传） |
| `ASR_EXTRA` | `extra` | JSON 对象，合并进请求体；方舟的模型建议 `{"thinking":{"type":"disabled"}}`，否则会很慢 |
| `ASR_TIMEOUT_S` | `timeoutSec` | 超时秒数，默认 30 |
| `ASR_DAILY_LIMIT` | `dailyLimit` | 每天最多识别几次，默认 100，`0` 表示不限 |
| `ASR_MAX_SECONDS` | `maxSeconds` | 单段录音最长几秒，默认 30，最大 60。识别服务如果拒绝较长的录音，调小它即可 |

`url`、`key`、`model` 三项齐全才算已配置。录音在浏览器里转成 16kHz 单声道 WAV 再上传（最大 2MB），**只发给你配置的识别服务，不会保存在服务器上**。次数用量记在 `data/asr-usage.json`，重启不会清零。可以一口气说几件事，识别后按句号拆开逐句解析，一次最多处理 5 句。

---

## 5. 从 Windows 迁移已录入的数据

在 Windows 上停掉服务（关掉 `start.bat` 窗口），然后：

```powershell
scp -r D:\test\home\data\* pi@192.168.1.xx:/home/pi/home-inventory/data/
```

开发板上：

```bash
sudo systemctl stop home-inventory
sudo chown -R $USER:$USER ~/home-inventory/data
sudo systemctl start home-inventory
```

`data/config.json` 一起复制过去的话，密码也随之迁移。

---

## 6. 日常运维

```bash
journalctl -u home-inventory -f            # 实时日志
sudo systemctl restart home-inventory      # 重启
cd ~/home-inventory && git pull && sudo systemctl restart home-inventory   # 更新代码
```

**自动备份**（每天 3 点，保留 14 份，默认到 `~/inventory-backups`）：

```bash
sudo apt-get install -y sqlite3          # 可选：有它备份时会用 SQLite 在线备份保证一致性
chmod +x deploy/backup.sh
( crontab -l 2>/dev/null; echo "0 3 * * * $HOME/home-inventory/deploy/backup.sh $HOME/inventory-backups" ) | crontab -
```

备份目录可以指到 U 盘 / NAS 挂载点。恢复：停服务 → 解压覆盖 `data/` → 启动。

---

## 7. 外出时也想访问？

当前服务是 HTTP 明文、单一密码，**不要直接把 3000 端口映射到公网**。推荐两种零配置方案：

- **Tailscale**（最简单）：开发板和手机都装 Tailscale 登录同一账号，手机在任何网络下用开发板的 Tailscale IP（100.x.x.x）访问，流量端到端加密。
  ```bash
  curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
  ```
- **ZeroTier / frp + HTTPS 反代**：同理，前者类似 Tailscale，后者需要有公网服务器并自行配置 Caddy/Nginx 的 HTTPS。

---

## 8. 故障排查

| 现象 | 处理 |
|---|---|
| `Cannot find module 'node:sqlite'` 或版本提示 | Node 太旧，按第 2 节升级；`which node` 确认 systemd 用的是新装的那个（脚本会写绝对路径） |
| `EADDRINUSE` | 端口被占用：`sudo ss -ltnp | grep 3000`，换 `PORT` 或停掉占用进程 |
| 手机打不开，开发板本机 `curl` 正常 | 防火墙：`sudo ufw allow 3000/tcp`，或 `sudo iptables -L -n` 看规则；确认手机和开发板在同一网段（访客 WiFi 常常隔离） |
| `EACCES` / 数据库只读 | `sudo chown -R <用户>:<用户> data`；若改了 `INVENTORY_DATA`，确认 service 里 `ReadWritePaths=` 也改了 |
| 上传图片失败 413 | 单张物品图上限 15MB、图纸 20MB（浏览器端会先压缩，一般不会触发） |
| 板子重启后服务没起来 | `systemctl is-enabled home-inventory` 应为 `enabled`；`journalctl -u home-inventory -b` 看启动日志 |
