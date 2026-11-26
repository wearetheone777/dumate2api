#!/usr/bin/env bash
# dumate2api 启动脚本（macOS / Linux）——与 Windows 的 start.bat 同语义：
# 起网关（默认 9080）+ 管理端（默认 9081）。后台运行，日志与 PID 落 data/。
#
# 用法：
#   ./start.sh              # 后台起网关 + 管理端（幂等：端口已在监听则跳过）
#   ./start.sh --foreground # 前台跑网关，日志直接打终端，Ctrl+C 停止
#   ./start.sh --gateway    # 只起网关
#   ./start.sh --admin      # 只起管理端
set -euo pipefail
cd "$(dirname "$0")"

DATA_DIR="${DUMATE_ADMIN_DATA:-$PWD/data}"
mkdir -p "$DATA_DIR"

GATEWAY_PORT="${DUMATE2API_PORT:-9080}"
ADMIN_PORT="${DUMATE_ADMIN_PORT:-9081}"

RUN_GATEWAY=1
RUN_ADMIN=1
FOREGROUND=0
for arg in "$@"; do
  case "$arg" in
    --gateway) RUN_ADMIN=0 ;;
    --admin) RUN_GATEWAY=0 ;;
    --foreground) FOREGROUND=1 ;;
    *) echo "未知参数：$arg（可用：--gateway / --admin / --foreground）" >&2; exit 1 ;;
  esac
done

port_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

start_bg() {
  local name="$1" port="$2"
  local log="$DATA_DIR/$name-$port.log"
  local pidfile="$DATA_DIR/$name-$port.pid"
  if port_listening "$port"; then
    echo "  [skip] $name 已在端口 $port 运行"
    return 0
  fi
  case "$name" in
    gateway) nohup node src/server.js >"$log" 2>&1 & ;;
    admin)   nohup node src/admin/server.js >"$log" 2>&1 & ;;
  esac
  local pid=$!
  echo "$pid" >"$pidfile"
  echo "  [ok] $name 已启动（pid $pid，端口 $port，日志 $log）"
}

echo "启动 dumate2api（网关 $GATEWAY_PORT / 管理端 $ADMIN_PORT）"

if [ "$FOREGROUND" = "1" ] && [ "$RUN_GATEWAY" = "1" ]; then
  echo "前台启动网关，日志直接输出，Ctrl+C 停止"
  exec node src/server.js
fi

[ "$RUN_GATEWAY" = "1" ] && start_bg gateway "$GATEWAY_PORT"
[ "$RUN_ADMIN" = "1" ] && start_bg admin "$ADMIN_PORT"

echo
echo "验证：curl http://127.0.0.1:$GATEWAY_PORT/health"
echo "管理端：http://127.0.0.1:$ADMIN_PORT"
