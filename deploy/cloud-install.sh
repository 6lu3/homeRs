#!/bin/bash
# 阿里云 Ubuntu 20.04 一键部署脚本
# 用途：在云服务器上直接运行家庭物资清点表（不需要 frp 内网穿透）

set -e

echo "=== 家庭物资清点表 - 云端部署 ==="
echo ""

# 检测系统
if [ ! -f /etc/lsb-release ] || ! grep -q "Ubuntu" /etc/lsb-release; then
  echo "警告: 此脚本为 Ubuntu 20.04/22.04 设计，其他系统可能需要调整"
  read -p "是否继续? (y/N) " -n 1 -r
  echo
  [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then 
  echo "请用 sudo 运行: sudo bash $0"
  exit 1
fi

# 询问域名（可选）
read -p "是否配置域名？留空则只用 IP 访问 (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  read -p "输入域名（如 home.example.com）: " DOMAIN
  if [ -z "$DOMAIN" ]; then
    echo "域名为空，将只配置 HTTP"
    USE_HTTPS=false
  else
    USE_HTTPS=true
    echo "将为 $DOMAIN 配置 HTTPS（Let's Encrypt）"
  fi
else
  USE_HTTPS=false
  DOMAIN=""
fi

# 询问初始密码
read -p "设置初始登录密码（留空默认 home1234）: " INIT_PASSWORD
INIT_PASSWORD=${INIT_PASSWORD:-home1234}

# 询问监听端口（给 Node.js 服务用）
read -p "内部端口（留空默认 3000）: " APP_PORT
APP_PORT=${APP_PORT:-3000}

PUBLIC_IP=$(curl -s --max-time 3 ip.sb || hostname -I | awk '{print $1}')
echo ""
echo "配置摘要："
echo "  服务器 IP: $PUBLIC_IP"
echo "  应用端口: $APP_PORT"
echo "  初始密码: $INIT_PASSWORD"
[ "$USE_HTTPS" = true ] && echo "  域名: $DOMAIN (HTTPS)" || echo "  域名: 无（HTTP 访问 IP:80）"
echo ""
read -p "确认并开始安装? (y/N) " -n 1 -r
echo
[[ ! $REPLY =~ ^[Yy]$ ]] && exit 0

# ==================== 安装依赖 ====================
echo ""
echo "[1/6] 安装系统依赖..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw

# 安装 Node.js 22（优先用清华镜像）
if ! command -v node &> /dev/null || [ $(node -v | cut -d'v' -f2 | cut -d'.' -f1) -lt 22 ]; then
  echo "安装 Node.js 22..."
  NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
  NODE_VERSION="22.13.1"
  NODE_ARCH="linux-x64"
  cd /tmp
  curl -fsSL "${NODE_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz" -o node.tar.xz
  tar -xJf node.tar.xz -C /usr/local --strip-components=1
  ln -sf /usr/local/bin/node /usr/bin/node
  ln -sf /usr/local/bin/npm /usr/bin/npm
fi
node --version
echo "✓ Node.js 已安装"

# ==================== 部署应用 ====================
echo ""
echo "[2/6] 下载应用代码..."
APP_DIR="/opt/home-inventory"
if [ -d "$APP_DIR" ]; then
  echo "目录已存在，拉取最新代码..."
  cd "$APP_DIR"
  git pull
else
  git clone https://gitee.com/b1u3/home_restore.git "$APP_DIR"
  cd "$APP_DIR"
fi

# 创建数据目录
mkdir -p data
chown -R root:root "$APP_DIR"
chmod 755 "$APP_DIR"

# 生成配置文件（设置初始密码）
if [ ! -f data/config.json ]; then
  echo "生成初始配置..."
  node -e "
    const crypto = require('crypto');
    const pw = process.argv[1];
    // 使用应用自己的 hashPassword 逻辑（盐:哈希）
    function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
      return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
    }
    const passwordHash = hashPassword(pw);
    const secret = crypto.randomBytes(32).toString('hex');
    const config = { passwordHash, secret };
    require('fs').writeFileSync('data/config.json', JSON.stringify(config, null, 2));
    console.log('✓ 初始密码:', pw);
  " "$INIT_PASSWORD"
fi

echo "✓ 应用已部署到 $APP_DIR"

# ==================== 创建 systemd 服务 ====================
echo ""
echo "[3/6] 配置系统服务..."
cat > /etc/systemd/system/home-inventory.service <<EOF
[Unit]
Description=家庭物资清点表
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
Environment="NODE_ENV=production"
Environment="PORT=$APP_PORT"
Environment="INVENTORY_PASSWORD=$INIT_PASSWORD"
ExecStart=/usr/local/bin/node --no-warnings server.js
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=home-inventory

# 资源限制（适配低配服务器）
LimitNOFILE=65536
MemoryMax=200M
CPUQuota=80%

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable home-inventory
systemctl restart home-inventory
sleep 2

if systemctl is-active --quiet home-inventory; then
  echo "✓ 服务已启动"
else
  echo "✗ 服务启动失败，查看日志:"
  journalctl -u home-inventory -n 20 --no-pager
  exit 1
fi

# 验证应用端口
if curl -s --max-time 5 http://127.0.0.1:$APP_PORT/api/me | grep -q "authed"; then
  echo "✓ 应用运行正常"
else
  echo "✗ 应用端口未响应，检查日志: journalctl -u home-inventory -f"
  exit 1
fi

# ==================== 配置 Nginx ====================
echo ""
echo "[4/6] 配置 Nginx 反向代理..."

# 先在 nginx.conf 的 http 块中添加限流配置
if ! grep -q "limit_req_zone.*login_limit" /etc/nginx/nginx.conf; then
  sed -i '/^http {/a \    # 限流：防止暴力破解登录\n    limit_req_zone $binary_remote_addr zone=login_limit:10m rate=5r/m;' /etc/nginx/nginx.conf
fi

# 生成 Nginx 配置
NGINX_CONF="/etc/nginx/sites-available/home-inventory"
if [ "$USE_HTTPS" = true ]; then
  # HTTPS 配置（先监听 80，certbot 会自动改成 443）
  cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size 20M;

    # 安全头
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";

    location /api/login {
        limit_req zone=login_limit burst=3 nodelay;
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket 支持（未来可能用到）
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    access_log /var/log/nginx/home-inventory.access.log;
    error_log /var/log/nginx/home-inventory.error.log;
}
EOF
else
  # HTTP 配置（直接用 IP 访问）
  cat > "$NGINX_CONF" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    client_max_body_size 20M;

    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;

    location /api/login {
        limit_req zone=login_limit burst=3 nodelay;
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;

        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    access_log /var/log/nginx/home-inventory.access.log;
    error_log /var/log/nginx/home-inventory.error.log;
}
EOF
fi

# 启用站点
rm -f /etc/nginx/sites-enabled/default
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/home-inventory
nginx -t && systemctl reload nginx
echo "✓ Nginx 已配置"

# ==================== 配置防火墙 ====================
echo ""
echo "[5/6] 配置防火墙..."
ufw --force enable
ufw allow 22/tcp comment "SSH"
ufw allow 80/tcp comment "HTTP"
[ "$USE_HTTPS" = true ] && ufw allow 443/tcp comment "HTTPS"
ufw status
echo "✓ 防火墙已配置"

# ==================== HTTPS 证书（可选）====================
if [ "$USE_HTTPS" = true ]; then
  echo ""
  echo "[6/6] 配置 HTTPS 证书..."
  echo "请先确保域名 $DOMAIN 的 DNS A 记录已指向: $PUBLIC_IP"
  echo "然后运行以下命令获取证书（需要输入邮箱）："
  echo ""
  echo "  sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m 你的邮箱"
  echo ""
  echo "证书会自动续期（每 3 个月），无需手动干预。"
else
  echo ""
  echo "[6/6] 跳过 HTTPS 配置"
fi

# ==================== 完成 ====================
echo ""
echo "=========================================="
echo "✓ 部署完成！"
echo "=========================================="
echo ""
if [ "$USE_HTTPS" = true ]; then
  echo "访问地址（等 DNS 生效后）:"
  echo "  http://$DOMAIN  (将自动跳转 HTTPS)"
  echo ""
  echo "下一步："
  echo "  1. 确保域名 $DOMAIN 的 A 记录指向 $PUBLIC_IP"
  echo "  2. 运行: sudo certbot --nginx -d $DOMAIN -m 你的邮箱"
else
  echo "访问地址:"
  echo "  http://$PUBLIC_IP"
fi
echo ""
echo "初始密码: $INIT_PASSWORD"
echo ""
echo "常用命令:"
echo "  查看日志: journalctl -u home-inventory -f"
echo "  重启服务: systemctl restart home-inventory"
echo "  查看状态: systemctl status home-inventory"
echo "  查看 Nginx 日志: tail -f /var/log/nginx/home-inventory.access.log"
echo ""
echo "数据目录: $APP_DIR/data"
echo "备份命令: tar -czf ~/backup-\$(date +%F).tar.gz $APP_DIR/data"
echo ""
