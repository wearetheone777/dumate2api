// src/admin/routes/models.js - 模型映射管理
const http = require('http');
const modelmap = require('../../modelmap');
const discovery = require('../../discovery');
const { sendJSON } = require('../router');

// 实测上游是否接受某个模型 ID。只发最小请求（1 token），
// 因为上游没有模型列表接口，只能靠这个探针回答「这个名字上游认不认」。
function probeModel(port, model, timeout = 15000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/qianfanproxy/v1/chat/completions',
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer nokey',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let upstreamError = '';
          if (res.statusCode >= 400) {
            try {
              const j = JSON.parse(data);
              upstreamError = (j.error && (j.error.message || j.error.code)) || j.error_message || '';
            } catch (e) { upstreamError = data.slice(0, 120); }
          }
          resolve({
            model,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            error: String(upstreamError).slice(0, 200),
          });
        });
      }
    );
    req.on('error', (e) => resolve({ model, ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ model, ok: false, status: 0, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// 千问办公的模型表由服务端 /api/v2/model/list 下发，**本地不可编辑**：
// 实测 1.1.0 只有 pro/flash，旧版的 qwork-advanced 等已消失——硬编码一份
// 必然过期。中文名也来自上游 display_name，不自己编。
const QW_NAMES = { pro: '高级', flash: '标准', 'qwen3.8-max-preview': 'Qwen3.8-Max' };

// TRAE Work 的模型表同样是上游下发的，本地改不了。当前只有静态表里那一
// 个（src/traework/constants.js 的 DEFAULT_MODEL 实测可用），留空表名由
// 上游后续扩展——硬编码一批「应该存在」的名字等于编数据。
const TW_NAMES = { 'glm-5.2': 'GLM-5.2' };

async function channelView(cfg) {
  const out = [{
    id: 'dumate', label: '百度搭子', editable: true, prefix: null,
    // 显示名与 /v1/models 同源：可读标注来自 modelmap.displayName，
    // 别名原样返回（它们没有上游标注）
    models: cfg.exposed.map((id) => ({ id, name: modelmap.displayName(id) })),
  }];
  try {
    const qw = require('../../qwenwork');
    const entries = await qw.listModelEntries();
    out.push({
      id: 'qwenwork', label: '千问办公', editable: false, prefix: 'qwen/',
      models: entries.map((e) => ({
        id: e.key,
        name: e.name || QW_NAMES[e.key] || e.key,
        prefixed: `qwen/${e.key}`,
        ...(Number.isFinite(e.rate) ? { rate: e.rate } : {}),
        ...(e.contextWindow ? { contextWindow: e.contextWindow } : {}),
        ...(e.multimodal ? { multimodal: true } : {}),
      })),
    });
  } catch (e) {
    out.push({ id: 'qwenwork', label: '千问办公', editable: false, prefix: 'qwen/', models: [], error: e.message });
  }
  try {
    const tw = require('../../traework');
    out.push({
      id: 'traework', label: 'TRAE Work', editable: false, prefix: 'traework/',
      models: tw.listModels().map((k) => ({
        id: k, name: TW_NAMES[k] || k, prefixed: `traework/${k}`,
      })),
    });
  } catch (e) {
    out.push({ id: 'traework', label: 'TRAE Work', editable: false, prefix: 'traework/', models: [], error: e.message });
  }
  return out;
}

const routes = [
  {
    method: 'GET',
    path: '/map',
    handler: async ({ res }) => {
      const cfg = modelmap.load();
      const upstream = new Set(cfg.upstream_models);
      return sendJSON(res, 200, {
        aliases: cfg.aliases,
        upstream_models: cfg.upstream_models,
        exposed: cfg.exposed,
        fallback: cfg.fallback,
        // 云端名空间（2026-11-06 实测定案，test/probe-dumate-cloud-models.js）：
        // 9084 与本地回落共用。cloud_upstream 是实测 200 的六个路由名，界面
        // **只读展示**——清单来自真机探测，编辑它只会诱导用户改成 404 名；
        // cloud_aliases（本地名 → 云端名回落映射）可编辑，校验见 POST。
        cloud_upstream: cfg.cloud_upstream,
        cloud_aliases: cfg.cloud_aliases,
        entries: Object.keys(cfg.aliases).sort().map((name) => ({
          name,
          target: cfg.aliases[name],
          upstream_native: upstream.has(name),
          exposed: cfg.exposed.includes(name),
        })),
        defaults: {
          aliases: modelmap.DEFAULT_ALIASES,
          upstream_models: modelmap.DEFAULT_UPSTREAM,
          exposed: modelmap.DEFAULT_EXPOSED,
          cloud_upstream: modelmap.DEFAULT_CLOUD_UPSTREAM,
          cloud_aliases: modelmap.DEFAULT_CLOUD_ALIASES,
        },
        // 通道视图：上面的 aliases/exposed 只描述搭子（那套别名表是搭子
        // 专用的）。千问办公的模型由上游下发，本地改不了，所以只读展示。
        channels: await channelView(cfg),
      });
    },
  },
  {
    // 上游 max_tokens 上限自学习观测（2026-11-06 清单项 4）。
    // dumate-caps 的机制：上游模型表不带 maxOutputTokens，第一次撞上限
    // （400 "Range of max_tokens should be [1, N]"）时 learn() 把 N 落盘
    // data/dumate-caps.json（7 天 TTL），之后 buildBody 出站前自动 clamp。
    // 管理端进程直接读落盘文件（与网关共享 data/，零跨进程调用）；
    // capOf 给每个已知模型算「当前生效上限」（内置表 or 已学习 or null）。
    method: 'GET',
    path: '/caps',
    handler: async ({ res }) => {
      const caps = require('../../dumate-caps');
      const fs = require('fs');
      let learned = {};
      try { learned = JSON.parse(fs.readFileSync(caps.filePath(), 'utf8')) || {}; } catch (e) { /* 尚未触发过学习 */ }
      const models = [...new Set([...Object.keys(caps.OUTPUT_CAPS), ...Object.keys(learned)])];
      const now = Date.now();
      const rows = models.map((m) => {
        const l = learned[m];
        const learnedValid = l && Number(l.n) > 0 && Number(l.at) && now - Number(l.at) <= caps.TTL_MS;
        return {
          model: m,
          cap: caps.capOf(m, now),
          source: learnedValid ? 'learned' : (caps.OUTPUT_CAPS[m] != null ? 'builtin' : null),
          learned_at: learnedValid ? Number(l.at) : null,
          expired: l && !learnedValid ? true : false,
        };
      });
      return sendJSON(res, 200, {
        ok: true,
        ttl_days: caps.TTL_MS / 86400000,
        rows: rows.sort((a, b) => a.model.localeCompare(b.model)),
      });
    },
  },
  {
    method: 'POST',
    path: '/map',
    handler: ({ res, body }) => {
      if (!body || typeof body !== 'object') {
        return sendJSON(res, 400, { error: '请求体必须是对象' });
      }
      const problems = [];
      if (body.aliases !== undefined) {
        if (typeof body.aliases !== 'object' || Array.isArray(body.aliases)) {
          problems.push('aliases 必须是对象');
        } else {
          for (const [k, v] of Object.entries(body.aliases)) {
            if (!String(k).trim()) problems.push('别名不能为空');
            if (!String(v || '').trim()) problems.push(`别名 ${k} 的目标为空`);
          }
        }
      }
      if (body.exposed !== undefined) {
        if (!Array.isArray(body.exposed) || !body.exposed.length) {
          problems.push('exposed 至少保留一个模型');
        }
      }
      if (body.upstream_models !== undefined) {
        if (!Array.isArray(body.upstream_models) || !body.upstream_models.length) {
          problems.push('upstream_models 至少保留一个模型');
        }
      }
      if (body.cloud_aliases !== undefined) {
        if (typeof body.cloud_aliases !== 'object' || Array.isArray(body.cloud_aliases)) {
          problems.push('cloud_aliases 必须是对象');
        } else {
          // 严格校验目标：toCloudModel 的映射分支要求目标在 cloud_upstream 里
          // 才生效——指到清单外的名字等于映射静默失效（兜底回 model-text），
          // 配置错误要在保存时挡住，不能等回落 404 了才发现。
          const cloudSet = new Set(modelmap.DEFAULT_CLOUD_UPSTREAM);
          for (const [k, v] of Object.entries(body.cloud_aliases)) {
            if (!String(k).trim()) problems.push('云端映射的本地名不能为空');
            if (!cloudSet.has(String(v || ''))) {
              problems.push(`云端映射 ${k} → ${v || '(空)'} 的目标不在云端模型清单里`);
            }
          }
        }
      }
      if (problems.length) return sendJSON(res, 400, { error: problems.join('；') });

      const saved = modelmap.save(body);
      require('../../admin/auth').audit('admin', 'model_map_save', '', JSON.stringify({
        aliases: Object.keys(saved.aliases).length,
        exposed: saved.exposed.length,
      }));
      return sendJSON(res, 200, { ok: true, ...saved });
    },
  },
  {
    method: 'POST',
    path: '/map/reset',
    handler: ({ res }) => {
      const cfg = modelmap.reset();
      require('../../admin/auth').audit('admin', 'model_map_reset');
      return sendJSON(res, 200, { ok: true, ...cfg });
    },
  },
  {
    // 三条通道的模型一览（统一形状，每个字段带来源）。
    // ?channel=dumate|qwenwork|traework 只看一条；缺省返回全部。
    // 与 /map 的区别：/map 只描述搭子（别名映射，可编辑）；这里描述
    // 「每个模型是什么、花多少、能吃多长上下文」，跨通道统一。
    method: 'GET',
    path: '/info',
    handler: async ({ res, req }) => {
      const chRaw = decodeURIComponent((req.url.match(/[?&]channel=([^&]*)/) || [])[1] || '');
      const ch = require('../../channels').normalize(chRaw);
      const force = /[?&]refresh=1/.test(req.url || '');
      // all=1 看 TRAE 上游表全量（含 subagent / custom_model 占位 / summary）。
      // 默认收窄到可用对话模型——排查「为什么某个名字调不通」才需要全量
      const all = /[?&]all=1/.test(req.url || '');
      // 区域（2026-11-03 国际版）：qoder → cn|global；traework → cn|intl。
      // 只有 qoder/traework 有区域概念，其余通道忽略
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = ['cn', 'global', 'intl'].includes(regionRaw) ? regionRaw : '';
      try {
        if (ch) {
          const r = await require('../../model-info').rowsFor(ch, { force, all, region });
          return sendJSON(res, 200, { channel: ch, rows: r.rows, error: r.error, region: region || undefined });
        }
        const r = await require('../../model-info').allRows({ force });
        return sendJSON(res, 200, { channel: '', rows: r.rows, errors: r.errors });
      } catch (e) {
        return sendJSON(res, 200, { channel: ch, rows: [], error: e.message });
      }
    },
  },
  {
    // 探针：批量确认一批模型 ID 上游是否接受
    method: 'POST',
    path: '/probe',
    handler: async ({ res, body }) => {
      const models = Array.isArray(body && body.models) ? body.models.map(String) : [];
      if (!models.length) return sendJSON(res, 400, { error: 'models 不能为空' });
      if (models.length > 20) return sendJSON(res, 400, { error: '一次最多探测 20 个模型' });

      const port = await discovery.discoverPort();
      if (!port) return sendJSON(res, 502, { error: '未找到上游，无法探测' });

      // 并发探测：串行等 20 个模型最坏是 20×15s=300s，而前端 axios 超时
      // 只有 30s，浏览器早断了而服务端还在发请求。分池并发把最坏压到约
      // 15s，同时不至于一次性打爆上游。
      const CONCURRENCY = 5;
      const results = new Array(models.length);
      let cursor = 0;
      async function worker() {
        while (cursor < models.length) {
          const i = cursor++;
          results[i] = await probeModel(port, models[i]);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, models.length) }, worker),
      );
      return sendJSON(res, 200, { upstream_port: port, results });
    },
  },
  {
    // 网关对外暴露的模型列表（直接问网关，确认改动已生效）
    method: 'GET',
    path: '/gateway-list',
    handler: async ({ res }) => {
      // 同 system.js：默认看 9080（稳定版），开发实例用
      // DUMATE_ADMIN_GATEWAY_PORT 指向 9082，避免读到稳定版的模型列表
      const port = parseInt(
        process.env.DUMATE_ADMIN_GATEWAY_PORT || process.env.DUMATE2API_PORT || '9080',
        10,
      );
      // 网关鉴权强制（2026-11-01）后 /v1/models 一律要求 key。管理端自己
      // 签发的 key 挑一把带上：优先**不限通道**的（绑了通道的 key 只能看到
      // 本通道的模型，「网关实际返回」就不再是全量视图）；都没有时退回第一把。
      let auth = process.env.DUMATE2API_KEY || '';
      let viaKey = 'DUMATE2API_KEY';
      if (!auth) {
        try {
          const keys = require('../../keys').list()
            .filter((k) => k.enabled !== false && k.plain);
          const pick = keys.find((k) => !k.channel) || keys[0];
          if (pick) { auth = pick.plain; viaKey = pick.name || `key-${pick.id}`; }
        } catch (e) { /* keys.json 读不到就裸发，由下面的状态码检查如实报错 */ }
      }
      const out = await new Promise((resolve) => {
        const req = http.request(
          // 超时放宽到 15s：本机在负载高时 /v1/models 实测出现过 1.7s 的响应，
          // 原先 4s 的窗口会偶发超时，界面就显示成「网关不可用」——而网关
          // 其实活着。宁可多等，也不要报一个假的故障。
          {
            host: '127.0.0.1', port, path: '/v1/models', method: 'GET', timeout: 15000,
            headers: auth ? { Authorization: `Bearer ${auth}` } : {},
          },
          (r) => {
            let data = '';
            r.setEncoding('utf8');
            r.on('data', (c) => { data += c; });
            r.on('end', () => {
              // **必须检查状态码**：网关鉴权拒绝时 body 是 {error:...}，
              // 不看状态码就会把它当模型列表 200 转给前端——表格永远
              // 「暂无数据」却看不出原因（实测踩过：强制鉴权上线后此表恒空）
              try {
                resolve({
                  ok: r.statusCode >= 200 && r.statusCode < 300,
                  status: r.statusCode,
                  data: JSON.parse(data),
                });
              } catch (e) { resolve({ ok: false, status: r.statusCode, error: 'invalid json' }); }
            });
          }
        );
        req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
        req.end();
      });
      if (!out.ok) {
        const detail = (out.data && (out.data.error || out.data.message)) || out.error || '';
        return sendJSON(res, 502, {
          error: `网关 ${port} /v1/models 返回 ${out.status || '无响应'}：${String(detail).slice(0, 120)}`,
        });
      }
      // 网关按 key 的通道绑定过滤模型列表（2026-11-01 起），列表是**这把 key
      // 的视角**而不是全量——如实带给前端展示，不标会被读成「模型丢了」
      const body = { ...out.data, via_key: viaKey };
      return sendJSON(res, 200, body);
    },
  },
];

module.exports = { routes, probeModel };
