# frp 内网穿透部署指南

通过阿里云 ECS 实现外网访问家里的服务，架构：`手机 → 云端8080 → frp隧道 → 家里3000`

---

## 前置要求

- 阿里云 ECS 一台（任意配置，1核1G足够）
- 家里有一台设备（Windows PC / Linux 开发板）跑家庭物资清点表
- 阿里云安全组**必须放行**端口：7000/TCP（frp通信）、8080/TCP（HTTP访问）

---

## 一、云端服务器配置（5分钟）

### 1.1 安装 frps

SSH 登录阿里云 ECS，运行：

```bash
# 方式一：从 Gitee 克隆仓库
git clone https://gitee.com/b1u3/home_restore.git
cd home_restore/deploy
bash frps-install.sh

# 方式二：手动下载脚本
wget https://gitee.com/b1u3/home_restore/raw/main/deploy/frps-install.sh
bash frps-install.sh
```

**记录输出的 token 和服务器公网 IP**，家里客户端需要用。

### 1.2 配置阿里云安全组

登录 [阿里云控制台](https://ecs.console.aliyun.com) → 网络与安全 → 安全组 → 配置规则 → 添加：

| 协议  | 端口范围 | 授权对象      | 说明             |
|-------|----------|---------------|------------------|
| TCP   | 7000     | 0.0.0.0/0     | frp 通信端口     |
| TCP   | 8080     | 0.0.0.0/0     | 物资清点表 HTTP  |

### 1.3 验证 frps 状态

```bash
# 查看服务状态
sudo systemctl status frps

# 查看日志
sudo journalctl -u frps -f

# 测试端口
ss -tlnp | grep 7000    # 应该看到 frps 监听 0.0.0.0:7000
ss -tlnp | grep 8080    # 暂时看不到，等客户端连上后才有
```

---

## 二、家里客户端配置

### 选项 A：Linux 开发板

```bash
# 1. 安装 frpc
cd /tmp
git clone https://gitee.com/b1u3/home_restore.git
cd home_restore/deploy
bash frpc-install.sh

# 2. 配置客户端
sudo nano /opt/frp/frpc.toml
```

填入以下内容（**替换服务器 IP 和 token**）：

```toml
serverAddr = "你的阿里云公网IP"    # 如 47.98.123.45
serverPort = 7000
auth.method = "token"
auth.token = "从云端frps-install.sh输出获取"

log.to = "/var/log/frp/frpc.log"
log.level = "info"
log.maxDays = 7

transport.poolCount = 3
transport.heartbeatInterval = 30

[[proxies]]
name = "home-inventory"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3000
remotePort = 8080
```

```bash
# 3. 启动 frpc
sudo mkdir -p /var/log/frp
sudo cp deploy/frpc.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable frpc
sudo systemctl start frpc

# 4. 验证
sudo systemctl status frpc
sudo journalctl -u frpc -f
```

---

### 选项 B：Windows PC

以**管理员身份**打开 PowerShell，运行：

```powershell
# 方式一：自动脚本
cd D:\test\home\deploy
.\frpc-install-windows.ps1

# 然后手动编辑 C:\frp\frpc.toml，填入服务器 IP 和 token
# 最后以管理员运行：
cd C:\frp
.\nssm.exe install frpc C:\frp\frpc.exe -c C:\frp\frpc.toml
.\nssm.exe start frpc
```

**或手动安装**：

1. 下载 frpc: https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_windows_amd64.zip
2. 解压到 `C:\frp`
3. 复制 `deploy/frpc.toml.example` → `C:\frp\frpc.toml`，填入服务器信息
4. 下载 NSSM: https://nssm.cc/release/nssm-2.24.zip，放到 `C:\frp`
5. 以管理员运行：
   ```cmd
   cd C:\frp
   nssm.exe install frpc frpc.exe -c C:\frp\frpc.toml
   nssm.exe start frpc
   ```

---

## 三、验证连接

### 3.1 云端检查

```bash
# 在阿里云 ECS 上
sudo ss -tlnp | grep 8080
# 应该看到 frps 监听 0.0.0.0:8080，状态 LISTEN

# 查看 frps 日志
sudo journalctl -u frps -n 20
# 应该看到类似 "[home-inventory] client connected"
```

### 3.2 家里检查

```bash
# Linux 开发板
sudo journalctl -u frpc -n 20
# 应该看到 "login to server success"

# Windows（查看日志）
Get-Content C:\frp\logs\frpc.log -Tail 20
```

### 3.3 手机测试

1. 确保家里的物资清点表已启动：`node server.js` 在 `http://localhost:3000`
2. 手机浏览器访问：`http://你的阿里云公网IP:8080`
3. 如果能看到登录页，输入密码 `home1234`，成功！

---

## 四、HTTPS 配置（可选但推荐）

### 4.1 准备域名

1. 注册一个域名（或使用已有的），如 `home.example.com`
2. 在 DNS 服务商添加 A 记录：`home` → `你的阿里云公网IP`
3. 等待 DNS 生效（1-10分钟，用 `nslookup home.example.com` 检查）

### 4.2 安装 Nginx + Let's Encrypt

在阿里云 ECS 上：

```bash
cd /path/to/home_restore/deploy
bash nginx-proxy.sh home.example.com

# 等 DNS 生效后
sudo certbot --nginx -d home.example.com
# 按提示输入邮箱、同意协议，自动配置 HTTPS
```

### 4.3 修改 frpc 配置

由于 Nginx 已监听 80/443，把 frps 的 remotePort 改为其他端口（如 18080），然后 Nginx 反向代理：

```bash
# 家里 frpc 改配置
sudo nano /opt/frp/frpc.toml
# 把 remotePort = 8080 改为 18080
sudo systemctl restart frpc

# 云端 Nginx 反向代理
sudo nano /etc/nginx/sites-available/home-inventory
# 把 proxy_pass 改为 http://127.0.0.1:18080
sudo nginx -t && sudo systemctl reload nginx
```

现在手机访问 `https://home.example.com` 即可（自动跳转 HTTPS）。

---

## 五、安全加固（生产环境必做）

### 5.1 修改默认密码

登录物资清点表后，在 设置 → 修改密码，把 `home1234` 改成强密码。

### 5.2 限制云端访问 IP（可选）

如果你只想让自己的手机访问，在阿里云安全组把 8080 端口的授权对象从 `0.0.0.0/0` 改为你的手机运营商 IP 段（不推荐，因为 4G/5G IP 经常变）。

更好的方案：用 Nginx 的 `allow/deny` 或者云端安装 Fail2ban 防止暴力破解。

### 5.3 启用 frp 加密（可选）

在 `frpc.toml` 和 `frps.toml` 都加上：

```toml
transport.tls.enable = true
```

重启两端服务，frp 通信会走 TLS 加密（默认只是 token 认证但明文传输）。

---

## 六、故障排查

### 问题 1：手机访问云端 IP:8080 无响应

**检查清单**：
1. 阿里云安全组是否放行 8080？
2. 云端 `sudo ss -tlnp | grep 8080` 是否监听？
3. 云端 `curl http://127.0.0.1:8080` 是否返回页面？
4. 家里 frpc 是否启动？`sudo systemctl status frpc`
5. 家里服务是否启动？`curl http://localhost:3000`

### 问题 2：frpc 一直重连

```bash
# 查看 frpc 日志
sudo journalctl -u frpc -n 50

# 常见原因：
# - token 填错
# - 云端 frps 没启动
# - 云端安全组没放行 7000
# - 家里网络不稳定
```

### 问题 3：访问很慢

- frp 会增加 10-50ms 延迟（取决于你家到阿里云的网络）
- 如果延迟 >100ms，检查云端和家里的带宽、CPU 占用
- 可以开启 KCP 加速：在 `frpc.toml` 和 `frps.toml` 都加 `transport.protocol = "kcp"`

### 问题 4：Windows 上 frpc 服务无法启动

```powershell
# 查看 NSSM 日志
Get-Content C:\frp\logs\stderr.log -Tail 50

# 手动测试
cd C:\frp
.\frpc.exe -c frpc.toml
# 看是否报错
```

---

## 七、性能与成本

### 带宽消耗

- 日常浏览：每次操作 10-50 KB
- 上传图片：按原图大小（前端已压缩到 1280px，约 100-300 KB）
- 一个月轻度使用（每天 10 次操作 + 5 张图片）：约 **100 MB**

阿里云轻量应用服务器 1TB/月 流量足够用一辈子。

### 资源占用

- **云端 frps**：约 10 MB 内存，0.1% CPU
- **家里 frpc**：约 8 MB 内存，几乎 0 CPU
- 你的 i.MX6ULL 开发板完全够用

### 成本

- 阿里云轻量应用服务器：99 元/年起（1核1G，1TB流量）
- 域名（可选）：10-50 元/年
- Let's Encrypt HTTPS 证书：免费

---

## 八、备选方案对比

如果你觉得 frp 配置麻烦，这些方案也可以考虑：

| 方案              | 优点                        | 缺点                      | 推荐度 |
|-------------------|-----------------------------|---------------------------|--------|
| Tailscale         | 零配置，延迟最低            | 需手机装 app，国内可能慢  | ⭐⭐⭐⭐⭐ |
| Cloudflare Tunnel | 零成本，自动 HTTPS          | 延迟高（200ms+）          | ⭐⭐⭐⭐   |
| frp（当前方案）   | 完全可控，延迟中等          | 需云服务器，配置复杂      | ⭐⭐⭐⭐   |
| ZeroTier          | 类似 Tailscale              | 国内速度一般              | ⭐⭐⭐    |

你已经有阿里云服务器了，frp 是最合适的。如果觉得配置麻烦，也可以试试 Tailscale（5分钟搞定）。
