// src/admin/routes/route-groups.js - 路由组（P1-7）的只读观测面
//
// 为什么先只读：组的写入是「改路由表」，写错的后果是请求静默走错通道（响应仍 200）。
// 第一批先把**当前会被选中的是谁、跳过了谁、为什么**暴露出来——没有这个读数，
// 编辑界面只是让人更容易写出看不见的错误。配置文件仍是 `data/route-groups.json`
// （mtime 热读），改完不用重启。
const router = require('../../upstream-router');
const routeGroups = require('../../route-groups');

const routes = [
  {
    // 每组逐个成员解析通道 + 查可用性：返回的是**此刻**的择优结果，
    // 与真实请求走的是同一对函数（resolve / availability），不是另写一份判据。
    method: 'GET',
    path: '/',
    handler: ({ res }) => {
      const loaded = routeGroups.Load();
      const groups = loaded.groups.map((g) => {
        const members = g.members.map((m, i) => {
          const r = router.resolve(m);
          if (r.error) {
            return { index: i + 1, model: m, channel: '', target: '', ok: false, reason: r.error };
          }
          let av = null;
          try { av = router.availability(r.channel); } catch (e) { av = { ok: false, reason: e.message }; }
          return {
            index: i + 1,
            model: m,
            channel: r.channel,
            target: r.model || m,
            ok: !!(av && av.ok),
            reason: av && av.reason ? av.reason : '',
          };
        });
        const chosen = members.find((x) => x.ok) || null;
        return {
          name: g.name,
          members,
          // 此刻会走谁；null = 全部不可用（真实请求会回 503 + 逐条原因）
          chosen: chosen ? { index: chosen.index, model: chosen.model, channel: chosen.channel } : null,
        };
      });
      return require('../router').sendJSON(res, 200, {
        ok: true,
        file: routeGroups.FILE,
        filePath: routeGroups.filePath(),
        maxMembers: routeGroups.MAX_MEMBERS,
        groups,
        // 配置里被丢弃的条目要露出来：手写文件的错别字只会在请求时才见效，
        // 这里当场报出来（含原因），比事后猜便宜得多
        dropped: loaded.dropped,
      });
    },
  },
];

module.exports = { routes };
