#!/usr/bin/env bash
# dumate2api 重启脚本（macOS / Linux）——先停后起，等同 Windows 的 restart.bat。
# 用法：./restart.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "== 停止 =="
"$PWD/stop.sh"

echo
echo "== 启动 =="
"$PWD/start.sh"
