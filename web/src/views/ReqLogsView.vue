<template>
  <div class="page">
    <PageHeader title="请求日志">
      <template #sub>
        <template v-if="tab === 'gateway'">
          网关每条转发的原始记录，点行看详情
          <template v-if="data"> · 共 {{ data.total }} 条</template>
        </template>
        <template v-else>
          上游计费记录（与网页端「积分消费记录」同源）
          <template v-if="points"> · 共 {{ points.total }} 条 · 合计 {{ fmtNum(points.consumed_points) }}</template>
        </template>
      </template>
      <template #actions>
        <!-- 通道跟随顶栏的全局切换，不另设选择器 -->
        <a-tag :color="isDirect ? 'cyan' : 'blue'" class="mr-1">{{ chLabel }}</a-tag>
        <a-select
          v-if="tab === 'gateway'"
          v-model:value="filterStatus"
          size="small"
          style="width: 100px"
          :options="statusOptions"
        />
        <a-select
          v-else
          v-model:value="filterAccount"
          size="small"
          style="width: 130px"
          :options="accountFilterOptions"
        />
        <a-select v-model:value="days" size="small" style="width: 110px" :options="dayOptions" />
        <a-button
          size="small"
          class="ghost-btn"
          :loading="tab === 'gateway' ? loading : pointsLoading"
          @click="load"
        >
          刷新
        </a-button>
      </template>
    </PageHeader>

    <a-tabs v-model:activeKey="tab" @change="onTabChange">
      <a-tab-pane key="gateway" tab="网关请求" />
      <!-- 「积分消费明细」是搭子上游的计费账单，两条直连通道都没有这份数据 -->
      <a-tab-pane v-if="!isDirect" key="points" tab="积分消费明细" />
    </a-tabs>

    <a-card v-if="tab === 'gateway'" :bordered="false">
      <a-table
        size="small"
        :data-source="data?.rows ?? []"
        :columns="columns"
        row-key="ts"
        :scroll="{ x: 1180 }"
        :pagination="pagination"
        :loading="loading"
        :custom-row="customRow"
        @change="onTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <span class="text-xs">{{ fmtTime(record.ts) }}</span>
          </template>
          <template v-else-if="column.key === 'path'">
            <span class="font-mono text-xs">{{ record.path }}</span>
            <a-tag v-if="record.stream" color="blue" class="ml-1">流式</a-tag>
          </template>
          <template v-else-if="column.key === 'channel'">
            <!-- 历史记录没有 channel 字段（分通道之前产生的），如实显示「—」
                 而不是默认成搭子——那会让搭子的历史数字凭空变大。
                 服务端过滤时把它们算进搭子，但这里仍标注来源，不伪造字段 -->
            <a-tag v-if="record.channel === 'qwenwork'" color="cyan">千问</a-tag>
            <a-tag v-else-if="record.channel === 'traework'" color="purple">TRAE</a-tag>
            <a-tag v-else-if="record.channel === 'qoder'" color="orange">Qoder</a-tag>
            <a-tag v-else-if="record.channel === 'dumate'" color="blue">搭子</a-tag>
            <a-tooltip v-else title="分通道埋点上线前的记录">
              <a-tag color="default">搭子*</a-tag>
            </a-tooltip>
            <!-- 区域（2026-11-03 国际版）：traework/qoder 随实际服务账号记录。
                 旧数据与纯国内通道没有这个字段，不显示——空串不能读成国内 -->
            <a-tag v-if="record.region === 'intl'" color="purple" class="ml-1">国际</a-tag>
            <a-tag v-else-if="record.region === 'cn'" color="blue" class="ml-1">国内</a-tag>
          </template>
          <template v-else-if="column.key === 'model'">
            <div class="text-xs">{{ record.model || '—' }}</div>
            <div v-if="record.mapped_model && record.mapped_model !== record.model" class="text-xs text-slate-500">
              → {{ record.mapped_model }}
            </div>
          </template>
          <template v-else-if="column.key === 'account'">
            <!-- 账号名可能很长（千问的显示名、TRAE 的昵称），加 tooltip 看全 -->
            <a-tooltip v-if="record.account" :title="record.account">
              <span class="text-xs">{{ record.account }}</span>
            </a-tooltip>
            <span v-else class="text-xs text-slate-400">—</span>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="statusColor(record.status)">{{ record.status || '中断' }}</a-tag>
          </template>
          <template v-else-if="column.key === 'ms'">
            <span class="num text-xs">{{ fmtMs(record.ms) }}</span>
            <div v-if="record.first_token_ms" class="num text-xs text-slate-500">首字 {{ fmtMs(record.first_token_ms) }}</div>
          </template>
          <template v-else-if="column.key === 'tokens'">
            <span class="num text-xs">{{ compact(record.total_tokens) }}</span>
            <div class="num text-xs text-slate-500">{{ compact(record.input_tokens) }} / {{ compact(record.output_tokens) }}</div>
          </template>
          <template v-else-if="column.key === 'client'">
            <span class="text-xs">{{ record.key || (record.key_id ? `key-${record.key_id}` : '未用密钥') }}</span>
            <!-- 链路来源：搭子上游有两条不同的路——桌面 auth.json 与网页凭证池。
                 模型名与计费相同（都是搭子），但凭证来源与轮询行为不同，
                 排查「为什么这次用了另一个账号」时要看这个 -->
            <div class="text-xs text-slate-500">
              <a-tag v-if="record.upstream === 'web'" color="geekblue">网页凭证</a-tag>
              {{ uaShort(record.ua) }}
            </div>
          </template>
          <template v-else-if="column.key === 'points'">
            <!-- 千问通道：扣的是千问自己的积分池，与搭子的余额游标是两套账。
                 按 req_id 精确配对，归因要等结算，刚发出的请求可能还没值。
                 不再标扣费池——上游停发每日免费额度后只剩付费池一个来源 -->
            <template v-if="record.channel === 'qwenwork'">
              <div v-if="record.qw_total !== undefined" class="text-xs">
                <span class="num text-blue-600">{{ fmtQw(record.qw_total) }}</span>
                <div v-if="record.qw_concurrent" class="text-xs text-slate-500">
                  <a-tooltip title="与相邻请求并发，差值可能含其它请求的消耗">
                    <span class="text-orange-700">并发</span>
                  </a-tooltip>
                </div>
              </div>
              <span v-else class="text-xs text-slate-400">—</span>
            </template>
            <!-- TRAE Work：消耗来自按 req_id 配对的归因记录（账号另有独立列） -->
            <template v-else-if="record.channel === 'traework'">
              <span v-if="record.tw_cost !== undefined" class="text-xs">
                <span class="num text-purple-500">{{ fmtQw(record.tw_cost) }}</span>
                <a-tooltip v-if="record.tw_exact === false" title="与同账号相邻请求并发，差值可能含对方的消耗">
                  <span class="text-xs text-orange-700">并发</span>
                </a-tooltip>
              </span>
              <div v-else-if="record.tw_account" class="text-xs text-slate-400">
                —
                <div class="text-xs text-slate-500">待下一条</div>
              </div>
              <span v-else class="text-xs text-slate-400">—</span>
            </template>
            <!-- Qoder：上游 usage 直给本条 credits，三条直连通道里唯一精确归因的 -->
            <template v-else-if="record.channel === 'qoder'">
              <span v-if="record.qoder_cost !== undefined" class="num text-xs text-orange-700">
                {{ fmtQw(record.qoder_cost) }}
              </span>
              <span v-else class="text-xs text-slate-400">—</span>
            </template>
            <!-- 搭子通道：余额游标差 -->
            <span v-else-if="record.points_delta !== undefined" class="num text-xs" :class="record.points_delta > 0 ? 'text-green-700' : 'text-slate-600'">
              {{ record.points_delta > 0 ? '+' : '' }}{{ record.points_delta }}
            </span>
            <span v-else class="text-xs text-slate-400">—</span>
          </template>
          <template v-else-if="column.key === 'ip'">
            <span class="text-xs">{{ record.ip || '—' }}</span>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- 上游积分消费明细：网页端同一份数据，一次转发可能拆成多笔扣费 -->
    <a-card v-if="tab === 'points'" :bordered="false">
      <a-alert
        type="info"
        show-icon
        class="mb-3"
        message="这是上游的计费记录，不是网关的转发记录"
        :description="points?.note || '两者不是一一对应：一次转发可能拆成多笔扣费。'"
      />
      <div v-if="points?.accounts?.length" class="mb-3 flex flex-wrap gap-2">
        <a-tag v-for="a in points.accounts" :key="a.id" :color="a.ok ? 'blue' : 'red'">
          {{ a.name }}
          <template v-if="a.ok">：{{ fmtNum(a.consumed_points ?? 0) }} 积分 / {{ a.total_count ?? 0 }} 笔</template>
          <template v-else>：{{ a.error }}</template>
        </a-tag>
      </div>
      <div v-if="filterAccount === null" class="text-xs text-slate-500 mb-3">
        全部账号时每个账号各显示最新 {{ pointsPageSize }} 条（合计 {{ points?.total ?? 0 }} 笔）；
        要看更早的记录请选定某个账号再翻页。
      </div>
      <a-table
        size="small"
        :data-source="points?.rows ?? []"
        :columns="pointsColumns"
        row-key="rowKey"
        :scroll="{ x: 640 }"
        :pagination="pointsPagination"
        :loading="pointsLoading"
        @change="onPointsTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <span class="text-xs">{{ fmtTime(record.ts) }}</span>
          </template>
          <template v-else-if="column.key === 'account'">
            <span class="text-xs">{{ record.account }}</span>
          </template>
          <template v-else-if="column.key === 'points'">
            <span class="num text-xs text-red-600">{{ record.points }}</span>
          </template>
          <template v-else-if="column.key === 'package_id'">
            <span class="font-mono text-xs">{{ record.package_id || '—' }}</span>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- 请求详情：抽屉。字段对齐桌面客户端的「请求详情」面板 -->
    <a-drawer v-model:open="detailOpen" title="请求详情" :width="480" placement="right">
      <template v-if="detail">
        <div class="mb-4">
          <div class="text-base font-medium">请求详情</div>
          <div class="text-xs text-slate-500 mt-1">{{ fmtTime(detail.ts) }}</div>
        </div>

        <div class="detail-grid">
          <div class="detail-label">来源 IP</div>
          <div class="detail-value">{{ detail.ip || '—' }}</div>

          <div class="detail-label">密钥</div>
          <div class="detail-value">{{ detail.key || (detail.key_id ? `key-${detail.key_id}` : '未使用') }}</div>

          <div class="detail-label">模型</div>
          <div class="detail-value font-mono text-xs">{{ detail.model || '—' }}</div>

          <div class="detail-label">映射模型</div>
          <div class="detail-value font-mono text-xs">{{ detail.mapped_model || '—' }}</div>

          <div class="detail-label">通道</div>
          <div class="detail-value">
            <a-tag v-if="detail.channel === 'qwenwork'" color="cyan">千问办公</a-tag>
            <a-tag v-else-if="detail.channel === 'traework'" color="purple">TRAE Work</a-tag>
            <a-tag v-else-if="detail.channel === 'qoder'" color="orange">Qoder</a-tag>
            <a-tag v-else-if="detail.channel === 'dumate'" color="blue">百度搭子</a-tag>
            <span v-else class="text-slate-400">百度搭子（分通道前的记录）</span>
            <a-tag v-if="detail.region === 'intl'" color="purple" class="ml-1">国际</a-tag>
            <a-tag v-else-if="detail.region === 'cn'" color="blue" class="ml-1">国内</a-tag>
          </div>

          <div class="detail-label">账号</div>
          <div class="detail-value">
            <!-- 埋点里的 account 是 provider 上报的「实际使用账号」。
                 TRAE 的归因记录里还有一份，两者应当一致；不一致时以埋点为准
                 并如实标出来（说明归因记录来自另一次账号选择） -->
            <template v-if="detail.account">
              {{ detail.account }}
              <span
                v-if="detail.tw_account && detail.tw_account !== detail.account"
                class="text-xs text-orange-700"
              >
                （归因记录为 {{ detail.tw_account }}）
              </span>
            </template>
            <span v-else class="text-slate-400">—</span>
          </div>

          <div class="detail-label">状态码</div>
          <div class="detail-value">
            <a-tag :color="statusColor(detail.status)">{{ detail.status || '中断' }}</a-tag>
          </div>

          <div class="detail-label">首字延迟</div>
          <div class="detail-value">{{ fmtMs(detail.first_token_ms) }}</div>

          <div class="detail-label">总耗时</div>
          <div class="detail-value">{{ fmtMs(detail.ms) }}</div>

          <div class="detail-label">Prompt Token</div>
          <div class="detail-value">{{ fmtNum(detail.input_tokens) }}</div>

          <div class="detail-label">Completion Token</div>
          <div class="detail-value">{{ fmtNum(detail.output_tokens) }}</div>

          <div class="detail-label">实际扣费</div>
          <div class="detail-value">
            <!-- 千问：扣的是千问自己的付费池，与搭子的余额游标是两套账，
                 必须分开显示 -->
            <template v-if="detail.channel === 'qwenwork'">
              <template v-if="detail.qw_total !== undefined">
                {{ fmtQw(detail.qw_total) }} 积分
                <a-tag color="blue" class="ml-1">付费池</a-tag>
                <!-- 千问是单账号直连，但显示出来便于核对「这条是不是我的号」 -->
                <div v-if="detail.qw_account" class="text-xs text-slate-500 mt-1">
                  账号：{{ detail.qw_account.name || '—' }}
                  <span v-if="detail.qw_account.tier">（{{ detail.qw_account.tier }}）</span>
                </div>
                <div v-if="detail.qw_balance" class="text-xs text-slate-500">
                  请求后余额：月度 {{ fmtQw(detail.qw_balance.monthly) }} ·
                  长期 {{ fmtQw(detail.qw_balance.longterm) }}
                </div>
                <div v-if="detail.qw_concurrent" class="text-xs text-orange-700">
                  与相邻请求并发，差值可能含其它请求的消耗
                </div>
              </template>
              <template v-else>
                —
                <span class="text-xs text-slate-400">
                  （归因要等结算，稍后刷新；或该请求未产生扣费）
                </span>
              </template>
            </template>
            <!-- TRAE Work：消耗来自按 req_id 配对的归因（账号见上方「账号」行） -->
            <template v-else-if="detail.channel === 'traework'">
              <template v-if="detail.tw_cost !== undefined">
                {{ fmtQw(detail.tw_cost) }} 额度
                <div v-if="detail.tw_consumed != null" class="text-xs text-slate-500 mt-1">
                  请求后累计已消耗 {{ fmtQw(detail.tw_consumed) }}
                  <template v-if="detail.tw_limit != null">
                    / 上限 {{ fmtQw(detail.tw_limit) }}
                  </template>
                </div>
                <div v-if="detail.tw_remain != null" class="text-xs text-slate-500">
                  剩余 {{ fmtQw(detail.tw_remain) }}
                </div>
                <div v-if="detail.tw_exact === false" class="text-xs text-orange-700">
                  与同账号相邻请求并发，差值可能含对方的消耗
                </div>
              </template>
              <template v-else-if="detail.tw_account">
                —
                <span class="text-xs text-slate-400">
                  （差值要等同账号的下一条请求才有参照点）
                </span>
              </template>
              <template v-else>
                —
                <span class="text-xs text-slate-400">（归因记录未落盘，稍后刷新）</span>
              </template>
            </template>
            <!-- Qoder：上游直给本条 credits，不需要差值参照点 -->
            <template v-else-if="detail.channel === 'qoder'">
              <template v-if="detail.qoder_cost !== undefined">
                {{ fmtQw(detail.qoder_cost) }} 积分
                <div v-if="detail.qoder_account" class="text-xs text-slate-500 mt-1">
                  账号：{{ detail.qoder_account }}
                </div>
                <div class="text-xs text-slate-400">上游按本条请求的倍率 × tokens 直给，无需差值</div>
              </template>
              <template v-else>
                —
                <span class="text-xs text-slate-400">（上游未返回 credits）</span>
              </template>
            </template>
            <template v-else-if="detail.points_delta !== undefined">
              {{ detail.points_delta > 0 ? '+' : '' }}{{ detail.points_delta }}
              <span v-if="detail.points_exact === false" class="text-xs text-orange-700">
                （与相邻请求并发，差值可能含其它请求的消耗）
              </span>
            </template>
            <template v-else>
              —
              <span class="text-xs text-slate-400">（无余额参照点，实测不到）</span>
            </template>
          </div>

          <div class="detail-label">链路</div>
          <div class="detail-value">
            <template v-if="detail.upstream === 'web'">
              <a-tag color="geekblue">网页凭证</a-tag>
              <span class="text-xs text-slate-400 ml-1">（9084 / 测试台，多账号轮询）</span>
            </template>
            <template v-else-if="detail.upstream">
              <a-tag>{{ detail.upstream }}</a-tag>
            </template>
            <span v-else class="text-slate-400">桌面后端（9080 / 9082）</span>
          </div>

          <div class="detail-label">流式</div>
          <div class="detail-value">{{ detail.stream ? '是' : '否' }}</div>

          <div class="detail-label">User-Agent</div>
          <div class="detail-value break-all text-xs">{{ detail.ua || '—' }}</div>

          <div class="detail-label">错误</div>
          <div class="detail-value">{{ detail.error || '—' }}</div>
        </div>
      </template>
    </a-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import { channelStore, CHANNELS, isDirectChannel, channelParam } from '@/stores/channel'
import type { ReqLogRow, ReqLogsData, PointsRecord, PointsRecordsData } from '@/api/reqlogs'

const data = ref<ReqLogsData | null>(null)
const loading = ref(false)
const days = ref(7)
const filterStatus = ref('all')
const page = ref(1)
const pageSize = 50

const tab = ref<'gateway' | 'points'>('gateway')
const points = ref<PointsRecordsData | null>(null)
const pointsLoading = ref(false)
const pointsPage = ref(1)
const pointsPageSize = 50
const filterAccount = ref<number | null>(null)

const detail = ref<ReqLogRow | null>(null)
const detailOpen = ref(false)

// 当前通道。网关请求按通道在**服务端**过滤；「积分消费明细」是搭子上游的
// 账单，三条直连通道都没有那份数据，所以该页签在直连通道下隐藏。
const isDirect = computed(() => isDirectChannel())
const chLabel = computed(() => CHANNELS.find((c) => c.id === channelStore.current)?.label || channelStore.current)

const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '仅成功', value: 'ok' },
  { label: '仅失败', value: 'err' },
]
const dayOptions = [
  { label: '近 24 小时', value: 1 },
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
]

const columns = [
  { title: '时间', key: 'ts', width: '13%' },
  { title: '路径', key: 'path', width: '13%' },
  { title: '通道', key: 'channel', width: '7%' },
  { title: '模型', key: 'model', width: '12%' },
  // 这条请求实际用了哪个上游账号。搭子/千问是当前登录的那个，
  // TRAE 是多账号池里轮询选中的那个——由 provider 上报，不是猜的
  { title: '账号', key: 'account', width: '11%' },
  { title: '状态', key: 'status', width: '6%' },
  { title: '耗时', key: 'ms', width: '9%' },
  { title: 'Token（总/入/出）', key: 'tokens', width: '11%' },
  { title: '扣费', key: 'points', width: '8%' },
  { title: '调用方', key: 'client', width: '10%' },
  { title: 'IP', key: 'ip', width: '8%' },
]

// 上游消费明细的列。上游只给「时间 + 金额 + 包 ID」，
// 没有模型/token，所以列就这几项，不凭空补字段
const pointsColumns = [
  { title: '消费时间', key: 'ts', width: '30%' },
  { title: '账号', key: 'account', width: '25%' },
  { title: '消耗积分', key: 'points', width: '20%' },
  { title: '额度包', key: 'package_id', width: '25%' },
]

const accountFilterOptions = computed(() => {
  const opts = [{ label: '全部账号', value: null as number | null }]
  for (const a of points.value?.accounts ?? []) {
    opts.push({ label: a.name, value: a.id })
  }
  return opts
})

const pointsPagination = computed(() => {
  // 上游按账号分页。合并视图下「每账号各取 N 条」的行数是 N×账号数，
  // 与按 pageSize 算出的页码对不上，翻页会错位。所以全部账号时不分页，
  // 只给每个账号的最新一批；选具体账号后才是真正按上游页码翻页。
  if (filterAccount.value === null) return false as const
  return {
    current: pointsPage.value,
    pageSize: pointsPageSize,
    total: points.value?.total ?? 0,
    size: 'small',
    showSizeChanger: false,
    showTotal: (t: number) => `共 ${t} 条`,
  }
})

const pagination = computed(() => ({
  current: page.value,
  pageSize,
  total: data.value?.total ?? 0,
  size: 'small',
  showSizeChanger: false,
  showTotal: (t: number) => `共 ${t} 条`,
}))

const fmtTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })
const fmtNum = (n: number) => (n || 0).toLocaleString('zh-CN')
// 千问积分保留 4 位：实测单次消耗 0.0025，按 2 位显示会变成 0
const fmtQw = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
// 千问不再区分扣费池：上游停发每日免费额度后只剩付费池一个来源，
// 「每日免费 / 付费」两栏恒为 0 与全额。
const fmtMs = (ms: number | null | undefined) =>
  typeof ms !== 'number' ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
const compact = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0))

function uaShort(ua?: string) {
  if (!ua) return ''
  // 取最有辨识度的一段：claude-cli/2.1.270 (external, cli) → claude-cli/2.1.270
  const m = ua.match(/([\w.-]+\/[\d.]+)/)
  return m ? m[1] : ua.slice(0, 40)
}

function statusColor(s: number) {
  if (s >= 200 && s < 400) return 'green'
  if (s >= 400 && s < 500) return 'orange'
  if (s >= 500) return 'red'
  return 'default'
}

function customRow(record: ReqLogRow) {
  // cursor: pointer 是「这一行可以点开详情」的唯一视觉线索——
  // 表格行默认没有可点击的暗示，不加用户不知道能点。
  return {
    onClick: () => openDetail(record),
    style: { cursor: 'pointer' },
  }
}

function openDetail(record: ReqLogRow) {
  detail.value = record
  detailOpen.value = true
}

function onTableChange(p: { current: number }) {
  page.value = p.current
  load()
}

async function load() {
  if (tab.value === 'points') return loadPoints()
  loading.value = true
  try {
    const params = new URLSearchParams({
      days: String(days.value),
      status: filterStatus.value,
      // 通道在服务端过滤：日志是滚动的，前端筛只能筛掉当前页的行，
      // 分页总数仍是全通道的，两者会对不上。
      // 用 channelParam() 而不是逐个比对——加第四条通道时不该再来改这里
      channel: channelParam(),
      limit: String(pageSize),
      offset: String((page.value - 1) * pageSize),
    })
    const { data: d } = await client.get('/reqlogs?' + params.toString())
    data.value = d
  } finally {
    loading.value = false
  }
}

async function loadPoints() {
  pointsLoading.value = true
  try {
    const params = new URLSearchParams({
      days: String(days.value),
      page: String(pointsPage.value),
      limit: String(pointsPageSize),
    })
    if (filterAccount.value) params.set('account_id', String(filterAccount.value))
    const { data: d } = await client.get('/reqlogs/points-records?' + params.toString())
    // 上游不返回唯一 id，用「账号+时间+金额+序号」拼一个稳定 key：
    // 同一秒可能有多笔同额扣费，只靠时间会撞 key 导致表格渲染错乱
    const rows: PointsRecord[] = (d.rows ?? []).map((r: PointsRecord, i: number) => ({
      ...r,
      rowKey: `${r.account_id}-${r.ts}-${r.points}-${i}`,
    }))
    points.value = { ...d, rows }
  } finally {
    pointsLoading.value = false
  }
}

function onTabChange(key: string | number) {
  // 切到消费明细时才请求：两个接口打的是不同上游，没必要一起加载
  if (key === 'points' && !points.value) loadPoints()
}

function onPointsTableChange(p: { current: number }) {
  pointsPage.value = p.current
  loadPoints()
}

// 天数或账号筛选变了要重新拉；页码回到第一页，否则会停在越界的空页上
watch([days, filterAccount], () => {
  if (tab.value !== 'points') return
  pointsPage.value = 1
  loadPoints()
})

// 切通道：日志要按新通道重拉，并回到第一页——新通道的总条数不同，
// 停在原来的页码会看到空白页
watch(() => channelStore.current, () => {
  page.value = 1
  // 直连通道没有「积分消费明细」页签，若正停在那页则切回
  if (isDirect.value && tab.value === 'points') {
    tab.value = 'gateway'
    load()
    return
  }
  load()
})

onMounted(() => load())
</script>

<style scoped>
/* 详情抽屉里的「标签 / 值」网格。
   标签列固定 130px 让所有值左对齐成一列——比例字体的值长短不一，
   不对齐会让整列看起来在抖。 */
.detail-grid {
  display: grid;
  grid-template-columns: 130px 1fr;
  row-gap: 13px;
  column-gap: 16px;
  font-size: 13px;
}
.detail-label {
  color: var(--lab-text-mute);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.4px;
  /* 与右侧值基线对齐（值是 13px，标签 11.5px，不补会视觉上偏低） */
  padding-top: 1px;
}
.detail-value {
  color: var(--lab-text);
  font-family: var(--lab-mono);
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}
/* 详情里的长文本（如 request body）单独放宽，等宽字体下会很长 */
.detail-value.pre {
  white-space: pre-wrap;
  line-height: 1.7;
  max-height: 320px;
  overflow-y: auto;
  background: var(--lab-surface-2);
  border: 1px solid var(--lab-border);
  border-radius: 8px;
  padding: 10px 12px;
}
</style>
