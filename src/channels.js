// src/channels.js - 通道 id 与能力声明的单一来源
//
// 通道白名单散落在 keys.js（网关鉴权）、admin/routes/keys.js（校验）、
// usage.js / reqlogs.js（筛选参数）四处。加一条通道要在四个文件里各改一遍，
// 漏一处就表现为「切到新通道后某项数据永远为空」——很难归因。
//
// 所以集中在这里，各处 require 同一份。
//
// 批次二十二（能力声明建模）：通道清单 / 标签 / kind / capabilities 的**事实**
// 在仓库根的 channels.def.json——本文件与前端 channel.ts 都从它构建。凡是要
// 回答「这条通道能不能 X」「有没有国际版」的地方读声明（can / regionsOf），
// 不要再写 id === 'qoder' 这类判定；kind 同理（kindOf），加通道改 JSON 一处，
// 其余消费方自动跟随。能力位的含义：
//   - checkin   签到 / 打卡体系（keepalive 签到适配器）
//   - credits   积分 / 额度账（界面「积分明细」菜单挂它）
//   - growth    成长任务（目前只有 WorkBuddy）
//   - media     生图 / TTS / 视频（搭子）
//   - search    联网搜索（千问 /v1/search/*）
//   - regions   账号区域维度；空数组 = 纯国内产品（intl key 直接拒）
const DEF = require('../channels.def.json');

const CHANNELS = DEF.channels.map((c) => c.id);

const LABELS = Object.fromEntries(DEF.channels.map((c) => [c.id, c.label]));

function label(id) {
  return LABELS[id] || id;
}

function defOf(id) {
  return DEF.channels.find((c) => c.id === id) || null;
}

/** 通道形态：'http'（代理型上游，如搭子）/ 'direct'（进程内直连，凭证自持） */
function kindOf(id) {
  const c = defOf(id);
  return c ? c.kind : null;
}

function capabilitiesOf(id) {
  const c = defOf(id);
  return c ? c.capabilities : null;
}

/** 能力位查询。能力不存在 / 未声明一律 false——不猜。 */
function can(id, cap) {
  const caps = capabilitiesOf(id);
  return !!(caps && caps[cap] === true);
}

/** 账号区域维度。空数组 = 纯国内产品（上游连国际端点都没有）。 */
function regionsOf(id) {
  const caps = capabilitiesOf(id);
  return caps && Array.isArray(caps.regions) ? caps.regions : [];
}

/** 管理端 /status 透出的公共形状（id/label/kind/capabilities），调用方再补运行态字段 */
function publicOf(id) {
  const c = defOf(id);
  return c ? { id: c.id, label: c.label, kind: c.kind, capabilities: { ...c.capabilities } } : { id, label: label(id), kind: null, capabilities: null };
}

/** 归一化筛选参数：不在白名单里的一律当「全部通道」 */
function normalize(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return CHANNELS.includes(s) ? s : '';
}

/**
 * 请求行是否属于该通道。
 * **历史记录（channel 未标注）归入搭子**——分通道埋点上线前只有搭子一条通道，
 * 把它们算进「未标注」会让用户切到搭子时数字凭空变小。
 * 只有「查看全部」时才单列未标注（由 effChannel 处理）。
 */
function belongs(row, ch) {
  if (!ch) return true;
  if (ch === 'dumate') return row.channel === 'dumate' || !row.channel;
  return row.channel === ch;
}

/** 通道归属：无 channel 字段时，按当前筛选归入搭子；查看全部时归入未标注 */
function effChannel(row, ch) {
  return row.channel || (ch === 'dumate' ? 'dumate' : 'untagged');
}

module.exports = { DEF, CHANNELS, LABELS, label, kindOf, capabilitiesOf, can, regionsOf, publicOf, normalize, belongs, effChannel };
