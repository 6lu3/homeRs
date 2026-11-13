#!/bin/bash
# Nginx 反向代理配置（可选，推荐）
# 在阿里云 ECS 上安装 Nginx 并配置 HTTPS

set -e

# 安装 Nginx
if ! command -v nginx &> /dev/null; then
  echo "安装 Nginx..."
  if [ -f /etc/debian_version ]; then
    sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
  elif [ -f /etc/redhat-release ]; then
    sudo yum install -y nginx certbot python3-certbot-nginx
  else
    echo "请手动安装 nginx 和 certbot"; exit 1
  fi
fi

# 配置 HTTP 反向代理（先不上 HTTPS）
DOMAIN="${1:-inventory.你的域名.com}"
if [ "$DOMAIN" = "inventory.你的域名.com" ]; then
  echo "用法: $0 <你的域名>"
  echo "示例: $0 home.example.com"
  exit 1
fi

sudo tee /etc/nginx/sites-available/home-inventory > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    # 安全头
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;

    # 限流（防止暴力破解密码）
    limit_req_zone \$binary_remote_addr zone=login_limit:10m rate=5r/m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # WebSocket 支持（如果将来需要）
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /api/login {
        limit_req zone=login_limit burst=3 nodelay;
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # 日志
    access_log /var/log/nginx/home-inventory.access.log;
    error_log /var/log/nginx/home-inventory.error.log;
}
EOF

# 启用站点
sudo ln -sf /etc/nginx/sites-available/home-inventory /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

echo "✓ Nginx 已配置，监听 80 端口"
echo ""
echo "下一步（可选）："
echo "1. 把域名 $DOMAIN 的 DNS A 记录指向: $(curl -s ip.sb)"
echo "2. 等 DNS 生效后运行（自动配置 Let's Encrypt HTTPS）:"
echo "   sudo certbot --nginx -d $DOMAIN"
