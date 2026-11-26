#!/usr/bin/env bash
# dumate2api 停止脚本（macOS / Linux）——与 Windows 的 stop.bat 同语义：
# 停网关（默认 9080）+ 管理端（默认 9081）。先按 PID 文件停，再按端口
# 兜底；不动其它进程（cc-switch、DuMate GUI 等）。
#
# 用法：
#   ./stop.sh            # 停网关 + 管理端
#   ./stop.sh --gateway  # 只停网关
#   ./stop.sh --admin    # 只停管理端
set -euo pipefail
cd "$(dirname "$0")"

DATA_DIR="${DUMATE_ADMIN_DATA:-$PWD/data}"
GATEWAY_PORT="${DUMATE2API_PORT:-9080}"
ADMIN_PORT="${DUMATE_ADMIN_PORT:-9081}"

STOP_GATEWAY=1
STOP_ADMIN=1
for arg in "$@"; do
  case "$arg" in
    --gateway) STOP_ADMIN=0 ;;
    --admin) STOP_GATEWAY=0 ;;
    *) echo "未知参数：$arg（可用：--gateway / --admin）" >&2; exit 1 ;;
  esac
done

kill_by_pidfile() {
  local name="$1" port="$2"
  local pidfile="$DATA_DIR/$name-$port.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "  停止 $name（pid $pid）"
      kill "$pid" 2>/dev/null || true
      # 优雅退出最多等 5 秒，不退再强杀
      for _ in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

kill_by_port() {
  local name="$1" port="$2"
  local pids
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "  端口 $port 仍有进程（$pids），停止"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
}

port_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

echo "停止 dumate2api（网关 $GATEWAY_PORT / 管理端 $ADMIN_PORT）"

[ "$STOP_GATEWAY" = "1" ] && { kill_by_pidfile gateway "$GATEWAY_PORT"; kill_by_port gateway "$GATEWAY_PORT"; }
[ "$STOP_ADMIN" = "1" ]  && { kill_by_pidfile admin "$ADMIN_PORT"; kill_by_port admin "$ADMIN_PORT"; }

echo
echo "验证端口释放："
for p in "$GATEWAY_PORT" "$ADMIN_PORT"; do
  if port_listening "$p"; then
    echo "  [WARN] 端口 $p 仍被占用"
  else
    echo "  [OK] 端口 $p 已释放"
  fi
done
