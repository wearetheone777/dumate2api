#!/bin/sh
# dumate2api 容器入口：单容器双进程（网关 :9080 + 管理端 :9081）。
#
# 为什么不拆两个容器：管理端查网关状态硬编码 127.0.0.1
# （src/admin/routes/{points,keys,models,system}.js），拆开就读不到网关。
# 与 start-dev.bat 同一套拓扑，只是换成了容器内并行。
#
# SIGTERM 转发给两个子进程再退出（store.js 写盘虽是 .tmp+rename 原子写，
# 干净退出仍优于 SIGKILL）；任一子进程先死则容器退出，交给 restart 策略拉起。
set -u
cd /app

node src/server.js & GATEWAY_PID=$!
node src/admin/server.js & ADMIN_PID=$!

STOP=0
term() {
  STOP=1
  kill -TERM "$GATEWAY_PID" "$ADMIN_PID" 2>/dev/null || true
}
trap term TERM INT

while [ "$STOP" -eq 0 ] \
  && kill -0 "$GATEWAY_PID" 2>/dev/null \
  && kill -0 "$ADMIN_PID" 2>/dev/null; do
  sleep 5
done

if [ "$STOP" -eq 0 ]; then
  # 有子进程自己退了：把另一个也带走，不留半个服务
  kill -TERM "$GATEWAY_PID" "$ADMIN_PID" 2>/dev/null || true
  exit 1
fi

wait 2>/dev/null || true
exit 0
