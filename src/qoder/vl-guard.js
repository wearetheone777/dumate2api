// src/qoder/vl-guard.js - 非视觉模型传图的前置校验（P2-24）
//
// 出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P2-24「VL 前置校验」（融合自
// fengyinxia/qoder2api）：非视觉模型传图**本地 400**，比放行后上游报错省一次
// 上游调用。
//
// **为什么值得做**：Qoder 的模型表带 `is_vl`（`session.fetchModels` 已归一出
// `multimodal`）。而图片走的是 OpenAI 标准 `image_url` part（base64 data URI），
// 一次请求可能几十 MB——放行到上游才被拒，等于白传一遍。省的不只是延迟，
// 还有那条 413 风险（SLB 30MB 硬限）。
//
// **2026-11-08 真机实测：本通道目前不会触发拦截**。Qoder 模型表里**全部 12 个
// 模型的 `is_vl` 都是 true**（auto/fast/qmodel_38max/qfmodel/dmodel/dfmodel/
// gmodel/gfmodel/kmodel_latest/kmodel/jmodel/mmodel），且实测给 `gfmodel` 传
// 1x1 PNG 上游**正常接受**（只在 reasoning 里用 `<image>` 元描述替代真实图像
// 内容——那是上游自己的降级行为，不是拒绝）。
//
// 那为什么还保留这份校验？三点：
//   1. `is_vl` 是**上游下发的字段**，随时可能按账号/灰度/模型批次收紧。那时
//      本校验自动生效，不必再改代码。
//   2. 判据是**放行优先**的（表不可用/模型不在表里一律放行），现在留着不会
//      误伤任何请求；12/12 已实测放行。
//   3. 「实测无拦截」这件事本身要写下来，否则后人会以为忘了接线。
//
// 三条口径（每条都有「不这么做会怎样」的理由）：
//   1. **只在模型表明确说「不是多模态」时拒绝**。表拿不到 / 该模型不在表里 /
//      字段缺失 → **放行**（带 `unknown` 说明）——放行的代价是上游报一次错，
//      误拒的代价是「本来能用的模型被网关挡住了」，后者严重得多。
//   2. 只看**结构化 part**，不猜文本里的 URL。`content` 是字符串里带
//      `![](http://…)` 那属于用户正文，不是图像输入通道。
//   3. 拒绝文案要**能指导下一步**：报出模型名、说明该模型不支持图像、
//      并点名当前表里哪些模型支持（一个都不支持时说清这点，别让人白找）。
'use strict';

/** 这条消息是否带图像输入（OpenAI 标准 image_url part） */
function hasImagePart(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || typeof part !== 'object') continue;
      // image_url 是标准写法；input_image 是 Responses 形态（本项目 Responses
      // 入口会转成 chat 形状，但保底也认一下，免得漏判）
      if (part.type === 'image_url' || part.type === 'input_image') return true;
    }
  }
  return false;
}

/** 统计图片**数量**（文案里要报，便于用户判断是不是附件塞多了） */
function countImageParts(messages) {
  let n = 0;
  if (!Array.isArray(messages)) return 0;
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url' || part.type === 'input_image') n++;
    }
  }
  return n;
}

/**
 * 判断这次请求该不该在本地拒掉。
 *
 * @param {object} p
 *   p.messages   请求的消息数组
 *   p.modelKey   已解析的上游模型 key（如 `gfmodel`）
 *   p.models     模型表（`fetchModels` 的归一化结果，带 multimodal）
 * @returns {{blocked:boolean, error?:string, code?:string, images?:number, vlModels?:string[]}}
 *   表不可用/模型不在表里 → `{blocked:false}`
 *   明确指出不支持且有图   → `{blocked:true, ...}`
 */
function checkVision(p = {}) {
  const images = countImageParts(p.messages);
  if (!images) return { blocked: false, images: 0 };
  const models = Array.isArray(p.models) ? p.models : null;
  // 表拿不到：放行。**不能因为「查不到」就拒**——那是把网关自身的数据缺口
  // 变成用户的故障。
  if (!models || !models.length) return { blocked: false, images, unknown: '模型表不可用，放行' };
  const key = String(p.modelKey || '');
  const meta = models.find((m) => m && (m.key === key || m.name === key));
  if (!meta) return { blocked: false, images, unknown: '模型不在表内，放行' };
  if (meta.multimodal === true) return { blocked: false, images };
  // 这里 meta.multimodal 明确为 false（表说有这个字段且不是视觉模型）
  const vlModels = models.filter((m) => m && m.multimodal === true).map((m) => m.key || m.name).filter(Boolean);
  const hint = vlModels.length
    ? `当前表里支持图像的模型：${vlModels.join('、')}`
    : '当前表里没有任何模型声明支持图像（is_vl）——这条通道可能整体不支持图像输入';
  return {
    blocked: true,
    images,
    vlModels,
    statusCode: 400,
    code: 'model_not_vision',
    error: `模型 ${key} 不支持图像输入（上游模型表 is_vl=false），本次请求带了 ${images} 张图。`
      + `${hint}。换模型重发，或把图改成文字描述。`
      + '（本地前置拒绝：省掉一次注定失败的上游调用与几十 MB 的图片传输。）',
  };
}

/**
 * 把 checkVision 的结果转成 handler 层可直接用的错误对象（带 statusCode，
 * 与既有 `err.statusCode` 约定一致，四个协议入口的收尾逻辑都认它）。
 */
function visionError(result) {
  if (!result || !result.blocked) return null;
  const err = new Error(result.error);
  err.statusCode = result.statusCode || 400;
  err.code = result.code;
  // **不惩罚账号**：拒绝的是「模型不支持」这件事，与账号健康无关。
  // poolInfoOf 见到 policy/opaqueCode 会走「不惩罚」分支；这里给一个明确
  // 标志，让上层能照它走（见 qoder/index.js 的 poolInfoOf）。
  err.visionBlocked = true;
  return err;
}

module.exports = { hasImagePart, countImageParts, checkVision, visionError };
