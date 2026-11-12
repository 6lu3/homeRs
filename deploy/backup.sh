#!/usr/bin/env bash
# 每日备份 data/ 目录到指定位置，保留最近 14 份
# 用法：bash deploy/backup.sh [备份目录]     建议配合 cron：  0 3 * * * /home/pi/home-inventory/deploy/backup.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${INVENTORY_DATA:-$APP_DIR/data}"
DEST="${1:-$HOME/inventory-backups}"
KEEP=14
mkdir -p "$DEST"
stamp="$(date +%Y%m%d-%H%M%S)"
# SQLite 在线备份：用 sqlite3 时走 .backup 命令保证一致性；没有 sqlite3 则直接复制（WAL 模式下通常也安全）
tmp="$(mktemp -d)"
if command -v sqlite3 >/dev/null; then sqlite3 "$DATA_DIR/inventory.db" ".backup '$tmp/inventory.db'"; else cp "$DATA_DIR/inventory.db" "$tmp/"; fi
cp "$DATA_DIR/config.json" "$tmp/" 2>/dev/null || true
cp -r "$DATA_DIR/uploads" "$tmp/" 2>/dev/null || true
tar -czf "$DEST/inventory-$stamp.tar.gz" -C "$tmp" .
rm -rf "$tmp"
ls -1t "$DEST"/inventory-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "已备份到 $DEST/inventory-$stamp.tar.gz"
