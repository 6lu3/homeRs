#!/bin/bash
# frp 客户端安装脚本（在 Windows/开发板上运行）
set -e

echo "=== 安装 frp 客户端 (frpc) ==="

# 检测架构
ARCH=$(uname -m)
case $ARCH in
  x86_64) FRP_ARCH="amd64" ;;
  aarch64|arm64) FRP_ARCH="arm64" ;;
  armv7l) FRP_ARCH="arm" ;;
  armv6l) FRP_ARCH="arm" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

# 检测系统
if uname -s | grep -qi "linux"; then
  OS="linux"
elif uname -s | grep -qi "darwin"; then
  OS="darwin"
else
  echo "请在 Linux/macOS 上运行，Windows 请手动下载"; exit 1
fi

# 下载
FRP_VERSION="0.61.1"
MIRROR="${FRP_MIRROR:-https://mirror.ghproxy.com/https://github.com}"
FRP_URL="${MIRROR}/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_${OS}_${FRP_ARCH}.tar.gz"

cd /tmp
echo "下载 frp v${FRP_VERSION} (${OS}/${FRP_ARCH})..."
curl -fsSL -o frp.tar.gz "$FRP_URL"
tar -xzf frp.tar.gz
cd frp_*

# 安装
sudo mkdir -p /opt/frp
sudo cp frpc /opt/frp/
sudo chmod +x /opt/frp/frpc

echo "✓ frpc 已安装到 /opt/frp/frpc"
echo ""
echo "接下来手动配置 /opt/frp/frpc.toml，填入你的服务器信息后运行:"
echo "  sudo systemctl enable frpc && sudo systemctl start frpc"
