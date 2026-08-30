#!/usr/bin/env bash
# 婚礼互动服务部署脚本（Linux 服务器 / 云主机，pm2 托管）
# 用法：bash deploy.sh
set -e
cd "$(dirname "$0")"

echo "=== 婚礼互动服务部署（Linux / pm2）==="

# 1. 安装依赖
if [ ! -d node_modules/ws ]; then
  echo "[1/4] 安装依赖..."
  npm install --no-audit --no-fund
else
  echo "[1/4] 依赖已就绪"
fi

# 2. 安装 pm2
if ! command -v pm2 >/dev/null 2>&1; then
  echo "[2/4] 安装 pm2..."
  npm install -g pm2
else
  echo "[2/4] pm2 已安装"
fi

# 3. 启动 / 重启服务
echo "[3/4] 启动服务（pm2）..."
pm2 delete wedding-live >/dev/null 2>&1 || true
pm2 start server.js --name wedding-live
pm2 save

# 4. 开机自启
echo "[4/4] 配置开机自启..."
pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true

echo ""
echo "=== 部署完成 ==="
echo "  本地访问   http://localhost:8080/"
echo "  查看日志   pm2 logs wedding-live"
echo "  重启服务   pm2 restart wedding-live"
pm2 list 2>/dev/null || true
