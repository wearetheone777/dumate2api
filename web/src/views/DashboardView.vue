<template>
  <div class="page">
    <PageHeader :title="isTw ? 'TRAE Work' : isQd ? 'Qoder' : isQw ? '千问办公' : '仪表盘'">
      <template #sub>
        {{ isTw ? '额度、签到与用量总览'
          : isQd ? '签到积分、账号健康与用量总览'
          : isQw ? '积分额度、登录态与用量总览' : '账号池健康度、上游状态与今日用量总览' }}
        <template v-if="lastRefresh"> · 更新于 {{ lastRefresh }}</template>
      </template>
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="refresh(true)">刷新</a-button>
      </template>
    </PageHeader>

    <!-- ============ TRAE Work：额度 + 签到 + 账号，与千问三池不同 ============ -->
    <template v-if="isTw">
      <!-- 顶部指标卡：口径与搭子/千问对齐（账号总数 / 有效期内 / 即将过期 /
           积分余额）。各通道独有的账（TRAE 的签到、千问的三池）放在下面的
           专有卡片里，不塞进这一排，否则切通道时这排数字含义会变。 -->
      <a-row :gutter="[16, 16]">
        <a-col :xs="12" :sm="12" :xl="5">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="账号总数" :value="twSummary?.total ?? '—'">
              <template #suffix><span class="text-sm text-slate-400">个</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="twSummary">今日已签 {{ twSummary.checkedIn }} 个</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :xl="5">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="有效期内" :value="twSummary?.valid ?? '—'" value-style="color:var(--lab-ok)">
              <template #suffix><span class="text-sm text-slate-400">个</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="twSummary">
                <template v-if="twSummary.unknown">额度查询失败 {{ twSummary.unknown }} 个</template>
                <template v-else>凭证可用</template>
              </template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :xl="5">
          <a-card :bordered="false" class="h-full">
            <a-statistic
              title="即将过期积分"
              :value="twExpiringPoints"
              :precision="2"
              :value-style="twExpiringPoints > 0 ? 'color:var(--lab-warn)' : ''"
            />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="twExpiring.length">
                {{ twExpiring.length }} 个额度包 7 天内到期
              </template>
              <template v-else-if="twCreditsLoaded">7 天内无到期积分</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :xl="5">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="额度余额" :value="twSummary?.remainTotal ?? '—'" :precision="2" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="twSummary?.limitTotal">上限合计 {{ fmt(twSummary.limitTotal) }}</template>
              <span v-else>上游未给出额度上限</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="今日请求" :value="usage?.cards.today.requests ?? '—'" value-style="color:var(--lab-primary)" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="usage">{{ compact(usage.cards.today.tokens) }} Token</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
      </a-row>

      <!-- 即将过期的积分明细。只在真有风险时出现——空的时候整块不显示，
           免得每次进仪表盘都看到一张「暂无」的卡。 -->
      <a-card
        v-if="twExpiring.length"
        title="即将过期的积分"
        :bordered="false"
        class="mt-4"
      >
        <template #extra>
          <span class="text-xs text-slate-500">7 天内到期 · 合计 {{ fmt(twExpiringPoints) }}</span>
        </template>
        <a-table
          size="small"
          :pagination="false"
          :data-source="twExpiring"
          :columns="expiringColumns"
          row-key="key"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'account'">
              <span class="text-xs">{{ record.account }}</span>
            </template>
            <template v-else-if="column.key === 'name'">
              <a-tag :color="remainColor(record.expireAt)">{{ record.name }}</a-tag>
            </template>
            <template v-else-if="column.key === 'remain'">
              <span class="font-medium text-amber-700 num">{{ fmt(record.remain) }}</span>
              <span v-if="record.limit" class="text-xs text-slate-500 ml-1">/ {{ fmt(record.limit) }}</span>
            </template>
            <template v-else-if="column.key === 'expireAt'">
              <span class="text-xs">{{ new Date(record.expireAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
            </template>
            <template v-else-if="column.key === 'daysLeft'">
              <a-tag :color="remainColor(record.expireAt)">{{ remainText(record.expireAt) }}</a-tag>
            </template>
          </template>
        </a-table>
        <div class="text-xs text-slate-500 mt-2">
          这些积分包到期即作废（签到奖励与月度赠送按各自有效期，不累积）。
          已用完的包不计入——到期不构成损失。
        </div>
      </a-card>

      <a-row :gutter="[16, 16]" class="mt-4">
        <a-col :xs="24" :lg="17">
          <a-card title="请求量趋势" :bordered="false" class="h-full">
            <template #extra><span class="text-xs text-slate-500">按天聚合 · 与搭子仪表盘同口径</span></template>
            <a-empty v-if="!(usage?.daily || []).length" description="还没有 TRAE Work 请求记录" />
            <template v-else>
              <!-- 与搭子一样拆成上下两张共享 X 轴的小图，而不是双 Y 轴：
                   请求数与 Token 量纲不同，刻度对齐点没有依据。 -->
              <div class="trend-block">
                <div class="trend-label">请求数</div>
                <div ref="twReqChartEl" class="trend-chart" />
              </div>
              <div class="trend-block">
                <div class="trend-label">Token</div>
                <div ref="twTokChartEl" class="trend-chart" />
              </div>
            </template>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="7">
          <a-card title="通道状态" :bordered="false" class="h-full">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item label="账号">
                {{ twInfo?.account || '—' }}
                <span v-if="(twInfo?.accounts ?? 0) > 1" class="text-xs text-slate-400 ml-1">
                  等 {{ twInfo?.accounts }} 个
                </span>
              </a-descriptions-item>
              <a-descriptions-item label="access token">
                <span class="font-mono text-xs">{{ fmtExpire(twInfo?.tokenExpiresAt) }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="refresh token">
                <span class="font-mono text-xs">{{ fmtExpire(twInfo?.refreshExpiresAt) }}</span>
                <a-tag v-if="twInfo?.refreshExpired" color="orange" class="ml-1">已过期</a-tag>
              </a-descriptions-item>
            </a-descriptions>
            <!-- 与千问的关键差异：TRAE 的凭证是我们自己换的，token 到期能自动续 -->
            <a-alert
              type="info"
              show-icon
              class="mt-3"
              message="凭证自持，可自动续期"
              description="access token 到期时网关用 refresh token 自动换新，不需要打开 TRAE 客户端。只有 refresh token 过期才需要重新登录。"
            />
          </a-card>
        </a-col>
      </a-row>

      <!-- 账号健康快照（多账号）：每账号一张卡，仿搭子/千问仪表盘。
           与千问的关键差异：TRAE 的 credits 会被消耗、由签到补充，
           所以健康条按「剩余额度占上限的比例」，而不是存活天数。 -->
      <a-card :bordered="false" class="mt-4">
        <template #title>
          <span>账号健康快照</span>
          <a-tag v-if="twAccounts.length" color="green" class="ml-2">
            在线 {{ twAccounts.filter(a => a.enabled && !a.refreshExpired).length }}
          </a-tag>
          <a-tag v-if="twDash?.summary.checkedInToday != null" color="blue" class="ml-1">
            今日已签 {{ twDash.summary.checkedInToday }} / {{ twAccounts.length }}
          </a-tag>
        </template>
        <a-empty v-if="!twAccounts.length" description="还没有添加 TRAE Work 账号，到「账号管理」加一个" />
        <a-row v-else :gutter="[16, 16]">
          <a-col v-for="a in twAccounts" :key="a.id" :xs="24" :sm="12" :lg="8">
            <div class="account-card">
              <div class="account-card-header">
                <span class="account-card-name">{{ a.name }}</span>
                <a-tag :color="a.lastError ? 'red' : a.refreshExpired ? 'orange' : a.enabled ? 'green' : 'default'">
                  {{ a.lastError ? '异常' : a.refreshExpired ? '待重登' : a.enabled ? '在线' : '停用' }}
                </a-tag>
              </div>
              <div v-if="a.phone" class="account-card-meta">
                {{ a.phone }}
                <span v-if="a.phoneSource === 'inferred-nickname'" class="text-slate-500 ml-1">（从昵称推断）</span>
              </div>
              <div class="health-bar">
                <div
                  class="health-bar-fill"
                  :class="healthColorTw(a)"
                  :style="{ width: healthWidthTw(a) }"
                />
              </div>
              <div class="account-card-footer">
                <span class="text-slate-500">
                  <template v-if="twCreditCap && a.credits != null">
                    剩余 {{ fmt(a.credits) }} / {{ fmt(twCreditCap) }}
                  </template>
                  <template v-else-if="a.daysAlive !== null">已用 {{ a.daysAlive }} 天</template>
                  <template v-else>额度未知</template>
                </span>
                <span :class="a.checkedInToday ? 'text-green-700' : 'text-slate-500'">
                  {{ a.checkedInToday ? '今日已签' : '今日未签' }}
                </span>
              </div>
              <div v-if="a.lastError" class="account-card-error">{{ a.lastError }}</div>
            </div>
          </a-col>
        </a-row>
        <div v-if="twDash?.note" class="text-xs text-slate-400 mt-3">{{ twDash.note }}</div>
      </a-card>

      <!-- 今日用量：三条通道同一套指标，抽成组件避免各写一份漂移 -->
      <a-card title="今日用量" :bordered="false" class="mt-4">
        <TodayUsageCard :today="usage?.cards.today" />
      </a-card>

      <!-- 今日积分明细：本地归因，按 req_id 与请求日志配对。
           成本取相邻 consumed 的差值——它是「这条请求花了多少」，
           与上面「剩余额度」是两回事，不要相加。 -->
      <a-card title="今日积分明细" :bordered="false" class="mt-4">
        <template #extra>
          <span class="text-xs text-slate-500">
            最近 {{ twRecords.length }} 条 · 合计 {{ fmt(twWindow.cost) }}
          </span>
        </template>
        <a-row :gutter="[16, 16]" class="mb-3">
          <a-col :xs="24" :sm="12" :lg="6">
            <a-statistic title="今日消耗" :value="twToday?.cost ?? '—'" :precision="2" />
            <div class="text-xs text-slate-500 mt-1">按相邻账号游标差值算出</div>
          </a-col>
          <a-col :xs="24" :sm="12" :lg="6">
            <a-statistic title="今日经网关请求" :value="twToday?.requests ?? '—'" />
            <div class="text-xs text-slate-500 mt-1">
              <a-tag v-if="twToday?.concurrent" color="orange" class="mr-1">并发 {{ twToday.concurrent }}</a-tag>
              <span class="text-slate-500">仅统计经本网关的请求</span>
            </div>
          </a-col>
          <a-col :xs="24" :lg="12">
            <div class="text-xs text-slate-500 leading-relaxed">
              成本来自「同一账号相邻两次累计已消耗的差值」，不是上游账单——
              TRAE 的额度接口只给累计值，没有逐笔流水。
              每账号的第一条没有参照点，如实留空（显示 —）而不是补 0。
              与相邻请求并发时差值可能含对方的消耗，标记为「并发」。
            </div>
          </a-col>
        </a-row>
        <a-empty v-if="!twRecords.length" description="还没有经网关的积分记录" />
        <a-table
          v-else
          size="small"
          :data-source="twRecords"
          :columns="twRecordColumns"
          row-key="req_id"
          :pagination="{ pageSize: 10, size: 'small', showSizeChanger: false }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'ts'">
              <span class="text-xs">{{ new Date(record.ts).toLocaleString('zh-CN', { hour12: false }) }}</span>
            </template>
            <template v-else-if="column.key === 'account'">
              <span class="text-xs">{{ record.account || '—' }}</span>
            </template>
            <template v-else-if="column.key === 'model'">
              <span class="font-mono text-xs">{{ record.model || '—' }}</span>
            </template>
            <template v-else-if="column.key === 'cost'">
              <span v-if="record.cost != null" class="font-medium num">{{ fmt(record.cost) }}</span>
              <span v-else class="text-slate-400">—</span>
              <a-tooltip v-if="record.cost != null && !record.exact" title="与相邻请求并发，差值可能含其它请求的消耗">
                <a-tag color="orange" class="ml-1">并发</a-tag>
              </a-tooltip>
            </template>
            <template v-else-if="column.key === 'remain'">
              <span class="text-xs text-slate-500">
                <template v-if="record.remain != null"><span class="num">{{ fmt(record.remain) }}</span></template>
                <template v-else>—</template>
              </span>
            </template>
            <template v-else-if="column.key === 'ms'">
              <span class="text-xs text-slate-500">{{ record.ms != null ? record.ms + ' ms' : '—' }}</span>
            </template>
          </template>
        </a-table>
      </a-card>
    </template>

    <!-- ============ WorkBuddy：第五通道（双区域），指标卡 + 趋势 + 账号健康 ============ -->
    <template v-else-if="isWb">
      <!-- 顶部指标卡：口径与 Qoder 对齐（账号 / 积分合计 / 临期 / 今日请求）。
           剩余积分来自 credits（套餐包合计），临期按包的 expireAt 聚合；
           国际版是订阅制，积分口径两格显示 — 与说明，不硬凑数字 -->
      <a-row :gutter="[16, 16]">
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="账号总数" :value="wbSummary?.total ?? '—'">
              <template #suffix><span class="text-sm text-slate-400">个</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="wbSummary">启用 {{ wbSummary.enabled }} 个</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic
              title="剩余积分合计"
              :value="wbCreditsTotals.remain ?? '—'"
              :precision="wbCreditsTotals.remain != null && !Number.isInteger(wbCreditsTotals.remain) ? 2 : undefined"
              value-style="color:var(--lab-primary)"
            />
            <div class="text-xs text-slate-500 mt-2">
              {{ isIntlRegion() ? '国际版订阅制，无积分口径' : 'billing 套餐包按账号独立' }}
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic
              title="7 天内到期积分"
              :value="wbExpiring.amount"
              :precision="wbExpiring.amount != null && !Number.isInteger(wbExpiring.amount) ? 2 : undefined"
              :value-style="wbExpiring.amount > 0 ? 'color:var(--lab-warn)' : ''"
            />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="wbExpiring.count">
                {{ wbExpiring.count }} 个套餐包临期 · 到期即作废
              </template>
              <template v-else-if="isIntlRegion()">订阅制无套餐包</template>
              <template v-else>暂无临期套餐包</template>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="今日请求" :value="usage?.cards.today.requests ?? '—'">
              <template #suffix><span class="text-sm text-slate-400">次</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="usage"><span class="num">{{ usage.cards.today.tokens }}</span> Token</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="今日已签到" :value="isIntlRegion() ? '—' : `${wbCreditsTotals.checked} / ${wbCreditsTotals.counted}`" />
            <div class="text-xs text-slate-500 mt-2">
              {{ isIntlRegion() ? '国际版没有签到接口' : '签到每日一次，幂等' }}
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic
              title="refresh 过期"
              :value="wbSummary?.refreshExpired ?? '—'"
              :value-style="(wbSummary?.refreshExpired ?? 0) > 0 ? 'color:var(--lab-warn)' : ''"
            >
              <template #suffix><span class="text-sm text-slate-400">个</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              过期账号无法自动续期，需重新登录
            </div>
          </a-card>
        </a-col>
      </a-row>

      <!-- 趋势 + 上游状态。与 TRAE/Qoder 同一布局（左趋势右状态），
           三条直连通道并排看时位置一致才不会找不着。 -->
      <a-row :gutter="[16, 16]" class="mt-4">
        <a-col :xs="24" :lg="17">
          <a-card title="近 14 天调用趋势" :bordered="false" class="h-full">
            <template #extra><span class="text-xs text-slate-500">按天聚合 · 与搭子仪表盘同口径</span></template>
            <a-empty v-if="!wbDaily.length" description="还没有 WorkBuddy 请求记录" />
            <!-- 请求数与 Token 拆成上下两张共享 X 轴的小图：量纲不同，
                 共图会凭空造出「此消彼长」的相关性（与 TRAE/Qoder 同一画法） -->
            <template v-else>
              <div class="trend-block">
                <div class="trend-label">请求数</div>
                <div ref="wbReqChartEl" class="trend-chart" />
              </div>
              <div class="trend-block">
                <div class="trend-label">Token</div>
                <div ref="wbTokChartEl" class="trend-chart" />
              </div>
            </template>
          </a-card>
        </a-col>

        <a-col :xs="24" :lg="7">
          <a-card title="上游状态" :bordered="false" class="h-full">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item label="通道">
                <a-tag :color="wbInfo?.ready ? 'green' : 'red'">
                  {{ wbInfo?.ready ? '就绪' : '不可用' }}
                </a-tag>
                <span v-if="wbInfo?.error" class="text-xs text-slate-400 ml-1">
                  {{ wbInfo.error }}
                </span>
              </a-descriptions-item>
              <a-descriptions-item label="可用账号">
                <template v-if="wbInfo?.accounts !== undefined">
                  {{ wbInfo.accounts }} 个
                </template>
                <span v-else class="text-slate-400">—</span>
              </a-descriptions-item>
              <a-descriptions-item label="当前账号">
                {{ wbInfo?.account || '—' }}
              </a-descriptions-item>
              <a-descriptions-item label="上游端点">
                <span class="font-mono text-xs">
                  {{ isIntlRegion() ? 'www.workbuddy.ai' : 'copilot.tencent.com' }}
                </span>
              </a-descriptions-item>
            </a-descriptions>
            <a-alert
              type="info"
              show-icon
              class="mt-3"
              message="凭证自持，双区域账号互不通用"
              description="国内（copilot.tencent.com）与国际（workbuddy.ai）是两套独立账号。access token 到期时网关用 refresh token 自动换新（国内 workbuddy / 国际 plugin 两种刷新渠道）。"
            />
          </a-card>
        </a-col>
      </a-row>

      <!-- 账号健康快照：本地落盘数据，不打上游 -->
      <a-card :bordered="false" class="mt-4">
        <template #title>
          <span>账号健康快照</span>
          <a-tag v-if="wbAccounts.length" color="green" class="ml-2">
            在线 {{ wbAccounts.filter(a => a.enabled && !a.refreshExpired).length }}
          </a-tag>
          <a-tag :color="regionStore.current === 'intl' ? 'purple' : 'blue'" class="ml-1">
            {{ regionStore.current === 'intl' ? '国际版（workbuddy.ai）' : '国内版（copilot.tencent.com）' }}
          </a-tag>
        </template>
        <a-empty v-if="!wbAccounts.length"
          :description="`还没有${regionStore.current === 'intl' ? '国际' : '国内'}版账号，到「账号管理」导入一个`" />
        <a-row v-else :gutter="[16, 16]">
          <a-col v-for="a in wbAccounts" :key="a.id" :xs="24" :sm="12" :lg="8">
            <div class="account-card">
              <div class="account-card-header">
                <span class="account-card-name">{{ a.name }}</span>
                <a-tag :color="a.lastError ? 'red' : a.refreshExpired ? 'orange' : a.enabled ? 'green' : 'default'">
                  {{ a.lastError ? '异常' : a.refreshExpired ? '待重登' : a.enabled ? '在线' : '停用' }}
                </a-tag>
              </div>
              <div class="flex items-center justify-between text-xs" style="margin-bottom:8px">
                <span class="text-slate-500">{{ a.refreshTail ? `refresh …${a.refreshTail}` : '—' }}</span>
                <span class="text-slate-500">{{ a.daysAlive !== null ? a.daysAlive + ' 天' : '天数未知' }}</span>
              </div>
              <div class="account-card-footer">
                <span class="text-slate-500">
                  token {{ a.expiresAt ? new Date(a.expiresAt).toLocaleDateString('zh-CN') : '—' }}
                </span>
                <span :class="a.lastError ? 'text-red-700' : 'text-slate-500'">
                  {{ a.lastError ? '有错误' : '正常' }}
                </span>
              </div>
              <div v-if="a.lastError" class="account-card-error">{{ a.lastError }}</div>
            </div>
          </a-col>
        </a-row>
      </a-card>

      <!-- 今日用量：与其它通道同一套指标 -->
      <a-card title="今日用量" :bordered="false" class="mt-4">
        <TodayUsageCard :today="usage?.cards.today" />
      </a-card>
    </template>

    <!-- ============ Qoder：与 TRAE 同构（多账号 + 签到 + 单 credits），
         但额度分两块（签到积分 / 套餐内额度），且不需要客户端 ============ -->
    <template v-else-if="isQd">
      <a-row :gutter="[16, 16]">
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="账号总数" :value="qdSummary?.total ?? '—'">
              <template #suffix><span class="text-sm text-slate-400">个</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="qdSummary">启用 {{ qdSummary.enabled }} 个</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="有效期内" :value="qdValid ?? '—'">
              <template #suffix><span class="text-sm text-slate-400">个</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">凭证可用</div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic
              title="签到积分合计"
              :value="qdTotals?.addOn ?? '—'"
              :precision="4"
            />
            <div class="text-xs text-slate-500 mt-2">签到/赠送，免费用户实际可用</div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="套餐内额度合计" :value="qdTotals?.user ?? '—'" :precision="4" />
            <div class="text-xs text-slate-500 mt-2">订阅套餐内（Free 恒为 0）</div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic
              title="即将过期积分"
              :value="qdCreditsSummary?.expiringAmount ?? '—'"
              :precision="4"
              :value-style="(qdCreditsSummary?.expiringAmount ?? 0) > 0 ? 'color:var(--lab-warn)' : ''"
            />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="qdCreditsSummary?.expiringCount">
                {{ qdCreditsSummary.expiringCount }} 个批次 7 天内到期 ·
                {{ qdCreditsSummary.expiringEstimated === false ? '领取额口径' : '按消耗推算剩余' }}
              </template>
              <template v-else-if="qdCreditsSummary">暂无即将过期</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :lg="8" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="今日请求" :value="qdToday?.requests ?? '—'">
              <template #suffix><span class="text-sm text-slate-400">次</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="qdToday"><span class="num">{{ qdToday.tokens }}</span> Token</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
      </a-row>

      <!-- 积分过期明细。
           Qoder 的积分是**签到领的、30 天后作废**（与千问的月度额度按
           valid_to 刷新、搭子按有效期都不同）。上游没有逐批余额接口，
           这里用本地账本的领取记录 + 上游总余额做「先领先扣」推算——
           estimatedRemaining 是推算剩余（可用读数），amount 是领取额
           （对照口径，不随消耗变）。 -->
      <a-card
        v-if="qdGrants.length"
        title="积分过期明细"
        :bordered="false"
        class="mt-4"
      >
        <template #extra>
          <span class="text-xs text-slate-500">
            {{ qdGrantsWindowDays }} 天内到期 · {{ qdGrants.length }} 个批次 ·
            推算剩余合计 {{ qdGrantsEstTotal == null ? '—' : fmt(qdGrantsEstTotal) }}
          </span>
        </template>
        <a-table
          size="small"
          :pagination="false"
          :data-source="qdGrants"
          :columns="qdGrantColumns"
          row-key="grantId"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'account'">
              <span class="text-xs">{{ record.accountName || '—' }}</span>
            </template>
            <template v-else-if="column.key === 'estimatedRemaining'">
              <!-- 推算剩余：先领先扣模拟。null = 余额没查到，不是 0 -->
              <span class="font-medium num" :class="record.estimatedRemaining > 0 ? 'text-amber-700' : 'text-slate-500'">
                {{ record.estimatedRemaining == null ? '—' : fmt(record.estimatedRemaining) }}
              </span>
            </template>
            <template v-else-if="column.key === 'amount'">
              <!-- 领取额仅作对照：这批当初领了多少，不随消耗变 -->
              <span class="num text-slate-400">{{ fmt(record.amount) }}</span>
            </template>
            <template v-else-if="column.key === 'grantedAt'">
              <span class="text-xs">{{ new Date(record.grantedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
            </template>
            <template v-else-if="column.key === 'expiresAt'">
              <span class="text-xs">{{ new Date(record.expiresAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
            </template>
            <template v-else-if="column.key === 'daysLeft'">
              <a-tag :color="remainColor(record.expiresAt)">
                {{ remainText(record.expiresAt) }}
              </a-tag>
            </template>
          </template>
        </a-table>
        <div class="text-xs text-slate-500 mt-2">
          Qoder 的签到积分<b>领取后 30 天作废</b>（每日 10:00 UTC+8 刷新领取资格）。
          <b>「推算剩余」按先领先扣模拟</b>——上游按总池扣费不按批次扣，把上游
          权威总余额从最新批次往回分配（与消耗顺序一致）得每批还剩多少；
          「领取额」是这批领到的数量，仅作对照。推算为 0 的批次已经按消耗顺序用完，
          到期即自然作废，不会浪费余额。
        </div>
      </a-card>

      <a-alert
        v-if="qdSummary && qdSummary.refreshExpired > 0"
        type="warning"
        show-icon
        class="mt-4"
        :message="`${qdSummary.refreshExpired} 个账号的 refresh token 已过期`"
        description="access token 到期后无法自动续期。请到「账号管理」删除后重新登录。"
      />

      <!-- 趋势 + 上游状态。与 TRAE 同一布局（左趋势右状态），
           三条直连通道并排看时位置一致才不会找不着。 -->
      <a-row :gutter="[16, 16]" class="mt-4">
        <a-col :xs="24" :lg="17">
          <a-card title="近 14 天调用趋势" :bordered="false" class="h-full">
            <template #extra><span class="text-xs text-slate-500">按天聚合 · 与搭子仪表盘同口径</span></template>
            <a-empty v-if="!qdDaily.length" description="还没有 Qoder 请求记录" />
            <!-- 同样拆成上下两张共享 X 轴的小图而不是双 Y 轴：请求数与 Token
                 量纲不同，共图会凭空造出「此消彼长」的相关性。 -->
            <template v-else>
              <div class="trend-block">
                <div class="trend-label">请求数</div>
                <div ref="qdReqChartEl" class="trend-chart" />
              </div>
              <div class="trend-block">
                <div class="trend-label">Token</div>
                <div ref="qdTokChartEl" class="trend-chart" />
              </div>
            </template>
          </a-card>
        </a-col>

        <a-col :xs="24" :lg="7">
          <a-card title="上游状态" :bordered="false" class="h-full">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item label="通道">
                <a-tag :color="qdInfo?.ready ? 'green' : 'red'">
                  {{ qdInfo?.ready ? '就绪' : '不可用' }}
                </a-tag>
                <span v-if="qdInfo?.error" class="text-xs text-slate-400 ml-1">
                  {{ qdInfo.error }}
                </span>
              </a-descriptions-item>
              <a-descriptions-item label="可用账号">
                <template v-if="qdInfo?.accounts !== undefined">
                  {{ qdInfo.accounts }} 个
                </template>
                <span v-else class="text-slate-400">—</span>
              </a-descriptions-item>
              <a-descriptions-item label="当前账号">
                {{ qdInfo?.account || '—' }}
              </a-descriptions-item>
              <a-descriptions-item label="access token">
                <span class="font-mono text-xs">{{ fmtExpire(qdInfo?.tokenExpiresAt) }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="refresh token">
                <span class="font-mono text-xs">{{ fmtExpire(qdInfo?.refreshExpiresAt) }}</span>
                <a-tag v-if="qdInfo?.refreshExpired" color="orange" class="ml-1">已过期</a-tag>
              </a-descriptions-item>
            </a-descriptions>
            <!-- Qoder 与千问的关键差异写在状态卡里：这是「要不要装客户端」
                 这个问题的答案，也是它比千问干净的地方。 -->
            <a-alert
              type="info"
              show-icon
              class="mt-3"
              message="凭证自持，不需要客户端"
              description="签名是纯本地算法（RSA + AES + MD5），不依赖 Qoder 客户端或任何 wasm。access token 到期时网关用 refresh token 自动换新。"
            />
          </a-card>
        </a-col>
      </a-row>

      <!-- 账号健康快照：本地落盘数据，不打上游 -->
      <a-card :bordered="false" class="mt-4">
        <template #title>
          <span>账号健康快照</span>
          <a-tag v-if="qdDashAccounts.length" color="green" class="ml-2">在线 {{ qdOnlineCount }}</a-tag>
        </template>
        <a-empty v-if="!qdDashAccounts.length" description="还没有添加 Qoder 账号，到「账号管理」加一个" />
        <a-row v-else :gutter="[16, 16]">
          <a-col v-for="a in qdDashAccounts" :key="a.id" :xs="24" :sm="12" :lg="8">
            <div class="account-card">
              <div class="account-card-header">
                <span class="account-card-name">
                  {{ a.name }}
                  <a-tag v-if="a.region === 'cn'" color="blue" class="ml-1" size="small">国内</a-tag>
                  <a-tag v-else color="purple" class="ml-1" size="small">国际</a-tag>
                </span>
                <a-tag :color="errFresh(a) ? 'red' : a.refreshExpired ? 'orange' : a.enabled ? 'green' : 'default'">
                  {{ errFresh(a) ? '异常' : a.refreshExpired ? '待重登' : a.enabled ? '在线' : '停用' }}
                </a-tag>
              </div>
              <div class="flex items-center justify-between text-xs" style="margin-bottom:8px">
                <span class="text-slate-500">{{ a.planName || '—' }}</span>
                <span class="text-slate-500">
                  {{ a.daysAlive !== null ? a.daysAlive + ' 天' : '天数未知' }}
                </span>
              </div>

              <!-- 积分剩余：两份额度**分开显示**，不能相加。
                   签到积分（addOnQuota）是免费用户实际能用的；
                   套餐内额度（userQuota）Free 套餐恒为 0。 -->
              <template v-if="qdCreditOf(a.id)">
                <!-- 健康条：按签到积分占其总量的比例。与 TRAE 同理——
                     这里是会被消耗的余额，「还剩多少」才是这个号的寿命指标。 -->
                <div class="health-bar">
                  <div
                    class="health-bar-fill"
                    :class="qdHealthColor(a.id)"
                    :style="{ width: qdHealthWidth(a.id) }"
                  />
                </div>
                <div class="account-card-footer">
                  <span class="text-slate-500">
                    签到积分
                    <span class="text-cyan-700 num ml-1">{{ fmtQd(qdCreditOf(a.id)!.addOnQuota?.remaining) }}</span>
                    <span class="text-slate-500" v-if="qdCreditOf(a.id)!.addOnQuota?.total">
                      / {{ fmtQd(qdCreditOf(a.id)!.addOnQuota!.total) }}
                    </span>
                  </span>
                  <span class="text-slate-500">
                    套餐内 <span class="num ml-1">{{ fmtQd(qdCreditOf(a.id)!.userQuota?.remaining) }}</span>
                  </span>
                </div>
                <!-- 最早到期的批次。签到积分领取后 30 天作废，所以「最早到期」
                     才是要提醒的那个。剩余时间 ≤1 天显示小时（utils/remain）。 -->
                <div v-if="qdGrantOf(a.id)" class="text-xs mt-1"
                  :class="remainColor(qdGrantOf(a.id)!.expiresAt) === 'red' ? 'text-red-600' : remainColor(qdGrantOf(a.id)!.expiresAt) === 'orange' ? 'text-orange-700' : 'text-slate-500'">
                  最早到期 {{ new Date(qdGrantOf(a.id)!.expiresAt).toLocaleDateString('zh-CN') }}
                  （{{ remainText(qdGrantOf(a.id)!.expiresAt) }}）
                </div>
                <div v-else-if="(qdCreditOf(a.id)!.addOnQuota?.remaining ?? 0) > 0" class="text-xs mt-1 text-slate-500">
                  有签到积分但无到期记录（本功能上线前领的）
                </div>
              </template>
              <div v-else class="text-xs mt-2 text-slate-500">额度未查询</div>

              <div v-if="a.lastError" class="account-card-error" :class="errFresh(a) ? '' : 'opacity-70'">
                <span class="text-slate-500">{{ errorWhen(a.lastErrorAt) }}</span>{{ a.lastError }}
              </div>
            </div>
          </a-col>
        </a-row>
      </a-card>

      <!-- 今日用量：三条通道同一套指标，抽成组件避免各写一份漂移 -->
      <a-card title="今日用量" :bordered="false" class="mt-4">
        <TodayUsageCard :today="usage?.cards.today" />
      </a-card>
    </template>

    <!-- ============ 千问办公：积分卡片。它是另一套账——不消耗搭子积分、不进账号池，
         所以整块替换而不是与搭子的指标卡混排。 ============ -->
    <template v-else-if="isQw">
      <!-- 顶部指标卡：口径与搭子/TRAE 对齐（账号总数 / 有效期内 / 即将过期 /
           积分余额）。千问独有的三池放在下面，不塞进这一排——否则切通道时
           这排数字的含义会变。 -->
      <a-row :gutter="[16, 16]">
        <a-col :xs="12" :sm="12" :xl="5">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="账号总数" :value="qwSummary?.total ?? '—'">
              <template #suffix><span class="text-sm text-slate-400">个</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="qwSummary">
                启用 {{ qwSummary.enabled }} · 停用 {{ qwSummary.disabled }}
              </template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :xl="5">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="有效期内" :value="qwSummary?.valid ?? '—'" value-style="color:var(--lab-ok)">
              <template #suffix><span class="text-sm text-slate-400">个</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <!-- 千问没有订阅到期日（免费版无 next_due_date），所以这里的
                   「有效期内」用凭证可用性判定，并在文案上说清与搭子的差别 -->
              <template v-if="qwSummary">凭证可用</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :xl="5">
          <a-card :bordered="false" class="h-full">
            <a-statistic
              title="即将过期积分"
              :value="qwSummary?.expiringSoonPoints ?? '—'"
              :precision="4"
              :value-style="(qwSummary?.expiringSoonPoints ?? 0) > 0 ? 'color:var(--lab-warn)' : ''"
            />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="qwSummary?.expiringSoon">
                {{ qwSummary.expiringSoon }} 个账号有到期积分
              </template>
              <template v-else-if="qwSummary">暂无即将过期</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :xl="5">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="积分余额" :value="qwSummary?.pointsTotal ?? '—'" :precision="2" />
            <div class="text-xs text-slate-500 mt-2">
              <!-- 与下方三个池子卡**同一个口径**（全账号合计），两处数字应当相等。
                   对不上时说明有账号余额没查到——那种情况池子卡会标出失败账号数 -->
              <template v-if="qwSummary">{{ qwSummary.total }} 个账号合计 · 与下方池子同口径</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="12" :sm="12" :xl="4">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="今日请求" :value="usage?.cards.today.requests ?? '—'" value-style="color:var(--lab-primary)" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="usage">{{ compact(usage.cards.today.tokens) }} Token</template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
      </a-row>

      <!-- 即将过期的积分明细。只在真有风险时出现——空的时候不显示，
           免得每次进仪表盘都看到一张「暂无」的卡。
           数据来源是各账号的 expiringSoon（上游自己点名会作废的钱包）。
           注意**不要用 active_wallets 的 valid_to** 渲染这里：那是月度额度的
           刷新时刻（实测月初），不是损失。 -->
      <a-card
        v-if="qwExpiringRows.length"
        title="即将过期的积分"
        :bordered="false"
        class="mt-4"
      >
        <template #extra>
          <span class="text-xs text-slate-500">
            {{ qwExpiringRows.length }} 笔 · 合计 {{ fmtQw(qwSummary?.expiringSoonPoints ?? 0) }}
          </span>
        </template>
        <a-table
          size="small"
          :pagination="false"
          :data-source="qwExpiringRows"
          :columns="expiringColumns"
          row-key="key"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'account'">
              <span class="text-xs">{{ record.account }}</span>
            </template>
            <template v-else-if="column.key === 'name'">
              <a-tag :color="remainColor(record.expireAt)">{{ record.name }}</a-tag>
            </template>
            <template v-else-if="column.key === 'remain'">
              <span class="font-medium text-amber-700 num">{{ fmtQw(record.remain) }}</span>
            </template>
            <template v-else-if="column.key === 'expireAt'">
              <span class="text-xs">{{ new Date(record.expireAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
            </template>
            <template v-else-if="column.key === 'daysLeft'">
              <a-tag :color="remainColor(record.expireAt)">{{ remainText(record.expireAt) }}</a-tag>
            </template>
          </template>
        </a-table>
        <div class="text-xs text-slate-500 mt-2">
          这些是上游标记「即将过期」的付费积分，到期即作废。
        </div>
      </a-card>

      <!-- 两个池子平级展示：月度（订阅套餐）与长期（充值赠送）性质不同，
           不能合并成一张卡。**余额是全账号合计**——与顶部「积分余额」同源。
           `balance` 为 null 表示「该池余额未知」（上游坏读），显示 —，
           不能显示 0（会被读成用完了）。
           **不再有「每日额度」卡**：上游 2026-11-01 起已停止发放，恒 0。 -->
      <a-row :gutter="[16, 16]">
        <a-col v-for="w in qwWallets" :key="w.id" :xs="12" :sm="12" :lg="6" :xl="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic :title="w.label" :value="w.balance ?? '—'" :precision="2">
              <template #suffix><span class="text-sm text-slate-400">积分</span></template>
            </a-statistic>
            <div class="text-xs text-slate-500 mt-2">
              <a-tag color="orange" class="mr-1">付费</a-tag>
              <template v-if="w.id === 'monthly'">
                <template v-if="qw?.accountCount && qw.accountCount > 1">
                  {{ qw.accountCount }} 个账号合计 ·
                </template>
                按有效期<template v-if="w.resetAt">（{{ fmtExpire(w.resetAt) }} 刷新）</template>
              </template>
              <template v-else>充值 / 赠送</template>
            </div>
            <!-- 合计由谁构成 + 有没有账号没查到。部分和必须说明，
                 否则会被读成「所有账号都算进去了」 -->
            <div v-if="w.id === 'monthly' && qw && (qw.accountCount > 1 || qw.failedAccounts > 0 || qw.retriedAccounts > 0 || qw.misreadAccounts > 0 || qw.partial)" class="text-xs text-slate-400 mt-1">
              <template v-if="qw.partial">
                <span class="text-orange-700">
                  合计只含余额已知的 {{ qw.totalKnown }} 个账号
                </span>
              </template>
              <template v-if="qw.failedAccounts > 0">
                <span class="text-orange-700">
                  · {{ qw.failedAccounts }} 个账号余额查询失败，未计入
                </span>
              </template>
              <!-- 上游 wallets 偶尔谎报全 0，已用 account-context 的权威总数校正。
                   这是「已校正」不是「已用尽」，不要与下面那条混为一谈 -->
              <template v-if="qw.misreadAccounts > 0">
                <span class="text-sky-700">
                  · {{ qw.misreadAccounts }} 个账号余额已校正（上游瞬时读失败）
                </span>
              </template>
              <template v-if="qw.retriedAccounts > 0">
                <span class="text-amber-700">
                  · {{ qw.retriedAccounts }} 个账号重试后仍为 0（可能已用尽）
                </span>
              </template>
            </div>
          </a-card>
        </a-col>

        <a-col :xs="12" :sm="12" :lg="6" :xl="6">
          <a-card :bordered="false" class="h-full">
            <a-statistic title="经本网关消耗" :value="qw?.today.total ?? '—'" :precision="4" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="qw">
                <a-tag :color="(qw.today.total ?? 0) > 0 ? 'orange' : 'green'" class="mr-1">
                  {{ (qw.today.total ?? 0) > 0 ? '已扣费' : '未扣费' }}
                </a-tag>
                {{ qw.today.requests }} 次请求
              </template>
              <span v-else>—</span>
            </div>
            <div v-if="qw?.today.scope === 'gateway'" class="text-xs text-slate-500 mt-1">
              仅统计经本网关的请求（唯一有实测依据的消耗口径）；
              客户端/网页里的对话不计入
            </div>
          </a-card>
        </a-col>
      </a-row>

      <a-row :gutter="[16, 16]" class="mt-4">
        <a-col :xs="24" :lg="17">
          <a-card title="用量趋势" :bordered="false" class="h-full">
            <template #extra><span class="text-xs text-slate-500">按天聚合</span></template>
            <a-empty v-if="!qwDaily.length" description="还没有归因记录" />
            <template v-else>
              <div ref="qwChartEl" class="qw-chart" />
              <!-- 再加一张 Token 图：积分是千问独有的口径，
                   Token 才是与搭子/TRAE 可比的用量指标。 -->
              <div class="trend-block mt-2">
                <div class="trend-label">Token</div>
                <div ref="qwTokChartEl" class="trend-chart" />
              </div>
            </template>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="7">
          <a-card title="通道状态" :bordered="false" class="h-full">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item label="状态">
                <a-tag :color="qwInfo?.ready ? (qwInfo.refreshExpired ? 'orange' : 'green') : 'red'">
                  {{ qwInfo?.ready ? (qwInfo.refreshExpired ? '可用·待重登' : '正常') : '不可用' }}
                </a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="签名">
                <span class="font-mono text-xs">{{ qwInfo?.wasm || '—' }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="主账号">
                {{ qwInfo?.account || '—' }}
                <span v-if="qwInfo?.tier" class="text-xs text-slate-400 ml-1">{{ qwInfo.tier }}</span>
                <a-tag v-if="qwAccounts.filter(a => a.active).length === 0" color="default" class="ml-1">
                  未设
                </a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="access token">
                <span class="font-mono text-xs">{{ fmtExpire(qwInfo?.tokenExpiresAt) }}</span>
              </a-descriptions-item>
              <a-descriptions-item label="refresh token">
                <span class="font-mono text-xs">{{ fmtExpire(qwInfo?.refreshExpiresAt) }}</span>
                <a-tag v-if="qwInfo?.refreshExpired" color="orange" class="ml-1">已过期</a-tag>
                <a-tag v-else-if="qwInfo?.refreshExpiringSoon" color="orange" class="ml-1">临期</a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="ACP 档位">
                <span class="font-mono text-xs">{{ qwInfo?.acpMode || '—' }}</span>
                <span v-if="!qwInfo?.acpMode" class="text-xs text-slate-400 ml-1">尚无 ACP 会话</span>
              </a-descriptions-item>
              <a-descriptions-item label="FEFO 选号">
                <!-- 写方是管理端 /accounts（本页加载即刷新），读方是网关热路径。
                     快照陈旧时网关自动退回普通轮询——这里要让退化可见。 -->
                <template v-if="qwFefo?.at">
                  <a-tag v-if="qwFefo.fresh" color="green">生效中</a-tag>
                  <a-tag v-else color="default">已退化</a-tag>
                  <span class="text-xs text-slate-400 ml-1">
                    快照 {{ fefoAgeText(qwFefo.at) }} · {{ qwFefo.accounts }} 个临期账号
                  </span>
                </template>
                <span v-else class="text-xs text-slate-400">快照未落盘</span>
              </a-descriptions-item>
            </a-descriptions>
            <a-alert
              v-if="qwInfo?.refreshExpiringSoon && !qwInfo?.refreshExpired"
              type="warning"
              show-icon
              class="mt-3"
              message="refresh token 24 小时内过期"
              description="过期后无法自动续期，账号会变成不可用——请到「账号管理」删除后重新登录。"
            />
            <a-alert
              v-if="qwInfo?.refreshExpired"
              type="warning"
              show-icon
              class="mt-3"
              message="refresh token 已过期"
              description="access token 到期后需在管理端「账号管理」删除该账号并重新登录，不要去打开千问客户端——客户端的登录态已经不再被这条通道使用。"
            />
          </a-card>
        </a-col>
      </a-row>

      <!-- 账号健康快照（多账号）：每账号一张卡，仿搭子仪表盘。
           千与搭子的「会员剩余天数」语义不同——这里用「账号存活天数」
           （从 createdAt 算到今天）。 -->
      <a-card :bordered="false" class="mt-4">
        <template #title>
          <span>账号健康快照</span>
          <a-tag v-if="qwAccounts.length" color="green" class="ml-2">
            在线 {{ qwAccounts.filter(a => a.enabled && a.usable).length }}
          </a-tag>
        </template>
        <a-empty v-if="!qwAccounts.length" description="还没有添加千问账号，到「账号管理」加一个" />
        <a-row v-else :gutter="[16, 16]">
          <a-col v-for="a in qwAccounts" :key="a.id" :xs="24" :sm="12" :lg="8">
            <div class="account-card">
              <div class="account-card-header">
                <span class="account-card-name">
                  {{ a.name || a.username || '未命名' }}
                  <a-tag v-if="a.active" color="blue" class="ml-1">主账号</a-tag>
                </span>
                <a-tag :color="errFresh(a) ? 'red' : a.refreshExpired ? 'orange' : a.enabled && a.usable ? 'green' : 'default'">
                  {{ errFresh(a) ? '异常' : a.refreshExpired ? '待重登' : a.enabled && a.usable ? '在线' : '停用' }}
                </a-tag>
                <a-tag v-if="a.refreshExpiringSoon && !a.refreshExpired" color="orange" class="ml-1">临期重登</a-tag>
                <a-tag v-if="a.adoptedFrom === 'official-desktop'" color="purple" class="ml-1">收编</a-tag>
              </div>
              <div v-if="a.phone" class="account-card-meta">
                {{ a.phone }}
              </div>
              <!-- 健康条：长度按账号存活天数，365 天为满。
                   与搭子的「会员剩余天数」不同——这是账号用了多久的客观度量，
                   满了不代表「过期」，只是看不到更老的。 -->
              <div class="health-bar">
                <div
                  class="health-bar-fill"
                  :class="healthColorQw(a)"
                  :style="{ width: healthWidthQw(a) }"
                />
              </div>
              <!-- 每账号的**剩余积分**单独给一行：这才是「这个号现在还能花多少」。
                   2026-11-02 起不再显示「每日免费 x / 100」——上游已停止发放
                   每日免费额度（daily 池恒 0），那个分母是过期政策的残留。
                   现在唯一有余额的是月度/长期（付费），所以显示合计。
                   余额未知（上游坏读）时显示 —，不显示 0。 -->
              <div class="flex items-center justify-between text-xs" style="margin-bottom:4px">
                <span class="text-slate-500">剩余积分</span>
                <span :class="dailyClassQw(a)">
                  {{ a.wallets && a.wallets.total != null ? fmtQw(a.wallets.total) : '—' }}
                  <a-tag v-if="a.wallets?.misread" color="blue" class="ml-1" title="上游余额接口瞬时读失败，已用权威总数校正；池子分配未知">
                    已校正
                  </a-tag>
                </span>
              </div>
              <div class="account-card-footer">
                <span class="text-slate-500">
                  {{ a.daysAlive !== null ? a.daysAlive + ' 天' : '天数未知' }}
                </span>
                <span class="text-slate-500">
                  <template v-if="a.wallets?.refreshAt">
                    额度刷新 {{ fmtExpire(a.wallets.refreshAt) }}
                  </template>
                  <template v-else>刷新时刻未知</template>
                </span>
              </div>
              <div v-if="a.lastError" class="account-card-error" :class="errFresh(a) ? '' : 'opacity-70'">
                <span class="text-slate-500">{{ errTimeText(a.lastErrorAt) }}</span>{{ a.lastError }}
              </div>
            </div>
          </a-col>
        </a-row>
      </a-card>

      <!-- 今日用量：三条通道同一套指标，抽成组件避免各写一份漂移 -->
      <a-card title="今日用量" :bordered="false" class="mt-4">
        <TodayUsageCard :today="usage?.cards.today" />
      </a-card>

      <!-- 今日积分明细：与 TRAE 侧同一套结构（本地归因、按 req_id 配对）。
           千问只有一个付费池可扣（每日免费额度上游已停发），所以不再分
           「免费/付费」两列——那两列现在恒为 0 与全额。 -->
      <a-card title="今日积分明细" :bordered="false" class="mt-4">
        <template #extra>
          <span class="text-xs text-slate-500">
            最近 {{ qwRecords.length }} 条 · 合计 {{ fmtQw(qwWindow.total) }}
          </span>
        </template>
        <a-row :gutter="[16, 16]" class="mb-3">
          <a-col :xs="24" :sm="12" :lg="6">
            <a-statistic title="今日消耗（经网关）" :value="fmtQw(qw?.today.total ?? 0)" />
            <div class="text-xs text-slate-500 mt-1">{{ qw?.today.requests ?? 0 }} 次请求</div>
          </a-col>
          <a-col :xs="24" :lg="18">
            <div class="text-xs text-slate-500 leading-relaxed">
              仅统计经本网关的请求——在千问客户端 / 网页里直接对话的部分不计入。
              上游已停止发放每日免费额度（2026-11-01 起），消耗全部从付费池扣。
            </div>
          </a-col>
        </a-row>
        <a-empty v-if="!qwRecords.length" description="还没有经网关的积分记录" />
        <a-table
          v-else
          size="small"
          :data-source="qwRecords"
          :columns="qwRecordColumns"
          row-key="req_id"
          :pagination="{ pageSize: 10, size: 'small', showSizeChanger: false }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'ts'">
              <span class="text-xs">{{ dateTimeText(record.ts) }}</span>
            </template>
            <template v-else-if="column.key === 'model'">
              <span class="font-mono text-xs">{{ record.model }}</span>
            </template>
            <template v-else-if="column.key === 'total'">
              <span class="font-medium num">{{ fmtQw(record.total) }}</span>
              <a-tooltip v-if="record.concurrent" title="与相邻请求并发，差值可能含其它请求的消耗">
                <a-tag color="orange" class="ml-1">并发</a-tag>
              </a-tooltip>
            </template>
            <template v-else-if="column.key === 'ms'">
              <span class="text-xs text-slate-500">{{ record.ms != null ? record.ms + ' ms' : '—' }}</span>
            </template>
          </template>
        </a-table>
      </a-card>
    </template>

    <!-- 搭子通道：账号池 + 用量 -->
    <template v-else>
    <!-- 登录态健康横幅（2026-11-06 清单项）：数据来自 /keepalive/health——
         后端纯内存快照，打开页面不会触发任何上游请求。判级在后端
         healthAlerts（纯函数），前端只着色展示不重复判级。
         红/黄才可展开明细，绿色一行带过不打扰。 -->
    <a-alert
      v-if="health"
      :type="healthBanner.type"
      show-icon
      class="mb-4"
    >
      <template #message>
        <span>{{ healthBanner.text }}</span>
        <a-button
          v-if="health.alerts.length"
          type="link"
          size="small"
          class="ml-2 px-1"
          @click="healthOpen = !healthOpen"
        >{{ healthOpen ? '收起明细' : `明细（${health.alerts.length}）` }}</a-button>
        <a-button type="link" size="small" class="px-1" @click="openSchedModal">排程设置</a-button>
        <a-button
          type="link"
          size="small"
          class="px-1"
          :loading="kaRunning"
          @click="onRunKeepalive"
        >立即跑一轮</a-button>
      </template>
      <template v-if="healthOpen && health.alerts.length" #description>
        <div v-for="(al, i) in health.alerts" :key="i" class="text-sm leading-7">
          <a-tag :color="al.level === 'crit' ? 'red' : 'orange'" class="mr-2">{{ al.level === 'crit' ? '危险' : '警告' }}</a-tag>
          <span class="text-slate-400 mr-2">{{ al.channel || '—' }}</span>
          <span class="font-medium mr-2">{{ al.account || '—' }}</span>
          <span>{{ al.message }}</span>
        </div>
        <div class="text-xs text-slate-400 mt-2">
          保活排程：{{ health.keepalive.enabled
            ? `每日 ${String(health.keepalive.hour).padStart(2, '0')}:${String(health.keepalive.minute).padStart(2, '0')} 启动（凭证余量 ${health.keepalive.warn_hours}h 内进预警）`
            : '未启用' }}
          <template v-if="health.keepalive.next_run_at"> · 下次 {{ fmtHealthTime(health.keepalive.next_run_at) }}</template>
          <template v-else-if="!health.keepalive.enabled"> · 账号页可开启</template>
        </div>
      </template>
    </a-alert>

    <!-- 保活排程编辑：PUT /keepalive/config（后端 configure 白名单校验 + 即时生效） -->
    <a-modal v-model:open="schedOpen" title="保活排程设置" :confirm-loading="schedSaving" @ok="saveSched">
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <span>每日自动保活</span>
          <a-switch v-model:checked="schedForm.enabled" />
        </div>
        <div class="text-xs text-slate-400 -mt-2">
          未启用时过期只在请求时被动发现；启用后每天低峰时点自动「续票 → 签到 → 查余额 → 解冻冷却账号」。
        </div>
        <div class="flex items-center justify-between">
          <span>触发时点</span>
          <a-space>
            <a-input-number v-model:value="schedForm.hour" :min="0" :max="23" style="width: 70px" />
            <span>:</span>
            <a-input-number v-model:value="schedForm.minute" :min="0" :max="59" style="width: 70px" />
          </a-space>
        </div>
        <div class="flex items-center justify-between">
          <span>随机后延（分钟）</span>
          <a-input-number v-model:value="schedForm.jitter_minutes" :min="0" :max="120" style="width: 90px" />
        </div>
        <div class="flex items-center justify-between">
          <span>提前预警窗口（小时）</span>
          <a-input-number v-model:value="schedForm.warn_hours" :min="0" :max="168" style="width: 90px" />
        </div>
        <div class="flex items-center justify-between">
          <span>签到参与解冻闭环</span>
          <a-switch v-model:checked="schedForm.checkin" />
        </div>
        <div class="text-xs text-slate-400 -mt-2">
          时点 + 随机后延只往后不往前（留在低峰窗口）；错过时点（关机/重启）会在下次启动时自动补跑，签到接口幂等不会重复领取。
        </div>
      </div>
    </a-modal>

    <!-- 顶部指标卡：数据来自 /web-accounts/dashboard（账号池）+ /stats（用量） -->
    <a-row :gutter="[16, 16]">
      <a-col :xs="12" :sm="12" :xl="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="账号总数" :value="dash?.summary.total ?? '—'">
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dash">
              启用 {{ dash.summary.enabled }} · 停用 {{ dash.summary.disabled }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :xs="12" :sm="12" :xl="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="有效期内" :value="dash?.summary.valid ?? '—'" value-style="color:var(--lab-ok)">
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dash">
              {{ dash.summary.valid === dash.summary.enabled ? '全部正常' : `${dash.summary.enabled - dash.summary.valid} 个待处理` }}
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :xs="12" :sm="12" :xl="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic
            title="即将过期积分"
            :value="dash?.summary.expiring_points ?? '—'"
            :precision="2"
            :value-style="(dash?.summary.expiring_points ?? 0) > 0 ? 'color:var(--lab-warn)' : ''"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dashExpiringRows.length">
              {{ dashExpiringRows.length }} 笔 · {{ dash?.summary.expiring_days }} 天内作废
            </template>
            <template v-else-if="dash">{{ dash.summary.expiring_days }} 天内无到期积分</template>
            <span v-else>—</span>
          </div>
          <!-- 与上面「有效期内」的账号订阅到期是两回事：那个是会员要续费，
               这个是积分要作废。同一个「即将过期」的说法容易混，这里分开写。 -->
        </a-card>
      </a-col>

      <a-col :xs="12" :sm="12" :xl="5">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="积分余额" :value="dash ? dash.summary.points_left : '—'" :precision="2" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="dash">
              <a-tag v-if="dash.summary.low_points" color="orange">
                {{ dash.summary.low_points }} 个低于 200
              </a-tag>
              <span v-else>{{ dash.summary.total }} 个账号合计</span>
            </template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>

      <a-col :xs="12" :sm="12" :xl="4">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="今日 Token" :value="todayTokensText" value-style="color:var(--lab-primary)" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="stats">{{ stats.today.requests }} 次请求</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <!-- 即将过期的积分明细。只在真有风险时出现——空的时候整块不显示，
         免得每次进仪表盘都看到一张「暂无」的卡。
         按「账号 × 到期日」聚合而不是逐个包：实测单账号 105 个包、32 个
         同一天到期，逐包列出来是一屏噪音，而真正要回答的是「哪天损失多少」。 -->
    <a-card
      v-if="dashExpiringRows.length"
      title="即将过期的积分"
      :bordered="false"
      class="mt-4"
    >
      <template #extra>
        <span class="text-xs text-slate-500">
          {{ dash?.summary.expiring_days }} 天内到期 · 合计 {{ fmt(dash?.summary.expiring_points ?? 0) }}
        </span>
      </template>
      <a-table
        size="small"
        :pagination="false"
        :data-source="dashExpiringRows"
        :columns="dashExpiringColumns"
        row-key="key"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'account'">
            <span class="text-xs">{{ record.account }}</span>
          </template>
          <template v-else-if="column.key === 'date'">
            <span class="text-xs">{{ record.date }}</span>
          </template>
          <template v-else-if="column.key === 'points'">
            <span class="font-medium text-amber-700 num">{{ fmt(record.points) }}</span>
            <span class="text-xs text-slate-400 ml-1">（{{ record.count }} 个包）</span>
          </template>
          <template v-else-if="column.key === 'sources'">
            <a-tag v-for="s in record.sources" :key="s" class="mr-1">{{ sourceText(s) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'daysLeft'">
            <a-tag :color="remainColor(record.latest)">{{ remainText(record.latest) }}</a-tag>
          </template>
        </template>
      </a-table>
      <div class="text-xs text-slate-500 mt-2">
        这些积分包到期即作废（签到赠送、成长计划奖励按各自有效期，不累积）。
        已用完的包不计入——到期不构成损失。
      </div>
    </a-card>

    <!-- 趋势 + 上游状态 -->
    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :xs="24" :lg="17">
        <a-card title="近 14 天调用趋势" :bordered="false" class="h-full">
          <a-empty v-if="!daily.length" description="还没有请求记录" />
          <!-- 请求数与 Token 拆成上下两张共享 X 轴的小图，而不是叠在一张图上用双 Y 轴：
               两个量纲的刻度对齐点是任意的，共图会凭空造出「此消彼长」的相关性。
               小倍数保留「同一时间轴上看两条趋势」的能力，又不需要读者在两套刻度间换算。 -->
          <template v-else>
            <div class="trend-block">
              <div class="trend-label">请求数</div>
              <div ref="reqChartEl" class="trend-chart" />
            </div>
            <div class="trend-block">
              <div class="trend-label">Token</div>
              <div ref="tokChartEl" class="trend-chart" />
            </div>
          </template>
        </a-card>
      </a-col>

      <a-col :xs="24" :lg="7">
        <a-card title="上游状态" :bordered="false" class="h-full">
          <a-descriptions :column="1" size="small">
            <a-descriptions-item label="网关">
              <a-tag :color="dash?.upstream.gateway_online ? 'green' : 'red'">
                {{ dash?.upstream.gateway_online ? '正常' : '未启动' }}
              </a-tag>
              <span class="text-xs text-slate-400 ml-1">:{{ dash?.upstream.gateway_port ?? 9084 }}</span>
            </a-descriptions-item>
            <a-descriptions-item label="可用账号">
              <template v-if="dash?.upstream.accounts_ready !== null && dash?.upstream.accounts_ready !== undefined">
                {{ dash.upstream.accounts_ready }} / {{ dash.upstream.accounts_total }}
              </template>
              <span v-else class="text-slate-400">—</span>
            </a-descriptions-item>
            <a-descriptions-item label="冷却中">
              <template v-if="dash?.upstream.cooling !== null && dash?.upstream.cooling !== undefined">
                {{ dash.upstream.cooling }}
              </template>
              <span v-else class="text-slate-400">—</span>
            </a-descriptions-item>
            <a-descriptions-item label="本地代理">
              <a-tag :color="status?.gateway.online ? 'green' : 'red'">
                {{ status?.gateway.online ? '在线' : '离线' }}
              </a-tag>
              <span class="text-xs text-slate-400 ml-1">:{{ status?.gateway.port ?? 9080 }}</span>
            </a-descriptions-item>
            <a-descriptions-item label="上游端口">
              {{ status?.upstream.port ?? '—' }}
              <a-tag v-if="status?.upstream.managed" color="blue" class="ml-1">自建</a-tag>
            </a-descriptions-item>
          </a-descriptions>
        </a-card>
      </a-col>
    </a-row>

    <!-- 账号健康快照 -->
    <a-card :bordered="false" class="mt-4">
      <template #title>
        <span>账号健康快照</span>
        <a-tag v-if="dash" color="green" class="ml-2">在线 {{ dash.summary.valid }}</a-tag>
      </template>
      <a-empty v-if="!dash?.accounts.length" description="还没有添加账号" />
      <a-row v-else :gutter="[16, 16]">
        <a-col v-for="a in dash.accounts" :key="a.id" :xs="24" :sm="12" :lg="8">
          <div class="account-card">
            <div class="account-card-header">
              <span class="account-card-name">{{ a.name }}</span>
              <a-tag :color="a.last_error ? 'red' : a.enabled ? 'green' : 'default'">
                {{ a.last_error ? '异常' : a.enabled ? '在线' : '停用' }}
              </a-tag>
            </div>
            <!-- 健康条：长度按会员剩余天数，30 天为满 -->
            <div class="health-bar">
              <div
                class="health-bar-fill"
                :class="healthColor(a)"
                :style="{ width: healthWidth(a) }"
              />
            </div>
            <div class="account-card-footer">
              <span class="text-slate-500">
                {{ a.days_left !== null ? a.days_left + ' 天' : '到期未知' }}
                <span v-if="a.days_alive !== null" class="text-slate-400 ml-1">
                  · 已用 {{ a.days_alive }} 天
                </span>
              </span>
              <span :class="a.points !== null && a.points < 200 ? 'text-orange-700' : 'text-slate-600'">
                {{ a.points !== null ? fmt(a.points) + ' 积分' : '积分未知' }}
              </span>
            </div>
            <div v-if="a.last_error" class="account-card-error">{{ a.last_error }}</div>
          </div>
        </a-col>
      </a-row>
    </a-card>

    <!-- 用量与账号状态明细 -->
    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :xs="24" :lg="12">
        <a-card title="今日用量" :bordered="false">
          <!-- 与千问/TRAE 用同一个组件：同一组指标（含成功率、首字延迟、
               流式占比）。此前这里用 stats/summary，缺那三项，切通道时
               指标会变——对齐后三处一致。 -->
          <TodayUsageCard :today="usage?.cards.today" />
          <div v-if="stats" class="text-xs text-slate-500 mt-2">
            累计 {{ stats.days }} 天：{{ fmt(stats.total.total_tokens) }} tokens
            / {{ stats.total.requests }} 次
          </div>
        </a-card>
      </a-col>

      <a-col :xs="24" :lg="12">
        <a-card title="本地代理账号" :bordered="false">
          <a-table
            size="small"
            :pagination="false"
            :data-source="accounts?.accounts ?? []"
            :columns="accountColumns"
            row-key="user_id"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'state'">
                <a-tag :color="stateColor(record.state)">{{ stateText(record.state) }}</a-tag>
              </template>
              <template v-else-if="column.key === 'web'">
                <a-tag v-if="record.web" color="green">已添加</a-tag>
                <span v-else class="text-xs text-slate-400">未添加</span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            「本地代理账号」是桌面端凭证（跑模型用），与上面「账号健康快照」的网页凭证是两套。
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-alert v-if="error" type="warning" show-icon class="mt-4" :message="`部分数据获取失败：${error}`" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import TodayUsageCard from '@/components/TodayUsageCard.vue'
import { channelStore, isTraework, isQwenwork, isQoder, isWorkBuddy } from '@/stores/channel'
import { qoderApi, type QoderDashboardAccount, type QoderCreditRow, type QoderGrant } from '@/api/qoder'
import { qwenworkApi, type QwCredits, type QwDailyRow, type QwAccount, type QwCreditRecord, type QwAccountsSummary } from '@/api/qwenwork'
import { lastErrorFresh, errorWhen } from '@/utils/lastError'
import { remainText, remainColor } from '@/utils/remain'
import { traeworkApi } from '@/api/traework'
import { workbuddyApi, type WorkBuddyDashAccount, type WorkBuddyCreditRow } from '@/api/workbuddy'
import { regionStore, regionParam, isIntlRegion } from '@/stores/region'
import { watch as vueWatch } from 'vue'
import type {
  TraeworkCreditRow, TraeworkDashboard, TraeworkCreditRecord, TraeworkDashAccount,
  TraeworkCreditsSummary, TraeworkExpiring,
} from '@/api/traework'
import client from '@/api/client'
import { fetchKeepaliveHealth, fetchKeepaliveConfig, saveKeepaliveConfig, runKeepaliveOnce, type KeepaliveHealth, type KeepaliveConfig } from '@/api/health'
import { App } from 'ant-design-vue'
import type { SystemStatus } from '@/api/system'
import type { PointsData, AccountsData } from '@/api/points'
import type { StatsSummary, DailyRow } from '@/api/stats'
import type { UsageOverview } from '@/api/usage'
import { SERIES, INK, TOOLTIP_BASE, axisStyle, compactNum, exactNum, lineSeries } from '@/utils/chartTheme'

interface DashAccount {
  id: number
  name: string
  nickname: string
  enabled: boolean
  points: number | null
  points_total: number | null
  subscribed: boolean
  days_left: number | null
  /** 账号存活天数（从 created_at 算到今天），与 days_left 是两回事 */
  days_alive: number | null
  expire_at: number | null
  checkin_result: string
  last_error: string
}

/** 即将过期的积分（按账号 × 到期日聚合，见后端 aggregateExpiring） */
interface DashExpiringRow {
  account: string
  accountId: number
  date: string
  points: number
  count: number
  sources: string[]
  daysLeft: number
}

interface DashData {
  summary: {
    total: number; enabled: number; disabled: number; valid: number
    expiring_soon: number; low_points: number
    points_left: number; points_total: number
    /** 30 天内会作废的积分合计。与 expiring_soon（账号订阅数）不是一回事 */
    expiring_points: number
    expiring_days: number
  }
  upstream: {
    gateway_online: boolean; gateway_port: number
    accounts_total: number | null; accounts_ready: number | null; cooling: number | null
  }
  accounts: DashAccount[]
  /** 即将过期的积分明细（账号 × 到期日）。空数组 = 窗口内无损失 */
  expiring_points_rows: DashExpiringRow[]
}

const status = ref<SystemStatus | null>(null)
const points = ref<PointsData | null>(null)
const accounts = ref<AccountsData | null>(null)
const stats = ref<StatsSummary | null>(null)
const daily = ref<DailyRow[]>([])
const dash = ref<DashData | null>(null)
// 登录态健康横幅（/keepalive/health，纯内存快照）。null = 端点不可达，
// 横幅整个隐藏（v-if）——健康面挂了不该让仪表盘跟着挂。
const health = ref<KeepaliveHealth | null>(null)
const healthOpen = ref(false)
const loading = ref(false)
const error = ref('')
const lastRefresh = ref('')

// 通道：千问办公是另一套账（积分/登录态），整块内容与搭子不同。
// 用 store 的全局状态而不是本地 ref —— 顶栏切换器与这里必须一致。
// 通道：千问与 TRAE 都是直连、账单与搭子不同（isDirectChannel），
// 但两者**彼此也不同**：千问是三个积分池、单账号只读；TRAE 是单一
// credits、多账号自持。所以页面在「非搭子」的骨架里还要再分一次。
const isTw = computed(() => isTraework())
const isQw = computed(() => isQwenwork())
const isQd = computed(() => isQoder())
const isWb = computed(() => isWorkBuddy())

// ---- WorkBuddy（第五通道，双区域）----
const wbDash = ref<{ accounts: WorkBuddyDashAccount[]; summary: { total: number; enabled: number; refreshExpired: number; errored: number } | null } | null>(null)
const wbAccounts = computed(() => wbDash.value?.accounts || [])
// 额度来自 /workbuddy/credits（套餐包，按区域过滤）。加载标志与 Qoder 同口径：
// 接口没回来（或失败）时合计显示 —，不拿 0 充数——0 会被读成「积分用完了」。
const wbCreditRows = ref<WorkBuddyCreditRow[]>([])
const wbCreditsLoaded = ref(false)
// 永不返回 null（未加载时 remain=null → 模板显示 —），
// 避免模板里到处写可能空值的 ?. 链——语义与「—」空态一致
const wbCreditsTotals = computed(() => {
  if (!wbCreditsLoaded.value) return { remain: null, checked: 0, counted: 0 }
  let remain: number | null = null
  let checked = 0
  let counted = 0
  for (const r of wbCreditRows.value) {
    if (r.total != null) remain = (remain ?? 0) + (r.totalPrecise != null ? r.totalPrecise : r.total)
    // 只数明确 true 的——查不出的（null）不计入，否则「已签 2/2」会把查不出的也算已签
    if (r.checkedIn === true) checked++
    if (r.region !== 'global') counted++
  }
  return { remain, checked, counted }
})
// 7 天内到期（按包的 expireAt 聚合；已用完的包不计入——到期不构成损失）
const wbExpiring = computed(() => {
  if (!wbCreditsLoaded.value) return { amount: 0, count: 0 }
  const now = Date.now()
  let amount = 0
  let count = 0
  for (const r of wbCreditRows.value) {
    for (const p of r.packages || []) {
      if (p.expireAt && p.expireAt > now && p.expireAt <= now + 7 * 86400000 && p.remain > 0) {
        amount += p.remainPrecise != null ? p.remainPrecise : p.remain
        count++
      }
    }
  }
  return { amount, count }
})
const wbSummary = computed(() => wbDash.value?.summary || null)
const wbInfo = computed(() => channelStore.infos['workbuddy'] || null)
// 趋势数据：/usage/overview?days=14&channel=workbuddy 已在 refreshWb 里拉了
const wbDaily = computed(() => usage.value?.daily || [])

// ---- Qoder ----
// 账号健康快照来自 /qoder/dashboard（本地落盘，不打上游）
const qdDashAccounts = ref<QoderDashboardAccount[]>([])
const qdSummary = ref<{ total: number; enabled: number; refreshExpired: number; errored: number } | null>(null)
// 额度来自 /qoder/credits（打上游）。**两份额度分开合计，不能相加**：
// addOn 是签到/赠送（免费用户实际可用），user 是订阅套餐内（Free 恒为 0）。
const qdCreditRows = ref<QoderCreditRow[]>([])
// 「查过没有」的标志：credits 接口还没回来（或失败）时，合计应显示 — 而不是 0
// ——0 会被读成「账号里一分签到积分都没有」。
const qdCreditsLoaded = ref(false)
const qdTotals = computed(() => {
  if (!qdCreditsLoaded.value) return null
  let addOn = 0, user = 0
  let known = 0
  for (const r of qdCreditRows.value) {
    if (r.addOnQuota) { addOn += r.addOnQuota.remaining || 0; known++ }
    if (r.userQuota) { user += r.userQuota.remaining || 0; known++ }
  }
  // 有账号行但两池全都取不到（上游失败时后端给 null，不补 0）：
  // 合计显示 —，不拿 0 充数（0 会被读成「一分签到积分都没有」）。
  if (qdCreditRows.value.length && !known) return null
  return { addOn, user }
})
const qdValid = computed(() => qdSummary.value
  ? qdSummary.value.total - qdSummary.value.refreshExpired : null)
// 额度汇总（来自 /qoder/credits，**与 dashboard 的汇总不是一份**）：
// 过期批次数与推算剩余合计在这里，不在 dashboard 的 summary 里。
const qdCreditsSummary = ref<{
  addOnTotal: number; userTotal: number; exceeded: number
  expiringCount: number; expiringAmount: number; expiringEstimated?: boolean
} | null>(null)
// 今日用量取当前通道的埋点（与其它通道同源）。未拉到时显示 —，不用 0 充数
const qdToday = computed(() => usage.value?.cards?.today || null)
// 趋势数据：/usage/overview?days=14&channel=qoder 已在 refreshQd 里拉了，
// 这里只是把 daily 取出来。与 TRAE 同源同口径（按天聚合请求数与 Token）。
const qdDaily = computed(() => usage.value?.daily || [])
// 上游状态取顶栏那一份通道元信息（/system/status），不打上游、不额外请求
const qdInfo = computed(() => channelStore.infos['qoder'] || null)

// 积分过期明细。数据来自**本地账本 + 上游总余额的先领先扣推算**（/qoder/grants）——
// Qoder 没有逐批余额接口，amount 是**领取额**不随消耗变；estimatedRemaining
// 是推算剩余（把上游权威总余额从最新批次往回分配，与消耗顺序一致）。
const qdGrants = ref<QoderGrant[]>([])
const qdGrantsWindowDays = ref(30)
const qdGrantColumns = [
  { title: '账号', key: 'account', width: '14%' },
  { title: '推算剩余', key: 'estimatedRemaining', width: '14%' },
  { title: '领取额', key: 'amount', width: '12%' },
  { title: '领取时间', key: 'grantedAt', width: '22%' },
  { title: '到期时间', key: 'expiresAt', width: '22%' },
  { title: '剩余', key: 'daysLeft', width: '16%' },
]
// 窗口内批次的推算剩余合计（明细表 extra 用；— 表示有批次没推出来）
const qdGrantsEstTotal = computed(() => {
  const rows = qdGrants.value || []
  if (!rows.length) return null
  if (rows.some((g) => g.estimatedRemaining == null)) return null
  return rows.reduce((s, g) => s + (g.estimatedRemaining || 0), 0)
})

// 账号健康快照每张卡要的派生数据。与 TRAE 同构：
//   - 剩余额度按账号取（额度是账号级的，不能用合计）
//   - 健康条按「签到积分占其总量」的比例——这是会被消耗的余额，
//     「还剩多少」才是这个号的寿命指标（与 TRAE 的 credits 同理）
const qdCreditOf = (id: number) => qdCreditRows.value.find((c) => c.id === id) || null
// 千问的积分单位很小（单次请求 0.0025 级），两位小数会全显示成 0.00，
// 所以这条通道统一用四位小数（与 PointsView 的口径一致）
const fmtQd = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
function qdHealthWidth(id: number) {
  const c = qdCreditOf(id)
  const total = c?.addOnQuota?.total ?? 0
  const remain = c?.addOnQuota?.remaining ?? 0
  if (!total) return '0%'
  return Math.max(0, Math.min(100, (remain / total) * 100)) + '%'
}
function qdHealthColor(id: number) {
  const c = qdCreditOf(id)
  const total = c?.addOnQuota?.total ?? 0
  const remain = c?.addOnQuota?.remaining ?? 0
  if (!total) return 'bg-slate-300'
  const pct = remain / total
  // 签到积分是**会过期**的（30 天），所以低余额标红——不像 TRAE 只是补充
  if (pct <= 0.1) return 'bg-red-400'
  if (pct <= 0.3) return 'bg-orange-400'
  return 'bg-green-500'
}
// 在线判定与其他三通道同口径：无新鲜错误、未待重登、且未停用
const qdOnlineCount = computed(() =>
  qdDashAccounts.value.filter((a) => !errFresh(a) && !a.refreshExpired && a.enabled).length)
// 该账号最早到期的批次（返回归一化对象，daysLeft 保证是数字）
const qdGrantOf = (id: number): { daysLeft: number; expiresAt: number } | null => {
  const list = qdGrants.value.filter((g) => g.accountId === id)
  if (!list.length) return null
  const g = list.reduce((m, x) => (x.expiresAt < m.expiresAt ? x : m), list[0])
  return { daysLeft: g.daysLeft ?? 0, expiresAt: g.expiresAt }
}
const twInfo = computed(() => channelStore.infos['traework'] || null)
// TRAE 的额度（按账号独立）与经网关的用量（/usage 按通道过滤）是两个数据源
const twRows = ref<TraeworkCreditRow[]>([])
const usage = ref<UsageOverview | null>(null)
// 账号健康快照 + 今日积分明细。dashboard 走本地数据（不打上游），
// records 是逐笔归因——两者都是仪表盘每次进入都要拉的数据
const twDash = ref<TraeworkDashboard | null>(null)
// /credits 的汇总与到期包。**到期数据只能从这里来**——它要打上游，
// 而 /dashboard 刻意不打（见后端注释），所以汇总跟着 /credits 走。
const twSummary = ref<TraeworkCreditsSummary | null>(null)
const twExpiring = ref<TraeworkExpiring[]>([])
const twExpiringPoints = ref(0)
// 区分「查过了没有」与「还没查」：前者显示「7 天内无到期积分」，
// 后者显示 —。不然没数据时会被读成「没有风险」。
const twCreditsLoaded = ref(false)

// 即将过期表格的列。TRAE 与千问共用——两边都是「哪个账号的哪笔积分何时作废」，
// 形状一致，各写一份必然漂移。
const expiringColumns = [
  { title: '账号', key: 'account', width: '24%' },
  { title: '来源', key: 'name', width: '18%' },
  { title: '剩余', key: 'remain', width: '20%' },
  { title: '到期时间', key: 'expireAt', width: '24%' },
  { title: '剩余', key: 'daysLeft', width: '14%' },
]

// 搭子的到期表列不同——它是按「账号 × 到期日」聚合的（一个日期一行、
// 含该日的包数与来源），而不是逐包一行。所以不复用上面那份。
const dashExpiringColumns = [
  { title: '账号', key: 'account', width: '22%' },
  { title: '到期日', key: 'date', width: '18%' },
  { title: '将作废', key: 'points', width: '26%' },
  { title: '来源', key: 'sources', width: '22%' },
  { title: '剩余', key: 'daysLeft', width: '12%' },
]

// 搭子到期明细（摊平成行）。key 用「账号-日期」——同一天多账号会有多行。
const dashExpiringRows = computed(() => {
  const rows = dash.value?.expiring_points_rows || []
  return rows.map((r) => ({ ...r, key: `${r.accountId}-${r.date}` }))
})

// 上游的来源标识转中文。保留原标识在 title 里——排查时要知道它对应哪个
// 接口字段，而界面上给中文是为了可读。
const SOURCE_LABELS: Record<string, string> = {
  login_bonus: '登录奖励',
  growth_plan_2026_bonus: '成长计划',
  event_bonus: '活动赠送',
  grant_point: '发放积分',
  plan_pro: '订阅套餐',
}
function sourceText(s: string) {
  return SOURCE_LABELS[s] || s
}
const twRecords = ref<TraeworkCreditRecord[]>([])
const twWindow = ref<{ cost: number; requests: number; exact: number }>({ cost: 0, requests: 0, exact: 0 })
const twAccounts = computed(() => twDash.value?.accounts || [])
const twToday = computed(() => twDash.value?.today || null)
// 顶部的汇总与到期数据来自 /credits 的 summary/expiring（见后端注释：
// 到期数据要打上游，而 /dashboard 刻意不打）。原来的 twTotals 是前端
// 自己把 rows 加起来算的——现在后端直接给，两边口径统一由后端保证。
const qw = ref<QwCredits | null>(null)
const qwDaily = ref<QwDailyRow[]>([])
// 账号健康快照用——千问现在也是多账号池，每个账号一张卡
const qwAccounts = ref<QwAccount[]>([])
// FEFO 快照新鲜度（/accounts 响应的 fefo 字段，src/expiring.js info()）。
// 让「临期优先选号没生效」可以被看见，而不是静默退回普通轮询。
const qwFefo = ref<{ at: number | null; fresh: boolean; accounts: number; windowDays: number } | null>(null)
// 顶部指标卡（账号总数 / 有效期内 / 即将过期 / 积分余额）
const qwSummary = ref<QwAccountsSummary | null>(null)
// 即将过期的积分，摊平成表格行。来源是各账号的 expiringSoon——
// **不是** qw.expiring（那是每日额度重置，每天都「即将到期」但不是损失）。
const qwExpiringRows = computed(() => {
  const out: Array<{
    key: string; account: string; name: string; remain: number
    limit: number | null; expireAt: number; daysLeft: number
  }> = []
  const now = Date.now()
  for (const a of qwAccounts.value) {
    const es = a.expiringSoon
    if (!es || !es.count) continue
    for (const w of (es.wallets || [])) {
      const t = Date.parse(w.valid_to || '')
      if (!Number.isFinite(t)) continue
      out.push({
        key: `${a.id}-${w.valid_to}-${w.balance}`,
        account: a.name || a.username || a.id,
        name: '付费积分',
        remain: w.balance,
        limit: null,
        expireAt: t,
        daysLeft: Math.max(0, Math.ceil((t - now) / 86400000)),
      })
    }
  }
  return out.sort((x, y) => x.expireAt - y.expireAt)
})
// 今日积分明细：逐笔归因，按 req_id 与请求日志配对
const qwRecords = ref<QwCreditRecord[]>([])
const qwWindow = ref<{ total: number; requests: number }>(
  { total: 0, requests: 0 },
)
const qwInfo = computed(() => channelStore.infos['qwenwork'] || null)
// 三个池子。后端平级返回 wallets，前端不再自己合并——「月度」与「长期」
// 一个来自订阅套餐、一个来自充值赠送，合并成一张「付费额度」卡会丢信息。
const qwWallets = computed(() => qw.value?.wallets || [])

function fmtExpire(iso?: string | null) {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

/** FEFO 快照的相对年龄（TTL 默认 6 小时，分钟级展示足够） */
function fefoAgeText(at: number) {
  const m = Math.floor((Date.now() - at) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  return `${Math.floor(m / 60)} 小时前`
}

const accountColumns = [
  { title: '账号', key: 'name', dataIndex: 'name' },
  { title: '桌面凭证', key: 'state', width: '20%' },
  { title: '网页凭证', key: 'web', width: '20%' },
]

// TRAE 今日积分明细的列。cost 与 remain 分开两列——前者是「这条花了多少」，
// 后者是「花完还剩多少」，混成一列会被读成同一个指标。
const twRecordColumns = [
  { title: '时间', key: 'ts', width: '20%' },
  { title: '账号', key: 'account', width: '18%' },
  { title: '模型', key: 'model', width: '16%' },
  { title: '本次消耗', key: 'cost', width: '16%' },
  { title: '剩余额度', key: 'remain', width: '14%' },
  { title: '耗时', key: 'ms', width: '12%' },
]

// 千问今日积分明细的列。只有「消耗」一列——每日免费额度上游已停发
// （2026-11-01 起），不再分免费/付费。
const qwRecordColumns = [
  { title: '时间', key: 'ts', width: '26%' },
  { title: '模型', key: 'model', width: '20%' },
  { title: '消耗', key: 'total', width: '22%' },
  { title: '耗时', key: 'ms', width: '18%' },
]

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
// 千问的积分单位很小（单次请求 0.0025 级别），两位小数会把它们全显示成 0.00。
// 所以这个通道单独用四位小数——与 PointsView 的口径一致。
const fmtQw = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
const dateTimeText = (ts: number) =>
  new Date(ts).toLocaleString('zh-CN', { hour12: false })

// lastError 是「最近一次失败的错误串」，**只在换票/请求成功时才清空**，没有
// 过期机制——所以它经常停在几小时前的一次瞬时抖动上（实测 2026-10-02：账号页
// 显示的 403/402 其实早已自愈）。新鲜度判定收敛到 utils/lastError.ts：
// 无时间戳（旧数据）一律当陈旧，有时间戳则过 30 分钟算陈旧。
const errFresh = (a: { lastError?: string; lastErrorAt?: number | null }) => lastErrorFresh(a)
const errTimeText = (ts: number | null | undefined) => errorWhen(ts)
const compact = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B'
    : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)

const todayTokensText = computed(() =>
  stats.value ? compact(stats.value.today.total_tokens) : '—')

const stateColor = (s: string) => {
  if (s === 'active') return 'green'
  if (s === 'standby') return 'blue'
  if (s === 'no_credential') return 'orange'
  return 'default'
}
const stateText = (s: string) => {
  if (s === 'active') return '使用中'
  if (s === 'standby') return '备用'
  if (s === 'no_credential') return '无凭证'
  return '未知'
}

// 健康条：按会员剩余天数，30 天为满格。
// 用天数而不是积分——积分随时会被模型消耗，天天在变；到期日是稳定的寿命指标。
function healthWidth(a: DashAccount) {
  if (a.days_left === null) return '0%'
  const pct = Math.max(0, Math.min(100, (a.days_left / 30) * 100))
  return pct + '%'
}
function healthColor(a: DashAccount) {
  if (a.last_error) return 'bg-red-400'
  if (a.days_left === null) return 'bg-slate-300'
  if (a.days_left <= 7) return 'bg-orange-400'
  return 'bg-green-500'
}

// 千问版：按账号存活天数（从 createdAt 算到今天），365 天为满格。
// 与搭子的语义不同——「剩余」vs「已活」，但视觉规则一致：0 用灰、
// 离线/异常用红/橙、在线用绿。「待重登」也算异常色——这条通道的
// refresh token 是池里这个号自己持有的，不该再走客户端。
function healthWidthQw(a: QwAccount) {
  if (a.daysAlive === null) return '0%'
  const pct = Math.max(0, Math.min(100, (a.daysAlive / 365) * 100))
  return pct + '%'
}
function healthColorQw(a: QwAccount) {
  // 只对「新鲜的」错误标红：超过 30 分钟的大概率已自愈，别一直挂着红条
  if (errFresh(a)) return 'bg-red-400'
  if (a.refreshExpired) return 'bg-orange-400'
  if (!a.enabled || !a.usable) return 'bg-slate-300'
  return 'bg-green-500'
}
// 剩余积分的配色：0 是「这个号已经没额度了」，用红；低于 20 用橙提示。
// 负数（欠费）也算红——它同样意味着这个号现在发不出请求。
// null（未知）用灰：不知道不等于 0。
function dailyClassQw(a: QwAccount) {
  const d = a.wallets ? a.wallets.total : null
  if (d == null) return 'text-slate-400'
  if (d <= 0) return 'text-red-600'
  if (d < 20) return 'text-orange-700'
  return 'text-cyan-700'
}

// TRAE 版：与千问同一套视觉规则（0 用灰、异常用红/橙、在线用绿），
// 但长度按**剩余额度占上限的比例**——TRAE 的 credits 是会被消耗掉的
// 余额（签到补充），「还剩多少」才是这个通道最要紧的寿命指标。
// 上限取不到（接口不给）时退化为按存活天数，并在卡片上标注来源。
/** 健康条的额度上限：取所有账号里最大的 limit，没有则 null（退化到天数） */
const twCreditCap = computed(() => {
  let cap: number | null = null
  for (const r of twRows.value) if (r.limit != null && (cap === null || r.limit > cap)) cap = r.limit
  return cap
})
function healthWidthTw(a: TraeworkDashAccount) {
  const cap = twCreditCap.value
  if (cap && a.credits != null) {
    const pct = Math.max(0, Math.min(100, (a.credits / cap) * 100))
    return pct + '%'
  }
  if (a.daysAlive === null) return '0%'
  const pct = Math.max(0, Math.min(100, (a.daysAlive / 365) * 100))
  return pct + '%'
}
function healthColorTw(a: TraeworkDashAccount) {
  if (a.lastError) return 'bg-red-400'
  if (a.refreshExpired) return 'bg-orange-400'
  if (!a.enabled) return 'bg-slate-300'
  const cap = twCreditCap.value
  if (cap && a.credits != null && a.credits < cap * 0.1) return 'bg-orange-400'
  return 'bg-green-500'
}

// 趋势图用 ECharts 按需引入：只加载折线图需要的模块，
// 比全量引入（约 1MB）小得多，也避免为一个图表拖慢首屏。
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart, GridComponent, TooltipComponent, LegendComponent,
  DataZoomComponent, CanvasRenderer,
])

const reqChartEl = ref<HTMLElement | null>(null)
const tokChartEl = ref<HTMLElement | null>(null)
let reqChart: echarts.ECharts | null = null
let tokChart: echarts.ECharts | null = null

// 两张小倍数图共享同一套 X 轴刻度与 grid，纵向对齐后可以当作一条时间轴来读。
// 拆开而不是双 Y 轴：双轴的刻度对齐点没有依据，会让人读出并不存在的相关性。
function renderChart() {
  const rows = daily.value
  const days = rows.map((r) => r.day.slice(5))
  // 共享的 X 轴配置：只在下面那张显示标签，避免重复占用垂直空间
  const baseGrid = { left: 56, right: 16, top: 8, bottom: 4 }
  const xAxisCommon = {
    type: 'category' as const,
    data: days,
    boundaryGap: false,
    axisLine: { show: true, lineStyle: { color: INK.axis } },
    axisTick: { show: false },
  }
  const tooltipCommon = {
    ...TOOLTIP_BASE,
    trigger: 'axis' as const,
    axisPointer: {
      type: 'line' as const,
      lineStyle: { color: INK.axis, width: 1 },
    },
  }

  if (reqChartEl.value) {
    if (!reqChart) reqChart = echarts.init(reqChartEl.value)
    reqChart.setOption({
      grid: baseGrid,
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any[]) => {
          const r = rows[params[0].dataIndex]
          return `${r.day}<br/>请求 <b>${exactNum(r.requests)}</b>`
        },
      },
      xAxis: { ...xAxisCommon, axisLabel: { show: false } },
      yAxis: {
        type: 'value',
        ...axisStyle({ formatter: (v: number) => compactNum(v) }),
      },
      series: [
        lineSeries({
          name: '请求数',
          data: rows.map((r) => r.requests),
          color: SERIES[0],
          area: true,
        }),
      ],
    })
  }

  if (tokChartEl.value) {
    if (!tokChart) tokChart = echarts.init(tokChartEl.value)
    tokChart.setOption({
      grid: { ...baseGrid, bottom: 22 },
      tooltip: {
        ...tooltipCommon,
        formatter: (params: any[]) => {
          const r = rows[params[0].dataIndex]
          return `${r.day}<br/>Token <b>${exactNum(r.total_tokens)}</b>`
        },
      },
      xAxis: { ...xAxisCommon, axisLabel: { color: INK.muted, fontSize: 11 } },
      yAxis: {
        type: 'value',
        ...axisStyle({ formatter: (v: number) => compactNum(v) }),
      },
      series: [
        lineSeries({
          name: 'Token',
          data: rows.map((r) => r.total_tokens),
          color: SERIES[1],
          area: true,
        }),
      ],
    })
  }
}

// 千问办公的数据单独拉：它走的是 /qwenwork/* 而不是搭子那套接口，
// 两者混在一个 Promise.all 里会让任一通道故障拖垮整页。
async function refreshQw() {
  loading.value = true
  error.value = ''
  try {
    const [c, d, a, rec, u] = await Promise.all([
      qwenworkApi.credits(),
      qwenworkApi.daily(14),
      // 账号健康快照用——不取的话下面那块只是空骨架
      qwenworkApi.accounts(),
      // 今日积分明细（逐笔归因）
      qwenworkApi.creditRecords(200).catch(() => ({ data: { rows: [], window: { total: 0, requests: 0 } } })),
      // 今日用量（请求数 / Token / 耗时）。与搭子仪表盘同一数据源，
      // 这样切通道时看到的是同一套指标，不用重新适应。
      client.get(`/usage/overview?days=14&channel=qwenwork`).catch(() => ({ data: null })),
    ])
    qw.value = c.data
    qwDaily.value = d.data.rows
    qwAccounts.value = (a.data && a.data.accounts) || []
    qwSummary.value = (a.data && a.data.summary) || null
    qwFefo.value = (a.data && a.data.fefo) || null
    qwRecords.value = (rec.data && rec.data.rows) || []
    qwWindow.value = (rec.data && rec.data.window) || { total: 0, requests: 0 }
    usage.value = u.data
    await channelStore.load()
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    await nextTick()
    renderQwChart()
    renderQwTokenChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

async function refreshQd() {
  loading.value = true
  error.value = ''
  try {
    const r = regionParam() as 'cn' | 'intl' | undefined
    const [d, c, g, u] = await Promise.all([
      // 账号健康快照：本地落盘，不打上游（按当前区域视图过滤）
      qoderApi.dashboard(r).catch(() => ({ data: { accounts: [], summary: null } })),
      // 额度：打上游。两份额度分开合计，不合并（按当前区域视图）
      // 失败返回 null（不是空 rows）：下面的 loaded 只在真拿到数据时才置 true，
      // 否则失败会被渲染成「合计 0.0000」，与「缺失显示 —」的口径相反。
      qoderApi.credits(r).catch(() => null),
      // 积分过期明细：本地账本 + 各账号总余额的先领先扣推算（上游侧）
      qoderApi.grants(30).catch(() => ({ data: { rows: [], windowDays: 30 } })),
      // 今日用量：与其它通道同一数据源（按当前区域过滤）
      client.get(`/usage/overview?days=14&channel=qoder${r ? `&region=${r}` : ''}`).catch(() => ({ data: null })),
    ])
    qdDashAccounts.value = (d.data.accounts || []) as QoderDashboardAccount[]
    qdSummary.value = d.data.summary || null
    if (c) {
      qdCreditRows.value = (c.data.rows || []) as QoderCreditRow[]
      qdCreditsLoaded.value = true
      // 过期批次数与领取额合计来自 credits 的 summary（dashboard 的 summary 里没有）
      qdCreditsSummary.value = (c.data as any).summary || null
    } else {
      qdCreditRows.value = []
      qdCreditsLoaded.value = false
      qdCreditsSummary.value = null
    }
    qdGrants.value = (g.data.rows || []) as QoderGrant[]
    qdGrantsWindowDays.value = g.data.windowDays || 30
    usage.value = u.data
    await channelStore.load()
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    // 趋势图要在 DOM 挂上之后再画（v-if 控制的元素此时才存在）
    await nextTick()
    renderQdChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

// TRAE Work 的数据分三路拉：额度（/traework/credits）、用量（/usage 按通道
// 过滤）、通道元信息（system/status）。与千问分开是因为两者的账完全不同，
// 混在一个 Promise.all 里会让任一通道故障拖垮整页。
async function refreshTw() {
  loading.value = true
  error.value = ''
  try {
    const r = regionParam() as 'cn' | 'intl' | undefined
    const [c, u, d, rec] = await Promise.all([
      traeworkApi.credits(r).catch(() => ({
        data: { count: 0, rows: [], summary: null, expiring: [], expiringPoints: 0 },
      })),
      client.get(`/usage/overview?days=14&channel=traework${r ? `&region=${r}` : ''}`).catch(() => ({ data: null })),
      // 账号健康快照 + 今日消耗：本地数据，不打上游（按当前区域视图过滤）
      traeworkApi.dashboard(r).catch(() => ({ data: null })),
      traeworkApi.creditRecords(200, r).catch(() => ({ data: { rows: [], window: { cost: 0, requests: 0, exact: 0 } } })),
    ])
    twRows.value = c.data.rows || []
    twSummary.value = c.data.summary || null
    twExpiring.value = c.data.expiring || []
    twExpiringPoints.value = c.data.expiringPoints || 0
    twCreditsLoaded.value = true
    usage.value = u.data
    twDash.value = d.data
    twRecords.value = (rec.data && rec.data.rows) || []
    twWindow.value = (rec.data && rec.data.window) || { cost: 0, requests: 0, exact: 0 }
    await channelStore.load()
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    await nextTick()
    renderTwChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

// WorkBuddy 仪表盘：指标卡（本地 dashboard + credits）+ 趋势 + 账号健康快照。
// 签到仅国内版有；国际视图不显示签到统计
async function refreshWb() {
  loading.value = true
  error.value = ''
  try {
    const r = regionParam() as 'cn' | 'intl' | undefined
    const [d, u, c] = await Promise.all([
      workbuddyApi.dashboard(r).catch(() => ({ data: { accounts: [], summary: null } })),
      client.get(`/usage/overview?days=14&channel=workbuddy${r ? `&region=${r}` : ''}`).catch(() => ({ data: null })),
      workbuddyApi.credits(r).catch(() => ({ data: { rows: [] } })),
    ])
    wbDash.value = d.data
    usage.value = u.data
    wbCreditRows.value = c.data?.rows || []
    wbCreditsLoaded.value = true
    await channelStore.load()
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    await nextTick()
    renderWbChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

// 横幅着色与文案：判级已在后端 healthAlerts 完成，这里只做映射——
// crit>0 红、warn>0 黄、否则绿。绿色不展开明细，一行带过。
const healthBanner = computed(() => {
  const h = health.value
  if (!h) return { type: 'success' as const, text: '' }
  const { crit, warn, enabled } = h.summary
  if (crit > 0) return { type: 'error' as const, text: `账号池有 ${crit} 个危险项 · ${warn} 个警告（${enabled} 个启用账号）` }
  if (warn > 0) return { type: 'warning' as const, text: `账号池 ${warn} 个警告（${enabled} 个启用账号，无危险项）` }
  return { type: 'success' as const, text: `账号池健康：${enabled} 个账号全部正常` }
})
const fmtHealthTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

// ── 保活排程编辑 + 手动触发 ──
// message 走 App.useApp() 实例（静态 import 拿不到上下文，与 WebAccountsView 同口径）
const { message } = App.useApp()
const schedOpen = ref(false)
const schedSaving = ref(false)
const kaRunning = ref(false)
const schedForm = reactive<KeepaliveConfig>({
  enabled: false, hour: 22, minute: 30, jitter_minutes: 30,
  warn_hours: 24, sem_cap: 3, per_account_delay_ms: 2000,
  balance_threshold: 0, checkin: true,
})

async function openSchedModal() {
  schedOpen.value = true
  try {
    Object.assign(schedForm, await fetchKeepaliveConfig())
  } catch (e) {
    // 拉不到配置就用当前表单默认值（保存时后端白名单校验兜底）
  }
}

async function saveSched() {
  schedSaving.value = true
  try {
    await saveKeepaliveConfig({ ...schedForm })
    schedOpen.value = false
    message.success(schedForm.enabled ? '排程已保存并启用' : '排程已保存（当前未启用）')
    await refresh(true)
  } catch (e: any) {
    message.error(e?.response?.data?.error || e?.message || '保存失败')
  } finally {
    schedSaving.value = false
  }
}

// 触发式：POST 只负责点火（一轮可能跑几十秒），跑完的结果在横幅/明细里刷新可见
async function onRunKeepalive() {
  kaRunning.value = true
  try {
    await runKeepaliveOnce()
    message.info('保活轮已启动：续票 → 签到 → 查余额 → 解冻，跑完刷新本页查看结果')
  } catch (e: any) {
    message.error(e?.response?.data?.error || e?.message || '触发失败')
  } finally {
    setTimeout(() => { kaRunning.value = false }, 3000)
  }
}

async function refresh(force = false) {
  if (isTw.value) return refreshTw()
  if (isQw.value) return refreshQw()
  if (isQd.value) return refreshQd()
  if (isWb.value) return refreshWb()
  loading.value = true
  error.value = ''
  try {
    const [s, p, a, st, dy, db, u, h] = await Promise.all([
      client.get('/system/status'),
      // 桌面凭证不存在时（客户端已卸载）这两个接口必然 502——这是预期状态
      // 不是故障。它们只喂两张次要卡片，不能让 Promise.all 短路把整页数据
      // 拖成空白（实测过的崩溃形态：全页只剩「部分数据获取失败」一条）。
      client.get('/points/points' + (force ? '?refresh=1' : '')).catch(() => ({ data: null })),
      client.get('/points/accounts').catch(() => ({ data: null })),
      client.get('/stats/summary'),
      client.get('/stats/daily?days=14'),
      client.get('/web-accounts/dashboard'),
      // 今日用量：与千问/TRAE 同一数据源，保证三个通道显示同一组指标
      // （stats/summary 没有成功率与首字延迟，只有这里给全）
      client.get('/usage/overview?days=14&channel=dumate').catch(() => ({ data: null })),
      // 健康横幅：端点失败静默降级为「不显示横幅」，不进 error 流
      fetchKeepaliveHealth().catch(() => null),
    ])
    status.value = s.data
    points.value = p.data
    accounts.value = a.data
    stats.value = st.data
    daily.value = dy.data.rows
    dash.value = db.data
    usage.value = u.data
    health.value = h
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    // 等 DOM 更新后再渲染，否则 ref 还没挂上
    await nextTick()
    renderChart()
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '未知错误'
  } finally {
    loading.value = false
  }
}

// TRAE 趋势：与搭子同口径（请求数 + Token 两张小倍数图）。
// 原来只画请求数——Token 是判断「这个通道烧了多少」的主要指标，
// 缺了它切到 TRAE 就看不到用量规模。
const twReqChartEl = ref<HTMLElement | null>(null)
const twTokChartEl = ref<HTMLElement | null>(null)
let twReqChart: echarts.ECharts | null = null
let twTokChart: echarts.ECharts | null = null

function renderTwChart() {
  const rows = usage.value?.daily || []
  if (!rows.length) return
  const days = rows.map((r) => r.day.slice(5))
  const xAxis = {
    type: 'category' as const,
    data: days,
    boundaryGap: false,
    axisLine: { show: true, lineStyle: { color: INK.axis } },
    axisTick: { show: false },
  }
  const yAxis = { type: 'value' as const, ...axisStyle({ formatter: (v: number) => compactNum(v) }) }
  const tip = (fmtRow: (r: any) => string) => ({
    ...TOOLTIP_BASE,
    trigger: 'axis' as const,
    formatter: (params: any[]) => fmtRow(rows[params[0].dataIndex]),
  })

  if (twReqChartEl.value) {
    if (!twReqChart) twReqChart = echarts.init(twReqChartEl.value)
    twReqChart.setOption({
      grid: { left: 56, right: 16, top: 8, bottom: 4 },
      tooltip: tip((r) => `${r.day}<br/>请求 <b>${exactNum(r.requests)}</b>${r.failed ? `<br/>失败 ${exactNum(r.failed)}` : ''}`),
      xAxis: { ...xAxis, axisLabel: { show: false } },
      yAxis,
      series: [lineSeries({ name: '请求数', data: rows.map((r) => r.requests), color: SERIES[0], area: true })],
    })
  }
  if (twTokChartEl.value) {
    if (!twTokChart) twTokChart = echarts.init(twTokChartEl.value)
    twTokChart.setOption({
      grid: { left: 56, right: 16, top: 8, bottom: 22 },
      tooltip: tip((r) => `${r.day}<br/>Token <b>${exactNum(r.total_tokens)}</b>`),
      xAxis: { ...xAxis, axisLabel: { color: INK.muted, fontSize: 11 } },
      yAxis,
      series: [lineSeries({ name: 'Token', data: rows.map((r) => r.total_tokens), color: SERIES[1], area: true })],
    })
  }
}

// Qoder 趋势：与 TRAE 完全同构（请求数 + Token 两张小倍数图），
// 所以**复用 renderTwChart 的画法**而不是抄一份——Qoder 与 TRAE 共用同一个
// `usage` ref（各自刷新时都会拉自己的 ?channel=），只有挂载的 DOM 不同。
// 抄一份必然漂移：改一处配色/网格就要改两处。
const qdReqChartEl = ref<HTMLElement | null>(null)
const qdTokChartEl = ref<HTMLElement | null>(null)
let qdReqChart: echarts.ECharts | null = null
let qdTokChart: echarts.ECharts | null = null

function renderQdChart() {
  const rows = qdDaily.value
  if (!rows.length) return
  const days = rows.map((r) => r.day.slice(5))
  const xAxis = {
    type: 'category' as const,
    data: days,
    boundaryGap: false,
    axisLine: { show: true, lineStyle: { color: INK.axis } },
    axisTick: { show: false },
  }
  const yAxis = { type: 'value' as const, ...axisStyle({ formatter: (v: number) => compactNum(v) }) }
  const tip = (fmtRow: (r: any) => string) => ({
    ...TOOLTIP_BASE,
    trigger: 'axis' as const,
    formatter: (params: any[]) => fmtRow(rows[params[0].dataIndex]),
  })

  if (qdReqChartEl.value) {
    if (!qdReqChart) qdReqChart = echarts.init(qdReqChartEl.value)
    qdReqChart.setOption({
      grid: { left: 56, right: 16, top: 8, bottom: 4 },
      tooltip: tip((r) => `${r.day}<br/>请求 <b>${exactNum(r.requests)}</b>${r.failed ? `<br/>失败 ${exactNum(r.failed)}` : ''}`),
      xAxis: { ...xAxis, axisLabel: { show: false } },
      yAxis,
      series: [lineSeries({ name: '请求数', data: rows.map((r) => r.requests), color: SERIES[0], area: true })],
    })
  }
  if (qdTokChartEl.value) {
    if (!qdTokChart) qdTokChart = echarts.init(qdTokChartEl.value)
    qdTokChart.setOption({
      grid: { left: 56, right: 16, top: 8, bottom: 22 },
      tooltip: tip((r) => `${r.day}<br/>Token <b>${exactNum(r.total_tokens)}</b>`),
      xAxis: { ...xAxis, axisLabel: { color: INK.muted, fontSize: 11 } },
      yAxis,
      series: [lineSeries({ name: 'Token', data: rows.map((r) => r.total_tokens), color: SERIES[1], area: true })],
    })
  }
}

// WorkBuddy 趋势：与 TRAE/Qoder 完全同构（请求数 + Token 两张小倍数图），
// 复用 renderQdChart 的画法而不是抄一份——与 Qoder 共用同一个 `usage` ref，
// 只有挂载的 DOM 不同。抄一份必然漂移：改一处配色/网格就要改两处。
const wbReqChartEl = ref<HTMLElement | null>(null)
const wbTokChartEl = ref<HTMLElement | null>(null)
let wbReqChart: echarts.ECharts | null = null
let wbTokChart: echarts.ECharts | null = null

function renderWbChart() {
  const rows = wbDaily.value
  if (!rows.length) return
  const days = rows.map((r) => r.day.slice(5))
  const xAxis = {
    type: 'category' as const,
    data: days,
    boundaryGap: false,
    axisLine: { show: true, lineStyle: { color: INK.axis } },
    axisTick: { show: false },
  }
  const yAxis = { type: 'value' as const, ...axisStyle({ formatter: (v: number) => compactNum(v) }) }
  const tip = (fmtRow: (r: any) => string) => ({
    ...TOOLTIP_BASE,
    trigger: 'axis' as const,
    formatter: (params: any[]) => fmtRow(rows[params[0].dataIndex]),
  })

  if (wbReqChartEl.value) {
    if (!wbReqChart) wbReqChart = echarts.init(wbReqChartEl.value)
    wbReqChart.setOption({
      grid: { left: 56, right: 16, top: 8, bottom: 4 },
      tooltip: tip((r) => `${r.day}<br/>请求 <b>${exactNum(r.requests)}</b>${r.failed ? `<br/>失败 ${exactNum(r.failed)}` : ''}`),
      xAxis: { ...xAxis, axisLabel: { show: false } },
      yAxis,
      series: [lineSeries({ name: '请求数', data: rows.map((r) => r.requests), color: SERIES[0], area: true })],
    })
  }
  if (wbTokChartEl.value) {
    if (!wbTokChart) wbTokChart = echarts.init(wbTokChartEl.value)
    wbTokChart.setOption({
      grid: { left: 56, right: 16, top: 8, bottom: 22 },
      tooltip: tip((r) => `${r.day}<br/>Token <b>${exactNum(r.total_tokens)}</b>`),
      xAxis: { ...xAxis, axisLabel: { color: INK.muted, fontSize: 11 } },
      yAxis,
      series: [lineSeries({ name: 'Token', data: rows.map((r) => r.total_tokens), color: SERIES[1], area: true })],
    })
  }
}

// 千问趋势：与搭子同口径加一张 Token 图。积分图保留——它是这个通道
// 独有的（免费/付费分池），但 Token 是跨通道可比的用量指标。
const qwTokChartEl = ref<HTMLElement | null>(null)
let qwTokChart: echarts.ECharts | null = null

function renderQwTokenChart() {
  const rows = usage.value?.daily || []
  if (!qwTokChartEl.value || !rows.length) return
  if (!qwTokChart) qwTokChart = echarts.init(qwTokChartEl.value)
  qwTokChart.setOption({
    grid: { left: 56, right: 16, top: 12, bottom: 22 },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      formatter: (params: any[]) => {
        const r = rows[params[0].dataIndex]
        return `${r.day}<br/>Token <b>${exactNum(r.total_tokens)}</b><br/>请求 ${exactNum(r.requests)} 次`
      },
    },
    xAxis: { type: 'category', data: rows.map((r) => r.day.slice(5)), ...axisStyle({ showGrid: false }) },
    yAxis: { type: 'value', ...axisStyle({ formatter: (v: number) => compactNum(v) }) },
    series: [lineSeries({ name: 'Token', data: rows.map((r) => r.total_tokens), color: SERIES[1], area: true })],
  })
}

// 千问积分趋势：免费与付费堆叠。分开画是因为「消耗的是免费额度还是
// 付费额度」是本通道最要紧的一件事——堆叠能一眼看出付费是否开始被动用。
const qwChartEl = ref<HTMLElement | null>(null)
let qwChart: echarts.ECharts | null = null

function renderQwChart() {
  const rows = qwDaily.value
  if (!qwChartEl.value || !rows.length) return
  if (!qwChart) qwChart = echarts.init(qwChartEl.value)
  const days = rows.map((r) => r.day.slice(5))
  qwChart.setOption({
    grid: { left: 56, right: 16, top: 12, bottom: 24 },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      formatter: (params: any[]) => {
        const r = rows[params[0].dataIndex]
        return `${r.day}<br/>消耗 <b>${exactNum(r.total)}</b><br/>请求 ${exactNum(r.requests)} 次`
      },
    },
    legend: { data: ['消耗'], right: 0, top: 0, textStyle: { color: INK.secondary, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
    xAxis: { type: 'category', data: days, boundaryGap: false, axisLine: { show: true, lineStyle: { color: INK.axis } }, axisTick: { show: false }, axisLabel: { color: INK.muted, fontSize: 11 } },
    // 积分量级很小（单次请求 0.0025~0.02），compactNum 会把刻度全取整成
    // 1/0，看不出差别——这里用小数位而不是紧凑格式。
    yAxis: { type: 'value', ...axisStyle({ formatter: (v: number) => (v === 0 ? '0' : v.toFixed(2)) }) },
    series: [
      // 只有一条线：每日免费额度上游已停发（2026-11-01 起），消耗全走付费池。
      // 画两条（其中一条恒 0）只会让读者怀疑是不是坏了。
      lineSeries({ name: '消耗', data: rows.map((r) => r.total), color: SERIES[1], area: true }),
    ],
  })
}

function onResize() {
  reqChart?.resize()
  tokChart?.resize()
  qwChart?.resize()
  // 直连通道新加的两张图（TRAE 请求/Token、千问 Token）也要跟着 resize，
  // 否则窗口变化后它们停在旧尺寸上
  twReqChart?.resize()
  twTokChart?.resize()
  qwTokChart?.resize()
  qdReqChart?.resize()
  qdTokChart?.resize()
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  refresh()
})

// 切通道要重拉数据：四条通道的数据源不同，不重拉会看到上一个通道的残留。
// 两个 computed 都要 watch——只盯 isQw 的话从搭子切到 TRAE 不触发。
watch([isQw, isTw, isQd, isWb], () => { refresh() })
// 切区域重拉（顶栏统一切换）：TRAE/Qoder/WorkBuddy 的数据按区域走
vueWatch(() => regionStore.current, () => {
  if (isTw.value || isQd.value || isWb.value) refresh()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  reqChart?.dispose()
  tokChart?.dispose()
  qwChart?.dispose()
  twReqChart?.dispose()
  twTokChart?.dispose()
  qwTokChart?.dispose()
  qdReqChart?.dispose()
  qdTokChart?.dispose()
  reqChart = null
  tokChart = null
  qwChart = null
  twReqChart = null
  twTokChart = null
  qwTokChart = null
})
</script>

<style scoped>
.qw-chart {
  height: 260px;
  width: 100%;
}
</style>
