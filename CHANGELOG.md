# Changelog

本项目的显著改动都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 2026-11 之前各落地批次的完整实测记录（依据、验证命令、踩坑细节）在
> [docs/LANDING-ARCHIVE-2026-11.md](docs/LANDING-ARCHIVE-2026-11.md)，
> 按日期命名的 `CHANGES-*.md` 为当时的单次会话存档，不再逐条搬进本文件。

## [Unreleased]

### Added

- **WSL 下搭子账号可自动登录**（`src/login-browser.js`）：WSL 里通常没有 Linux 浏览器，
  原先只能手动粘 cookie。现在改用 **CDP 桥接**——用 PowerShell 在 Windows 宿主拉起 Edge
  （独立 profile + 远程调试端口），Node 侧 `chromium.connectOverCDP` 连上读 cookie。
  - playwright 的 stdio 管道跨不了 WSL/Windows 边界，CDP 走 TCP 可以（WSL2 localhost 转发实测可达）
  - 零安装、零 sudo：只用宿主已有的 Edge/Chrome
  - 取消/成功后自动关闭 Windows 侧浏览器进程，不碰用户的日常 Edge
  - 端口默认 9333，`DUMATE_WSL_CDP_PORT` 可改
  - 新增 `test/unit/login-browser-wsl.test.js`（7 项，锁路径换算与探测语义）

### Changed

- 手动粘贴的引导文案改准：原先写「全选复制所有 cookie」——DevTools 的 Cookie 表格
  不支持多选，且 `BDUSS` 是 HttpOnly 拿不到。改为「Network 面板找 Request Headers 的 Cookie 行」。

## [2.0.0] - 2026-11-23

> 破坏性版本：端口统一为 9080/9081、`stable/` 快照机制退役。
> 升级前请确认启动脚本、托盘快捷方式与任何写死 9082/9083 的客户端配置已更新。

### Added

- **Docker 部署**：新增 `Dockerfile`（两阶段构建：pnpm 前端构建 → `node:22-alpine` 运行时）、
  `docker-compose.yml`、`docker/entrypoint.sh`、`.dockerignore`。
  - 单容器双进程（网关 + 管理端）——管理端查网关状态硬编码 `127.0.0.1`，拆成两个容器读不到网关。
  - 运行时只装 `playwright-core`：管理端启动链顶层 require 它（`admin/routes/accounts.js` →
    `login-browser.js`），缺了管理端起不来；它不下载 Chromium，容器内可正常安装。
  - 端口默认只绑宿主回环；数据落在 named volume `dumate2api-data`；`TZ=Asia/Shanghai`（签到排程按北京时间）。
  - 容器内不可用：Windows 桌面后端链路、搭子「浏览器登录」抓 cookie（改用粘贴 cookie）。
- **README**：新增「Docker 部署」章节；补全 WorkBuddy 第五通道的描述（双区域账号池、
  浏览器授权登录、签到仅国内版、风控连坐、国内 CLI 不实时扣套餐）。

### Changed

- **端口统一（破坏性）**：取消「稳定 9080 / 开发 9082」双轨，全仓库只剩一套默认值——
  网关 `9080` / 管理端 `9081`。`npm start`、`npm run admin`、`start.bat`、`start-dev.bat`
  与托盘启动器全部指向同一套端口与同一份 `src/`。
  - `start-dev.bat` 不再设 `DUMATE2API_PORT=9082` / `DUMATE_ADMIN_PORT=9083` /
    `DUMATE_ADMIN_GATEWAY_PORT=9082`；管理端默认即读 9080，无需任何 env。
  - 托盘启动器 `launcher/dumate2api-tray.ps1` 同步端口，并移除整套「启动/停止 9080 稳定版」按钮与函数。
  - 并行跑第二个实例时仍可用 `DUMATE2API_PORT` / `DUMATE_ADMIN_PORT` / `DUMATE_ADMIN_GATEWAY_PORT` 显式错开。

### Removed

- **`stable/` 冻结快照退役（破坏性）**：删除 `stable/`（106 文件）——它已落后主目录 133 个文件、
  且不含管理端，无法独立成一套服务。同步删除 `scripts/snapshot-closure.js` 与
  `docs/STABLE-SNAPSHOT.md`，发布流程随之取消。
  - `src/service-identity.js` 的 `-stable` 后缀判定保留（恒为 false，不破坏旧调用点），
    注释标注为历史遗留；`DUMATE_ROLE` 仍可显式指定任意 role。
  - 历史归档文档（`LANDING-ARCHIVE`、`GITHUB-*`、`FUSION-*` 等）保留原文，仅两份活指导文档
    （`LANDING-2026-11-16.md`、`DEV-CHECKLIST-2026-11-04.md`）加了退役横幅。

### Fixed

- `src/keepalive.js`：`require('../channel-pool')` 从 `src/` 出发会指向仓库根（路径错误），改为 `'./channel-pool'`。
- `test/integration.test.js`：桩补 `hasFunctionTools`，修复「播报即收尾」接线后该用例的 `TypeError`。
- `test/pool.test.js`：轮询用例显式钉住 `pickMode: 'rr'` 与 `pickGapMs: 0`，避免默认加权抽签与
  防撞号窗口让断言只在随机碰巧时通过。

## [1.1.0] - 2026-11（历史）

五通道（搭子 / 千问办公 / TRAE Work / Qoder / WorkBuddy）+ 三协议网关，逐批落地记录见
[docs/LANDING-ARCHIVE-2026-11.md](docs/LANDING-ARCHIVE-2026-11.md)。

[Unreleased]: https://github.com/wearetheone777/dumate2api/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/wearetheone777/dumate2api/releases/tag/v2.0.0
