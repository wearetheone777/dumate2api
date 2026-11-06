// src/images.js - 图像输入的共享转换（2026-10-30）
//
// 背景：三个翻译层（anthropic/responses/google）此前把图像一律降级成
// 「[Image content - not supported by DuMate backend]」占位文本。那是**搭子
// 的能力边界**（上游不支持视觉），却被套到了所有通道上——实测 TRAE 的
// llm_utils_chat 直接认 OpenAI 标准的 image_url part（data URI，2026-10-30
// 真机验证：纯红色 PNG → 模型答「红色」），图像在翻译层被剥掉等于白白丢掉
// 客户端能力。
//
// 现在的分层：
//   翻译层   → 保真：把各家图像块统一转成 OpenAI 的 image_url part
//   通道层   → 消歧：TRAE 直通 + 多模态校验（traework/index.js）；
//              千问/Qoder 的 COSY 协议只有纯文本槽（chat_context.text），
//              图像展开成占位文本，不静默丢、也不假装发到了上游；
//              搭子维持原有降级（它真的不支持）。
//
// 注意：HTTP(S) 外链图未实测（上游是否代拉外网图片未知），data URI 已实测。
// 不做人为的尺寸/格式白名单——没有实测依据的限制只会挡住能用的场景。

/** url → OpenAI image_url part（标准形状，llm_utils_chat 已实测接受） */
function toImageUrlPart(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  return { type: 'image_url', image_url: { url: u } };
}

/**
 * Responses API 的图像 part → url。
 * 兼容三种写法：image_url 字符串 / image_url 对象 {url} / 顶层 url。
 */
function responsesPartToUrl(p) {
  if (!p || typeof p !== 'object') return '';
  const iu = p.image_url;
  if (typeof iu === 'string') return iu;
  if (iu && typeof iu === 'object' && iu.url) return String(iu.url);
  if (p.url) return String(p.url);
  return '';
}

/**
 * OpenAI/Responses content 数组里的图像 parts → image_url part 数组。
 * 识别 input_image（Responses）与 image_url（OpenAI/chat 直通）两种块。
 */
function imagePartsFromContent(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const t = String(p.type || '');
    if (t === 'input_image' || t === 'image_url' || (!t && (p.image_url || p.url))) {
      const part = toImageUrlPart(responsesPartToUrl(p));
      if (part) out.push(part);
    }
  }
  return out;
}

/**
 * content（字符串或数组）→ 纯文本。
 * 给只有纯文本槽的通道（千问/Qoder 的 chat_context.text）用：
 * text part 拼接，图像 part 换成占位文本——**必须显式处理**，否则
 * `String([{type:'text',...},{type:'image_url',...}])` 会得到 "[object Object]"，
 * 模型看到的是这串垃圾而不是用户的话。
 */
function contentText(content, imagePlaceholder) {
  const ph = imagePlaceholder || '[Image content - not supported by this channel]';
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const parts = [];
  for (const p of content) {
    if (p == null) continue;
    if (typeof p === 'string') { parts.push(p); continue; }
    if (typeof p.text === 'string') { parts.push(p.text); continue; }
    if (p.type === 'image_url' || p.type === 'input_image' || p.image_url || p.url) parts.push(ph);
  }
  return parts.filter(Boolean).join('\n');
}

/** content 数组里有没有图像 part（OpenAI/Responses 形状） */
function hasImageContent(content) {
  if (!Array.isArray(content)) return false;
  return content.some((p) => p && typeof p === 'object'
    && (p.type === 'image_url' || p.type === 'input_image' || (p.image_url && !p.text)));
}

module.exports = { toImageUrlPart, responsesPartToUrl, imagePartsFromContent, contentText, hasImageContent };
