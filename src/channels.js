// src/channels.js - 通道 id 的单一来源
//
// 通道白名单散落在 keys.js（网关鉴权）、admin/routes/keys.js（校验）、
// usage.js / reqlogs.js（筛选参数）四处。加一条通道要在四个文件里各改一遍，
// 漏一处就表现为「切到新通道后某项数据永远为空」——很难归因。
//
// 所以集中在这里，各处 require 同一份。
const CHANNELS = ['dumate', 'qwenwork', 'traework', 'qoder', 'workbuddy'];

const LABELS = {
  dumate: '百度搭子',
  qwenwork: '千问办公',
  traework: 'TRAE Work',
  qoder: 'Qoder',
  workbuddy: 'WorkBuddy',
};

function label(id) {
  return LABELS[id] || id;
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

module.exports = { CHANNELS, LABELS, label, normalize, belongs, effChannel };
