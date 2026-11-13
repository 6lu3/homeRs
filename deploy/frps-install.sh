#!/bin/bash
# frp 服务端安装脚本（在阿里云 ECS 上运行）
set -e

echo "=== 安装 frp 服务端 (frps) ==="

# 检测架构
ARCH=$(uname -m)
case $ARCH in
  x86_64) FRP_ARCH="amd64" ;;
  aarch64|arm64) FRP_ARCH="arm64" ;;
  armv7l) FRP_ARCH="arm" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

# 下载最新版 frp（使用国内镜像加速）
FRP_VERSION="0.61.1"
MIRROR="${FRP_MIRROR:-https://mirror.ghproxy.com/https://github.com}"
FRP_URL="${MIRROR}/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"

cd /tmp
echo "下载 frp v${FRP_VERSION} (${FRP_ARCH})..."
curl -fsSL -o frp.tar.gz "$FRP_URL"
tar -xzf frp.tar.gz
cd frp_*

# 安装 frps
sudo mkdir -p /opt/frp
sudo cp frps /opt/frp/
sudo chmod +x /opt/frp/frps

# 生成随机 token（只在首次安装时生成）
if [ ! -f /opt/frp/token ]; then
  TOKEN=$(openssl rand -hex 16)
  echo "$TOKEN" | sudo tee /opt/frp/token
  echo "✓ 已生成认证 token: $TOKEN"
  echo "  请把这个 token 复制到家里客户端的配置文件中"
else
  TOKEN=$(cat /opt/frp/token)
  echo "✓ 使用已有 token: $TOKEN"
fi

# 创建配置文件
sudo tee /opt/frp/frps.toml > /dev/null <<EOF
# frp 服务端配置
bindAddr = "0.0.0.0"
bindPort = 7000               # frpc 连接端口
kcpBindPort = 7000            # 启用 KCP 加速（可选）

# Web 管理面板（可选，生产环境建议关闭或加强密码）
webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "admin_$(openssl rand -hex 4)"

# 认证
auth.method = "token"
auth.token = "$TOKEN"

# 日志
log.to = "/var/log/frp/frps.log"
log.level = "info"
log.maxDays = 7

# 限制（根据你的带宽调整）
transport.maxPoolCount = 10
EOF

sudo mkdir -p /var/log/frp
echo "✓ 配置文件: /opt/frp/frps.toml"

# 创建 systemd 服务
sudo tee /etc/systemd/system/frps.service > /dev/null <<'EOF'
[Unit]
Description=frp server
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
Restart=on-failure
RestartSec=10s
ExecStart=/opt/frp/frps -c /opt/frp/frps.toml
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

# 启动服务
sudo systemctl daemon-reload
sudo systemctl enable frps
sudo systemctl restart frps
sleep 2

if systemctl is-active --quiet frps; then
  echo "✓ frps 已启动"
  echo ""
  echo "=== 下一步 ==="
  echo "1. 在阿里云控制台 → 安全组，放行端口："
  echo "   - 7000/TCP  (frp 通信端口)"
  echo "   - 8080/TCP  (家庭物资清点表 HTTP)"
  echo ""
  echo "2. 家里客户端配置需要的信息："
  echo "   服务器地址: $(curl -s ip.sb || hostname -I | awk '{print $1}')"
  echo "   Token: $TOKEN"
  echo ""
  echo "3. 查看日志: journalctl -u frps -f"
else
  echo "✗ frps 启动失败，查看日志:"
  sudo journalctl -u frps -n 50 --no-pager
  exit 1
fi
