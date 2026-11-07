// src/admin/routes/accounts.js - 网页端账号管理（多账号签到 / 抽奖 / 积分）
const crypto = require('crypto');
const accounts = require('../../accounts');
const web = require('../../dumate-web');
const loginBrowser = require('../../login-browser');
const webPool = require('../../web-pool');
const accountPool = require('../../pool').pool;
const taskRunner = require('../../task-runner');
const taskScheduler = require('../../task-scheduler');
const records = require('../../records');
const ledger = require('../../checkin-ledger');
const pointsAgg = require('../../points-agg');
// 临期积分快照（FEFO 数据源）：写方在 /web-accounts，读方在 web-pool.js
const expiringSnap = require('../../expiring');
// 余额变动流水（施工包 C）：签到与手动刷新查到的余额都在这里留痕
const balanceHist = require('../../balance-hist');
const { sendJSON } = require('../router');

// 登录链接。百度 SSO 的登录页，登录后 cookie 落在 .baidu.com 域，
// 正是调 console/dumate 接口需要的。
const LOGIN_URL = 'https://login.bce.baidu.com/?redirect=' +
  encodeURIComponent('https://www.dumate.cn/app');

// 逐账号的完整明细只放在内存里缓存：额度包常有上百个，写回
// web-accounts.json 会让账号文件无谓膨胀，而它每次账号操作都要读写。
// 磁盘上仍只落 left/total/used 摘要（accounts.js 自己管）。
const DETAIL_CACHE_TTL_MS = 60 * 1000;
const detailCache = new Map();

/**
 * 从上游补回账号的真实昵称与 uid（**幂等，已有昵称时不打上游**）。
 *
 * 为什么需要它：`nickname` 早先只在**浏览器登录**那条路径（`/login/poll`）回填，
 * 而手动粘贴 cookie 添加的账号走 `POST /web-accounts`，那条路径从不写 nickname
 * ——于是这些账号的显示名永久停在 `create()` 生成的占位名「账号 N」，
 * 即使上游明明返回了「张三」。界面上就是「为什么显示账号 1 而不是用户名」。
 *
 * 修法是**自愈而不是一次性迁移**：任何一次触达上游的路径顺手补一次，
 * 已经补过的直接返回，不打上游。这样不用写迁移脚本，老账号也会在
 * 下次签到/刷新状态时自动补上。
 *
 * 只补 `nickname` 与 `uid` 两个**上游权威字段**，不动用户自己填的 `name`
 * ——`name` 是用户可见可改的标签，覆盖它等于替用户做决定。
 *
 * 三层保护，缺一不可（都针对「这是个读路径，不能拖慢主流程」）：
 *   1. **负缓存**：取不到昵称的账号在 TTL 内不重试。桌面凭证失效的账号
 *      永远取不到昵称，没有这层的话每次进仪表盘都要为它白等一次超时。
 *   2. **并发去重**：同一账号的并发请求只打一次上游（仪表盘 + 积分明细
 *      可能同时开火）。
 *   3. **显式超时**：`userInfo` 自身超时 20s，而前端 axios 是 30s——几个
 *      失效账号叠加就能把整页拖垮。这里压到 8s，失败即走负缓存。
 *
 * @returns {Promise<string>} 补到的昵称；取不到时返回已有的（可能为 ''）
 */
const NICK_FAIL_TTL_MS = 10 * 60 * 1000;
const NICK_TIMEOUT_MS = 8000;
// 最近一次补昵称失败的时刻（按账号 id）。TTL 内不重试
const nickFailAt = new Map();
// 正在飞的补昵称请求（按账号 id），并发去重
const nickInflight = new Map();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function backfillNickname(account) {
  if (!account) return '';
  if (account.nickname) return account.nickname;
  const id = account.id;
  const failedAt = nickFailAt.get(id);
  if (failedAt && Date.now() - failedAt < NICK_FAIL_TTL_MS) return account.nickname || '';
  const flying = nickInflight.get(id);
  if (flying) return flying;

  const task = (async () => {
    try {
      // 出站代理（E 包收口补点）：与对话同出口；失败走 catch 不影响主流程
      const agent = web.agentFor(account);
      const info = await withTimeout(web.api.userInfo(account.cookie, { agent }), NICK_TIMEOUT_MS);
      if (!info || !info.ok || !info.nickname) {
        nickFailAt.set(id, Date.now());
        return account.nickname || '';
      }
      accounts.patchInternal(id, {
        nickname: info.nickname,
        ...(info.uid ? { uid: info.uid } : {}),
      });
      nickFailAt.delete(id);
      return info.nickname;
    } catch (e) {
      // 补昵称失败绝不能影响主流程（签到、查积分都不该因此中断）
      nickFailAt.set(id, Date.now());
      return account.nickname || '';
    } finally {
      nickInflight.delete(id);
    }
  })();
  nickInflight.set(id, task);
  return task;
}

/**
 * 批量补昵称，**只对启用且昵称为空的账号**打上游。
 *
 * 抽出来是因为挂载点不止一处（仪表盘、账号详情、积分明细），
 * 各写一遍必然漏掉某个保护。禁用账号不必补——它不参与任何操作。
 */
async function backfillAll(list) {
  const need = (list || []).filter((a) => a && a.enabled !== false && !a.nickname);
  if (!need.length) return;
  await Promise.all(need.map((a) => backfillNickname(a)));
}

// 服务端自动发放的登录奖励，补记到操作流里。
//
// 为什么需要它：实测 login_bonus 的 granted_at 是当天 00:00:00，服务端按天
// 自动发，不依赖任何签到调用。于是每次点签到都命中 already，「签到成功 +500」
// 这条记录永远不出现——但 500 是真到账了，只是没进操作记录，于是看起来像
// 「签到从来没给过分」。
//
// 数据取自 quota_overview 的额度包本身（真实发放记录），不是估算，
// 也不冒充签到结果：type 记 'grant'、result 记 'auto_login_bonus'，
// 与「本系统主动做的动作」区分开。
async function recordAutoGrant(account, beforeSnapshot) {
  try {
    // 出站代理（E 包收口补点）：配置非法走 catch 返 null（少记一笔，不直连）
    const agent = web.agentFor(account);
    const r = await web.api.quotaOverview(account.cookie, { agent });
    if (!r.ok) return null;

    // 只认今天发的登录奖励：历史包也在 packages 里，全取会把过去每天
    // 都补一遍，造成重复记录
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = dayStart.getTime();
    const pkg = (r.packages || []).find(
      (p) => p.source === 'login_bonus' && p.granted_at && p.granted_at >= today,
    );
    if (!pkg || !(pkg.total > 0)) return null;

    // 先探测再写：同一天可能被点很多次签到（实测一天点过 4 次），
    // 每次都补会刷出一堆重复行，看不出「这天就发了一次」
    if (alreadyRecordedGrant(account.id, pkg.granted_at)) return null;

    const amount = pkg.total;
    const before = beforeSnapshot ? beforeSnapshot.left : null;
    // 发放前余额推不出来（发放发生在我们第一次观测之前），所以只给
    // 发放后的真实余额和金额，不反推 before——编一个 before 出来
    // 就是伪造数据。
    const after = r.left;

    records.append({
      type: 'grant',
      account_id: account.id,
      account: accounts.displayName(account),
      ok: true,
      result: 'auto_login_bonus',
      source: pkg.source,
      // 发放时刻用包自己的 granted_at，不是「我们查到的时刻」：
      // 记录要反映真实发生时间，否则会显示成「点签到才发的」
      granted_at: pkg.granted_at,
      points_delta: amount,
      points_before: null,
      points_after: after,
      note: '服务端自动发放，非本系统触发',
    });
    return { amount, granted_at: pkg.granted_at };
  } catch (e) {
    // 补记录失败不影响签到本身
    return null;
  }
}

// 同一天只补一次：签到可能被点很多次（实测一天点过 4 次），
// 每次都补会刷出一堆重复行，看不出「这天就发了一次」。
function alreadyRecordedGrant(accountId, grantedAt) {
  const { rows } = records.read({ limit: 0, type: 'grant' });
  return rows.some(
    (r) => Number(r.account_id) === Number(accountId) && r.granted_at === grantedAt,
  );
}

// 签到结果写回账号记录。抽出来单独一个函数是因为「一键签到」和
// 「单账号签到」两条路径都要用，且都要在失败时记下原因。
async function doCheckin(account) {
  // 出站代理（E 包收口补点）：签到全链路与对话同出口。配置非法直接失败，
  // 绝不静默回退直连（否则代理配置形同虚设）。
  let agent;
  try { agent = web.agentFor(account); } catch (e) {
    return { ok: false, error: e.message };
  }
  // 动作前的积分快照，用于算这次签到带来多少积分变化。
  // 放在最前面取：已签到的分支不需要它，但多取一次的成本远低于
  // 「有的分支有差值、有的没有」造成的记录不一致。
  account._pointsBefore = await records.pointsSnapshot(account.cookie, account);

  const info = await web.api.loginBonusInfo(account.cookie, { agent });
  if (!info.ok) {
    accounts.patchInternal(account.id, {
      last_error: info.error,
      last_login_ok_at: info.expired ? null : account.last_login_ok_at,
    });
    records.append({
      type: 'checkin', account_id: account.id, account: accounts.displayName(account),
      ok: false, result: 'failed', error: info.error,
    });
    return { id: account.id, name: accounts.displayName(account), ok: false, error: info.error, expired: !!info.expired };
  }

  // 已签到就不再打上游：签到接口本身幂等，但重复调用没有意义，
  // 而且会让「今天是否签到成功」这件事难以判断
  if (info.has_issued) {
    accounts.patchInternal(account.id, {
      last_error: '',
      last_login_ok_at: Date.now(),
      checkin: {
        ...account.checkin,
        last_result: 'already',
        total_times: info.total_times,
        sign_in_days: info.sign_in_days,
        month_points: info.month_points,
      },
    });
    // 已签到的分支：这次调用没有触发任何发放，所以不放 delta=0。
    // 0 会被读成「测过了、这次没给分」，而真相是「压根没打发放接口、无从测量」——
    // 与 pointsDelta 的约定一致（测不到返回 null，不返回 0）。
    //
    // 今日的额度通常已经由服务端在 00:00 自动发过（实测 login_bonus 的
    // granted_at 是当天 00:00:00），那份 500 属于「当天早些时候的发放」，
    // 不是这次调用带来的，记到这次头上会把两件事混成一件事。
    const cur = account._pointsBefore ? account._pointsBefore.left : null;
    const ret = {
      id: account.id, name: accounts.displayName(account), ok: true, already: true, info,
      points_delta: null, points_before: cur, points_after: cur,
    };

    // 补一条服务端自动发放的记录：500 确实到账了，只是不由这次调用触发。
    // 放在 already 分支里——签到成功时上游自己会带差额，不需要补。
    const grant = await recordAutoGrant(account, account._pointsBefore);
    if (grant) ret.auto_grant = grant;

    // 余额流水观测（web 键位 = 裸 String(id)）：已签到分支的当前值也是一次
    // 真实观测，基线比对留给 balance-hist
    if (Number.isFinite(cur)) {
      try { balanceHist.observe({ account: String(account.id), channel: 'web', balance: cur, source: 'checkin' }); } catch (e) { /* 记账失败不影响签到 */ }
    }
    records.append({
      type: 'checkin', account_id: account.id, account: accounts.displayName(account),
      ok: true, result: 'already', total_times: info.total_times,
      total_points: info.total_points,
      points_delta: null, points_before: cur, points_after: cur,
    });
    // 签到账本：某天某账号签到了（按月/按年的签到详情用它）。
    // 与 activity.jsonl 不同，这里只记「签成了」，且按天幂等。
    ledger.append({
      channel: 'dumate', account_id: account.id, account: accounts.displayName(account),
      at: Date.now(), source: 'already',
    });
    return ret;
  }

  const res = await web.api.claimLoginBonus(account.cookie, { agent });
  // 签到前先取一次积分快照，签完再取一次，差值就是这次签到发了多少。
  // 上游不返回金额，只能用余额差值——这是实测真值，不是估算。
  const afterPoints = res.ok ? await records.pointsSnapshot(account.cookie, account) : null;
  const pd = records.pointsDelta(account._pointsBefore, afterPoints);

  accounts.patchInternal(account.id, {
    last_error: res.ok ? '' : res.error,
    last_login_ok_at: res.ok ? Date.now() : account.last_login_ok_at,
    checkin: {
      ...account.checkin,
      last_at: res.ok ? Date.now() : account.checkin.last_at,
      last_result: res.ok ? 'claimed' : 'failed',
      total_times: info.total_times,
      sign_in_days: info.sign_in_days,
      month_points: info.month_points,
    },
  });
  records.append({
    type: 'checkin', account_id: account.id, account: accounts.displayName(account),
    ok: res.ok, result: res.ok ? 'claimed' : 'failed',
    total_times: info.total_times,
    total_points: info.total_points,
    points_delta: pd.delta,
    points_before: pd.before,
    points_after: pd.after,
    error: res.error || '',
  });
  if (res.ok) {
    ledger.append({
      channel: 'dumate', account_id: account.id, account: accounts.displayName(account),
      at: Date.now(), credits: pd.delta, source: 'claim',
    });
    // 余额流水观测（web 键位 = 裸 String(id)）：签到后的真实余额
    if (Number.isFinite(pd.after)) {
      try { balanceHist.observe({ account: String(account.id), channel: 'web', balance: pd.after, source: 'checkin' }); } catch (e) { /* 记账失败不影响签到 */ }
    }
  }
  return {
    id: account.id, name: accounts.displayName(account), ok: res.ok, error: res.error, info,
    points_delta: pd.delta, points_before: pd.before, points_after: pd.after,
  };
}

/**
 * 把积分包按到期日聚合成「哪天会损失多少」。
 *
 * 为什么按天而不是逐包：
 *   实测单账号 105 个包、其中 32 个同一天到期。逐包列出来是一屏噪音，
 *   而用户真正要回答的问题是「我哪天会损失多少积分」——按天合并就是那个答案。
 *
 * 窗口取 30 天而不是 7 天：搭子的包**最早也要 25 天后才到期**（实测 47 个包
 * 全落在 15-30 天区间，7 天内一个都没有），照抄 TRAE 的 7 天窗口这里会恒为空。
 * 两个通道的到期节奏不同（TRAE 是签到奖励天天有、搭子是月度包批量发），
 * 窗口必须按各自的分布取，不能共用。
 *
 * 只算 left > 0 的包：已用完的包到期不构成损失，报出来只是噪音。
 *
 * @returns {Array<{date:string, points:number, count:number, sources:string[]}>}
 *   按到期日升序。date 是本地日期 YYYY-MM-DD。
 */
function aggregateExpiring(packages, accountId, days = 30) {
  const now = Date.now();
  const limit = now + days * 86400000;
  const byDay = new Map();
  for (const p of (packages || [])) {
    if (!p || !p.expire_at || !(p.left > 0)) continue;
    if (p.expire_at > limit) continue;
    const d = new Date(p.expire_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = byDay.get(key) || { date: key, points: 0, count: 0, sources: new Set(), latest: 0 };
    cur.points += p.left;
    cur.count += 1;
    // 记下这一天的**最晚**到期时刻，用它算「还剩几天」——按当天末尾算会
    // 出现「30 天窗口里显示还剩 31 天」这种自相矛盾的行。
    if (p.expire_at > cur.latest) cur.latest = p.expire_at;
    // 来源名保留原样（login_bonus / growth_plan_2026_bonus 等）——它是判断
    // 「这笔是签到送的还是成长计划发的」的唯一线索
    cur.sources.add(String(p.source || p.package_type || ''));
    byDay.set(key, cur);
  }
  return [...byDay.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((x) => ({
      date: x.date,
      points: Number(x.points.toFixed(4)),
      count: x.count,
      sources: [...x.sources].filter(Boolean),
      daysLeft: Math.max(0, Math.ceil((x.latest - now) / 86400000)),
      // 该日**最晚**到期时刻（毫秒）——前端「≤1 天显示小时」用它，
      // 只有 ceil 后的天数看不出最后一天还剩几小时
      latest: x.latest,
    }));
}

const routes = [
  {
    // 桌面端登录态直读导入（2026-11-07 清单项 6 尾巴）：解密本机
    // auth.json（AES-256-GCM，排布实测见 src/auth-import.js 头注释），
    // 免去 DevTools 复制 Cookie 的手工步骤。BDUSS 去重由 accounts.create
    // 的重复检查兜底（同账号重复导入 409 如实报「已存在」）。
    method: 'POST',
    path: '/import-desktop',
    handler: ({ res, body }) => {
      const importer = require('../../auth-import');
      const r = importer.importDesktopAuth({ dir: body && body.dir });
      if (!r.ok) return sendJSON(res, 400, r);
      try {
        const created = accounts.create({
          cookie: r.cookie,
          name: String((body && body.name) || '').trim() || r.name_hint || '',
        });
        require('../../admin/auth').audit('admin', 'web_account_create', accounts.displayName(created), `via desktop auth.json（${r.cookie_count} 条 cookie）`);
        const fresh = accounts.getRaw(created.id) || created;
        return sendJSON(res, 200, {
          ok: true,
          cookie_count: r.cookie_count,
          skipped_domains: r.skipped_domains,
          account: accounts.toPublic({
            ...fresh,
            uid: fresh.uid || r.bce_user_id || '',
            nickname: fresh.nickname || r.name_hint || '',
          }),
        });
      } catch (e) {
        // 已存在同账号等：409 如实报，不吞
        return sendJSON(res, 409, { ok: false, error: e.message });
      }
    },
  },
  {
    // 登录器：打开一个受控浏览器窗口，登录后自动抓 cookie。
    // 这是「不依赖用户浏览器状态」的唯一自动路径——搭子没有登录票据接口，
    // 而系统浏览器的 cookie 库在运行时被独占锁定。
    method: 'POST',
    path: '/login/start',
    handler: async ({ res, body }) => {
      const r = await loginBrowser.start({ name: (body && body.name) || '' });
      if (!r.ok) return sendJSON(res, 400, r);
      require('../../admin/auth').audit('admin', 'web_login_start', '', r.browser_path || '');
      return sendJSON(res, 200, r);
    },
  },
  {
    // 轮询登录状态。成功时把 cookie 落库并清空暂存——同一份凭证不能入库两次。
    method: 'GET',
    path: '/login/poll',
    handler: async ({ res, req }) => {
      const s = loginBrowser.snapshot();
      if (s.status === 'success' && s.has_cookie) {
        const cookie = loginBrowser.takeCookie();
        const wantName = (req.url.match(/[?&]name=([^&]*)/) || [])[1];
        try {
          // 先问上游这个 cookie 是谁：昵称和 uid 是列表页展示要用的，
          // 拿不到就退回「账号 N」，不要让入库因为一次查询失败而中断
          let info = null;
          // 出站代理（E 包收口补点）：登录时还没有账号，走全局默认代理；
          // 配置非法按查不到信息处理（入库流程不中断）
          try { info = await web.api.userInfo(cookie, { agent: web.agentFor(null) }); } catch (e) { info = null; }
          const name = (wantName ? decodeURIComponent(wantName) : '') ||
            (info && info.nickname) || '';

          const created = accounts.create({ cookie, name });
          if (info && info.ok) {
            accounts.patchInternal(created.id, {
              uid: info.uid || '',
              nickname: info.nickname || '',
              last_login_ok_at: Date.now(),
              last_error: '',
            });
          }
          require('../../admin/auth').audit('admin', 'web_account_create', accounts.displayName(created), 'via browser');
          // 回包用**对外形状**：created 是 create() 的返回值，其中的 name
          // 已是显示名；但 uid/nickname 是这次刚拿到的，要合进去再序列化，
          // 否则新账号的回包会漏掉昵称（下一个接口才补上）。
          const fresh = accounts.getRaw(created.id) || created;
          return sendJSON(res, 200, {
            ...s, status: 'saved', has_cookie: false,
            account: accounts.toPublic({
              ...fresh, uid: info?.uid || '', nickname: info?.nickname || '',
            }),
          });
        } catch (e) {
          // 已存在同账号等：如实报错，但不把 cookie 丢掉——用户可改用粘贴方式
          return sendJSON(res, 409, { ...s, status: 'failed', message: e.message });
        }
      }
      return sendJSON(res, 200, s);
    },
  },
  {
    method: 'POST',
    path: '/login/cancel',
    handler: ({ res }) => sendJSON(res, 200, loginBrowser.cancel()),
  },
  {
    // 手动粘贴入口（保留）：浏览器登录器不可用时（无 Edge/Chrome）的兜底
    method: 'GET',
    path: '/login-url',
    handler: ({ res }) => sendJSON(res, 200, {
      url: LOGIN_URL,
      steps: [
        '点击链接，在打开的页面登录百度账号',
        '登录成功后回到本页，打开浏览器开发者工具（F12）',
        '切到 Application → Cookies → https://www.dumate.cn',
        '全选复制所有 cookie，粘贴到下面的输入框',
      ],
      note: '百度登录态位于 baidu.com 域，网页无法直接读取浏览器 cookie，所以需要手动复制一次',
      browser_available: !!loginBrowser.findBrowser(),
    }),
  },
  {
    method: 'GET',
    path: '',
    handler: ({ res }) => sendJSON(res, 200, {
      accounts: accounts.list(),
      login_url: LOGIN_URL,
      file: accounts.filePath(),
    }),
  },
  {
    method: 'POST',
    path: '',
    handler: ({ res, body }) => {
      try {
        const created = accounts.create(body || {});
        require('../../admin/auth').audit('admin', 'web_account_create', accounts.displayName(created));
        return sendJSON(res, 200, created);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    },
  },
  {
    // 验证 cookie 是否可用：调用 user/info，顺便把昵称回填到账号记录
    method: 'POST',
    path: '/verify',
    handler: async ({ res, body }) => {
      const cookie = accounts.normalizeCookie(body && body.cookie);
      if (!cookie) return sendJSON(res, 400, { error: 'cookie 不能为空' });
      // 出站代理（E 包收口补点）：验证时还没有账号，走全局默认代理；
      // 配置非法如实报错，不回退直连
      let r;
      try { r = await web.api.userInfo(cookie, { agent: web.agentFor(null) }); } catch (e) {
        return sendJSON(res, 502, { ok: false, error: e.message });
      }
      return sendJSON(res, r.ok ? 200 : 401, r.ok
        ? { ok: true, uid: r.uid, nickname: r.nickname }
        : { ok: false, error: r.error, expired: !!r.expired });
    },
  },
  {
    method: 'PATCH',
    path: '/:id',
    handler: ({ res, body, params }) => {
      try {
        const updated = accounts.update(params[0], body || {});
        if (!updated) return sendJSON(res, 404, { error: '账号不存在' });
        return sendJSON(res, 200, updated);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    },
  },
  {
    method: 'DELETE',
    path: '/:id',
    handler: ({ res, params }) => {
      const ok = accounts.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: '账号不存在' });
      require('../../admin/auth').audit('admin', 'web_account_delete', params[0]);
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    // 单账号签到
    method: 'POST',
    path: '/:id/checkin',
    handler: async ({ res, params }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const result = await doCheckin(acc);
      require('../../admin/auth').audit('admin', 'web_checkin', accounts.displayName(acc), result.ok ? 'ok' : result.error);
      return sendJSON(res, result.ok ? 200 : 502, result);
    },
  },
  {
    // 一键签到：并发跑所有启用账号，单个失败不影响其余
    method: 'POST',
    path: '/checkin-all',
    handler: async ({ res }) => {
      const targets = accounts.load().accounts.filter((a) => a.enabled);
      if (!targets.length) return sendJSON(res, 200, { results: [], ok_count: 0, fail_count: 0 });
      // 签到记录里要写账号名，先补昵称——否则 activity.jsonl 会冻结占位名
      await backfillAll(targets);
      const results = await Promise.all(targets.map((a) => doCheckin(a)));
      const ok = results.filter((r) => r.ok).length;
      require('../../admin/auth').audit('admin', 'web_checkin_all', '', `${ok}/${results.length}`);
      return sendJSON(res, 200, { results, ok_count: ok, fail_count: results.length - ok });
    },
  },
  {
    // 账号详情：签到信息 + 抽奖状态 + 积分，并发取
    method: 'GET',
    path: '/:id/status',
    handler: async ({ res, params }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });

      const [bonus, draw, points, tasks] = await Promise.all([
        web.api.loginBonusInfo(acc.cookie, { agent: web.agentFor(acc) }),
        web.api.drawStatus(acc.cookie, { agent: web.agentFor(acc) }),
        web.api.quotaOverview(acc.cookie, { agent: web.agentFor(acc) }),
        web.api.tasks(acc.cookie, { agent: web.agentFor(acc) }),
      ]);

      // 登录态失效是最需要立刻知道的状态，单独置顶
      const expired = [bonus, draw, points].some((r) => r.expired);

      // 顺手回填缓存，列表页不必再单独请求
      accounts.patchInternal(acc.id, {
        last_error: expired ? '登录态已失效' : '',
        checkin: bonus.ok ? {
          ...acc.checkin,
          last_result: bonus.has_issued ? 'already' : acc.checkin.last_result,
          total_times: bonus.total_times,
          sign_in_days: bonus.sign_in_days,
          month_points: bonus.month_points,
        } : acc.checkin,
        lottery: draw.ok ? {
          ...acc.lottery,
          remaining: draw.remaining_draws,
          my_prizes: draw.my_prizes,
        } : acc.lottery,
        points: points.ok ? { left: points.left, total: points.total, used: points.used } : acc.points,
        points_at: points.ok ? Date.now() : acc.points_at,
      });

      return sendJSON(res, 200, {
        id: acc.id,
        name: accounts.displayName(acc),
        expired,
        checkin: bonus.ok ? {
          has_issued: bonus.has_issued,
          total_times: bonus.total_times,
          sign_in_days: bonus.sign_in_days,
          month_points: bonus.month_points,
        } : { error: bonus.error },
        lottery: draw.ok ? {
          remaining_draws: draw.remaining_draws,
          prizes: draw.prizes,
          my_prizes: draw.my_prizes,
          winning_records: draw.winning_records,
        } : { error: draw.error },
        points: points.ok ? {
          left: points.left, total: points.total, used: points.used,
          subscribed: points.subscribed, throttled: points.throttled,
          packages: points.packages,
        } : { error: points.error },
        tasks: tasks.ok ? tasks.tasks : { error: tasks.error },
      });
    },
  },
  {
    // 抽奖。次数由服务端扣减，这里只负责发起并把结果写回。
    method: 'POST',
    path: '/:id/draw',
    handler: async ({ res, params, body }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const times = Math.max(1, Math.min(10, parseInt((body && body.times) || 1, 10)));

      const results = [];
      for (let i = 0; i < times; i++) {
        // 幂等键必须每次不同：复用会让服务端把后续请求当成重复提交
        const rid = crypto.randomUUID();
        const r = await web.api.draw(acc.cookie, rid, { agent: web.agentFor(acc) });
        results.push(r);
        if (!r.ok) break;
        if (r.remaining_draws !== null && r.remaining_draws <= 0) break;
      }

      const last = results[results.length - 1] || {};
      accounts.patchInternal(acc.id, {
        lottery: {
          ...acc.lottery,
          remaining: last.remaining_draws !== undefined ? last.remaining_draws : acc.lottery.remaining,
          last_at: Date.now(),
          last_result: results.every((r) => r.ok) ? 'ok' : 'failed',
        },
      });
      require('../../admin/auth').audit('admin', 'web_draw', accounts.displayName(acc), `${results.length} 次`);
      return sendJSON(res, 200, {
        results,
        ok_count: results.filter((r) => r.ok).length,
        remaining_draws: last.remaining_draws,
      });
    },
  },
  {
    // 领奖
    method: 'POST',
    path: '/:id/claim-prize',
    handler: async ({ res, params, body }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const prizeId = body && body.prize_id;
      if (!prizeId) return sendJSON(res, 400, { error: '缺少 prize_id' });
      const r = await web.api.claimPrize(acc.cookie, prizeId, undefined, { agent: web.agentFor(acc) });
      return sendJSON(res, r.ok ? 200 : 502, r);
    },
  },
  {
    method: 'GET',
    path: '/:id/points',
    handler: async ({ res, params }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const [points, charge, usage] = await Promise.all([
        web.api.quotaOverview(acc.cookie, { agent: web.agentFor(acc) }),
        web.api.chargeRecords(acc.cookie, { agent: web.agentFor(acc) }),
        web.api.usageRecords(acc.cookie, { agent: web.agentFor(acc) }),
      ]);
      if (!points.ok) return sendJSON(res, 502, { error: points.error, expired: !!points.expired });
      return sendJSON(res, 200, {
        ...points,
        charge_records: charge.ok ? charge.records : null,
        usage_records: usage.ok ? usage.records : null,
      });
    },
  },
  {
    // 所有账号的积分明细（并发拉取）。
    // 积分明细页原先只看本地后端那一个账号，但账号管理里可以有多份网页凭证，
    // 每份都能独立查积分——只看一个会漏掉其余账号。
    //
    // 每个账号除余额外还要带完整的派生视图（按来源 / 每日发放 / 临期 /
    // 逐笔），这样前端切换账号时不必再逐账号打一次上游。
    method: 'GET',
    path: '/points-all',
    handler: async ({ res, req }) => {
      const force = /[?&]refresh=1/.test(req.url || '');
      const list = accounts.load().accounts.filter((a) => a.enabled);

      // 回包要带显示名，先补昵称——这条路径也触达上游，没理由不顺手补
      await backfillAll(list);

      const results = await Promise.all(list.map(async (a) => {
        // name 给**解析后的显示名**（占位名会被真实昵称顶掉），
        // nickname 保持原义（上游真实昵称，可能为空）——两个都留着，
        // 前端与操作记录各自按需取用
        const base = { id: a.id, name: accounts.displayName(a), nickname: a.nickname || '' };
        // 明细只缓存在内存里：额度包可能有上百个，写回 web-accounts.json
        // 会让账号文件无谓膨胀。磁盘上仍然只留 left/total/used 摘要。
        const hit = detailCache.get(a.id);
        if (!force && hit && Date.now() - hit.at < DETAIL_CACHE_TTL_MS) {
          // **base 后展开**：缓存里冻着入缓存那一刻的 name，而 base 是本次
          // 刚解析的显示名。反过来写会让 60s 内改好的昵称被旧名盖回去——
          // 仪表盘显示「张三」、积分明细显示「账号 1」。
          return { ...hit.data, ...base, cached: true };
        }

        // 出站代理（E 包收口补点）：配置非法该账号出错误行，其余账号照常
        let agent;
        try { agent = web.agentFor(a); } catch (e) {
          return { ...base, ok: false, error: e.message, expired: false };
        }
        const r = await web.api.quotaOverview(a.cookie, { agent });
        if (!r.ok) {
          accounts.patchInternal(a.id, { last_error: r.error });
          return { ...base, ok: false, error: r.error, expired: !!r.expired };
        }

        const data = {
          ...base,
          ok: true,
          left: r.left,
          total: r.total,
          used: r.used,
          subscribed: r.subscribed,
          throttled: r.throttled,
          // 与本地后端共用同一份聚合，两边口径才不会分叉
          ...pointsAgg.aggregate(r.packages),
        };
        detailCache.set(a.id, { at: Date.now(), data });
        accounts.patchInternal(a.id, {
          points: { left: r.left, total: r.total, used: r.used },
          points_at: Date.now(),
          last_error: '',
        });
        return { ...data, cached: false };
      }));

      const ok = results.filter((r) => r.ok);
      return sendJSON(res, 200, {
        accounts: results,
        // 汇总口径：只累加取到数据的账号，避免失败的账号把总数拉低
        totals: {
          accounts: results.length,
          ok_accounts: ok.length,
          left: ok.reduce((s, r) => s + (r.left || 0), 0),
          total: ok.reduce((s, r) => s + (r.total || 0), 0),
          used: ok.reduce((s, r) => s + (r.used || 0), 0),
        },
      });
    },
  },
  {
    // 任务状态（只读）。列出每个账号的任务与完成情况，不执行任何动作。
    method: 'GET',
    path: '/tasks',
    handler: async ({ res }) => {
      const list = await taskRunner.listTasks();
      return sendJSON(res, 200, {
        accounts: list,
        auto_types: [...taskRunner.AUTO_TYPES],
        // 说明自动化边界，避免「为什么这几个没做」被当成漏跑
        not_automatable: {
          PC_PUSH: '网页端不支持，需在桌面端或移动端完成',
          INVITATION: '需要真人注册',
          INVITED: '需要他人的邀请码',
        },
        runs: taskRunner.recentRuns(50),
      });
    },
  },
  {
    // 任务执行历史（常驻列表用）。与 /tasks 里的 runs 同源，
    // 但独立成一个接口，便于列表单独刷新而不必重算各账号的任务状态。
    method: 'GET',
    path: '/tasks/runs',
    handler: async ({ res, req }) => {
      const limit = Math.min(500, Math.max(1, parseInt((req.url.match(/[?&]limit=(\d+)/) || [])[1] || '100', 10) || 100));
      return sendJSON(res, 200, { limit, rows: taskRunner.recentRuns(limit) });
    },
  },
  {
    // 跑任务：把各账号可自动完成的任务做完（QUERY_INPUT / USE_SKILL）
    method: 'POST',
    path: '/tasks/run',
    handler: async ({ res, body }) => {
      const only = body && body.account_id ? Number(body.account_id) : null;
      let results;
      if (only) {
        const acc = accounts.getRaw(only);
        if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
        results = [await taskRunner.runForAccount(acc)];
      } else {
        results = await taskRunner.runAll();
      }
      const done = results.reduce((s, r) => s + (r.done_count || 0), 0);
      const fail = results.reduce((s, r) => s + (r.fail_count || 0), 0);
      // 账号级异常（如执行器抛错）要透传给界面：runAll 把异常吞进
      // { ok:false, error } 里，不透传的话界面只会显示「没有可自动完成的任务」，
      // 真实原因（代码炸了）被静默吞掉
      const errors = results.filter((r) => r.error && !r.ok).map((r) => `${r.name || r.account_id}: ${r.error}`);
      require('../../admin/auth').audit('admin', 'task_run', '', `完成 ${done}，失败 ${fail}${errors.length ? '，异常 ' + errors.length : ''}`);
      return sendJSON(res, 200, { results, done_count: done, fail_count: fail, errors });
    },
  },
  {
    // 一键抽奖：把所有账号的可用次数抽完（可选自动领奖）
    method: 'POST',
    path: '/draw-all',
    handler: async ({ res, body }) => {
      const autoClaim = !body || body.claim !== false;
      const list = accounts.load().accounts.filter((a) => a.enabled);
      const out = [];

      for (const a of list) {
        // 出站代理（E 包收口补点）：配置非法该账号出错误行，其余账号照常
        let agent;
        try { agent = web.agentFor(a); } catch (e) {
          out.push({ id: a.id, name: accounts.displayName(a), ok: false, error: e.message });
          continue;
        }
        const st = await web.api.drawStatus(a.cookie, { agent });
        if (!st.ok) { out.push({ id: a.id, name: accounts.displayName(a), ok: false, error: st.error }); continue; }

        // 抽奖前后的积分快照：抽到积分类奖品会让总量上涨，
        // 差值就是这一轮实际到手的积分。
        const beforePoints = await records.pointsSnapshot(a.cookie, a);

        let remaining = st.remaining_draws || 0;
        const draws = [];
        // 抽到没次数为止。上限 20 次防止服务端计数异常时无限循环。
        for (let i = 0; i < Math.min(remaining, 20); i++) {
          const r = await web.api.draw(a.cookie, crypto.randomUUID(), { agent });
          draws.push(r);
          if (!r.ok) break;
          if (r.remaining_draws !== null && r.remaining_draws <= 0) break;
        }

        // 领奖：只有「非 SUCCESS 且需要联系方式」的奖品才需要领。
        // 实测所有积分/会员奖品抽到即 status=SUCCESS，自动到账，无需领取；
        // 之前按 claimed 字段判断（该字段不存在）导致把已完成的当成待领，
        // 逐个去领反而报「参数错误:DrawRecordID」。
        let claimed = [];
        if (autoClaim) {
          const after = await web.api.drawStatus(a.cookie, { agent });
          const pending = (after.ok ? after.my_prizes : []).filter(
            (p) => p.status && p.status !== 'SUCCESS' && p.draw_record_id,
          );
          for (const p of pending.slice(0, 10)) {
            const c = await web.api.claimPrize(a.cookie, p.draw_record_id, undefined, { agent });
            claimed.push({ prize: p.prize_name, ok: c.ok, error: c.error || '' });
          }
        }

        // 抽到的奖品按类型汇总，让界面能直接说「抽到了什么」
        const finalStatus = await web.api.drawStatus(a.cookie, { agent });
        const wonPrizes = [];
        if (finalStatus.ok) {
          const before = new Set((st.my_prizes || []).map((p) => p.draw_record_id));
          for (const p of (finalStatus.my_prizes || [])) {
            if (!before.has(p.draw_record_id)) {
              wonPrizes.push({ name: p.prize_name, type: p.prize_type, value: p.prize_value, status: p.status });
            }
          }
        }

        // 一次抽奖可能连抽多次，按「每次抽到的奖品」逐条记录，
        // 这样记录页能列出具体中了什么而不是只写「抽了 N 次」。
        // 积分变化记在第一条上（整轮的总变化），避免每条都重复同一个数。
        const dp = records.pointsDelta(beforePoints, await records.pointsSnapshot(a.cookie, a));
        for (let i = 0; i < wonPrizes.length; i++) {
          const w = wonPrizes[i];
          records.append({
            type: 'draw', account_id: a.id, account: accounts.displayName(a),
            ok: true, prize: w.name, prize_type: w.type, prize_value: w.value,
            points_delta: i === 0 ? dp.delta : null,
            points_before: i === 0 ? dp.before : null,
            points_after: i === 0 ? dp.after : null,
          });
        }
        if (!wonPrizes.length && draws.length) {
          records.append({
            type: 'draw', account_id: a.id, account: accounts.displayName(a),
            ok: draws.some((d) => d.ok), count: draws.filter((d) => d.ok).length,
            points_delta: dp.delta, points_before: dp.before, points_after: dp.after,
          });
        }

        out.push({
          id: a.id, name: accounts.displayName(a), ok: true,
          before: remaining,
          drawn: draws.filter((d) => d.ok).length,
          remaining_after: draws.length ? draws[draws.length - 1].remaining_draws : remaining,
          results: draws,
          claimed,
          won: wonPrizes,
          points_delta: dp.delta,
        });
      }

      const total = out.reduce((s, r) => s + (r.drawn || 0), 0);
      require('../../admin/auth').audit('admin', 'draw_all', '', `抽奖 ${total} 次`);
      return sendJSON(res, 200, { results: out, drawn_count: total });
    },
  },
  {
    // 任务轮询开关与状态。间隔的定法（含抖动）写在 rationale 里一并返回，
    // 界面直接展示，避免「这个间隔是怎么来的」只能靠猜。
    method: 'GET',
    path: '/tasks/schedule',
    handler: ({ res }) => sendJSON(res, 200, taskScheduler.snapshot()),
  },
  {
    method: 'POST',
    path: '/tasks/schedule',
    handler: ({ res, body }) => {
      try {
        const r = taskScheduler.configure(body || {});
        require('../../admin/auth').audit('admin', 'task_schedule_config',
          r.enabled ? 'on' : 'off', `${r.minutes} 分钟`);
        return sendJSON(res, 200, r);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    },
  },
  {
    // 立即跑一轮（不等定时器），用于验证配置
    method: 'POST',
    path: '/tasks/poll-now',
    handler: async ({ res }) => {
      const r = await taskScheduler.runOnce('manual');
      return sendJSON(res, 200, r);
    },
  },
  {
    // 操作记录：签到 / 任务 / 抽奖，按时间倒序。
    // 支持按账号、类型、天数过滤，前端用同一份数据出列表和日历两种视图。
    method: 'GET',
    path: '/records',
    handler: ({ res, req }) => {
      const q = (k) => (req.url.match(new RegExp(`[?&]${k}=([^&]*)`)) || [])[1];
      const limit = Math.min(1000, parseInt(q('limit') || '200', 10) || 200);
      const accountId = q('account_id') ? Number(decodeURIComponent(q('account_id'))) : null;
      const type = q('type') ? decodeURIComponent(q('type')) : null;
      const days = Math.min(180, Math.max(1, parseInt(q('days') || '30', 10) || 30));
      const since = Date.now() - days * 86400000;

      const { rows, total } = records.read({ limit, account_id: accountId, type, since });
      const daily = records.dailySummary(days);
      // 历史记录里的 account 是**写入当时冻结的字符串**：改昵称前写的那些行
      // 会永远停在占位名「账号 N」，而签到日历（实时解析）已经显示「张三」
      // ——同一页两个名字。记录本身是既成事实不该改写，但**显示名是账号的
      // 属性**，所以读取时按 account_id 重解析一次。账号已删除时回落到
      // 冻结值（那时它确实只剩这个名字了）。
      const nameOf = (id, fallback) => {
        const raw = accounts.getRaw(id);
        return raw ? accounts.displayName(raw) : (fallback || '');
      };
      for (const r of rows) r.account = nameOf(r.account_id, r.account);
      for (const d of daily) d.account = nameOf(d.account_id, d.account);
      return sendJSON(res, 200, {
        rows,
        total,
        days,
        // 日历视图要的按天聚合
        daily,
        // 记录类型与含义，前端据此渲染标签，避免各处自己硬编码
        types: {
          checkin: '签到',
          task: '任务',
          draw: '抽奖',
          // 服务端自动发放，不是本系统触发的动作，单独一类
          grant: '自动发放',
        },
      });
    },
  },
  {
    // 各账号的签到日历（直接取上游的 sign_in_days，不受本地记录起点限制）
    method: 'GET',
    path: '/checkin-calendar',
    handler: async ({ res, req }) => {
      const months = Math.min(6, Math.max(1, parseInt((req.url.match(/[?&]months=(\d+)/) || [])[1] || '1', 10)));
      const list = accounts.load().accounts.filter((a) => a.enabled);
      const out = [];

      for (const a of list) {
        // 出站代理（E 包收口补点）：配置非法该账号出错误行，其余账号照常
        let agent;
        try { agent = web.agentFor(a); } catch (e) {
          out.push({ account_id: a.id, name: accounts.displayName(a), ok: false, error: e.message });
          continue;
        }
        const info = await web.api.loginBonusInfo(a.cookie, { agent });
        out.push({
          account_id: a.id,
          name: accounts.displayName(a),
          nickname: a.nickname || '',
          ok: info.ok,
          error: info.ok ? '' : info.error,
          has_issued_today: info.ok ? info.has_issued : null,
          total_times: info.ok ? info.total_times : null,
          // 上游返回的是「哪些天签过」，这是权威数据；
          // 本地记录只能回答「我什么时候去点的」，两者互补
          sign_in_days: info.ok ? (info.sign_in_days || []) : [],
        });
      }
      return sendJSON(res, 200, { accounts: out, months });
    },
  },
  {
    // 仪表盘聚合：一次给全所有账号的关键指标，避免前端为每个账号发多次请求。
    //
    // 只聚合我们真实拥有的数据。参考实现里的「连败降权」「Redis 模式」
    // 在这套系统里没有对应机制（池是轮询 + 冷却，没有降权，也不用 Redis），
    // 所以不编造这两个字段——界面上缺一个格子好过填一个假数字。
    method: 'GET',
    path: '/dashboard',
    handler: async ({ res }) => {
      const list = accounts.load().accounts;
      const gatewayPort = parseInt(process.env.DUMATE_WEB_GATEWAY_PORT || '9084', 10);

      // 先补昵称再算指标：下面各处（健康快照、即将过期明细）都要用显示名，
      // 补完这一轮后续全部拿到真实昵称。**只对启用且昵称为空的账号**打上游，
      // 失败走负缓存——见 backfillAll 的注释。
      await backfillAll(list);

      // 网关的实时池状态（token 缓存、冷却）只在网关进程里，能读到就用，
      // 读不到也不影响其余指标
      const gw = await new Promise((resolve) => {
        const req = require('http').request(
          { host: '127.0.0.1', port: gatewayPort, path: '/health', method: 'GET', timeout: 3000 },
          (r) => {
            let d = '';
            r.setEncoding('utf8');
            r.on('data', (c) => { d += c; });
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
          },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
      });

      // 每个账号的积分与订阅到期，用于健康快照。
      // 用缓存优先：仪表盘是高频页面，不必每次都为每个账号打一次上游。
      //
      // 顺路把**积分包的到期分布**算出来（顶部「即将过期」卡与明细表要用）。
      // 上游 packages 里每个包都带 left 与 expire_at，但原实现只挑了
      // subscription 的到期日，包维度整个丢了——于是答不出「哪些积分快作废」。
      //
      // **按天聚合而不是逐包列**：实测搭子单账号有 105 个包、其中 32 个同一天
      // 到期，逐包列出来是一屏噪音；按天合并后是几行，一眼看得出「哪天要损失多少」。
      const detail = await Promise.all(list.map(async (a) => {
        const cachedFresh = a.points && a.points_at && Date.now() - a.points_at < 60_000;
        if (cachedFresh && a.points.expire_at) {
          return {
            id: a.id, points: a.points, expire_at: a.points.expire_at,
            expiring: a.points.expiring || [], cached: true,
          };
        }
        // 出站代理（E 包收口补点）：配置非法该账号出错误行，其余账号照常
        let agent;
        try { agent = web.agentFor(a); } catch (e) {
          return {
            id: a.id, points: a.points || null,
            expire_at: a.points ? a.points.expire_at : null,
            expiring: (a.points && a.points.expiring) || [],
            error: e.message,
          };
        }
        const r = await web.api.quotaOverview(a.cookie, { agent });
        if (!r.ok) {
          return {
            id: a.id, points: a.points || null,
            expire_at: a.points ? a.points.expire_at : null,
            expiring: (a.points && a.points.expiring) || [],
            error: r.error,
          };
        }
        const sub = (r.packages || []).find((p) => p.kind === 'subscription' && p.expire_at);
        const summary = {
          left: r.left, total: r.total, used: r.used,
          expire_at: sub ? sub.expire_at : null,
          subscribed: r.subscribed,
          expiring: aggregateExpiring(r.packages, a.id),
        };
        accounts.patchInternal(a.id, { points: summary, points_at: Date.now(), last_error: '' });
        return { id: a.id, points: summary, expire_at: summary.expire_at, expiring: summary.expiring };
      }));

      const byId = new Map(detail.map((d) => [d.id, d]));
      const now = Date.now();

      const enriched = list.map((a) => {
        const d = byId.get(a.id) || {};
        const p = d.points || {};
        const daysLeft = d.expire_at ? Math.ceil((d.expire_at - now) / 86400000) : null;
        return {
          id: a.id,
          name: accounts.displayName(a),
          nickname: a.nickname || '',
          enabled: a.enabled,
          points: p.left !== undefined ? p.left : null,
          points_total: p.total !== undefined ? p.total : null,
          subscribed: !!p.subscribed,
          // 会员剩余天数：参考图的健康条用它当「寿命」
          days_left: daysLeft,
          // 账号存活天数（从 created_at 算到今天）。与 days_left 是两回事——
          // 那个是订阅有效期，这是账号用了多久。没有 created_at 就 null
          days_alive: a.created_at ? Math.floor((now - a.created_at) / 86400000) : null,
          expire_at: d.expire_at || null,
          checkin_result: (a.checkin && a.checkin.last_result) || '',
          last_error: a.last_error || '',
        };
      });

      const enabled = enriched.filter((a) => a.enabled);
      const withPoints = enabled.filter((a) => a.points !== null);
      // 低余额阈值：低于 200 视为需要注意（与参考图口径一致）
      const lowPoints = withPoints.filter((a) => a.points < 200).length;
      const expiringSoon = enabled.filter((a) => a.days_left !== null && a.days_left <= 7).length;

      // 即将过期的积分（按账号 × 到期日摊平，供仪表盘明细表）。
      // 与上面的 expiring_soon 不是一回事：那个数的是**账号订阅**快到期，
      // 这个是**积分包**快作废。两者都叫「即将过期」但含义不同，
      // 界面上要分开写，否则会把「订阅要续费」误读成「积分要没了」。
      const expiringPoints = [];
      for (const a of enriched) {
        const d = byId.get(a.id) || {};
        for (const x of (d.expiring || [])) {
          expiringPoints.push({
            account: accounts.displayName(a),
            accountId: a.id,
            date: x.date,
            points: x.points,
            count: x.count,
            sources: x.sources,
            daysLeft: x.daysLeft,
            // 最晚到期时刻（前端 ≤1 天显示小时用它）——这里是**重新映射**
            // 字段，不加 latest 前端就拿不到（2026-11-01）
            latest: x.latest,
          });
        }
      }
      expiringPoints.sort((x, y) => (x.date < y.date ? -1 : 1));

      // 临期快照（FEFO 数据源）：网关选号读它优先消耗临期积分。这里本就在
      // 拉额度概览，顺手落盘；快照陈旧时网关自动退回普通轮询，可用性
      // 不依赖这份数据（src/expiring.js）。按账号取最早到期日（latest）。
      // 概览失败的账号走 keepIds 保留旧条目——「查不到」不等于「无临期」
      const fefoMin = new Map();
      for (const x of expiringPoints) {
        const p = fefoMin.get(x.accountId);
        if (p == null || x.latest < p) fefoMin.set(x.accountId, x.latest);
      }
      expiringSnap.update('dumate',
        [...fefoMin].map(([accountId, nearest]) => ({ accountId, nearest })),
        { keepIds: [...byId.values()].filter((d) => d.error).map((d) => d.id) });

      return sendJSON(res, 200, {
        // 顶部卡片
        summary: {
          total: enriched.length,
          enabled: enabled.length,
          disabled: enriched.length - enabled.length,
          // 「有效期内」= 有凭证且订阅未过期
          valid: enabled.filter((a) => a.days_left === null || a.days_left > 0).length,
          expiring_soon: expiringSoon,
          low_points: lowPoints,
          points_left: withPoints.reduce((s, a) => s + (a.points || 0), 0),
          points_total: withPoints.reduce((s, a) => s + (a.points_total || 0), 0),
          // 30 天内会作废的积分合计（与 expiring_soon 的账号数分开报）
          expiring_points: Number(expiringPoints.reduce((s, x) => s + x.points, 0).toFixed(4)),
          expiring_days: 30,
        },
        // FEFO 快照的新鲜度（排障用：网关有没有在按临期优先选号）
        fefo: expiringSnap.info('dumate'),
        // 即将过期的积分明细（账号 × 到期日）。空数组 = 30 天内无损失
        expiring_points_rows: expiringPoints,
        // 上游/池状态
        upstream: {
          gateway_online: !!gw,
          gateway_port: gatewayPort,
          accounts_total: gw ? gw.accounts_total : null,
          accounts_ready: gw ? gw.accounts_ready : null,
          cooling: gw ? (gw.accounts || []).filter((x) => x.cooling).length : null,
          // 网关未启动时这些数字没有意义，如实标 null 而不是填 0
        },
        accounts: enriched,
      });
    },
  },
  {
    // 账号池运维端点（GAP F6a,随施工包 A）。惩罚态落在 data/pool-state.json
    // （src/pool.js,跨进程共享）:这里的动作立即写盘,网关进程 5s 防抖落盘前会
    // 按记录级 rev（锁内单调版本号）吸纳本进程的更新,不会被覆盖。
    //
    // 动作语义:
    //   freeze  冻结（hard 冷却,余额恢复可解冻）
    //   revive  复活:清禁用+暂停+全部冷却+熔断+防误杀计数
    //   pause   暂停选号（不动惩罚域,保活/签到照常）
    //   resume  解除暂停
    //   balance 手动余额刷新:快照写入 + 余额>0 解冻硬冷却（签到→解冻闭环的
    //           手动等价,B 包把这条链路自动化）
    method: 'POST',
    path: '/pool/:id/freeze',
    handler: ({ res, params, body }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const b = body || {};
      const ms = Number(b.ms != null ? b.ms : (Number(b.minutes) || 0) * 60000);
      if (!Number.isFinite(ms) || ms <= 0) return sendJSON(res, 400, { error: '缺少冻结时长（ms 或 minutes）' });
      accountPool.freeze(acc.id, ms, String(b.reason || '人工冻结'));
      require('../../admin/auth').audit('admin', 'pool_freeze', accounts.displayName(acc),
        `${Math.round(ms / 60000)} 分钟 ${b.reason || ''}`);
      return sendJSON(res, 200, { ok: true, state: accountPool.status(acc.id) });
    },
  },
  {
    method: 'POST',
    path: '/pool/:id/revive',
    handler: ({ res, params }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      accountPool.revive(acc.id);
      require('../../admin/auth').audit('admin', 'pool_revive', accounts.displayName(acc));
      return sendJSON(res, 200, { ok: true, state: accountPool.status(acc.id) });
    },
  },
  {
    method: 'POST',
    path: '/pool/:id/pause',
    handler: ({ res, params }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      accountPool.pause(acc.id);
      require('../../admin/auth').audit('admin', 'pool_pause', accounts.displayName(acc));
      return sendJSON(res, 200, { ok: true, state: accountPool.status(acc.id) });
    },
  },
  {
    method: 'POST',
    path: '/pool/:id/resume',
    handler: ({ res, params }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      accountPool.resume(acc.id);
      require('../../admin/auth').audit('admin', 'pool_resume', accounts.displayName(acc));
      return sendJSON(res, 200, { ok: true, state: accountPool.status(acc.id) });
    },
  },
  {
    method: 'POST',
    path: '/pool/:id/balance',
    handler: async ({ res, params }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      // 出站代理（E 包收口补点）：手动余额刷新与对话同出口，配置非法如实报 502
      let agent;
      try { agent = web.agentFor(acc); } catch (e) {
        return sendJSON(res, 502, { ok: false, error: e.message });
      }
      const r = await web.api.quotaOverview(acc.cookie, { agent });
      if (!r.ok) return sendJSON(res, 502, { ok: false, error: r.error, expired: !!r.expired });
      accountPool.setCredits(acc.id, r.left, r.total);
      const { unfrozen } = accountPool.reenableIfCredits(acc.id, r.left, r.total);
      // 余额流水观测（C 包挂钩）：手动刷新点，web 键位 = 裸 String(id)
      try { balanceHist.observe({ account: String(acc.id), channel: 'web', balance: r.left, source: 'manual' }); } catch (e) { /* 记账失败不影响刷新 */ }
      // 余额顺手回写账号记录（仪表盘复用现有缓存口径）
      accounts.patchInternal(acc.id, {
        points: { left: r.left, total: r.total, used: r.used },
        points_at: Date.now(),
        last_error: '',
      });
      require('../../admin/auth').audit('admin', 'pool_balance_refresh',
        accounts.displayName(acc), `left=${r.left}${unfrozen ? ',已解冻' : ''}`);
      return sendJSON(res, 200, {
        ok: true, left: r.left, total: r.total, unfrozen,
        state: accountPool.status(acc.id),
      });
    },
  },
  {
    method: 'GET',
    path: '/pool',
    handler: ({ res }) => {
      // 账号池的运行态（token 缓存、成功/失败计数、冷却）只存在于网关进程内，
      // 管理端是另一个进程读不到。这里返回「配置 + 最近一次探测结果」，
      // 需要实时运行态就查网关的 /health。
      //
      // 惩罚态（冷却/熔断/禁用/余额快照）已随施工包 A 落盘到 pool-state.json,
      // 管理端能直接读——先吸纳网关 5s 防抖内新写的内容再出视图。
      const gatewayPort = parseInt(process.env.DUMATE_WEB_GATEWAY_PORT || '9084', 10);
      accountPool.reloadIfChanged();
      const poolState = {
        counts: accountPool.counts(),
        entries: accounts.load().accounts.map((a) => ({
          id: a.id,
          name: accounts.displayName(a),
          ...accountPool.status(a.id),
        })),
      };
      const list = accounts.load().accounts.map((a) => ({
        id: a.id,
        name: accounts.displayName(a),
        nickname: a.nickname || '',
        enabled: a.enabled,
        last_error: a.last_error || '',
        points: a.points ? a.points.left : null,
        checkin_result: (a.checkin && a.checkin.last_result) || '',
      }));

      // 顺带探一下网关是否在跑，界面据此提示「先启动 9084」
      const req = require('http').request(
        { host: '127.0.0.1', port: gatewayPort, path: '/health', method: 'GET', timeout: 3000 },
        (r) => {
          let d = '';
          r.setEncoding('utf8');
          r.on('data', (c) => { d += c; });
          r.on('end', () => {
            let health = null;
            try { health = JSON.parse(d); } catch (e) { health = null; }
            sendJSON(res, 200, { gateway_port: gatewayPort, gateway_online: true, health, accounts: list, pool_state: poolState });
          });
        },
      );
      req.on('error', () => sendJSON(res, 200, {
        gateway_port: gatewayPort, gateway_online: false, health: null, accounts: list, pool_state: poolState,
      }));
      req.on('timeout', () => { req.destroy(); });
      req.end();
    },
  },
  {
    // 探测某账号能否跑模型（走一次真实的 1-token 调用）
    method: 'POST',
    path: '/:id/probe-model',
    handler: async ({ res, params }) => {
      const acc = accounts.getRaw(params[0]);
      if (!acc) return sendJSON(res, 404, { error: '账号不存在' });
      const r = await webPool.probe(acc.id);
      return sendJSON(res, r.ok ? 200 : 502, r);
    },
  },
];

module.exports = { routes, LOGIN_URL, doCheckin };
