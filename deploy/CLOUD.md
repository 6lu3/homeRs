# 云端直接部署指南

在阿里云 Ubuntu 20.04/22.04 上直接运行家庭物资清点表，不需要内网穿透。

---

## 前置要求

- 阿里云 ECS（1核1G起，推荐 1核2G）
- 操作系统：Ubuntu 20.04 或 22.04
- 可选：一个域名（用于 HTTPS）

---

## 一键部署（10 分钟）

### 1. SSH 登录云服务器

```bash
ssh root@你的阿里云公网IP
```

### 2. 运行部署脚本

```bash
# 下载仓库
git clone https://gitee.com/b1u3/home_restore.git
cd home_restore/deploy

# 执行一键安装
sudo bash cloud-install.sh
```

脚本会询问：
- **是否配置域名？** 输入 `y` 并填域名（如 `home.example.com`），或直接回车用 IP 访问
- **初始密码？** 留空默认 `home1234`，或设一个你自己的
- **内部端口？** 留空默认 `3000`

### 3. 等待完成

脚本会自动：
- ✓ 安装 Node.js 22、Nginx
- ✓ 下载应用代码到 `/opt/home-inventory`
- ✓ 创建 systemd 服务并启动
- ✓ 配置 Nginx 反向代理（监听 80 端口）
- ✓ 配置防火墙（开放 22、80、443）

完成后会显示访问地址和初始密码。

### 4. 访问测试

**如果用 IP 访问**（没配置域名）：
- 手机浏览器打开 `http://你的公网IP`
- 输入初始密码登录

**如果配置了域名**：
- 先在域名 DNS 服务商添加 A 记录：`home` → `你的公网IP`
- 等 1-10 分钟 DNS 生效（用 `nslookup home.example.com` 检查）
- 然后在服务器上运行：
  ```bash
  sudo certbot --nginx -d home.example.com -m 你的邮箱 --agree-tos --non-interactive
  ```
- 手机访问 `https://home.example.com`（自动 HTTPS）

---

## 配置阿里云安全组（重要！）

脚本已配置服务器防火墙，但**阿里云安全组**需要手动放行：

1. 登录 [阿里云控制台](https://ecs.console.aliyun.com)
2. 网络与安全 → 安全组 → 配置规则
3. 添加入方向规则：

| 协议 | 端口范围 | 授权对象   | 说明           |
|------|----------|------------|----------------|
| TCP  | 22       | 0.0.0.0/0  | SSH 登录       |
| TCP  | 80       | 0.0.0.0/0  | HTTP 访问      |
| TCP  | 443      | 0.0.0.0/0  | HTTPS 访问     |

保存后立即生效。

---

## 日常管理

### 查看服务状态

```bash
# 应用服务
sudo systemctl status home-inventory

# 查看实时日志
sudo journalctl -u home-inventory -f

# 重启服务
sudo systemctl restart home-inventory
```

### 查看 Nginx 日志

```bash
# 访问日志
sudo tail -f /var/log/nginx/home-inventory.access.log

# 错误日志
sudo tail -f /var/log/nginx/home-inventory.error.log
```

### 修改密码

登录后在 设置 → 修改密码，或直接编辑 `/opt/home-inventory/data/config.json`。

### 备份数据

```bash
# 打包数据目录
cd /opt/home-inventory
sudo tar -czf ~/backup-$(date +%F).tar.gz data/

# 下载到本地（在你的电脑上运行）
scp root@你的IP:~/backup-*.tar.gz ~/Downloads/
```

### 恢复数据

```bash
# 上传备份文件到服务器
scp ~/backup-2026-11-13.tar.gz root@你的IP:~/

# 恢复
sudo systemctl stop home-inventory
cd /opt/home-inventory
sudo tar -xzf ~/backup-2026-11-13.tar.gz
sudo systemctl start home-inventory
```

### 更新应用

```bash
cd /opt/home-inventory
sudo git pull
sudo systemctl restart home-inventory
```

---

## 性能优化

### 1. 启用 Gzip 压缩（节省带宽）

编辑 `/etc/nginx/nginx.conf`，在 `http {}` 块中启用：

```nginx
gzip on;
gzip_vary on;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
gzip_min_length 1000;
```

重启 Nginx：`sudo systemctl reload nginx`

### 2. 配置日志轮转（防止日志占满磁盘）

创建 `/etc/logrotate.d/home-inventory`：

```
/var/log/nginx/home-inventory.*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 `cat /var/run/nginx.pid`
    endscript
}
```

### 3. 定时备份（每天凌晨 3 点）

```bash
sudo crontab -e
```

添加：

```cron
0 3 * * * cd /opt/home-inventory && tar -czf ~/backup-$(date +\%F).tar.gz data/ && find ~ -name "backup-*.tar.gz" -mtime +7 -delete
```

自动保留最近 7 天的备份，旧的自动删除。

---

## 安全加固

### 1. 修改 SSH 端口（可选）

```bash
sudo nano /etc/ssh/sshd_config
# 把 Port 22 改成 Port 2222
sudo systemctl restart sshd

# 记得在安全组放行新端口，再关闭 22
```

### 2. 禁用密码登录，只用密钥

```bash
# 先在本地生成密钥对（如果没有）
ssh-keygen -t ed25519

# 把公钥上传到服务器
ssh-copy-id root@你的IP

# 测试密钥登录成功后，禁用密码
sudo nano /etc/ssh/sshd_config
# 设置 PasswordAuthentication no
sudo systemctl restart sshd
```

### 3. 安装 Fail2ban（防暴力破解）

```bash
sudo apt install -y fail2ban

# 启用 Nginx 登录保护
sudo tee /etc/fail2ban/jail.local > /dev/null <<EOF
[nginx-login]
enabled = true
filter = nginx-login
logpath = /var/log/nginx/home-inventory.access.log
maxretry = 5
bantime = 3600
EOF

# 创建过滤规则
sudo tee /etc/fail2ban/filter.d/nginx-login.conf > /dev/null <<EOF
[Definition]
failregex = ^<HOST>.*"POST /api/login HTTP.*" 401
ignoreregex =
EOF

sudo systemctl restart fail2ban
```

登录失败 5 次后自动封禁 IP 1 小时。

### 4. 启用 HTTPS（强烈推荐）

如果有域名：

```bash
sudo certbot --nginx -d 你的域名 -m 你的邮箱 --agree-tos --non-interactive
```

证书会自动续期，无需手动干预。

---

## 故障排查

### 问题 1：访问公网 IP 无响应

**检查清单**：
1. 阿里云安全组是否放行 80 端口？
2. 服务器防火墙：`sudo ufw status`
3. Nginx 是否运行：`sudo systemctl status nginx`
4. 应用是否运行：`sudo systemctl status home-inventory`
5. 应用端口是否监听：`sudo ss -tlnp | grep 3000`

**快速诊断**：

```bash
# 测试应用
curl http://127.0.0.1:3000/api/me

# 测试 Nginx
curl http://127.0.0.1/api/me

# 从外部测试（在你的电脑上）
curl http://你的公网IP/api/me
```

### 问题 2：服务启动失败

```bash
# 查看详细错误
sudo journalctl -u home-inventory -n 50 --no-pager

# 常见原因：
# - 端口被占用：sudo ss -tlnp | grep 3000
# - 权限问题：sudo chown -R root:root /opt/home-inventory
# - Node.js 版本过低：node --version（需要 >=22.13）
```

### 问题 3：HTTPS 证书获取失败

```bash
# 检查域名 DNS 是否生效
nslookup 你的域名

# 查看 certbot 日志
sudo certbot certificates
sudo tail -f /var/log/letsencrypt/letsencrypt.log

# 手动测试
sudo certbot --nginx -d 你的域名 --dry-run
```

### 问题 4：内存不足（1核1G 服务器）

编辑 `/etc/systemd/system/home-inventory.service`，降低内存限制：

```ini
MemoryMax=150M
```

然后重启：

```bash
sudo systemctl daemon-reload
sudo systemctl restart home-inventory
```

或者在阿里云控制台升级到 1核2G（推荐）。

---

## 成本估算

### 阿里云 ECS 轻量应用服务器

| 配置       | 价格     | 说明                          |
|------------|----------|-------------------------------|
| 1核1G      | 99元/年  | 够用，需开启 swap             |
| 1核2G      | 118元/年 | 推荐，运行更流畅              |
| 2核2G      | 298元/年 | 可承载更多并发用户            |

### 流量消耗

- 轻度使用（每天 10 次操作 + 5 张图片）：约 **3-5 GB/月**
- 中度使用（5 个家人，每天共 50 次操作）：约 **10-15 GB/月**
- 轻量服务器自带 **1 TB/月** 流量，完全够用

### 总成本

- 服务器：99-298 元/年
- 域名（可选）：10-50 元/年
- HTTPS 证书：免费（Let's Encrypt）

**年总成本：100-350 元**，全家共享，不限设备数。

---

## 对比本地部署

| 方案        | 优点                         | 缺点                         |
|-------------|------------------------------|------------------------------|
| 云端部署    | 外网直接访问，无需内网穿透   | 需付费服务器，数据存云端     |
| 本地 + frp  | 数据在家里，成本低           | 需配置内网穿透，家里断网就挂 |
| 本地 + WiFi | 完全免费，数据本地           | 只能局域网访问               |

如果你的需求是：
- ✅ 随时随地访问（4G/5G 下也能用）
- ✅ 不想折腾家里设备
- ✅ 愿意每年花 100 元

那么**云端部署**最合适。如果更在意数据隐私或想省钱，用 frp 方案（刚才写的那套脚本）。
