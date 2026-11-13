#!/bin/bash
# 修复已部署的家庭物资清点表（针对之前版本的脚本部署的）
# 用途：修复密码哈希格式、端口配置、Nginx 配置等问题

set -e

echo "=== 家庭物资清点表 - 修复工具 ==="
echo ""

if [ "$EUID" -ne 0 ]; then 
  echo "请用 sudo 运行: sudo bash $0"
  exit 1
fi

APP_DIR="/opt/home-inventory"
if [ ! -d "$APP_DIR" ]; then
  echo "✗ 应用目录不存在: $APP_DIR"
  echo "  请先运行部署脚本"
  exit 1
fi

cd "$APP_DIR"

# 检测当前配置
echo "检测当前配置..."
if [ -f data/config.json ]; then
  CURRENT_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('data/config.json','utf8')).passwordHash)")
  echo "当前密码哈希: ${CURRENT_HASH:0:50}..."
fi

CURRENT_PORT=$(sudo ss -tlnp | grep node | grep -oP ':\K\d+' | head -1)
if [ -n "$CURRENT_PORT" ]; then
  echo "当前应用端口: $CURRENT_PORT"
else
  echo "⚠ 应用未运行"
  CURRENT_PORT=3000
fi

# 询问要修复什么
echo ""
echo "请选择要修复的问题："
echo "  1. 密码登录失败（修复密码哈希格式）"
echo "  2. 端口配置不一致（同步 Nginx 和应用端口）"
echo "  3. Nginx 配置混乱（certbot 修改后的问题）"
echo "  4. 全部修复"
echo ""
read -p "选择 (1-4): " CHOICE

case $CHOICE in
  1)
    FIX_PASSWORD=true
    ;;
  2)
    FIX_PORT=true
    ;;
  3)
    FIX_NGINX=true
    ;;
  4)
    FIX_PASSWORD=true
    FIX_PORT=true
    FIX_NGINX=true
    ;;
  *)
    echo "无效选择"
    exit 1
    ;;
esac

# ===== 修复密码 =====
if [ "$FIX_PASSWORD" = true ]; then
  echo ""
  echo "[1/3] 修复密码哈希格式..."
  read -p "输入新密码（留空保持当前密码不变）: " NEW_PW
  
  if [ -z "$NEW_PW" ]; then
    echo "跳过密码修复"
  else
    node -e "
      const crypto = require('crypto');
      const fs = require('fs');
      const pw = process.argv[1];
      function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
        return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
      }
      const config = JSON.parse(fs.readFileSync('data/config.json', 'utf8'));
      config.passwordHash = hashPassword(pw);
      fs.writeFileSync('data/config.json', JSON.stringify(config, null, 2));
      console.log('✓ 密码已重置为:', pw);
    " "$NEW_PW"
  fi
fi

# ===== 修复端口 =====
if [ "$FIX_PORT" = true ]; then
  echo ""
  echo "[2/3] 同步端口配置..."
  read -p "应用端口（留空使用当前: $CURRENT_PORT）: " APP_PORT
  APP_PORT=${APP_PORT:-$CURRENT_PORT}
  
  # 更新 systemd 配置
  if grep -q "Environment=\"PORT=" /etc/systemd/system/home-inventory.service; then
    sudo sed -i "s/Environment=\"PORT=[0-9]*\"/Environment=\"PORT=$APP_PORT\"/" /etc/systemd/system/home-inventory.service
  else
    sudo sed -i "/Environment=\"NODE_ENV=production\"/a Environment=\"PORT=$APP_PORT\"" /etc/systemd/system/home-inventory.service
  fi
  echo "✓ 已更新 systemd 配置: PORT=$APP_PORT"
  
  # 更新 Nginx 配置
  NGINX_CONF="/etc/nginx/sites-enabled/home-inventory"
  if [ -f "$NGINX_CONF" ]; then
    NGINX_PORT=$(grep -oP 'proxy_pass http://127\.0\.0\.1:\K\d+' "$NGINX_CONF" | head -1)
    if [ "$NGINX_PORT" != "$APP_PORT" ]; then
      sudo sed -i "s/:$NGINX_PORT/:$APP_PORT/g" "$NGINX_CONF"
      echo "✓ 已更新 Nginx 配置: $NGINX_PORT → $APP_PORT"
    else
      echo "✓ Nginx 端口已同步: $APP_PORT"
    fi
  fi
  
  # 重启服务
  sudo systemctl daemon-reload
  sudo systemctl restart home-inventory
  sleep 2
  
  if systemctl is-active --quiet home-inventory; then
    echo "✓ 应用已重启"
  else
    echo "✗ 应用启动失败，查看日志:"
    sudo journalctl -u home-inventory -n 20 --no-pager
    exit 1
  fi
fi

# ===== 修复 Nginx =====
if [ "$FIX_NGINX" = true ]; then
  echo ""
  echo "[3/3] 修复 Nginx 配置..."
  
  NGINX_CONF="/etc/nginx/sites-enabled/home-inventory"
  if [ ! -f "$NGINX_CONF" ]; then
    echo "✗ Nginx 配置不存在: $NGINX_CONF"
    exit 1
  fi
  
  # 检测是否配置了 HTTPS
  if grep -q "ssl_certificate" "$NGINX_CONF"; then
    DOMAIN=$(grep "server_name" "$NGINX_CONF" | grep -oP '\s\K[a-zA-Z0-9.-]+' | head -1)
    CERT_PATH="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
    
    if [ -f "$CERT_PATH" ]; then
      echo "检测到 HTTPS 配置，域名: $DOMAIN"
      APP_PORT=${APP_PORT:-$CURRENT_PORT}
      
      # 备份原配置
      sudo cp "$NGINX_CONF" "${NGINX_CONF}.bak.$(date +%s)"
      
      # 重新生成干净的配置
      sudo tee "$NGINX_CONF" > /dev/null <<EOF
# HTTP 跳转到 HTTPS
server {
    listen 80;
    server_name $DOMAIN;
    
    # Let's Encrypt 验证
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    
    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS 主配置
server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    # SSL 证书
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 20M;

    # 安全头
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 限流登录接口
    location /api/login {
        limit_req zone=login_limit burst=3 nodelay;
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # 其他路由
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket 支持
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    access_log /var/log/nginx/home-inventory.access.log;
    error_log /var/log/nginx/home-inventory.error.log;
}
EOF
      echo "✓ 已重新生成 Nginx 配置（HTTPS）"
    else
      echo "⚠ 证书文件不存在: $CERT_PATH"
      echo "  将生成 HTTP 配置"
      USE_HTTPS=false
    fi
  else
    echo "检测到 HTTP 配置"
    USE_HTTPS=false
  fi
  
  # HTTP 配置
  if [ "$USE_HTTPS" = false ]; then
    APP_PORT=${APP_PORT:-$CURRENT_PORT}
    sudo cp "$NGINX_CONF" "${NGINX_CONF}.bak.$(date +%s)"
    
    sudo tee "$NGINX_CONF" > /dev/null <<EOF
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
    echo "✓ 已重新生成 Nginx 配置（HTTP）"
  fi
  
  # 确保 limit_req_zone 在 nginx.conf 里
  if ! grep -q "limit_req_zone.*login_limit" /etc/nginx/nginx.conf; then
    sudo sed -i '/^http {/a \    limit_req_zone $binary_remote_addr zone=login_limit:10m rate=5r/m;' /etc/nginx/nginx.conf
    echo "✓ 已添加限流配置到 nginx.conf"
  fi
  
  # 测试并重启
  if sudo nginx -t; then
    sudo systemctl reload nginx
    echo "✓ Nginx 已重启"
  else
    echo "✗ Nginx 配置测试失败"
    exit 1
  fi
fi

# ===== 完成 =====
echo ""
echo "=========================================="
echo "✓ 修复完成！"
echo "=========================================="
echo ""

# 验证
echo "验证服务状态..."
if systemctl is-active --quiet home-inventory; then
  echo "✓ 应用正在运行"
  ACTUAL_PORT=$(sudo ss -tlnp | grep node | grep -oP ':\K\d+' | head -1)
  echo "  监听端口: $ACTUAL_PORT"
  
  if curl -s --max-time 3 http://127.0.0.1:$ACTUAL_PORT/api/me | grep -q "authed"; then
    echo "✓ 应用响应正常"
  else
    echo "⚠ 应用端口无响应"
  fi
else
  echo "✗ 应用未运行"
fi

if systemctl is-active --quiet nginx; then
  echo "✓ Nginx 正在运行"
else
  echo "✗ Nginx 未运行"
fi

echo ""
echo "如果还有问题，查看日志："
echo "  应用日志: sudo journalctl -u home-inventory -n 50"
echo "  Nginx 错误: sudo tail -50 /var/log/nginx/home-inventory.error.log"
echo ""
