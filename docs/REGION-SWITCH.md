# 国内 / 国际区域切换

> 本文件从 `CLAUDE.md` 的「项目定位」章节按主题拆出，内容为原文照搬（未改写）。
> 改通道细节请改这里；`CLAUDE.md` 只保留核心架构与索引。

**全页面的国内/国际区分（2026-11-03 同日，bsk 逐页真机验证过）**。用户
要求「每个页面都区分」，落地清单：

1. **请求埋点带 `region`**（`server.js` 的 `onAccount` 收第二个参数账号
   id → 回查 `qoder/auth` 或 `traework/auth` 的区域 → `req._upstreamRegion`
   → `logRequest` 记 `region` 字段；qoder 的 global 术语在埋点层归一成
   intl）。Qoder 的 `send` 也把 `onAccount(name, id)` 升级到带 id。搭子/
   千问纯国内不记（空串）。**旧数据没有这个字段，界面不显示**——空缺
   不能读成国内。
2. **仪表盘**：TRAE 统计卡「国内 N · 国际 N」+「国际账号按请求数计，
   不进积分合计」；「今日已签 x / y」的 y 只数国内账号（国际没有签到
   接口，算进分母会永远签不满）；账号健康快照标题带「国际 N（订阅制 ·
   无签到）」。Qoder 仪表盘账号卡区域徽标（原有）+ 标题区域计数。
3. **模型管理**：两通道区域切换（上一节）+ 通道元信息行「可用账号 N
   （国内 x · 国际 y）」+ TRAE 额度卡分母/订阅说明 + Qoder 额度卡在两区
   并存时显示分区小计（国内/国际的 addOn/user 分别列）。
4. **聊天测试台**：TRAE/Qoder 通道加区域单选（统一 'cn'/'intl'，qoder
   发请求时映射成 global）；模型表按区域重拉（`/chatlab/*-models?region=`），
   国际区域不列 TRAE 宝条目（国内身份）；`/chatlab/chat` 带 `region` 约束
   选号。真机：国际区域默认选中 `traework/deepseek-v4.1-flash`，实发一条
   由 wearetheone777 回答。
5. **逐笔账本带 `region`**（`traework/credits.js` 与 `qoder/credits.js` 的
   `creditRecords` 按 account_id 回查区域）——积分明细与用量统计的区域列
   数据源。**配套修了 capture 的一个口径**：国际账号 `consumed` 恒 null
   原来会被 `capture` 直接跳过（账本里看不到国际请求）——现在国际请求
   照落账、标 `intl:true`，成本由前端显示「订阅制不计积分」。**坑**：
   `computeCosts` 的差值链遇 consumed null 必须断链（`continue`）——
   JS 里 null 参与减法会静默归 0，国际行后面的国内请求会被编成「全额
   累计值」当成本。
6. **请求日志**：行与详情在通道标签旁显示区域徽标。
7. **用量统计**：TRAE 额度表加区域列，intl 行显示套餐名 +「按请求数计」。

**区域视图改为整页切换（2026-11-03 同日二次改版，用户明确「两个不同的页面
可以切换，别放在一起」）**：顶栏新增「国内版/国际版」切换器
（`stores/region.ts`，localStorage 持久化 `lab-region`；只在有区域概念的
通道显示——TRAE/Qoder/WorkBuddy；搭子与千问纯国内隐藏）。切到哪个区域，
**所有页面整体只显示那个区域的数据**：各管理端接口（traework 的
status/credits/dashboard/credits/daily/credits/records，qoder 的
status/credits/dashboard，reqlogs，usage/overview，chatlab 模型清单）都认
`?region=`，**服务端过滤**（日志与账本的「国内」视图包含 region 缺失的历史行，
「国际」只看明确 intl 的行）；登录弹窗的区域单选全部移除、跟随顶栏。
上一版混排在单页里的区域徽标/分区小计/分母修正已整体移除。
两个口径细节：① TRAE `/credits` 的 FEFO 快照**按全量账号更新**（区域视图
只过滤返回行，不缩窄快照写入范围——否则国内视图会把国际临期条目忘干净）；
② 纯订阅视图（国际）的 remainTotal/limitTotal 给 **null**（显示 —），
0.00 会被读成「额度用完了」。WorkBuddy 加入同套切换。

**Qoder 国际版（2026-11-03 页面区分收尾——通道本身早已支持 cn/global）。**
Qoder 的登录区域选择、per-region 端点、`accountsForRegion`（intl key →
global 池）都是既有能力；本次补的是**页面层**：模型页 Qoder 卡加区域切换
（国内/国际，`/qoder/models?region=` 按区域选主账号拉表，没有该区域账号时
明确报「没有国际（global）账号」**不静默回落国内表**）、计费自检带 region
（国际模型不再可能被国内账号接走）、测试台/积分明细/仪表盘的区域区分
（见上一节清单）。库内当前两个账号都是 cn——添加国际
账号走账号管理 → 添加账号 → 选「国际 qoder.sh」（device flow，需登录
qoder.com），链接生成已真机验证指向国际域。
