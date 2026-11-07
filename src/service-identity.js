// src/service-identity.js - 进程身份（/health 的 role 字段 + X-Service 响应头）
//
// 本仓库四个进程跑同一份代码的不同入口（9080 稳定 / 9082 开发 / 9083 管理端 /
// 9084 网页网关）。端口探活时「返回 2xx 的不一定是本服务」——同端口残留的
// 其他服务、或别的项目占用了端口都会造成假成功（workbuddy2api 面板 2026-11
// 版的同类设计：强校验用带 Key 的状态端点，弱校验用无鉴权 health + 身份字段）。
//
// 字段口径：
//   service 固定 'dumate2api'（品牌级，四个进程相同——探活判它就知道命中了本仓库）
//   role    区分入口：gateway / admin / web-gateway；DUMATE_ROLE 环境变量可覆盖
//   stable  快照目录（stable/src）跑的 gateway 额外带 '-stable' 后缀——
//           9080 对外实例与 9082 开发实例代码同源，只有目录不同，靠它区分
//
// stable 判定用 __dirname：发布时按依赖闭包把本模块同步进 stable/src/，
// 稳定版进程加载的是自己目录下的副本，天然带 stable 路径；开发版不带。
const STABLE_DIR = /[\\/]stable[\\/]/.test(__dirname);

/**
 * @param {string} baseRole 入口基础角色（gateway / admin / web-gateway）
 * @returns {{ service: string, role: string }}
 */
function identity(baseRole) {
  const env = String(process.env.DUMATE_ROLE || '').trim();
  const role = env || (STABLE_DIR ? `${baseRole}-stable` : baseRole);
  return { service: 'dumate2api', role };
}

module.exports = { identity, STABLE_DIR };
