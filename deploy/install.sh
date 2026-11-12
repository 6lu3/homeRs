#!/usr/bin/env bash
# 一键安装为 systemd 服务（Debian / Ubuntu / Armbian / Raspberry Pi OS 等）
# 用法：在项目目录内执行  sudo bash deploy/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
SERVICE=home-inventory

if [[ $EUID -ne 0 ]]; then echo "请用 sudo 运行：sudo bash deploy/install.sh"; exit 1; fi

# 1. 检查 Node.js 版本（需要 >= 22.13，内置 SQLite）
NODE_BIN="$(command -v node || true)"
need_node=1
if [[ -n "$NODE_BIN" ]]; then
  ver="$("$NODE_BIN" -v | sed 's/^v//')"; major="${ver%%.*}"; minor="$(echo "$ver" | cut -d. -f2)"
  if (( major > 22 || (major == 22 && minor >= 13) )); then need_node=0; echo "✔ 已安装 Node.js v$ver ($NODE_BIN)"; else echo "✘ Node.js v$ver 过低"; fi
else
  echo "✘ 未安装 Node.js"
fi
if (( need_node )); then
  ARCH="$(uname -m)"
  if [[ "$ARCH" == "armv7l" || "$ARCH" == "armv6l" ]]; then
    # 32 位 ARM（i.MX6ULL、树莓派 2/3 32 位系统等）：NodeSource 不提供，直接装官方二进制包
    echo "检测到 $ARCH，下载 Node.js 22 官方二进制包……"
    apt-get update -qq && apt-get install -y -qq curl ca-certificates xz-utils >/dev/null 2>&1 || true
    MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"   # 国内镜像；海外可设 NODE_MIRROR=https://nodejs.org/dist
    if [[ "$ARCH" == "armv6l" ]]; then MIRROR="https://unofficial-builds.nodejs.org/download/release"; fi
    VER="$(curl -fsSL "$MIRROR/latest-v22.x/" | grep -o "node-v22\.[0-9]*\.[0-9]*-linux-$ARCH\.tar\.xz" | head -1)"
    [[ -n "$VER" ]] || { echo "没有在 $MIRROR 找到 $ARCH 的安装包，请按 DEPLOY.md 手动安装"; exit 1; }
    curl -fL "$MIRROR/latest-v22.x/$VER" -o /tmp/node.tar.xz
    mkdir -p /usr/local/lib/nodejs && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
    ln -sf "/usr/local/lib/nodejs/${VER%.tar.xz}/bin/node" /usr/local/bin/node
    ln -sf "/usr/local/lib/nodejs/${VER%.tar.xz}/bin/npm" /usr/local/bin/npm
    rm -f /tmp/node.tar.xz
  else
    echo "正在通过 NodeSource 安装 Node.js 22 LTS……"
    apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  NODE_BIN="$(command -v node)"
  echo "✔ 已安装 $("$NODE_BIN" -v)"
fi

# 2. 数据目录与权限
mkdir -p "$APP_DIR/data/uploads"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/data"

# 3. 写入 systemd 服务
sed -e "s|__USER__|$RUN_USER|g" -e "s|__DIR__|$APP_DIR|g" -e "s|__NODE__|$NODE_BIN|g" \
  "$APP_DIR/deploy/$SERVICE.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 1
systemctl --no-pager --lines=5 status "$SERVICE" || true

# 4. 防火墙（若启用了 ufw）
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 3000/tcp >/dev/null && echo "✔ 已在 ufw 放行 3000 端口"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "完成！手机（同一 WiFi）访问：http://${IP:-<开发板IP>}:3000"
echo "  初始密码 home1234，登录后请在「设置」中修改。"
echo "  查看日志：journalctl -u $SERVICE -f"
echo "  更新代码：cd $APP_DIR && git pull && sudo systemctl restart $SERVICE"
