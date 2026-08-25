#!/bin/bash
# ============================================================
# 43 生产后端启动脚本（PearPlayer HTTP + P2P 方案）
# 用法（手动或进程守护）:
#   bash start-43.sh                 # 前台运行
#   nohup bash start-43.sh >/tmp/p2p-server.log 2>&1 &
# 进程守护建议：systemd 或 pm2（见 README）
# ============================================================
set -e
cd /www/wwwroot/bot3.1230sb.com/p2p_mp4

export PEAR_FOG_COUNT=0
export PEAR_NO_NODES=1
export PEAR_WS_PORT=8003
export PEAR_PUBLIC_BASE="https://bot3.1230sb.com/p2p_mp4"
export PEAR_TORRENT_BASE="https://wietrade.github.io/p2p_mp4/torrents"
export PEAR_SOURCE_HOST="bot3.1230sb.com"
export PEAR_SOURCE_PORT=443

exec node index.js
