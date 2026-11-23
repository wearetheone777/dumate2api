# syntax=docker/dockerfile:1
#
# dumate2api 容器镜像。两阶段：
#   1) web-build：前端 Vue 3 + Vite 构建（pnpm，lockfile 权威）
#   2) runtime：纯 Node 运行时。网关本体零第三方依赖；根目录只装
#      playwright-core —— 管理端启动链顶层 require 它
#      （src/admin/routes/accounts.js → src/login-browser.js），缺了管理端起不来。
#      它只驱动系统浏览器，容器内没有浏览器也装得上（不下载 Chromium）。
#
# 单容器双进程：网关（9080）+ 管理端（9081）。管理端查网关状态硬编码
# 127.0.0.1，拆成两个容器读不到网关，别拆。
#
# 容器内不可用、不要翻出来试的：
#   - Windows 桌面后端链路（dumate-main-server.exe）——搭子默认走网页凭证
#   - 搭子账号的「浏览器登录」抓 cookie（需要本机浏览器，改用粘贴 cookie）

FROM node:22-alpine AS web-build
WORKDIR /web
RUN npm install -g pnpm@12 --silent
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM node:22-alpine
RUN apk add --no-cache tzdata \
  && npm install -g pnpm@12 --silent
# DUMATE2API_HOST / DUMATE_ADMIN_HOST 默认 127.0.0.1，容器里必须绑 0.0.0.0
# 才能被端口映射到；签到排程按北京时间设计，TZ 默认上海（compose 可覆盖）。
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DUMATE2API_HOST=0.0.0.0 \
    DUMATE_ADMIN_HOST=0.0.0.0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src/ src/
COPY --from=web-build /web/dist/ web/dist/
RUN mkdir -p /app/data \
  && chown -R node:node /app
COPY docker/entrypoint.sh /usr/local/bin/dumate2api-entrypoint.sh

# node 用户（uid 1000）：凭证文件由 src/fileperm.js 收紧到 0600，非 root 足够。
# 换 bind mount 时宿主目录需 `chown -R 1000:1000`，或在 compose 里 user: "0"。
USER node
EXPOSE 9080 9081 18080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:9080/health >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/bin/sh", "/usr/local/bin/dumate2api-entrypoint.sh"]
