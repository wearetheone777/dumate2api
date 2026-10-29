// dumate2api - Main server: OpenAI pass-through + Anthropic translation
const http = require('http');
const { discoverPort, verifyPort } = require('./discovery');
const { mapModel, anthropicToOpenAI, openAIToAnthropic, mapFinishReason } = require('./anthropic');
const { googleToOpenAI, openAIToGoogle, translateStreamToGoogle } = require('./google');
const { responsesToOpenAI, openAIToResponse, translateStreamToResponses } = require('./responses');
const { resolveMaxTokens, resolveQwenMaxTokens, resolveTraeworkMaxTokens, resolveQoderMaxTokens } = require('./budget');
const webFallback = require('./fallback-web');

// 按通道选用预算策略。收敛在这里而不是在四个调用点各写一遍 if——
// 分开写必然漂移（曾经就漏了千问，导致小预算直接截断正文）。
// 千问与 TRAE 的下限都远低于搭子（16384 vs 32768），因为它们的
// reasoning 峰值比搭子小一个量级。
function resolveBudget(target, requested) {
  const kind = target && target.budgetKind;
  if (kind === 'qwenwork') return resolveQwenMaxTokens(requested);
  if (kind === 'traework') return resolveTraeworkMaxTokens(requested);
  if (kind === 'qoder') return resolveQoderMaxTokens(requested);
  return resolveMaxTokens(requested);
}
const reqlog = require('./reqlog');
// 首字标记归 reqlog 统一实现：三个协议翻译器（Responses / Anthropic / Google）
// 也在 reqlog 之外调用它，两处各写一份必然漂移。
const markFirstToken = reqlog.markFirstToken;
const pointsCursor = require('./points-cursor');
const cors = require('./cors');
const modelmap = require('./modelmap');
const keysvc = require('./keys');
const router = require('./upstream-router');
// 热配置（F5）：/v1/models 与 /v1beta/models 输出侧的 hiddenModels 过滤
const livecfg = require('./livecfg');
// 启动接线（集成阶段）：池状态机恢复 / 热配置 / 出站代理 / 计量挂钩探活。
// 保活排程不在这里启动——它由管理端进程经 task-scheduler 持有（见 boot.js）。
const boot = require('./boot');

const PROXY_PORT = parseInt(process.env.DUMATE2API_PORT || '9080', 10);
const PROXY_HOST = process.env.DUMATE2API_HOST || '127.0.0.1';
// 审计修复（P0-1）：DUMATE2API_KEY 此前定义后从未被使用——管理员设了这个
// 变量也不会有任何强制，是个配置陷阱。现在它与登记 key 体系并联：
//   - DUMATE_REQUIRE_KEY=1          → 校验管理端登记的 key（原开关，语义不变）
//   - 设置了 DUMATE2API_KEY（非空）  → 同样强制鉴权，命中该 env 密钥（或任一
//     登记 key）才放行。两个开关任意一个打开即启用鉴权。
const ENV_API_KEY = String(process.env.DUMATE2API_KEY || '').trim();
const REQUIRE_KEY = process.env.DUMATE_REQUIRE_KEY === '1' || !!ENV_API_KEY;

let upstreamPort = null;
let upstreamManaged = false;
let qwenworkUp = null; // 千问办公通道端口；null = 本次启动未就绪
let lastDiscoveryTime = 0;
const DISCOVERY_INTERVAL = 30000; // re-discover every 30s if port changes

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/**
 * 事件循环卡顿监控。
 *
 * **为什么需要**：网关里所有重活都是**同步**的（签名编码、翻译层解析），
 * 一段同步代码卡住就等于整个进程「假死」——`/health` 不响应、其他通道的
 * 请求全部排队，而进程 CPU 跑满却不崩、**一行日志都不打**。客户端表现为
 * 「一直转圈、没有任何输出」。2026-10-03 的 `cosy.encode` 就是这种
 * （64MB 要 15s、128MB OOM；靠 `process._debugProcess` + inspector
 * `Debugger.pause` 抓栈才定位到）。
 *
 * 这个探针用 setInterval 测「实际间隔 - 期望间隔」，卡顿超过阈值就打一条
 * 带**时间戳与时长**的日志。它不解决卡顿，但把「静默假死」变成「日志里
 * 有明确时间点与严重程度」——事后排查至少知道是哪一秒、卡了多久。
 *
 * 阈值取 2000ms：正常 GC 停顿与首个大请求的编码（几百 ms）都不报，
 * 只有真正的秒级卡顿才落日志。`DUMATE_LAG_MONITOR=0` 关闭。
 */
function startLagMonitor() {
  if (process.env.DUMATE_LAG_MONITOR === '0') return;
  const EXPECTED = 1000;
  const WARN_MS = parseInt(process.env.DUMATE_LAG_WARN_MS || '2000', 10);
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - EXPECTED;
    last = now;
    if (lag >= WARN_MS) {
      log(`⚠ 事件循环卡顿 ${lag}ms（同步代码阻塞，期间 /health 与其他通道请求都不响应）`);
    }
  }, EXPECTED);
  if (timer.unref) timer.unref(); // 不因它而阻止进程退出
}

/**
 * 流式 SSE 的安全写入小工具（Anthropic 翻译器用；Responses 有等价的 send 守卫）。
 *
 * **存在的理由**：客户端中途断连、或上游出错后收尾逻辑仍想补发事件时，
 * `res.write()` 会抛 ERR_STREAM_WRITE_AFTER_END / ERR_STREAM_DESTROYED。
 * 流式 res 的 'error' 事件若没有监听者就是**未捕获异常，直接把网关进程打挂**
 * （9082 整个退出，不是单个请求失败）——这是踩过的坑，见 CLAUDE.md。
 * 所以所有写入都必须先查 `writableEnded/destroyed`。
 */
function makeSSEWriter(res) {
  const head = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...(res._cors || {}),
  };
  const flushHead = () => {
    if (res.headersSent) return;
    try { res.writeHead(200, head); } catch (e) { /* 已结束 */ }
  };
  const write = (chunk) => {
    if (res.writableEnded || res.destroyed) return false;
    flushHead();
    try { res.write(chunk); return true; } catch (e) { return false; }
  };
  return {
    flushHead,
    write,
    event: (type, payload) => write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`),
    data: (payload) => write(`data: ${JSON.stringify(payload)}\n\n`),
    end: () => { try { if (!res.writableEnded) res.end(); } catch (e) { /* 已结束 */ } },
  };
}

async function ensureUpstream() {
  const now = Date.now();
  if (upstreamPort && now - lastDiscoveryTime < DISCOVERY_INTERVAL) {
    return upstreamPort;
  }
  const port = await discoverPort();
  if (port) {
    if (port !== upstreamPort) {
      log(`Discovered DuMate main-server on port ${port}`);
    }
    upstreamPort = port;
    lastDiscoveryTime = now;
    return port;
  }
  // If we have a cached port, keep using it
  if (upstreamPort) return upstreamPort;
  throw new Error('DuMate main-server not found. Is DuMate running?');
}

/**
 * 直连通道（千问办公）的统一入口。
 *
 * 它不是「另一个本地 HTTP 上游」——没有端口，请求由 src/qwenwork/ 自己发到
 * gateway.qwenwork.cn。所以这里不能直接复用 forwardToUpstream。
 *
 * 流式路径刻意复用现有的三个翻译器（Anthropic / Responses / Google）：它们
 * 只需要一个会吐 `data:` 行的 EventEmitter，所以这里用 PassThrough 把
 * provider 的回调转成等价的流，而不是把三套 SSE 状态机各重写一遍。
 */
async function handleDirectChannel(req, res, payload, route, ctx) {
  const { startedAt, info, kind } = ctx;
  // 按通道选 provider：三条直连通道各有各的凭证与签名方式
  //   qwenwork → 官方 wasm 封装请求体（依赖客户端安装的 wasm）
  //   traework → 自持凭证，直接调上游
  //   qoder    → 纯本地签名（cosy.js），连 wasm 都不需要
  const provider = route.channel === 'traework'
    ? require('./traework')
    : route.channel === 'qoder'
      ? require('./qoder')
      : require('./qwenwork');
  const wantStream = !!payload.stream;

  // 请求 id 在这里就定下来：埋点与积分归因两边都要用同一个值才能配对。
  // 归因要等 1.5s 结算，时间戳对不上；靠时间猜会让同秒内的两条请求互相串账。
  if (!req._reqId) req._reqId = reqlog.newReqId();
  const reqId = req._reqId;

  // provider 在发请求前回调「这次实际用了哪个账号」，由它写进埋点。
  // 多账号轮询下（TRAE）只有 provider 知道选中的是哪一个——
  // 在埋点处猜一个必然会在轮询时记错。
  const onAccount = (name) => { if (name) req._upstreamAccount = String(name); };
  // provider 解析出**实际发给上游的模型 key** 后回调（目前只有 Qoder 报）。
  // `route.model` 只是去掉前缀的调用方写法，显示名有没有解析成功看不出来。
  const onModel = (name) => { if (name) req._mappedModel = String(name); };

  try {
    if (!wantStream) {
      // traework 的 send 第二参是 onChunk；不传即为非流式聚合
      const result = await provider.send(payload, undefined, { reqId, onAccount, onModel });
      const out = kind === 'openai' ? result : result;
      if (kind === 'anthropic') {
        const anth = openAIToAnthropic(out, payload.model);
        logRequest(req, res, startedAt, info, 200, anth.usage || null);
        return sendJSON(res, 200, anth);
      }
      if (kind === 'google') {
        logRequest(req, res, startedAt, info, 200, out.usage || null);
        return sendJSON(res, 200, openAIToGoogle(out, payload.model));
      }
      // responses 路径：provider 返回的是 OpenAI chat 形状，
      // 必须再翻成 Responses 对象，否则 Codex 拿到 chat.completion 会解析失败。
      // （漏了这条分支时表现为「返回体字段全不认识」）
      if (kind === 'responses') {
        logRequest(req, res, startedAt, info, 200, out.usage || null);
        return sendJSON(res, 200, openAIToResponse(out, payload.model));
      }
      const usage = out.usage || {};
      logRequest(req, res, startedAt, info, 200, {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        total: usage.total_tokens || 0,
      });
      return sendJSON(res, 200, out);
    }

    // ---- 流式：把 provider 回调桥接成等价的上游响应流 ----
    //
    // 三个翻译器的契约是「喂进来一个会吐 `data:` 行的上游响应，往 res 写」。
    // 所以这里只造一个 PassThrough 冒充上游响应，**res 原样传给翻译器**——
    // 它是真的 http.ServerResponse，writeHead/write/end 全都齐备，
    // 比手搓一个鸭子类型的 sink 稳得多（翻译器内部还会挂 'close' 之类的监听）。
    // 这样三套 SSE 状态机（Anthropic 的 block 顺序、Responses 的事件序列、
    // Google 的分片）都能原样复用，不必为直连通道各重写一遍。
    const { PassThrough } = require('stream');
    const shim = new PassThrough();

    // 流式累计正文，供结束时的埋点取 token（OpenAI 路径原本没有任何
    // 落埋点的地方——千问的流式请求因此从不出现在请求日志里）。
    // 只保留尾部窗口：usage 只在最后一两个块里，而流可以活很久。
    let seen = '';
    const TAIL = 32768;
    let logged = false;

    const done = (usage, status, extra) => {
      if (logged) return;
      logged = true;
      // 流式失败时翻译器会**同步**在它的 error 处理里 finish(502)：那次 done
      // 先到并把 logged 置位，外层再传 extra 就永远被丢掉（logRequest 按
      // res._logged 去重）。所以错误先挂到 req 上，让**第一次** done 就能带上。
      let merged = extra;
      if (req._streamError && !(extra && extra.error)) merged = { ...(extra || {}), error: req._streamError };
      let finalStatus = status || 200;
      // 翻译器的 error 路径硬编码 502；真实状态码（如 402）要还原回来，
      // 否则埋点里所有直连通道的失败都是 502，看不出是额度还是上游挂了。
      if (req._streamError && req._streamErrorStatus && finalStatus === 502) finalStatus = req._streamErrorStatus;
      logRequest(req, res, startedAt, info, finalStatus, usage || null, merged);
    };

    // OpenAI 路径专用的延迟响应头。翻译器分支各自会 writeHead，只有
    // OpenAI 分支没有翻译器，需要我们自己发头——且**必须推迟到第一帧**：
    // 上游错误（如 `403 Model is not available`）是在流里才暴露的，若一进来
    // 就 writeHead(200)，等发现是错误时头已发出，改不成 4xx，客户端只能看到
    // 一个空的 200 —— 静默失败，最难排查的那种。
    let writeSSEHead = null;
    // 是否有翻译器负责收尾。翻译器分支失败时会自己发终结事件；
    // OpenAI 分支没有翻译器，失败时只能自己关流（否则客户端永久挂起）。
    let translated = false;

    if (kind === 'anthropic') {
      translated = true;
      translateStreamToAnthropic(shim, res, payload.model, done);
    } else if (kind === 'responses') {
      translated = true;
      translateStreamToResponses(shim, res, payload.model, done);
    } else if (kind === 'google') {
      translated = true;
      translateStreamToGoogle(shim, res, payload.model, done);
    } else {
      // OpenAI 路径：无翻译，把 shim 直接接到 res。
      // pipe 不能漏——翻译器分支是「翻译器读 shim 写 res」，OpenAI 分支没有
      // 翻译器，不 pipe 就无人转发，客户端拿到 0 字节且流永不结束。
      writeSSEHead = () => {
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...(res._cors || {}),
        });
      };
      shim.once('data', writeSSEHead);
      shim.pipe(res);
    }

    // 流式等待期的 SSE 保活帧（2026-10-30，对齐官方客户端形态——qoder2api-hub
    // 逆向：官方在上游沉默期间按固定节奏发注释帧）。上游首字实测可长达
    // 40~70 秒（高思考档位 + 长上下文），期间 Codex / Claude Code 或中间代理
    // 会因空闲超时断连。每 5s 写一个 `: ping`——SSE 规范里冒号行是注释（合法
    // no-op），三套翻译器与 OpenAI 直通都按 `data: ` 前缀过滤、天然忽略。
    // OpenAI 分支的头必须推迟到真实首帧（上游错误在流里才暴露，要保住回
    // 4xx 的能力），所以头发出前不写 ping。
    let pingTimer = null;
    if (wantStream) {
      pingTimer = setInterval(() => {
        if (shim.writableEnded || shim.destroyed || res.writableEnded || res.destroyed) {
          clearInterval(pingTimer);
          return;
        }
        if (!translated && !res.headersSent) return;
        try { shim.write(': ping\n\n'); } catch (e) { clearInterval(pingTimer); }
      }, 5000);
    }

    (async () => {
      try {
        await provider.send(payload, (inner) => {
          if (inner === '[DONE]') {
            // 按 OpenAI 规范补发结束标记再关流。千问上游本身不发
            // `data: [DONE]`（它用 event:finish 收尾），但客户端按规范等这个
            // 标记；只靠流关闭会让部分客户端（如 Codex）认为响应未完成。
            if (pingTimer) clearInterval(pingTimer);
            writeSSEHead && writeSSEHead();
            shim.write('data: [DONE]\n\n');
            shim.end();
            return;
          }
          // 首帧到达，保活帧使命结束（间隔里的最后一帧是无害的 no-op）
          if (pingTimer) clearInterval(pingTimer);
          // 首字时刻：直连通道的 first_token_ms 全靠这里标，
          // 不标则请求日志里千问的「首字延迟」永远是空
          markFirstToken(res);
          // OpenAI 路径没有翻译器，得在这里自己扫 usage。
          // **必须补上 `data: ` 前缀**：inner 是解信封后的裸 JSON，
          // 而 usageFromSSE 按 `data:` 行扫描——不补前缀就永远扫不到，
          // 流式请求的 token 会一直记成 0。
          seen += `data: ${inner}\n`;
          if (seen.length > TAIL) seen = seen.slice(-TAIL);
          shim.write(`data: ${inner}\n\n`);
        }, { reqId, onAccount, onModel });
        // traework 的 provider 回调不发 [DONE]（事件流用 event:done 收尾，
        // 已在 readStream 里吃掉），所以这里补一个再关流。
        // **顺序关键**：先补 [DONE]、再 end——直接 end 会让翻译器在
        // 没有收到任何帧的情况下看到流结束，报 upstream stream error。
        if (route.channel === 'traework') {
          writeSSEHead && writeSSEHead();
          shim.write('data: [DONE]\n\n');
        }
        shim.end();
        // OpenAI 路径的收尾埋点。翻译器分支各自在 done 里记，
        // 只有这里没有——不补上，千问的流式请求就不进请求日志。
        if (kind === 'openai') done(reqlog.usageFromSSE(seen), 200);
      } catch (e) {
        // 顺序很关键：**先 unpipe 再 end**。
        if (pingTimer) clearInterval(pingTimer);
        // shim 已经 pipe 到 res，若直接 shim.end()，pipe 会把 res 一并结束
        // （发成 200 空响应），等想回 4xx JSON 时头已发出、改不回来了。
        try { shim.unpipe(res); } catch (e2) { /* 未 pipe */ }
        const status = e.statusCode || 502;
        // 先挂到 req 上：翻译器会在下面的 emit('error') 里**同步**收尾并调用
        // done，那时再传 extra 已经晚了（见 done 的注释）。
        req._streamError = e.message;
        req._streamErrorStatus = status;
        // 已经吐过帧了：不能改状态码，也不能直接 res.end()——那会让客户端
        // 收到一个**没有终结事件的流**。Codex 对此报
        // `stream disconnected before completion: stream closed before response.completed`
        // （用户看到「思考很久然后失败」），且因为没收到任何 item 而
        // 记成 0 token 的一轮空转。
        //
        // 正确做法是让**翻译器自己**发它的失败终结事件（Responses 的
        // response.failed、Anthropic 的 message_delta+message_stop），
        // 再把错误透传给翻译器走它的 error 路径。
        //
        // **不能只 emit('error') 就完事**：若翻译器没有 'error' 监听者，
        // Node 会抛未捕获异常打挂进程。所以先补一个空监听兜底，
        // 再 emit——有监听者时它照常收尾，没有时至少不崩。
        if (!res.headersSent) {
          // 首帧前就失败：回正经的 4xx JSON，客户端能看懂
          try { shim.end(); } catch (e2) { /* 已结束 */ }
          // **extra 必须交给 done**：done 内部才调 logRequest，而 logRequest
          // 按 res._logged 去重——先 done 再单独调一次带 error 的 logRequest
          // 会被静默丢掉，于是所有直连通道的错误在埋点里都是 err 为空。
          done(null, status, { error: e.message });
          try {
            sendJSON(res, status, { error: { message: e.message, type: 'api_error' } });
          } catch (e2) { /* 已结束 */ }
          return;
        }
        if (translated) {
          // 已经吐过帧、且有翻译器：把错误交给翻译器收尾，让它发**对应的
          // 失败终结事件**（Responses 的 response.failed、Anthropic 的
          // message_delta+message_stop、Google 的裸关流）。
          // **不能只 emit('error') 就完事**：若翻译器没有 'error' 监听者，
          // Node 会抛未捕获异常打挂进程。先补空监听兜底再 emit。
          try {
            if (shim.listenerCount('error') === 0) shim.on('error', () => { /* 兜底：无监听者时不崩 */ });
            shim.emit('error', e);
          } catch (e2) {
            try { shim.end(); } catch (e3) { /* 已结束 */ }
          }
        } else {
          // OpenAI 路径（无翻译器）：直接把错误帧按 OpenAI 规范写进流再关。
          // 头已发出改不成状态码，但客户端能从这个 error 帧知道失败原因；
          // 不写的话就是裸关闭，客户端只能报「响应未完成」。
          try {
            if (!res.writableEnded && !res.destroyed) {
              res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'api_error', code: status } })}\n\n`);
              res.write('data: [DONE]\n\n');
            }
          } catch (e2) { /* 写失败不打断收尾 */ }
          try { shim.end(); } catch (e2) { /* 已结束 */ }
          try { if (!res.writableEnded) res.end(); } catch (e2) { /* 已结束 */ }
        }
        // 同上一分支：错误必须交给 done，单独再调 logRequest 会被去重丢掉
        done(null, status, { error: e.message });
      }
    })();
  } catch (e) {
    const status = e.statusCode || 502;
    logRequest(req, res, startedAt, info, status, null, { error: e.message });
    // 429 必须带 Retry-After：上游限流时**自己说了要等多久**
    // （retryAfterSeconds / waitTime，见 upstream-errors.throttleRetryMs）。
    // 不带给客户端，它就只能盲退避——退不够会再撞一次限流（加深冷却），
    // 退过头则白白拉长用户等待。Codex / Claude Code 都认这个头。
    const ra = Number(e.retryAfterMs);
    const extra = status === 429 && ra > 0
      ? { 'Retry-After': String(Math.ceil(ra / 1000)) }
      : null;
    return sendJSON(res, status, { error: { message: e.message, type: 'api_error' } }, extra);
  }
}

// Forward request to DuMate upstream
//
// callback 只允许被调用一次：上游 socket 出错（含客户端主动 destroy）时
// Node 会同时触发 error 与后续事件，重复调用会让响应被写两次、
// 客户端永久挂在半开的流上（表现为「输出突然停止」）。
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.DUMATE_UPSTREAM_TIMEOUT_MS || '600000', 10);

function forwardToUpstream(portOrTarget, path, method, headers, body, callback) {
  let settled = false;
  const once = (arg) => { if (!settled) { settled = true; callback(arg); } };

  // 两种调用形态：
  //   forwardToUpstream(8980, ...)                 ← 老签名，等价于搭子 target
  //   forwardToUpstream({host,port,basePath,...})  ← 路由后的 target
  // 保留老签名是因为 stable/ 快照与外部调用点都按数字端口写，改签名会波及
  // 到不该动的代码。归一化放在这里，调用方不用关心。
  const t = (typeof portOrTarget === 'object' && portOrTarget !== null)
    ? portOrTarget
    : { host: '127.0.0.1', port: portOrTarget, basePath: '/api/qianfanproxy/v1', authHeader: 'Bearer nokey' };
  const basePath = t.basePath || '/api/qianfanproxy/v1';

  const options = {
    host: t.host || '127.0.0.1',
    port: t.port,
    path: `${basePath}${path}`,
    method: method,
    timeout: UPSTREAM_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      // 千问通道要带它自己那把 Key；搭子是固定的 Bearer nokey。
      // authHeader 为 null 说明 key 文件缺失，此时不塞 Authorization，
      // 让上游回 401 —— 比在这里伪造一个空 Bearer 更容易定位。
      ...(t.authHeader ? { 'Authorization': t.authHeader } : {}),
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
    }
  };

  const req = http.request(options, (upstreamRes) => {
    // 上游响应中途断开时，把中断交给下游 handler 收尾（各 handler 都监听了
    // 'error' 或 'end'）。这里不能吞掉，否则客户端会挂在半开的流上。
    upstreamRes.on('error', () => {});
    once(upstreamRes);
  });

  req.on('error', (err) => {
    once({
      fakeResponse: true,
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      write: () => {},
      end: () => {}
    });
  });
  req.on('timeout', () => {
    req.destroy(new Error('upstream timeout after ' + UPSTREAM_TIMEOUT_MS + 'ms'));
  });
  if (body) req.write(body);
  req.end();
  return req;
}

/**
 * 与 forwardToUpstream 同签名，但桌面链路不可用时自动回落到网页凭证池。
 *
 * 只在**搭子通道**用（调用点自己判断 target.id）。
 *
 * **网页链路不是「缩水版」。** 早先这里写着「桌面链路独有 responses /
 * count_tokens / 前缀分流」，那是错的：回落把网页池包成伪上游响应，四个协议
 * 处理器原样复用，`responses`、`count_tokens`、前缀分流在网页链路上全部可用
 * （2026-10-14 实测）。真正缺 `responses` 的是 9084 那个独立网关
 * （`web-gateway.js`），两者别混为一谈。
 *
 * 凭证来源默认就是网页池（`router.dumateSource()`），桌面链路要显式
 * `DUMATE_DUMATE_SOURCE=auto` 才参与；本函数的回落分支于是成了那条路上的兜底。
 *
 * 回落时机严格限定为「还没交给回调」：后端连不上（fakeResponse）或回了
 * 4xx/5xx（凭证过期时后端以错误码回应）。一旦回调拿到响应开始写下游，
 * 就不再换链路——半截响应 + 换链路重来会让客户端收到两段拼接的内容。
 */
function forwardWithFallback(portOrTarget, path, method, headers, body, clientReq, callback) {
  const t = (typeof portOrTarget === 'object' && portOrTarget !== null)
    ? portOrTarget : null;
  const isDumate = !t || t.id === 'dumate';

  const useWebFallback = (parsedBody) => {
    const { emitter, done, ready, flush } = webFallback.callWebPool(parsedBody, {
      // 账号在池子选中时就回填（早于流结束），供埋点记录「实际用了哪个」。
      // 多账号轮询下只有池子知道，在埋点处猜必然是错的。
      onAccount: (name) => { if (name && clientReq) clientReq._upstreamAccount = String(name); },
    });
    // 标记这次走了回落——埋点与界面据此区分「用的是哪套凭证」
    if (clientReq) clientReq._credentialSource = 'web';
    // 状态码定下来再交出去：调用方拿到就 writeHead，
    // 晚一步失败就会被翻成「HTTP 200 + 空响应」
    ready.then(() => { callback(emitter); flush(); });
    return done;
  };

  const tryWebFallback = (why) => {
    if (!isDumate || !webFallback.available()) return false;
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return false; }
    log(why === 'forced'
      ? '搭子凭证来源：网页池（桌面链路不参与），直接走网页凭证'
      : '桌面链路不可用，回落到网页凭证池');
    useWebFallback(parsed);
    return true;
  };

  // 只用网页凭证（**默认**）：跳过整个桌面链路（含端口探测与 PowerShell 查询）。
  // 池子可不可用由路由层（router.availability）先判，那里会给出明确原因。
  if (isDumate && router.dumateSource() === 'web') {
    if (tryWebFallback('forced')) return null;
    // 竞态：availability 通过之后池子变空。如实报 502，**不静默退回桌面链路**
    // ——用户明确要求走 web，偷偷换凭证来源等于瞒着他。
    callback({ fakeResponse: true, statusCode: 502, headers: {}, write() {}, end() {} });
    return null;
  }

  // 端口解析也要纳入回落范围。桌面凭证失效时 dumate-main-server.exe 会拒绝
  // 启动或直接退出，ensureUpstream() 于是抛错——这条分支让那种情况也能走到
  // 回落，而不是在调用点先抛错。
  //
  // **注意：这条分支走不到。** 网页来源在上面已经直接返回；桌面来源
  // （DUMATE_DUMATE_SOURCE=auto）下，upstream-router 给 dumate 的 defaultPort
  // 是 8980 且 portOf() 保证返回有效数字，所以 t.port 恒有值。
  // 真实的失败路径是下面的 startForward(t)：连一次本地 8980 →
  // ECONNREFUSED（回环连接，毫秒级）→ 回调里 tryWebFallback()。
  // 也就是说「客户端没装」**不会**给每个请求带来探测开销，不必给失败结果加
  // 缓存——2026-10-14 实测确认（打桩 discovery 计数：客户端缺失时连发 5 个
  // 请求，discoverPort 一次都没被调用）。真正的探测开销只在**启动时**那一次
  // discoverPort（要跑 PowerShell 查询，实测约 3 秒），而它只在 auto 模式下跑。
  if (isDumate && t && !t.port) {
    ensureUpstream().then(
      (port) => { t.port = port; startForward(t); },
      () => { if (!tryWebFallback()) callback({ fakeResponse: true, statusCode: 502, headers: {}, write() {}, end() {} }); },
    );
    return null;
  }

  return startForward(portOrTarget);

  function startForward(targetOrPort) {
    return forwardToUpstream(targetOrPort, path, method, headers, body, (upstreamRes) => {
      // 后端在跑但连不上（进程刚挂 / 端口被占），或它回了错误码（凭证过期）
      const dead = upstreamRes.fakeResponse;
      const badStatus = !dead && (!upstreamRes.statusCode || upstreamRes.statusCode >= 400);
      if (dead || badStatus) {
        if (tryWebFallback()) {
          if (!dead && upstreamRes.resume) upstreamRes.resume();  // 把失败的上游读干净
          return;
        }
      }
      callback(upstreamRes);
    });
  }
}

// 请求体上限（审计 P1-1a）：网关是匿名可达的一侧，readBody 不设限等于让
// 一次 POST 把内存吃满、再被 JSON.parse 二次放大。默认 32MB——聊天请求带
// base64 图片也有富余。DUMATE_MAX_BODY_MB 可调。
const MAX_BODY_BYTES = Math.max(1, parseInt(process.env.DUMATE_MAX_BODY_MB || '32', 10)) * 1024 * 1024;

function readBody(req) {
  // 超限标记：鉴权预读阶段超限时已经把流读干净，这里直接短路，
  // 不再尝试二次消费
  if (req._bodyTooLarge) return Promise.resolve(null);
  // 鉴权阶段可能已经为模型白名单预读过请求体；流只能消费一次，
  // 直接返回缓存，否则 handler 拿到空串
  if (typeof req._rawBody === 'string') return Promise.resolve(req._rawBody);
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req._bodyTooLarge = true;
        chunks.length = 0;
        // 继续把剩余数据读干净，连接才能正常收尾；handler 统一回 413
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(req._bodyTooLarge ? null : Buffer.concat(chunks).toString('utf8')));
  });
}

// 请求体超限的统一出口。各端点正常错误形状不同，但 413 极少触发，
// 统一 OpenAI 形状即可（客户端只看状态码）。
function sendBodyTooLarge(res) {
  return sendJSON(res, 413, { error: { message: 'Request body too large', type: 'invalid_request_error' } });
}

// 非流式上游响应的累积上限（审计 P1-1b）：上游半信任，流量不可控，
// 无限 `data += c` 等于把上游（或中间人）的输出全部吃进内存。
// 默认 64MB，DUMATE_MAX_UPSTREAM_MB 可调。超限后停止累积、继续读干净，
// 由调用方回 502。
const MAX_UPSTREAM_BYTES = Math.max(1, parseInt(process.env.DUMATE_MAX_UPSTREAM_MB || '64', 10)) * 1024 * 1024;

function sendUpstreamTooLarge(res) {
  return sendJSON(res, 502, { error: { message: 'Upstream response too large', type: 'api_error' } });
}

// 收全上游响应体后回调一次。end / aborted / error 三路都以同一入口收尾，
// 避免上游中途断开时下游永远等不到回调（「输出停止」类故障的根因之一）。
// 超限时 onComplete 收到 null（不是超长字符串）——调用方按「上游响应异常」处理。
function collectAndFinish(upstreamRes, onComplete, maxBytes = MAX_UPSTREAM_BYTES) {
  let data = '';
  let over = false;
  let done = false;
  const finish = () => { if (!done) { done = true; onComplete(over ? null : data); } };
  upstreamRes.on('data', (c) => {
    if (over) return;
    data += c;
    if (data.length > maxBytes) {
      over = true;
      data = '';
    }
  });
  upstreamRes.on('end', finish);
  upstreamRes.on('aborted', finish);
  upstreamRes.on('error', finish);
}

function sendJSON(res, statusCode, data, extraHeaders) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...(res._cors || {}),
    ...(extraHeaders || {}),
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// 埋点辅助：把一次请求的结局写进 requests.jsonl。
// 用 res 上的标记保证同一次请求只记一行——流式路径会同时挂 end/error/aborted
// 三个收尾点，不挡一下就会记出重复条目。
function logRequest(req, res, startedAt, info, status, usage, extra) {
  if (res._logged) return;
  res._logged = true;
  const u = usage || { input: 0, output: 0, total: 0 };
  const h = req.headers || {};
  const ts = Date.now();
  // req_id 优先取请求上已生成的（千问直连通道要把它传给积分归因，
  // 两边必须用同一个 id 才能配对），没有则现生成一个
  const reqId = req._reqId || reqlog.newReqId();
  req._reqId = reqId;
  reqlog.record({
    ts,
    req_id: reqId,
    ms: Date.now() - startedAt,
    // 首字延迟：从收到请求到上游吐出第一个字节。总耗时无法反映这一点——
    // 一个 30 秒的请求可能 0.5 秒就出字、也可能 20 秒才出字，
    // 后者才是用户感知到的「卡」。
    first_token_ms: res._firstTokenAt ? res._firstTokenAt - startedAt : null,
    path: req._logPath || '',
    // 通道：区分请求走的是搭子还是千问办公。不加这个字段，两侧的首字延迟
    // 会混在同一个均值里（千问首帧实测 6.7s，搭子不是），且无法归因。
    channel: req._channel || 'dumate',
    // 这条请求实际用的是哪套凭证。搭子有两条链路（桌面 / 网页回落），
    // 不记这个的话，排查「为什么这次走的账号不是桌面那个」时无从判断。
    // 只有真的回落了才有值，桌面链路不带这个字段。
    credential_source: req._credentialSource || '',
    model: info.model || '',
    // 映射后的模型：客户端发来的名字经 modelmap 转换后实际打给上游的值。
    // 排查「为什么 glm-5 变成了 model-text」这类问题时要看它。
    mapped_model: req._mappedModel || '',
    stream: !!info.stream,
    messages: info.messages || 0,
    status: status || 0,
    input_tokens: u.input || 0,
    output_tokens: u.output || 0,
    total_tokens: u.total || 0,
    ip: reqlog.clientIP(req),
    // 客户端标识：区分 Codex / Claude Code / 其它调用方，排查兼容问题时最先看这个
    ua: String(h['user-agent'] || '').slice(0, 200),
    // 记 id 而不是名字：名字可改，改名后按名字聚合的历史会全部对不上号。
    // 名称另存一份，便于日志直接可读。
    key_id: (req._apiKey && req._apiKey.id) || 0,
    key: (req._apiKey && req._apiKey.name) || '',
    // 这条请求实际用了哪个上游账号。**权威来源是 provider 上报的**
    // （req._upstreamAccount，多账号轮询下「实际用的那个」只有它知道）；
    // provider 没报时按通道读当前凭证兜底。都没有就留空——
    // 界面显示「—」，而不是编一个名字。
    account: req._upstreamAccount || require('./upstream-account').fallback(req._channel || 'dumate'),
    ...(extra || {}),
  });

  // 余额游标：请求结束后记一次余额，与上一次的差值就是这条请求的实际扣费。
  // 上游账单归因不可靠（实测同一请求时间窗内有 1~3 条候选，无法唯一对应），
  // 所以改用实测余额差。不 await——采集在响应发出后进行，不占请求延迟。
  //
  // **只对搭子通道记**：这条游标读的是搭子账号的余额（桌面 8980 或网页凭证），
  // 直连通道（千问 / TRAE）的账在各自的池子里。早期无条件记录，导致
  // 搭子余额的差值被贴到直连通道的日志行上——界面上表现为 TRAE 请求
  // 显示 +1099.19 这种既不是它消耗、也无法解释的数字。
  const ch = req._channel || 'dumate';
  // 账号取自**权威来源**：`req._upstreamAccount` 由通道在选中账号时回填
  // （网页池多账号轮询下只有它知道实际用了哪个），`extra.account` 是翻译器
  // 回调带回来的，两条都要认。
  //
  // 这里曾经只读 `extra.account`，而网页回落只写 `req._upstreamAccount`，
  // 于是每条网页请求都拿空账号去走 `balanceDesktop()`：白跑一次 PowerShell
  // 探测（实测 1.3~2s），且游标一条都落不下来——`points_delta` 在全部
  // `dumate/web` 行上都是空的。别改回去。
  const cursorAccount = req._upstreamAccount || (extra && extra.account) || '';
  if (ch === 'dumate' && status && status < 500
      && (u.input || u.output || cursorAccount)) {
    pointsCursor.capture(ts, cursorAccount);
  }
}

// ==================== OpenAI Compatible Endpoints ====================

async function handleOpenAIModels(req, res) {
  // 条目来自 modelmap（可经管理端编辑），不再硬编码：
  // 之前这里的列表与 anthropic.js 的 MODEL_MAP 各写一份，会各自漂移。
  const cfg = modelmap.load();
  const created = Math.floor(Date.now() / 1000);
  const upstream = new Set(cfg.upstream_models);
  let data = cfg.exposed.map((id) => ({
    id,
    object: 'model',
    created,
    // 区分「上游直接认识」与「靠别名转换」——后者换名字也能用，
    // 但前者才是上游真实模型，界面与客户端据此判断
    owned_by: upstream.has(id) ? 'dumate' : 'dumate-proxy',
    // 可读名来自 modelmap.displayName：上游没有模型列表接口，这几个名字是
    // **本地标注**（`model-text` → 文本模型），不是百度下发的元信息。
    // 别名（claude-* / gpt-*）没有标注，原样返回。
    // 带上 name 是为了与其它通道形状一致——cc-switch 读 `name` 显示模型名。
    name: modelmap.displayName(id),
  }));

  // 千问办公的模型带 qwen/ 前缀列出来，否则客户端无从发现这个通道
  // （它们不在 modelmap 里——那套别名是搭子专用的）。
  // 列不出来时静默跳过：通道不可用不该让整个 /v1/models 失败。
  // **带 name**：cc-switch 解析模型列表读 `name` 字段，只给 {id} 只能显示内部 key。
  // 千问上游的模型列表接口是空的（回落到静态表 pro/flash），**没有显示名**——
  // 所以 name 就用 key 本身，不编一个上游没给的名字。
  if ((process.env.DUMATE_QWENWORK_AUTOSTART || 'auto') !== 'off') {
    try {
      const qw = require('./qwenwork');
      const models = await qw.listModels();
      for (const m of router.exposedFor('qwenwork', models)) {
        data.push({ id: m, object: 'model', created, owned_by: 'qwenwork', name: m.slice('qwen/'.length) });
      }
    } catch (e) { /* 通道不可用，不列 */ }
  }

  // TRAE Work 同理：模型名带 traework/ 前缀。凭证是我们自持的，
  // 没有账号时 listModels 仍返回静态表，但通道不可用就不列。
  // **带 name 与上下文**：TRAE 的上游模型表有完整元信息（display_name / 上下文），
  // 客户端据此显示真实模型名而不是内部 key。
  if ((process.env.DUMATE_TRAEWORK_AUTOSTART || 'auto') !== 'off') {
    try {
      const tw = require('./traework');
      if (tw.status().ready) {
        for (const m of tw.listModelEntries()) {
          data.push({
            id: `traework/${m.id}`,
            object: 'model',
            created,
            owned_by: 'traework',
            name: m.name,
            ...(m.contextWindow ? { contextWindow: m.contextWindow, maxContextWindow: m.maxContextWindow } : {}),
          });
        }
      }
    } catch (e) { /* 通道不可用，不列 */ }
  }

  // Qoder 同理：模型名带 qoder/ 前缀。签名纯本地、不需要客户端。
  // **带 name 与上下文**：cc-switch 解析模型列表读 `name` 字段
  // （实测其二进制里与 owned_by 相邻的字段是 id/name/cost/contextWindow/
  // maxContextWindow）。只给 {id, owned_by} 的话客户端只能显示内部 key
  // （`qoder/qfmodel`），看不出是哪个模型。
  if ((process.env.DUMATE_QODER_AUTOSTART || 'auto') !== 'off') {
    try {
      const qd = require('./qoder');
      if (qd.status().ready) {
        for (const m of await qd.listModelEntries()) {
          data.push({
            id: m.id,
            object: 'model',
            created,
            owned_by: 'qoder',
            name: m.name,
            ...(m.contextWindow ? { contextWindow: m.contextWindow, maxContextWindow: m.maxContextWindow } : {}),
          });
        }
      }
    } catch (e) { /* 通道不可用，不列 */ }
  }

  // hiddenModels 热配置（F5）：输出侧过滤。管理端 PUT 后下一次列表即新口径。
  try {
    data = livecfg.applyHiddenModels(data);
  } catch (e) { /* 配置不可用按全量列表 */ }

  sendJSON(res, 200, { object: 'list', data });
}

async function handleOpenAIChat(req, res) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  if (bodyStr == null) return sendBodyTooLarge(res);
  let reqBody;
  try {
    reqBody = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }

  const info = reqlog.describeRequest(reqBody);
  req._logPath = '/v1/chat/completions';

  // 通道分流：`qwen/xxx` 走千问办公，其余走搭子。
  // 必须在 mapModel 之前——千问的模型名（pro/flash）不在搭子的别名表里，
  // 先过 mapModel 会被兜底成 model-text，等于把请求打到错的模型上。
  const route = router.resolve(reqBody.model);
  if (route.error) {
    return sendJSON(res, 400, { error: { message: route.error, type: 'invalid_request_error' } });
  }
  const avail = router.availability(route.channel);
  if (!avail.ok) {
    return sendJSON(res, 503, {
      error: { message: `channel ${route.channel} unavailable: ${avail.reason}`, type: 'api_error' }
    });
  }
  req._channel = route.channel;
  req._mappedModel = route.model;

  if (route.target.needsModelMap) {
    reqBody.model = mapModel(route.model);
    req._mappedModel = reqBody.model;
  } else {
    reqBody.model = route.model;
  }

  // 预算统一由 budget.js 判定：glm 的 reasoning 与正文共用一个 max_tokens
  // 预算，小预算会让正文被 reasoning 吃光（实测 max_tokens<=1024 时正文为空，
  // finish_reason=length）。
  // 千问办公不套这一档：实测它的推理与正文分开流（reasoning 2060 字 / 正文
  // 96 字），机制不同，套上搭子的 32768 下限只会把小请求凭空撑大。
  if (route.target.needsBudget) {
    reqBody.max_tokens = resolveBudget(route.target, reqBody.max_tokens);
  }

  const target = route.target;

  // 千问办公是直连通道（没有本地端口），走 provider 而不是转发。
  // 在 mapModel / 预算之后、转发之前分流——它的 body 构造与搭子不同，
  // 且要经官方 wasm 封装。
  if (target.direct) {
    return await handleDirectChannel(req, res, reqBody, route, { startedAt, info, kind: 'openai' });
  }

  // 云端网关（dumate-svc.baidu.com）只在被显式要求时才在流尾补一个 usage 帧；
  // 8980 桌面后端默认就发，所以缺了这行的症状只出现在网页凭证链路上——
  // 请求全部 200，token 全记 0。**必须放在 target.direct 之后**：直连通道的
  // buildBody 不认识这个字段。
  if (reqBody.stream) reqBody.stream_options = { include_usage: true };

  const outBody = JSON.stringify(reqBody);

  const upstreamReq = forwardWithFallback(target, '/chat/completions', 'POST', {}, outBody, req, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_unavailable' });
      return sendJSON(res, 502, { error: { message: 'DuMate upstream unavailable', type: 'api_error' } });
    }

    if (reqBody.stream) {
      // Pass-through streaming
      res.writeHead(upstreamRes.statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...(res._cors || {}),
      });
      // 上游中途断开时必须主动收尾，否则客户端挂在半开的流上
      // （表现为「输出写到一半就停住，一直不返回」）。
      // 顺路扫 SSE 取真实 usage：流式响应没有单一 usage 字段。
      // usage 只在最后一两个块里，所以只保留尾部固定窗口——原实现一直累积
      // 到 200KB 且从不截断，而流可以活 55 秒以上，并发流就是 N×200KB。
      let seen = '';
      const TAIL = 32768;
      // StringDecoder：跨 chunk 的汉字不能逐块解码（会变 U+FFFD），
      // 而这里要扫的是 SSE 文本里的 usage，乱码会让匹配失准
      const seenDec = new (require('string_decoder').StringDecoder)('utf8');
      upstreamRes.on('data', (c) => {
        markFirstToken(res);
        seen += seenDec.write(c);
        if (seen.length > TAIL) seen = seen.slice(-TAIL);
      });
      const finishStream = () => {
        logRequest(req, res, startedAt, info, upstreamRes.statusCode, reqlog.usageFromSSE(seen));
        // 已结束还写会抛 ERR_STREAM_WRITE_AFTER_END——同样是未捕获异常，
        // 一样能打挂进程。守卫与 send() 同款。
        if (!res.writableEnded && !res.destroyed) res.end();
      };
      upstreamRes.on('aborted', finishStream);
      upstreamRes.on('error', finishStream);

      // 网页回落返回的是**伪上游响应**（EventEmitter + statusCode/headers，
      // 见 fallback-web.js）——它没有 pipe 方法。原先这里无条件
      // `upstreamRes.pipe(res)`，回落时抛 `TypeError: upstreamRes.pipe is not
      // a function`：未捕获异常，**直接打挂整个网关进程**（不是单个请求失败，
      // 实测 9082 整个端口消失）。
      //
      // 桌面凭证可用时走的是真响应（IncomingMessage，有 pipe），所以这个洞
      // 只在回落路径上暴露——而卸载客户端后回落恰恰是唯一链路，必现。
      //
      // 真响应仍走 pipe（自带背压处理）；伪响应改为事件转发。两者的 chunk
      // 都是 string（真响应 setEncoding('utf8')，伪响应由 web-pool 透传），
      // res.write 与 StringDecoder 都能直接吃，不必转换。
      const canPipe = typeof upstreamRes.pipe === 'function';
      if (!canPipe) {
        upstreamRes.on('data', (c) => {
          if (res.writableEnded || res.destroyed) return;
          res.write(c);
        });
      }
      upstreamRes.on('end', () => {
        logRequest(req, res, startedAt, info, upstreamRes.statusCode, reqlog.usageFromSSE(seen));
        // pipe 会自动 end res；伪响应没有 pipe，不自己收尾的话客户端会
        // 永久挂在半开的流上（表现为「内容都到了但请求一直不返回」）。
        if (!canPipe && !res.writableEnded && !res.destroyed) res.end();
      });
      if (canPipe) upstreamRes.pipe(res);
    } else {
      // Pass-through non-streaming
      let data = '';
      let over = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        // 上游响应超限（审计 P1-1b）：不把超长体转发给客户端，回 502
        if (over) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_too_large' });
          return sendUpstreamTooLarge(res);
        }
        let usage = null;
        try {
          const j = JSON.parse(data);
          usage = reqlog.pickUsage(j.usage);
        } catch (e) { /* 非 JSON 就按 0 记 */ }
        logRequest(req, res, startedAt, info, upstreamRes.statusCode, usage);
        res.writeHead(upstreamRes.statusCode, {
          'Content-Type': 'application/json',
          ...(res._cors || {}),
        });
        res.end(data);
      };
      upstreamRes.on('data', (c) => {
        markFirstToken(res);
        if (over) return;
        data += c;
        if (data.length > MAX_UPSTREAM_BYTES) {
          over = true;
          data = '';
        }
      });
      upstreamRes.on('end', finish);
      upstreamRes.on('aborted', finish);
      upstreamRes.on('error', finish);
    }
  });
}

// Rough token estimate. DuMate exposes no tokenizer, so chars/4 is a
// deliberately conservative stand-in that keeps Claude Code happy.
// String.length 是 UTF-16 码元数，**不是字节数**：一个汉字算 1，UTF-8 下它
// 占 3 字节。所以这是「字符数/4」；中文按真分词约 1 字 1 token，估算值会
// 偏小约 4 倍——只够给客户端做预算参考，不能当计费依据。
function estimateTokens(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / 4);
  if (Array.isArray(value)) {
    return value.reduce((acc, b) => {
      if (typeof b === 'string') return acc + Math.ceil(b.length / 4);
      if (b && typeof b === 'object') {
        const t = typeof b.text === 'string' ? b.text : JSON.stringify(b.input || b.content || '');
        return acc + Math.ceil(t.length / 4);
      }
      return acc;
    }, 0);
  }
  return Math.ceil(String(value).length / 4);
}

async function handleAnthropicCountTokens(req, res) {
  const bodyStr = await readBody(req);
  if (bodyStr == null) return sendBodyTooLarge(res);
  let body;
  try {
    body = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
  }
  let total = estimateTokens(body.system);
  for (const m of (body.messages || [])) total += estimateTokens(m.content) + 4;
  for (const t of (body.tools || [])) total += estimateTokens(t.description || '') + estimateTokens(JSON.stringify(t.input_schema || {}));
  return sendJSON(res, 200, { type: 'count_tokens_result', input_tokens: total });
}

// ==================== Google Generative Language (v1beta) Compatible Endpoints ====================

async function handleGoogleModels(req, res) {
  const models = [
    { name: 'models/glm-5', displayName: 'GLM-5', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
    { name: 'models/model-text', displayName: 'DuMate text', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
    { name: 'models/claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet (proxy)', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
    { name: 'models/gpt-4o', displayName: 'GPT-4o (proxy)', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
  ];
  // hiddenModels 热配置（F5）：与 /v1/models 同一过滤口径（applyHiddenModels
  // 自剥 'models/' 前缀比对裸名，读不到配置时原样返回）
  sendJSON(res, 200, { models: livecfg.applyHiddenModels(models) });
}

async function handleGoogleGenerateContent(req, res, isStream, pathModel) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  if (bodyStr == null) return sendBodyTooLarge(res);
  let googleReq;
  try {
    googleReq = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { code: 400, message: 'Invalid JSON body', status: 'INVALID_ARGUMENT' } });
  }

  googleReq.stream = isStream;
  // Google 的模型名在 URL 路径上，body 里没有，埋点要显式带上
  const info = reqlog.describeRequest(googleReq, pathModel);
  req._logPath = '/v1beta:generateContent';

  // 把 URL 上的模型名落回 body 再转换：通道分流读的是 openaiReq.model，
  // 不落这一步它会一直是 undefined，`qwen/` / `traework/` 前缀随之丢失、
  // 静默判成搭子。转换层刻意不再自己 mapModel，映射交给下面的 needsModelMap。
  googleReq.model = pathModel;
  const openaiReq = googleToOpenAI(googleReq);
  req._mappedModel = openaiReq.model;

  // 通道分流：Google 路径的模型名来自 URL，googleToOpenAI 已把它落到
  // openaiReq.model，所以这里与 chat 路径共用同一套解析。
  const route = router.resolve(openaiReq.model);
  if (route.error) {
    return sendJSON(res, 400, { error: { message: route.error, code: 400, status: 'INVALID_ARGUMENT' } });
  }
  const avail = router.availability(route.channel);
  if (!avail.ok) {
    return sendJSON(res, 503, { error: { message: `channel ${route.channel} unavailable: ${avail.reason}`, code: 503, status: 'UNAVAILABLE' } });
  }
  req._channel = route.channel;

  if (route.target.needsModelMap) {
    openaiReq.model = mapModel(route.model);
    req._mappedModel = openaiReq.model;
  } else {
    openaiReq.model = route.model;
    req._mappedModel = route.model;
  }
  if (route.target.needsBudget) {
    openaiReq.max_tokens = resolveBudget(route.target, openaiReq.max_tokens);
  }
  const target = route.target;
  if (target.direct) {
    openaiReq.stream = isStream;
    return await handleDirectChannel(req, res, openaiReq, route, { startedAt, info, kind: 'google' });
  }
  // 同 handleOpenAIChat：云端只在被显式要求时回流 usage 帧。
  if (isStream) openaiReq.stream_options = { include_usage: true };
  const outBody = JSON.stringify(openaiReq);
  forwardWithFallback(target, '/chat/completions', 'POST', {}, outBody, req, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_unavailable' });
      return sendJSON(res, 502, { error: { code: 502, message: 'DuMate upstream unavailable', status: 'UNAVAILABLE' } });
    }

    // 上游报错时必须把状态码透出去。原实现在这里不检查 statusCode 就
    // writeHead(200)，于是 429/500 被翻译成「HTTP 200 + 空候选」，
    // 客户端以为成功、拿到的却是空回答。
    if (upstreamRes.statusCode >= 400) {
      return collectAndFinish(upstreamRes, (data) => {
        if (data == null) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_too_large' });
          return sendUpstreamTooLarge(res);
        }
        logRequest(req, res, startedAt, info, upstreamRes.statusCode, null, { error: 'upstream_error' });
        sendJSON(res, upstreamRes.statusCode, {
          error: { code: upstreamRes.statusCode, message: 'Upstream error: ' + data.substring(0, 300), status: 'UNAVAILABLE' },
        });
      });
    }

    if (isStream) {
      // Google streaming supports both ?alt=sse and bare streamGenerateContent.
      translateStreamToGoogle(upstreamRes, res, googleReq.model, (usage, status) => {
        logRequest(req, res, startedAt, info, status, usage);
      });
    } else {
      let data = '';
      let over = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        // 上游响应超限（审计 P1-1b）：回 502，不解析超长体
        if (over) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_too_large' });
          return sendUpstreamTooLarge(res);
        }
        try {
          const openaiResp = JSON.parse(data);
          logRequest(req, res, startedAt, info, 200, reqlog.pickUsage(openaiResp.usage));
          res.writeHead(200, {
            'Content-Type': 'application/json',
            ...(res._cors || {}),
          });
          res.end(JSON.stringify(openAIToGoogle(openaiResp, googleReq.model)));
        } catch (e) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'parse_error' });
          sendJSON(res, 502, { error: { code: 502, message: 'Upstream parse error: ' + data.substring(0, 200), status: 'INTERNAL' } });
        }
      };
      upstreamRes.on('data', (c) => {
        if (over) return;
        data += c;
        if (data.length > MAX_UPSTREAM_BYTES) {
          over = true;
          data = '';
        }
      });
      upstreamRes.on('end', finish);
      upstreamRes.on('aborted', finish);
      upstreamRes.on('error', finish);
    }
  });
}

// ==================== OpenAI Responses API (Codex CLI) ====================

async function handleOpenAIResponses(req, res) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  if (bodyStr == null) return sendBodyTooLarge(res);
  let reqBody;
  try {
    reqBody = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }

  const isStream = reqBody.stream !== false; // Codex 默认流式
  const info = reqlog.describeRequest(reqBody);
  req._logPath = '/v1/responses';

  const openaiReq = responsesToOpenAI(reqBody, isStream);
  req._mappedModel = openaiReq.model;

  // 通道分流：Codex 的 responses 接口同样支持 qwen/ 前缀
  const route = router.resolve(openaiReq.model);
  if (route.error) {
    return sendJSON(res, 400, { error: { message: route.error, type: 'invalid_request_error' } });
  }
  const avail = router.availability(route.channel);
  if (!avail.ok) {
    return sendJSON(res, 503, { error: { message: `channel ${route.channel} unavailable: ${avail.reason}`, type: 'api_error' } });
  }
  req._channel = route.channel;

  if (route.target.needsModelMap) {
    openaiReq.model = mapModel(route.model);
    req._mappedModel = openaiReq.model;
    // 与 Anthropic 路径同口径：reasoning_effort 只给直连通道，搭子透传前剥掉
    delete openaiReq.reasoning_effort;
  } else {
    openaiReq.model = route.model;
    req._mappedModel = route.model;
  }
  if (route.target.needsBudget) {
    openaiReq.max_tokens = resolveBudget(route.target, openaiReq.max_tokens);
  }
  const target = route.target;
  if (target.direct) {
    openaiReq.stream = isStream;
    return await handleDirectChannel(req, res, openaiReq, route, { startedAt, info, kind: 'responses' });
  }
  // 同 handleOpenAIChat：云端只在被显式要求时回流 usage 帧。
  if (isStream) openaiReq.stream_options = { include_usage: true };
  const outBody = JSON.stringify(openaiReq);
  forwardWithFallback(target, '/chat/completions', 'POST', {}, outBody, req, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_unavailable' });
      return sendJSON(res, 502, { error: { message: 'DuMate upstream unavailable', type: 'api_error' } });
    }
    if (!upstreamRes.statusCode || upstreamRes.statusCode >= 400) {
      return collectAndFinish(upstreamRes, (data) => {
        if (data == null) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_too_large' });
          return sendUpstreamTooLarge(res);
        }
        logRequest(req, res, startedAt, info, upstreamRes.statusCode || 502, null, { error: 'upstream_error' });
        sendJSON(res, upstreamRes.statusCode || 502, {
          error: { message: 'Upstream error: ' + data.substring(0, 300), type: 'api_error' },
        });
      });
    }

    if (isStream) {
      translateStreamToResponses(upstreamRes, res, reqBody.model, (usage, status, extra) => {
        logRequest(req, res, startedAt, info, status, usage, extra);
      });
    } else {
      collectAndFinish(upstreamRes, (data) => {
        if (data == null) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_too_large' });
          return sendUpstreamTooLarge(res);
        }
        try {
          const openaiResp = JSON.parse(data);
          logRequest(req, res, startedAt, info, 200, reqlog.pickUsage(openaiResp.usage));
          sendJSON(res, 200, openAIToResponse(openaiResp, reqBody.model));
        } catch (e) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'parse_error' });
          sendJSON(res, 502, { error: { message: 'Upstream parse error: ' + data.substring(0, 200), type: 'api_error' } });
        }
      });
    }
  });
}

// ==================== Anthropic Compatible Endpoints ====================

async function handleAnthropicMessages(req, res) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  if (bodyStr == null) return sendBodyTooLarge(res);
  let anthropicReq;
  try {
    anthropicReq = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
  }

  const info = reqlog.describeRequest(anthropicReq);
  req._logPath = '/v1/messages';

  // 通道分流**必须在转换之前**：工具模式按通道选（直连通道转发结构化工具、
  // 搭子保持文本降级），而模式要在调用转换时就定下来。模型名直接取
  // anthropicReq.model——转换不会改它（映射在下面的 needsModelMap 分支里做）。
  const route = router.resolve(anthropicReq.model);
  if (route.error) {
    return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: route.error } });
  }
  const avail = router.availability(route.channel);
  if (!avail.ok) {
    return sendJSON(res, 503, { type: 'error', error: { type: 'api_error', message: `channel ${route.channel} unavailable: ${avail.reason}` } });
  }
  req._channel = route.channel;

  // Convert to OpenAI format。直连通道开 nativeTools：不开的话 Anthropic 的
  // tools 会被整段丢弃，模型收不到工具定义，只能在正文里吐 `<seed:tool_call>`
  // 文本式调用——Claude Code 拿不到 tool_use 块，直接判定回合结束
  // （表现为「很快就输出、任务没做」）。搭子（needsModelMap）保持文本降级，
  // 它的上游确实不支持 function calling，这是能力边界不是缺陷。
  const openaiReq = anthropicToOpenAI(anthropicReq, { nativeTools: !route.target.needsModelMap });
  req._mappedModel = openaiReq.model;

  if (route.target.needsModelMap) {
    openaiReq.model = mapModel(route.model);
    req._mappedModel = openaiReq.model;
    // 思考强度是直连通道（Qoder）才下发的字段；搭子是「最小干预透传」，
    // 多余字段原样进云端，行为未知——剥掉（翻译层加的，这里剥干净）。
    delete openaiReq.reasoning_effort;
  } else {
    openaiReq.model = route.model;
    req._mappedModel = route.model;
  }
  if (route.target.needsBudget) {
    openaiReq.max_tokens = resolveBudget(route.target, openaiReq.max_tokens);
  }
  const target = route.target;
  if (target.direct) {
    openaiReq.stream = !!anthropicReq.stream;
    return await handleDirectChannel(req, res, openaiReq, route, { startedAt, info, kind: 'anthropic' });
  }
  // Ask the upstream for a usage-bearing final chunk so we can report real
  // token counts instead of zeroes. Harmless if the upstream ignores it.
  if (anthropicReq.stream) openaiReq.stream_options = { include_usage: true };
  const outBody = JSON.stringify(openaiReq);

  forwardWithFallback(target, '/chat/completions', 'POST', {}, outBody, req, (upstreamRes) => {
    if (upstreamRes.fakeResponse) {
      logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_unavailable' });
      return sendJSON(res, 502, { type: 'error', error: { type: 'api_error', message: 'DuMate upstream unavailable' } });
    }

    if (anthropicReq.stream) {
      // Translate OpenAI SSE stream to Anthropic SSE events
      translateStreamToAnthropic(upstreamRes, res, anthropicReq.model, (usage, status) => {
        logRequest(req, res, startedAt, info, status, usage);
      });
    } else {
      // Non-streaming: collect and translate
      collectAndFinish(upstreamRes, (data) => {
        if (data == null) {
          logRequest(req, res, startedAt, info, 502, null, { error: 'upstream_too_large' });
          return sendUpstreamTooLarge(res);
        }
        try {
          const openaiResp = JSON.parse(data);
          const anthropicResp = openAIToAnthropic(openaiResp, anthropicReq.model);
          logRequest(req, res, startedAt, info, upstreamRes.statusCode, reqlog.pickUsage(openaiResp.usage));
          sendJSON(res, 200, anthropicResp);
        } catch (e) {
          sendJSON(res, 502, { type: 'error', error: { type: 'api_error', message: 'Upstream parse error: ' + data.substring(0, 200) } });
        }
      });
    }
  });
}

// Translate OpenAI SSE stream to Anthropic SSE stream
function translateStreamToAnthropic(upstreamRes, res, originalModel, onDone) {
  let finished = false;
  const finish = (status) => {
    if (finished) return;
    finished = true;
    if (onDone) onDone({ input: inputTokens, output: outputTokens, total: inputTokens + outputTokens }, status);
  };
  // 延迟发头 + 安全写：上游在流里报错（402/400）时头还没发，
  // catch 分支能回正经的 4xx JSON 而不是一个没有终结事件的空流。
  const w = makeSSEWriter(res);

  // Send message_start
  const msgId = 'msg_' + Date.now() + Math.random().toString(36).substring(2, 8);
  const sendEvent = (event, data) => w.event(event, data);

  sendEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: originalModel || 'claude-3-5-sonnet-20241022',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  let buffer = '';
  // StringDecoder：跨 chunk 的多字节汉字不能逐块解码，否则出现 U+FFFD
  const decoder = new (require('string_decoder').StringDecoder)('utf8');
  let blockIndex = -1;
  let currentBlockType = null; // 'thinking' or 'text'
  let hasText = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastFinishReason = null;
  // 工具调用缓冲。**刻意缓冲到流末再发**，两个理由：
  //   1. Anthropic 的 content block 是**顺序**的（必须关掉前一个才能开下一个），
  //      而上游的多个 tool_call 增量会按 index 交错到达。实时发块会让「往已关闭
  //      的块写 delta」必然发生。
  //   2. content_block_start 一旦发出就不能改 name，而实测上游的后续增量帧
  //      name 是空串、只有首帧带名。缓冲后流末一定拿得到名字。
  // 代价是工具调用不「流式」——它本身只有几十到几百 token，延迟可忽略。
  const toolBuf = new Map(); // tool_call index -> { id, name, args }

  upstreamRes.on('data', (chunk) => {
    // 首个上游字节到达即记首字（口径同另外两个翻译器）。
    markFirstToken(res);
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.substring(6).trim();
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);
        if (chunk.usage) {
          if (chunk.usage.prompt_tokens != null) inputTokens = chunk.usage.prompt_tokens;
          if (chunk.usage.completion_tokens != null) outputTokens = chunk.usage.completion_tokens;
        }
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (!delta) continue;

        // Reasoning content -> thinking block
        if (delta.reasoning_content) {
          if (currentBlockType !== 'thinking') {
            // Close previous block
            if (blockIndex >= 0) {
              sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            }
            blockIndex++;
            currentBlockType = 'thinking';
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'thinking', thinking: '' }
            });
          }
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
          });
        }

        // Content -> text block
        if (delta.content) {
          if (currentBlockType !== 'text') {
            if (blockIndex >= 0) {
              sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            }
            blockIndex++;
            currentBlockType = 'text';
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' }
            });
          }
          hasText = true;
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: delta.content }
          });
        }

        // 工具调用增量：只累积，流末统一发块（理由见 toolBuf 的声明处注释）。
        // 三种形状都认：OpenAI 的 function.name、TRAE 上游原生的 function_call.name、
        // 以及平铺在 tc 顶层的 name——直连通道的归一化程度不一，这里兜住。
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          for (const tc of delta.tool_calls) {
            const ti = tc.index != null ? tc.index : 0;
            let entry = toolBuf.get(ti);
            if (!entry) { entry = { id: '', name: '', args: '' }; toolBuf.set(ti, entry); }
            if (tc.id) entry.id = tc.id;
            const nm = (tc.function && tc.function.name)
              || (tc.function_call && tc.function_call.name) || tc.name || '';
            if (nm) entry.name = nm;
            const args = (tc.function && tc.function.arguments)
              || (tc.function_call && tc.function_call.arguments) || tc.arguments || '';
            if (args) entry.args += args;
          }
        }

        // Finish reason
        const finishReason = chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason;
        if (finishReason) lastFinishReason = finishReason;
      } catch (e) {
        // ignore parse errors
      }
    }
  });

  upstreamRes.on('end', () => {
    // Close any open block
    if (blockIndex >= 0) {
      sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }
    // If no content was generated, add an empty text block
    // （有工具调用时不补：那会让客户端先看到一个空 text 块，
    //   某些实现据此判定「模型只是说了句空话」）
    if (!hasText && blockIndex < 0 && !toolBuf.size) {
      sendEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      });
      sendEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '' }
      });
      sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
    }
    // 工具块：按 index 顺序依次发 start + 完整 input_json_delta + stop。
    // 用 input_json_delta 而不是直接在 start 里塞 input——前者是各家客户端
    // 实现都吃的最标准形状。
    const toolEntries = [...toolBuf.entries()].sort((a, b) => a[0] - b[0]);
    let sentToolUse = false;
    for (const [, t] of toolEntries) {
      if (!t.name) {
        // 上游没给工具名：发出去客户端只会报 unknown tool，所以不发——
        // 但必须留痕，静默丢弃是最难排查的那种。
        console.warn('[anthropic] 丢弃一个没有名字的工具调用（上游未给 name）');
        continue;
      }
      blockIndex++;
      sendEvent('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'tool_use',
          id: t.id || ('toolu_' + Math.random().toString(36).slice(2, 10)),
          name: t.name,
          input: {},
        },
      });
      sendEvent('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: t.args || '{}' },
      });
      sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      sentToolUse = true;
    }
    // stop_reason：有工具调用**必须**是 tool_use，不能照搬上游的 finish_reason。
    // 实测 TRAE 在给出 tool_calls 的同时报的是 `stop`，照搬会被翻成 end_turn，
    // 而 Claude Code 看到 end_turn 就认为回合正常结束、**不去执行工具**——
    // 表现为「模型说要调工具，但什么都没发生」。
    sendEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: sentToolUse ? 'tool_use' : mapFinishReason(lastFinishReason),
        stop_sequence: null,
      },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    });
    sendEvent('message_stop', { type: 'message_stop' });
    finish(200);
    w.end();
  });

  upstreamRes.on('error', (e) => {
    // 一个内容块都没发出去 = 上游在出内容之前就死了（限流 / 额度 / 网关错）。
    // **不能**收成一个「正常但空」的 message_delta + message_stop：Claude Code
    // 会把它当成一次合法的空回合，不重试，用户看到的就是「模型什么都不回答」。
    // Anthropic 的 SSE 有专门的 `error` 事件，客户端据此抛错并按退避重试。
    const nothingSent = blockIndex < 0 && !toolBuf.size && !hasText;
    if (nothingSent) {
      const msg = String((e && e.message) || 'upstream error');
      sendEvent('error', {
        type: 'error',
        error: { type: anthErrorType(e && e.statusCode, msg), message: msg },
      });
      finish(Number(e && e.statusCode) || 502);
      w.end();
      return;
    }
    // 已经吐过内容：协议上收不回去了，只能按正常收尾（客户端已有部分输出）
    sendEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(lastFinishReason), stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    });
    sendEvent('message_stop', { type: 'message_stop' });
    finish(502);
    w.end();
  });
}

/**
 * Anthropic SSE 错误事件的 `type`。取值来自 Anthropic 的错误类型枚举——
 * 客户端（Anthropic SDK / Claude Code）按它决定是否重试：`rate_limit_error`
 * 与 `overloaded_error` 会退避重试，`invalid_request_error` 不会。
 */
function anthErrorType(status, message) {
  const n = Number(status) || 0;
  if (n === 429) return 'rate_limit_error';
  if (n === 401) return 'authentication_error';
  if (n === 403) return 'permission_error';
  if (n === 404) return 'not_found_error';
  if (n === 400 || n === 422) return 'invalid_request_error';
  if (n === 529) return 'overloaded_error';
  // 上游排队挂起（自造的串）也是「稍后再来」，按过载处理让客户端重试
  if (/queued|read idle|timeout/i.test(String(message || ''))) return 'overloaded_error';
  return 'api_error';
}

// ==================== Server ====================

const server = http.createServer(async (req, res) => {
  // CORS 白名单判定（fail-closed，见 cors.js）：入口算一次挂到 res 上，
  // sendJSON / SSE writeHead 统一取用。默认不发任何 CORS 头。
  res._cors = cors.headersFor(req);
  // CORS preflight：仅白名单命中的 Origin 才回 ACAO，其余 204 但不带
  // 放行头——浏览器会拒绝后续实际请求，服务端不执行任何业务逻辑。
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...res._cors,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  // 兜住异步 handler 的拒绝。原来只包了同步 try/catch，而 handler 是 async：
  // `await ensureUpstream()` 抛错时（例如网关先于 DuMate 启动——启动日志里
  // 明确提示「Will retry on first request」就是这条路径）拒绝会绕过同步
  // catch，既不写响应（客户端永久挂起），又变成 unhandledRejection 让进程退出。
  const fail = (err) => {
    log('Error:', err.message);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: { message: err.message, type: 'api_error' } });
    } else {
      res.end();
    }
  };

  try {
    // Health check
    if (url === '/health' || url === '/ping') {
      return sendJSON(res, 200, {
        status: 'ok',
        upstream_port: upstreamPort,
        upstream_managed: upstreamManaged,
        // 通道状态：搭子是主链路，千问是可选。分开报，便于一眼看出
        // 「qwen/ 请求会在哪一步失败」。千问是进程内直连，没有端口，
        // 所以报的是 wasm 版本与登录态而不是 port。
        channels: {
          dumate: (() => {
            let fb = { available: false, enabled: false };
            try { fb = { available: webFallback.available(), enabled: webFallback.enabled() }; }
            catch (e) { /* 池子读不到就按不可用报，别让 health 自己抛错 */ }
            // 凭证来源：web = 只用网页池（**默认**，桌面链路根本不参与）；
            // auto = 桌面优先、不可用时回落（DUMATE_DUMATE_SOURCE=auto）
            const source = router.dumateSource();
            return {
              port: upstreamPort,
              // ready 的语义是「这个通道现在能不能跑」：
              //   auto → 看桌面链路；web → 看网页池（桌面链路被跳过）。
              // 桌面 ready=false 且 fallback.available=true 时请求仍能成功，
              // 排障时不知道这点会看错方向（见 forwardWithFallback）。
              ready: source === 'web' ? fb.available : !!upstreamPort,
              source,
              fallback: fb,
            };
          })(),
          qwenwork: {
            direct: true,
            ready: !!(qwenworkUp && router.availability('qwenwork').ok),
            wasm: qwenworkUp || null,
            // 与 traework 对称：凭证自持后，可用性取决于池里有几个能用的账号
            accounts: (() => {
              try { return require('./qwenwork').status().accounts || 0; }
              catch (e) { return 0; }
            })(),
          },
          // TRAE Work：凭证自持（OAuth 换取），没有 wasm 依赖。
          // ready 取决于「有没有可用账号」——与千问的 wasm+登录态判定不同。
          traework: (() => {
            try {
              const st = require('./traework').status();
              return { direct: true, ready: st.ready, accounts: st.accounts, error: st.error || '' };
            } catch (e) {
              return { direct: true, ready: false, accounts: 0, error: e.message };
            }
          })(),
          // Qoder：凭证自持（device flow 换取），**连 wasm 都不需要**
          // （签名是纯本地算法）。needsClient=false 明确表示不依赖任何客户端安装。
          qoder: (() => {
            try {
              const st = require('./qoder').status();
              return { direct: true, ready: st.ready, needsClient: false, accounts: st.accounts, error: st.error || '' };
            } catch (e) {
              return { direct: true, ready: false, needsClient: false, accounts: 0, error: e.message };
            }
          })(),
        },
        service: 'dumate2api',
      });
    }

    // ==================== API Key 鉴权 ====================
    // 触发条件（满足其一）：DUMATE_REQUIRE_KEY=1，或设置了 DUMATE2API_KEY。
    // 环境变量密钥此前是死变量（定义后从未校验），现已接线：命中登记 key
    // 或 env 密钥任一即放行。鉴权在路由分发之前统一做，避免新增端点漏挂。
    if (REQUIRE_KEY && url !== '/health' && url !== '/ping') {
      const token = keysvc.tokenFromHeaders(req.headers);
      let key = keysvc.resolve(token);
      // env 密钥兜底：与登记 key 体系并联，常时比较（keys.tokenMatches）
      if (!key && ENV_API_KEY && keysvc.tokenMatches(token, ENV_API_KEY)) {
        key = { id: 0, name: 'env:DUMATE2API_KEY', enabled: true };
      }

      // 模型白名单与通道绑定都需要知道请求的是哪个模型。只有 key 真的配了
      // 这两类规则时才预读请求体——否则给默认路径凭空加一次完整读取。
      // 预读的内容存到 req._rawBody，handler 里的 readBody 会直接取用，
      // 不会二次消费流。
      let model = null;
      const hasModelRule = key && Array.isArray(key.model_allowlist) && key.model_allowlist.length > 0;
      const hasChannelRule = key && !!key.channel;
      if ((hasModelRule || hasChannelRule) && req.method === 'POST') {
        // Google 的模型名在 URL 路径里，且**可能带通道前缀**（qwen/pro），
        // 所以不能排除 '/'——早期写成 [^:/?]+ 会把 qwen/pro 截断成匹配失败。
        const gm = url.match(/^\/v1beta\/models\/([^:?]+):/);
        if (gm) {
          model = decodeURIComponent(gm[1]);
        } else {
          const raw = await readBody(req);
          req._rawBody = raw;
          try {
            const parsed = JSON.parse(raw);
            model = parsed && parsed.model ? String(parsed.model) : null;
          } catch (e) { model = null; }
        }
      }
      // 通道绑定判定：靠模型名前缀，与 upstream-router 的分流口径一致。
      // 解析不出来（如 GET /v1/models）就不传通道，validate 会跳过这条规则
      // ——不该因为「无法判定通道」把只读请求拒掉。
      let reqChannel = '';
      if (model) {
        try {
          const r = require('./upstream-router').resolve(model);
          reqChannel = r.channel || '';
        } catch (e) { reqChannel = ''; }
      }

      const verdict = keysvc.validate(key, reqlog.clientIP(req), model, reqChannel);
      if (!verdict.ok) {
        const status = key ? 403 : 401;
        req._logPath = url;
        return sendJSON(res, status, {
          error: {
            message: verdict.reason === 'unknown_key'
              ? 'Invalid or missing API key'
              : `API key rejected: ${verdict.reason}`,
            type: 'authentication_error',
            code: verdict.reason,
          },
        });
      }
      req._apiKey = key;
    }

    // ==================== OpenAI compatible ====================
    // Models list
    if (url === '/v1/models' && req.method === 'GET') {
      return await handleOpenAIModels(req, res);
    }

    // Chat completions (OpenAI format, pass-through with model mapping)
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      return await handleOpenAIChat(req, res);
    }

    // Responses API (Codex CLI 0.155+ 只认 wire_api="responses")
    if ((url === '/v1/responses' || url === '/responses') && req.method === 'POST') {
      return await handleOpenAIResponses(req, res);
    }

    // ==================== Google Generative Language compatible ====================
    const googleModels = url.match(/^\/v1beta\/models$/);
    const googleGenerate = url.match(/^\/v1beta\/models\/([^:?]+):(generateContent|streamGenerateContent)$/);
    if (googleModels && req.method === 'GET') {
      return await handleGoogleModels(req, res);
    }
    if (googleGenerate && req.method === 'POST') {
      return await handleGoogleGenerateContent(req, res, googleGenerate[2] === 'streamGenerateContent', decodeURIComponent(googleGenerate[1]));
    }

    // ==================== Anthropic compatible ====================
    // Messages (Anthropic format, full translation)
    // Some clients (Claude Code / cc-switch) hit the bare path, others the
    // /v1-prefixed one. Accept both.
    if ((url === '/v1/messages' || url === '/messages') && req.method === 'POST') {
      return await handleAnthropicMessages(req, res);
    }

    // Also support /v1/chat/completions for Anthropic-style path
    if (url === '/api/v1/messages' && req.method === 'POST') {
      return await handleAnthropicMessages(req, res);
    }

    if ((url === '/v1/messages/count_tokens' || url === '/messages/count_tokens' || url === '/api/v1/messages/count_tokens') && req.method === 'POST') {
      return await handleAnthropicCountTokens(req, res);
    }

    // 404
    sendJSON(res, 404, { error: { message: `Not found: ${url}`, type: 'invalid_request_error' } });
  } catch (err) {
    fail(err);
  }
});

// Initial discovery and start
async function start() {
  log('Starting dumate2api...');
  log(`Proxy will listen on ${PROXY_HOST}:${PROXY_PORT}`);

  // 运行时模块启动接线（pool 恢复 / livecfg / 出站代理 / 计量探活），见 boot.js
  try { boot.init({ log }); } catch (e) { log(`⚠ 启动接线异常（不阻断监听）: ${e.message}`); }

  // 只用网页凭证（默认）时跳过初始发现——桌面链路根本不参与，
  // 这次探测（要跑 PowerShell 查询，实测约 3 秒）纯属浪费启动时间。
  const sourceEnv = String(process.env.DUMATE_DUMATE_SOURCE || '').trim();
  if (sourceEnv && !['web', 'auto', 'desktop'].includes(sourceEnv.toLowerCase())) {
    log(`⚠ DUMATE_DUMATE_SOURCE="${sourceEnv}" 无法识别，按默认（web）处理；可选值 web / auto / desktop`);
  }
  if (router.dumateSource() === 'web') {
    log('· 搭子凭证来源：网页池（默认，不探测桌面链路；设 DUMATE_DUMATE_SOURCE=auto 可启用桌面链路）');
  } else {
    try {
      const port = await discoverPort();
      if (port) {
        const valid = await verifyPort(port);
        if (valid) {
          upstreamPort = port;
          upstreamManaged = port === require('./discovery').MANAGED_PORT && (process.env.DUMATE_AUTOSTART || 'auto') !== 'off';
          lastDiscoveryTime = Date.now();
          log(`✓ DuMate main-server verified on port ${port}` + (upstreamManaged ? ' (headless, no DuMate GUI needed)' : ''));
        } else {
          log(`⚠ Found dumate-main-server on port ${port} but endpoint verification failed`);
          upstreamPort = port; // still try to use it
          lastDiscoveryTime = Date.now();
        }
      } else {
        log('⚠ DuMate main-server not detected. Will retry on first request.');
        log('  Make sure DuMate desktop app is running and logged in.');
      }
    } catch (e) {
      log('⚠ Initial discovery failed:', e.message);
    }
  }
  // 千问办公通道：进程内直连，**不需要拉起任何外部服务、也不需要客户端**。
  // 签名默认走本地算法（见 qwenwork/cosy-sign.js）；只有
  // DUMATE_QWENWORK_USE_WASM=1 时才需要官方 wasm（保留为退路）。
  // 早期版本走 Buddy2api（8787）中转，后来发现它的 wasm_helper.mjs 本身就是
  // 纯 Node 脚本、Python 只是一层壳，改为直连后少一个进程、少一层鉴权。
  // 预热失败不阻断启动：搭子是主链路，千问只是可选通道。
  if ((process.env.DUMATE_QWENWORK_AUTOSTART || 'auto') !== 'off') {
    try {
      const qwmod = require('./qwenwork');
      qwmod.warmup();
      const st = qwmod.status();
      // 签名方式如实上报给 /health（前端三处展示位读这个字段）。
      // 原来恒为 'ready' 是 wasm 单路径时代的写法，现在有 local/wasm 两种。
      const mode = st.signer === 'wasm'
        ? `wasm ${(st.wasm && st.wasm.version) || ''}`.trim()
        : 'local';
      qwenworkUp = st.ready ? mode : null;
      // 「有没有账号」与「签名能不能用」是两回事，日志要能一眼分清是哪一种
      log(st.ready
        ? `✓ QwenWork 通道就绪（签名 ${mode}，账号 ${st.accounts} 个）`
        : `· QwenWork 通道未就绪：${st.error || '尚未添加账号（到管理端用浏览器登录一次即可，不需要开千问客户端）'}`);
    } catch (e) {
      log('⚠ QwenWork 通道不可用（搭子链路不受影响）:', e.message);
      qwenworkUp = null;
    }
  } else {
    log('· QwenWork 通道已关闭（DUMATE_QWENWORK_AUTOSTART=off）');
  }

  // TRAE Work 通道：同样进程内直连，凭证自持（不依赖 TRAE 客户端）。
  // 这里预热**模型表**：/v1/models 与 upstream-router 都是同步取列表，
  // 不预热就只能拿到静态兜底里的那一个模型。失败不阻断启动。
  // **与 /v1/models 的 DUMATE_TRAEWORK_AUTOSTART 判定保持一致**：关闭的通道
  // 不该在启动时打网络、也不该在日志里报「就绪」（2026-10-22 修）。
  if ((process.env.DUMATE_TRAEWORK_AUTOSTART || 'auto') !== 'off') {
    try {
      const twmod = require('./traework');
      const st = twmod.status();
      if (st.ready) {
        twmod.warmupModels().then((m) => {
          if (m && m.ok) log(`✓ TRAE Work 模型表就绪（${m.models.length} 个模型）`);
          else log(`⚠ TRAE Work 模型表拉取失败（回落静态表）: ${(m && m.error) || 'unknown'}`);
        });
        log(`✓ TRAE Work 通道就绪（账号 ${st.accounts} 个）`);
      } else {
        log(`· TRAE Work 通道未就绪：${st.error}`);
      }
    } catch (e) {
      log('⚠ TRAE Work 通道不可用（搭子链路不受影响）:', e.message);
    }
  } else {
    log('· TRAE Work 通道已关闭（DUMATE_TRAEWORK_AUTOSTART=off）');
  }

  // Qoder 通道：签名纯本地，不需要任何客户端。同样要预热**模型表**——
  // resolveModelKey 靠它把显示名（GLM-5.3-Flash）映射成上游 key（gfmodel）。
  // 漏了预热时网关进程里的缓存恒为空，客户端写显示名会被原样当 key 发出去，
  // 上游回 provider_error，用户拿到 200 + 空回答。
  // **与 /v1/models 的 DUMATE_QODER_AUTOSTART 判定保持一致**：关闭的通道
  // 不该在启动时打网络、也不该在日志里报「就绪」（2026-10-22 修）。
  if ((process.env.DUMATE_QODER_AUTOSTART || 'auto') !== 'off') {
    try {
      const qd = require('./qoder');
      const st = qd.status();
      if (st.ready) {
        qd.warmupModels().then((m) => {
          if (m && m.ok) log(`✓ Qoder 模型表就绪（${m.models.length} 个模型）`);
          else log(`⚠ Qoder 模型表拉取失败（显示名将无法解析，只能用内部 key）: ${(m && m.error) || 'unknown'}`);
        });
        log(`✓ Qoder 通道就绪（账号 ${st.accounts} 个）`);
      } else {
        log(`· Qoder 通道未就绪：${st.error}`);
      }
    } catch (e) {
      log('⚠ Qoder 通道不可用（搭子链路不受影响）:', e.message);
    }
  } else {
    log('· Qoder 通道已关闭（DUMATE_QODER_AUTOSTART=off）');
  }

  server.listen(PROXY_PORT, PROXY_HOST, () => {
    log(`✓ dumate2api listening on http://${PROXY_HOST}:${PROXY_PORT}`);
    // 同步代码卡住时打日志，把「静默假死」变成可排查的痕迹（见函数注释）
    startLagMonitor();
    // 鉴权态势（P0-1）：env 密钥 / 登记 key 开关任一打开即有鉴权；
    // 都没开且监听非回环地址时显式告警（不拒启，保持兼容）。
    if (REQUIRE_KEY) {
      log(ENV_API_KEY
        ? '✓ 已启用鉴权：模型端点要求 Bearer / x-api-key（DUMATE2API_KEY 或管理端登记 key）'
        : '✓ 已启用鉴权：模型端点要求管理端登记的 API key（DUMATE_REQUIRE_KEY=1）');
    } else {
      const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
      if (!LOOPBACK.has(String(PROXY_HOST).toLowerCase())) {
        log(`⚠ 安全警告：未启用任何 API key 鉴权（未设 DUMATE2API_KEY / DUMATE_REQUIRE_KEY=1），且监听 ${PROXY_HOST} 非回环地址——局域网内任何设备都能直接消耗上游账号与积分。`);
        log('  最小修复：设 DUMATE2API_KEY=<密钥> 后，客户端请求头带 Bearer <密钥>。');
      }
    }
    if (!cors.allowlistSize()) {
      log('· CORS 默认关闭（浏览器跨域请求将在 preflight 被拒）；如需放行请设 DUMATE_CORS_ORIGINS=http://localhost:xxxx（逗号分隔，支持 *.example.com）');
    }
    log('');
    log('Endpoints:');
    log('  OpenAI:    http://127.0.0.1:' + PROXY_PORT + '/v1/chat/completions');
    log('  Models:    http://127.0.0.1:' + PROXY_PORT + '/v1/models');
    log('  Anthropic: http://127.0.0.1:' + PROXY_PORT + '/v1/messages');
    log('  Health:    http://127.0.0.1:' + PROXY_PORT + '/health');
    log('');
    log('cc-switch configuration:');
    log('  Claude Code: Base URL = http://127.0.0.1:' + PROXY_PORT + (REQUIRE_KEY ? ', API Key = <你的 DUMATE2API_KEY 或登记 key>' : ', API Key = nokey'));
    log('  Codex:       Base URL = http://127.0.0.1:' + PROXY_PORT + '/v1' + (REQUIRE_KEY ? ', API Key = <你的 DUMATE2API_KEY 或登记 key>' : ', API Key = nokey'));
  });
}

// 优雅停止（集成阶段）：信号到来时把池状态与计量分桶刷盘再退。
// SIGINT/SIGTERM 被接管后默认的立即退出没有了，shutdown 里显式 exit。
process.once('SIGINT', () => { log('收到 SIGINT，刷盘退出…'); boot.shutdown('SIGINT', true); });
process.once('SIGTERM', () => { log('收到 SIGTERM，刷盘退出…'); boot.shutdown('SIGTERM', true); });
process.once('exit', () => { try { boot.shutdown('exit'); } catch (e) { /* 退出路径不再抛 */ } });

start().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
