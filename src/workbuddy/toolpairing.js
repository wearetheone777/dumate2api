// src/workbuddy/toolpairing.js - 出站前的 tool_call↔tool 配对修复（P0-3）
//
// 移植自 misakano7545/workbuddy2api-panel 的 internal/upstream/tool_pairing.go
// （吸收参考仓库 sse.ts resolveToolPairing 语义 + hub PR #3 reorder_early_tool_results）。
//
// 背景：OpenAI 兼容协议要求带 tool_calls 的 assistant 消息，其每一个 tool_call id
// 都必须有对应的一条 role:tool 结果消息；反之 role:tool 消息也必须有对应的前置
// tool_call。缺任一侧、或结果不紧跟调用，上游都以 400 拒绝（11148
// tool_call_sequence_broken）并顶死整条会话——之后每一条用户消息都 400。
//
// 网关是最后一道防线：发出请求前把可机械修复的坏历史修掉，让会话自愈，
// 宁可丢一轮工具上下文，也好过整条会话死亡。与 hawklithm 系实现「歧义回 422」
// 的取舍不同：本文件的四步修复**按构造保证**剩余历史两侧配对完整（cleanup 的
// keepCalls 是调用集∩结果集的对称裁剪），不存在修不动的歧义态，所以不设 422
// 分支——死代码不如没有。
//
// 四步顺序（每步只调顺序/并批/删除，不改任何内容）：
//   1. mergeAdjacentToolCalls   相邻 assistant（前带 tool_calls）并批
//   2. repackToolResultBlocks   插在调用与结果之间的非 tool 消息后移
//   3. reorderEarlyToolResults  早于其调用的结果移到对应 assistant 之后
//   4. cleanupOrphanToolCalls   双侧对称裁剪孤儿（含缺名调用）
'use strict';

/** 一条 assistant 消息 tool_calls 里的非空 id（其他消息为空数组） */
function declaredToolCallIDs(raw) {
  if (!raw || typeof raw !== 'object' || raw.role !== 'assistant') return [];
  const tcs = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
  const ids = [];
  for (const tci of tcs) {
    if (tci && typeof tci === 'object' && typeof tci.id === 'string' && tci.id) {
      ids.push(tci.id);
    }
  }
  return ids;
}

/** tool_call 单项是否缺少可用的功能名（function 缺失 / name 缺失 / name 空白）。
 * 上游对这类条目直接判 11133 model_param_invalid，带不带配对结果都拒——
 * 流在 name 分片到达前断掉时聚合器会落下占位条目，留着只会顶死会话。 */
function toolCallNameMissing(tc) {
  if (!tc || typeof tc !== 'object') return true;
  const fn = tc.function;
  if (!fn || typeof fn !== 'object') return true;
  if (typeof fn.name !== 'string') return true;
  return fn.name.trim() === '';
}

/**
 * 把「前一条带 tool_calls 的 assistant」与紧随其后的 assistant 合并成一条
 * （正文拼接、tool_calls 并批）。中间没有 tool 结果的相邻 assistant 在 wire 上
 * 就是同一轮：拆开会让前一批 tool_calls 变成「无结果调用」。纯文本相邻回复
 * （前一条无 tool_calls）不动——那是两轮真实对话。只合并字符串（或 null/缺省）
 * 正文：content 是结构化 parts 时形状未知，宁可漏修也不改形状。
 */
function mergeAdjacentToolCalls(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return { messages, changed: false };
  const out = [];
  let changed = false;
  for (const raw of messages) {
    const m = raw && typeof raw === 'object' ? raw : null;
    if (!m || m.role !== 'assistant' || !out.length) { out.push(raw); continue; }
    const prev = out[out.length - 1];
    if (!prev || typeof prev !== 'object') { out.push(raw); continue; }
    const ptc = Array.isArray(prev.tool_calls) ? prev.tool_calls : [];
    const tc = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!ptc.length) { out.push(raw); continue; }
    // 正文：字符串或缺省（null 视同缺省）才并；双方皆空则只并 tool_calls
    const pc = typeof prev.content === 'string' ? prev.content : '';
    const cc = typeof m.content === 'string' ? m.content : '';
    if ((typeof prev.content !== 'string' && prev.content != null)
      || (typeof m.content !== 'string' && m.content != null)) {
      out.push(raw); continue;
    }
    const merged = { ...prev };
    if (pc || cc) merged.content = pc + cc; else delete merged.content;
    merged.tool_calls = [...ptc, ...tc];
    const rcs = [];
    if (typeof prev.reasoning_content === 'string' && prev.reasoning_content) rcs.push(prev.reasoning_content);
    if (typeof m.reasoning_content === 'string' && m.reasoning_content) rcs.push(m.reasoning_content);
    if (rcs.length) merged.reasoning_content = rcs.join('\n'); else delete merged.reasoning_content;
    out[out.length - 1] = merged;
    changed = true;
  }
  return { messages: changed ? out : messages, changed };
}

/**
 * 把插在 assistant.tool_calls 与其 tool 结果之间的非 tool 消息挪到整组之后，
 * 保证同一批 tool_call 的结果在 wire 上连续（Codex 的 image_resize_notice 类
 * 插入物真实成因）。只调顺序、不改内容；无插入消息时零改动。
 */
function repackToolResultBlocks(messages) {
  if (!Array.isArray(messages) || messages.length < 3) return { messages, changed: false };
  const out = [];
  let changed = false;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || m.role !== 'assistant') { out.push(m); i++; continue; }
    const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!tcs.length) { out.push(m); i++; continue; }
    const want = new Set();
    for (const tci of tcs) {
      if (tci && typeof tci === 'object' && typeof tci.id === 'string' && tci.id) want.add(tci.id);
    }
    out.push(m);
    i++;
    const results = [];
    const between = [];
    let sawNonTool = false;
    while (i < messages.length) {
      const mm = messages[i];
      if (!mm || typeof mm !== 'object') break;
      const role = typeof mm.role === 'string' ? mm.role : '';
      if (role === 'tool') {
        const id = typeof mm.tool_call_id === 'string' ? mm.tool_call_id : '';
        if (!want.has(id)) {
          // 孤儿结果暂存待后移，**不能 break**——它后面可能还有本批的合法结果。
          // 孤儿本身由 cleanupOrphanToolCalls 删，这里只保证不遮挡后续结果。
          between.push(mm);
          sawNonTool = true;
          i++;
          continue;
        }
        results.push(mm);
        if (sawNonTool) changed = true;
        i++;
        continue;
      }
      if (!results.length) break; // assistant 后没有结果：交由 cleanup 处理
      // 下一组 assistant.tool_calls 是新的组头，绝不能当插入物吞掉——一旦被
      // 收进 between，它自己那批结果就永远得不到重排。必须 break 交还外层。
      if (role === 'assistant' && Array.isArray(mm.tool_calls) && mm.tool_calls.length) break;
      between.push(mm);
      sawNonTool = true;
      i++;
    }
    out.push(...results, ...between);
  }
  return { messages: changed ? out : messages, changed };
}

/**
 * 把「早于其 tool_call」出现的 role:tool 结果移到对应 assistant(tool_calls) 之后，
 * 保证 wire 上永远是「调用在前、结果在后」（Responses 类适配器按原始顺序拼接
 * input 时会产出这种顺序）。参照 hub PR #3，只调顺序、不改内容。
 *
 * 归属判定不能用「同 id 跟最后一次声明走」：id 会跨轮复用（上游没给 id 时
 * 网关按轮内下标补 call_0），那会把顺序本来就对的第一轮结果搬到最后一轮之后，
 * 反而制造 11148。正序扫描记每个 id「已声明、未应答」次数：
 *   - 结果命中未应答的声明 → 正常配对，原地不动；
 *   - 否则它属于后面最近的同 id 声明 = 早到结果，预记该次已应答；
 *   - 前后都找不到声明者的孤儿结果不动，交给 cleanup 删。
 */
function reorderEarlyToolResults(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return { messages, changed: false };
  const decls = new Map(); // id → 全部声明下标（正序遍历 → 升序）
  messages.forEach((raw, i) => {
    for (const id of declaredToolCallIDs(raw)) {
      if (!decls.has(id)) decls.set(id, []);
      decls.get(id).push(i);
    }
  });
  if (!decls.size) return { messages, changed: false };
  const open = new Map();   // id → 已声明未应答次数；早到结果先扣，可暂为负
  const group = new Map();  // 声明下标 → 归它的早到结果（原相对顺序）
  const early = new Array(messages.length).fill(false);
  let anyEarly = false;
  messages.forEach((raw, i) => {
    for (const id of declaredToolCallIDs(raw)) {
      open.set(id, (open.get(id) || 0) + 1);
    }
    const m = raw && typeof raw === 'object' ? raw : null;
    if (!m || m.role !== 'tool') return;
    const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
    if (open.get(id) > 0) {
      open.set(id, open.get(id) - 1);
      return;
    }
    for (const j of decls.get(id) || []) {
      if (j > i) {
        early[i] = true;
        anyEarly = true;
        if (!group.has(j)) group.set(j, []);
        group.get(j).push(raw);
        open.set(id, (open.get(id) || 0) - 1);
        break;
      }
    }
  });
  if (!anyEarly) return { messages, changed: false };
  const out = [];
  let pending = [];
  const flush = () => { if (pending.length) { out.push(...pending); pending = []; } };
  messages.forEach((raw, i) => {
    if (early[i]) return; // 早到的结果不在此处落地
    const m = raw && typeof raw === 'object' ? raw : null;
    const role = m && typeof m.role === 'string' ? m.role : '';
    // 结果区结束（来了一条非 tool 消息）：先把上一批待补的结果补上
    if (pending.length && role !== 'tool') flush();
    out.push(raw);
    if (group.has(i)) pending = group.get(i);
  });
  flush();
  return { messages: out, changed: true };
}

/**
 * 剔除无法配对的 tool_call 与 tool 结果。keepCalls = 调用集 ∩ 结果集 − 缺名集，
 * 两侧按它对称裁剪（调用与其结果成对剔除），任何输入都不会产生半截配对；
 * 同一 call_id 的重复结果只留第一条。无任何工具流量 → 原样返回。
 */
function cleanupOrphanToolCalls(messages) {
  if (!Array.isArray(messages) || !messages.length) return { messages, changed: false };
  const callIDs = new Set();
  const resultIDs = new Set();
  const nameBadIDs = new Set();
  let hasTraffic = false;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool') {
      if (typeof m.tool_call_id === 'string' && m.tool_call_id) {
        resultIDs.add(m.tool_call_id);
        hasTraffic = true;
      }
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tci of m.tool_calls) {
        if (!tci || typeof tci !== 'object') continue;
        if (typeof tci.id === 'string' && tci.id) {
          callIDs.add(tci.id);
          if (toolCallNameMissing(tci)) nameBadIDs.add(tci.id);
          hasTraffic = true;
        }
      }
    }
  }
  if (!hasTraffic) return { messages, changed: false };
  const keepCalls = new Set();
  for (const id of callIDs) {
    if (nameBadIDs.has(id)) continue;
    if (resultIDs.has(id)) keepCalls.add(id);
  }
  let changed = false;
  // 1) assistant.tool_calls：按 keepCalls 对称裁剪，过滤后为空则删键。
  //    （批内整批丢弃会留下无主结果——两侧必须共用同一份 keepCalls。）
  for (const m of messages) {
    if (!m || typeof m !== 'object' || m.role !== 'assistant') continue;
    const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!tcs.length) continue;
    const keptCalls = tcs.filter((tci) => tci && typeof tci === 'object' && keepCalls.has(tci.id));
    if (keptCalls.length === tcs.length) continue;
    changed = true;
    if (keptCalls.length) m.tool_calls = keptCalls; else delete m.tool_calls;
  }
  // 2) role:tool 结果：对应调用被保留才保留；孤儿整条删除；重复结果只留第一条
  const kept = [];
  const seenResult = new Set();
  for (const m of messages) {
    if (m && typeof m === 'object' && m.role === 'tool') {
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
      if (!keepCalls.has(id) || seenResult.has(id)) { changed = true; continue; }
      seenResult.add(id);
    }
    kept.push(m);
  }
  return { messages: changed ? kept : messages, changed };
}

/** 四步修复主管线。返回 { messages, changed, steps:[实际生效的步名] } */
function repairToolPairing(messages) {
  let cur = messages;
  const steps = [];
  const r1 = mergeAdjacentToolCalls(cur);
  if (r1.changed) { steps.push('merge'); cur = r1.messages; }
  const r2 = repackToolResultBlocks(cur);
  if (r2.changed) { steps.push('repack'); cur = r2.messages; }
  const r3 = reorderEarlyToolResults(cur);
  if (r3.changed) { steps.push('reorder'); cur = r3.messages; }
  const r4 = cleanupOrphanToolCalls(cur);
  if (r4.changed) { steps.push('cleanup'); cur = r4.messages; }
  return { messages: cur, changed: steps.length > 0, steps };
}

module.exports = {
  declaredToolCallIDs, toolCallNameMissing,
  mergeAdjacentToolCalls, repackToolResultBlocks, reorderEarlyToolResults,
  cleanupOrphanToolCalls, repairToolPairing,
};
