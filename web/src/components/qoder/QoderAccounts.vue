<template>
  <div class="page">
    <PageHeader title="账号管理" :sub="subText">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="checkinLoading" @click="checkinAll">
          一键签到
        </a-button>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
        <AccountTransferCard @imported="load" />
        <a-button type="primary" size="small" @click="openLogin">添加账号</a-button>
      </template>
    </PageHeader>

    <a-alert type="info" show-icon>
      <template #message>Qoder 的凭证由本项目自己持有，不需要任何客户端</template>
      <template #description>
        <div>
          凭证走 <b>OAuth device flow</b> 换取，存在 <code>data/qoder-accounts.json</code>。
        </div>
        <div class="mt-1">
          与千问办公的关键差异：千问的请求体必须由官方 <code>wasm</code> 生成（所以要装客户端），
          Qoder 的签名是<b>纯本地算法</b>——不依赖任何客户端安装。
        </div>
        <div class="mt-1">
          请求默认走「主账号」，失败时<b>自动转移</b>到下一个可用账号。
          新账号额度为 0，<b>必须先签到领积分</b>才能对话。
        </div>
      </template>
    </a-alert>

    <a-alert v-if="err" type="warning" show-icon class="mt-4" :message="err" />

    <a-card :bordered="false" class="mt-4">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="section-title">账号列表</span>
          <span class="hint-text ml-2">
            共 {{ rows.length }} 个 · 启用 {{ enabledCount }} 个
            <template v-if="credits.length">
              · 今日已签 {{ checkedInCount }}/{{ credits.length }}
            </template>
          </span>
        </div>
      </div>

      <a-empty v-if="!rows.length && !loading"
        :description="`还没有${regionStore.current === 'intl' ? '国际版（qoder.sh）' : '国内版（qoder.com.cn）'} Qoder 账号`">
        <a-button type="primary" @click="openLogin">添加第一个账号</a-button>
      </a-empty>

      <a-skeleton v-if="loading && !rows.length" active :paragraph="{ rows: 4 }" />

      <a-row v-else :gutter="[16, 16]">
        <a-col v-for="a in rows" :key="a.id" :span="12" :xs="24" :sm="12">
          <a-card size="small" :bordered="true" class="h-full">
            <div class="flex items-start justify-between">
              <div class="min-w-0">
                <div class="font-medium truncate">
                  {{ a.nickname || '未命名' }}
                  <a-tag v-if="a.preferred" color="blue" class="ml-1">主账号</a-tag>
                  <a-tag v-else-if="!a.enabled" color="default" class="ml-1">已停用</a-tag>
                </div>
                <div class="text-xs text-slate-400 mt-1">
                  <a-tag :color="a.region === 'cn' ? 'blue' : 'purple'" size="small">
                    {{ a.region === 'cn' ? '国内' : '国际' }}
                  </a-tag>
                  {{ a.planName || '—' }}
                </div>
                <!-- P1-1：Token 续期状态。后台轮转探针写，失败不写 lastError。
                     没有记录时显示「—」，不猜成「正常」。 -->
                <div class="text-xs text-slate-500 mt-1">
                  Token 续期
                  <a-tag v-if="a.tokenRefresh" :color="a.tokenRefresh.ok ? 'green' : 'orange'" size="small">
                    {{ a.tokenRefresh.ok ? '已续期' : '续期失败' }}
                  </a-tag>
                  <span v-else>—</span>
                  <span v-if="a.tokenRefresh?.error" class="ml-1">{{ a.tokenRefresh.error }}</span>
                  <span v-else-if="a.expiresAt" class="ml-1">
                    到期 {{ new Date(a.expiresAt).toLocaleString('zh-CN') }}
                  </span>
                </div>
                <!-- 脱敏手机号：认号用（多个账号昵称可能相近）。
                     只显示脱敏形式——完整号码不进界面，账号文件里也没有。 -->
                <div v-if="a.phoneMasked" class="text-xs text-slate-500 mt-1">
                  <span class="font-mono">{{ a.phoneMasked }}</span>
                </div>
                <!-- 临期角标（批次二十一）：qoder 不在 expiring-snapshot 里，
                     从 grants 账本出（credits 行的 expiring* 字段）——有金额
                     也有最早到期时刻，比快照通道的信息更全 -->
                <div v-if="expiringOf(a.id)" class="mt-2">
                  <a-tooltip title="7 天窗口内会作废的批次；金额是推算剩余（余额查不到时回落领取额口径）。明细见积分明细页的 Qoder 批次账本。">
                    <a-tag :color="expiringOf(a.id)!.urgent ? 'red' : 'orange'">
                      {{ expiringOf(a.id)!.dateText }} 到期 · 剩 {{ expiringOf(a.id)!.daysLeft }} 天 · ≈{{ expiringOf(a.id)!.amountText }} 积分
                    </a-tag>
                  </a-tooltip>
                </div>
              </div>
              <a-switch
                size="small"
                :checked="a.enabled"
                @change="(v: boolean) => toggle(a, v)"
              />
            </div>

            <a-alert
              v-if="a.lastError"
              :type="lastErrorFresh(a) ? 'error' : 'warning'"
              :message="errorWhen(a.lastErrorAt) + a.lastError"
              show-icon
              class="mt-2"
              style="padding: 4px 8px"
            />

            <!-- 今日签到状态。
                 判据是**只读**的 /campaigns（claimStatus），查它不会触发领取——
                 与 TRAE 的 checkedIn 同一口径。查不出（null）显示「—」并说明原因，
                 不猜成「已签」：新账号靠这个提示去领第一笔积分（额度为 0 时
                 聊天会挂起，不是报错）。 -->
            <div class="mt-3 flex items-center justify-between gap-2">
              <div class="min-w-0">
                <div class="text-xs text-slate-400">今日签到</div>
                <div class="mt-1 flex items-center gap-1 flex-wrap">
                  <a-tag :color="checkinColor(a)">{{ checkinText(a) }}</a-tag>
                  <span v-if="checkinNextText(a)" class="text-xs text-slate-500">
                    {{ checkinNextText(a) }}
                  </span>
                </div>
              </div>
              <div class="text-right shrink-0">
                <div class="text-xs text-slate-400">上次签到</div>
                <div class="text-xs mt-1">
                  {{ creditOf(a.id)?.lastCheckin ? dateText(creditOf(a.id)!.lastCheckin!) : '—' }}
                </div>
              </div>
            </div>

            <!-- 查询失败要分两条说：额度和签到状态是两次独立请求，
                 混成一条「查询失败」会让用户不知道自己点的签到到底成没成 -->
            <a-alert
              v-if="creditOf(a.id)?.checkinError"
              type="warning"
              show-icon
              class="mt-2"
              style="padding: 4px 8px"
              :message="'签到状态查询失败：' + creditOf(a.id)!.checkinError"
            />
            <a-alert
              v-if="creditOf(a.id)?.error"
              type="warning"
              show-icon
              class="mt-2"
              style="padding: 4px 8px"
              :message="'额度查询失败：' + creditOf(a.id)!.error"
            />

            <!-- 额度：userQuota（订阅内）与 addOnQuota（签到/赠送）**分开显示**，
                 不能相加——Free 套餐的 userQuota 恒为 0。 -->
            <div v-if="creditOf(a.id)" class="mt-3 grid grid-cols-2 gap-2">
              <div class="qw-pool">
                <div class="qw-pool-label">签到积分</div>
                <div class="qw-pool-value num text-cyan-700">
                  {{ fmtQ(creditOf(a.id)!.addOnQuota?.remaining) }}
                </div>
              </div>
              <div class="qw-pool">
                <div class="qw-pool-label">套餐内额度</div>
                <div class="qw-pool-value num">
                  {{ fmtQ(creditOf(a.id)!.userQuota?.remaining) }}
                </div>
              </div>
            </div>
            <!-- 团队共享额度池：团队号才有，个人号没有这个对象。
                 有效余额 = 套餐 + 可用共享池，所以它必须单列，不能加进上面两格 -->
            <div v-if="creditOf(a.id)?.orgResourcePackage" class="mt-2 text-xs">
              <span class="text-slate-500">团队共享池：</span>
              <span v-if="creditOf(a.id)!.orgResourcePackage!.unlimited" class="text-cyan-700">不限量</span>
              <span v-else class="num text-cyan-700">
                {{ fmtQ(creditOf(a.id)!.orgResourcePackage!.remaining) }}
                <span class="text-slate-500">
                  / {{ fmtQ(creditOf(a.id)!.orgResourcePackage!.cap) }}
                  <template v-if="!creditOf(a.id)!.orgResourcePackage!.available">（不可用）</template>
                </span>
              </span>
            </div>
            <div v-else class="mt-3 text-xs text-slate-500">额度未查询（点「刷新」）</div>

            <!-- 该账号的积分到期情况。签到积分**领取后 30 天作废**，
                 所以这里报最早的到期批次。剩余是**推算值**（先领先扣，
                 总余额来自上游额度接口）；领取额仅对照。 -->
            <div v-if="grantOf(a.id)" class="mt-2 text-xs">
              <span class="text-slate-500">最早到期：</span>
              <span :class="remainColor(grantOf(a.id)!.expiresAt) === 'red' ? 'text-red-600' : remainColor(grantOf(a.id)!.expiresAt) === 'orange' ? 'text-orange-700' : 'text-slate-400'">
                {{ new Date(grantOf(a.id)!.expiresAt).toLocaleDateString('zh-CN') }}
                （{{ remainText(grantOf(a.id)!.expiresAt) }}，推算剩余
                {{ grantOf(a.id)!.estimatedRemaining == null ? '—' : fmtQ(grantOf(a.id)!.estimatedRemaining) }}）
              </span>
              <!-- 归属核验（P0-2）：每日积分按账号各发一份，只有服务端判定
                   「同一个人」时才只发一份。所以「领过了」与「真领到了」是两回事。
                   三态严格区分，问不出结论就显示「未核实」——不猜不假报。 -->
              <a-tag
                :color="verifyColor(grantOf(a.id)!.verification)"
                class="ml-1"
                :title="grantOf(a.id)!.verifyNote || ''"
              >
                {{ verifyText(grantOf(a.id)!.verification) }}
              </a-tag>
              <div v-if="grantOf(a.id)!.verification === 'same_person'" class="text-orange-700 mt-1">
                额度进了同一个人的另一个号——本号没有积分进账，别按领取额算
              </div>
              <div v-else-if="grantOf(a.id)!.verification === 'unverified'" class="text-slate-400 mt-1">
                归属未核实{{ grantOf(a.id)!.verifyNote ? '：' + grantOf(a.id)!.verifyNote : '' }}
              </div>
            </div>
            <div v-else-if="creditOf(a.id) && (creditOf(a.id)!.addOnQuota?.remaining ?? 0) > 0" class="mt-2 text-xs text-slate-500">
              有签到积分但无到期记录（本功能上线前领的，无法追溯）
            </div>

            <div class="flex items-center justify-between mt-3">
              <span class="text-xs text-slate-500">
                {{ a.daysAlive !== null ? '已用 ' + a.daysAlive + ' 天' : '' }}
              </span>
              <div class="flex gap-2">
                <a-button size="small" :loading="checkinBusy[a.id]" @click="checkinOne(a)">签到</a-button>
                <a-popconfirm
                  v-if="proEligible(a.id)"
                  title="Pro 福利包是一次性领取（+1800），领取后不可撤回，确定？"
                  ok-text="确定领取"
                  @confirm="claimPro(a)"
                >
                  <a-button size="small" :loading="proBusy[a.id]">领 Pro 福利包</a-button>
                </a-popconfirm>
                <a-button size="small" v-if="!a.preferred" @click="setMain(a)">设为主账号</a-button>
                <a-popconfirm title="删除并移入回收站（30 天内可恢复）？" @confirm="remove(a)">
                  <a-button size="small" danger>删除</a-button>
                </a-popconfirm>
              </div>
            </div>
          </a-card>
        </a-col>
      </a-row>
    </a-card>

    <!-- ============ 添加账号（device flow）============ -->
    <a-modal v-model:open="loginOpen" title="添加 Qoder 账号" :footer="null" width="640">
      <a-steps :current="loginStep" size="small" class="mb-4">
        <a-step title="选择区域并生成链接" />
        <a-step title="浏览器登录" />
        <a-step title="等待取票" />
      </a-steps>

      <template v-if="loginStep === 0">
        <a-alert type="info" show-icon class="mb-3">
          <template #message>
            将登录{{ regionStore.current === 'intl' ? '国际版（qoder.sh）' : '国内版（qoder.com.cn）' }}账号
          </template>
          <template #description>
            区域跟随顶栏切换器（当前{{ regionStore.current === 'intl' ? '国际版' : '国内版' }}视图）。
            两套账号不通用。
          </template>
        </a-alert>
        <a-button type="primary" block :loading="urlLoading" @click="genLoginUrl">
          生成登录链接
        </a-button>
      </template>

      <template v-else-if="loginStep === 1">
        <a-alert type="info" show-icon class="mb-3">
          <template #message>
            <a :href="loginUrl" target="_blank" rel="noopener">① 点此打开登录页 →</a>
          </template>
          <template #description>
            <ol class="pl-4 mb-0 mt-1 text-xs">
              <li>在打开的页面里登录<b>要添加的那个</b> Qoder 账号</li>
              <li>登录后浏览器会跳走（<b>打不开是正常的</b>）</li>
              <li>回来点下面的按钮，程序会自动取票</li>
            </ol>
          </template>
        </a-alert>
        <div class="text-xs text-slate-400 mb-2">登录链接（如按钮失效可手动复制）</div>
        <a-textarea :value="loginUrl" :rows="3" readonly class="font-mono text-xs" />
        <div class="mt-3 flex gap-2">
          <a-button @click="cancelLogin">取消</a-button>
          <a-button type="primary" @click="startPolling">已登录，开始取票</a-button>
        </div>
      </template>

      <template v-else>
        <a-alert v-if="!loginError" type="info" show-icon class="mb-3">
          <template #message>正在等待授权结果…</template>
          <template #description>已等待 {{ waitedText }}。登录完成后会自动落盘。</template>
        </a-alert>
        <a-alert v-else type="error" show-icon class="mb-3" :message="loginError" />
        <div class="flex gap-2">
          <a-button v-if="!loginError" @click="cancelLogin">取消</a-button>
          <a-button v-else type="primary" @click="loginStep = 1">返回重试</a-button>
        </div>
      </template>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch, onUnmounted } from 'vue'
import { App } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import AccountTransferCard from '@/components/AccountTransferCard.vue'
import { channelStore, isQoder } from '@/stores/channel'
import { regionStore, regionParam } from '@/stores/region'
import { qoderApi } from '@/api/qoder'
import type { QoderAccount, QoderCreditRow, QoderGrant } from '@/api/qoder'
import { lastErrorFresh, errorWhen } from '@/utils/lastError'
import { remainText, remainColor } from '@/utils/remain'

// message 走 App.useApp() 的实例，App.vue 已包 <a-app>（静态 import 会拿不到上下文主题）
const { message } = App.useApp()

const rows = ref<QoderAccount[]>([])
const credits = ref<QoderCreditRow[]>([])
const grants = ref<QoderGrant[]>([])
const err = ref('')
const loading = ref(false)
const checkinLoading = ref(false)
const checkinBusy = reactive<Record<number, boolean>>({})
// Pro 福利包：一次性领取（+1800），资格是只读查询。true 才显示按钮，
// null（查不出）不显示——不拿一个没查到的事实催用户点。
const proBusy = reactive<Record<number, boolean>>({})
const proEligibility = ref<Record<number, boolean>>({})
const proEligible = (id: number) => proEligibility.value[id] === true

const enabledCount = computed(() => rows.value.filter((a) => a.enabled).length)
// 只数**明确**已签的；查不出的（null）不算，否则「已签 2/2」会把未知当已签
const checkedInCount = computed(() => credits.value.filter((c) => c.checkedIn === true).length)
const subText = computed(() => 'Qoder 多账号池（凭证自持，device flow 取票）')

const creditOf = (id: number) => credits.value.find((c) => c.id === id) || null

// 临期角标（批次二十一）：grants 账本 → credits 行的 expiring* 字段。
// 有临期批次才出标签（快照通道拿不到金额，qoder 恰好两样都有）。
function expiringOf(id: number): { urgent: boolean; dateText: string; daysLeft: number; amountText: string } | null {
  const c = creditOf(id)
  if (!c?.expiringNearest || !c.expiringCount || !(Number(c.expiringAmount) > 0)) return null
  const d = new Date(c.expiringNearest)
  const p = (n: number) => String(n).padStart(2, '0')
  const daysLeft = Math.max(1, Math.ceil((c.expiringNearest - Date.now()) / 86400000))
  const amt = Number(c.expiringAmount).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  return {
    urgent: daysLeft <= 3,
    dateText: `${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    daysLeft,
    // 推算剩余口径带 ≈ 前缀；回落领取额口径时如实不带（tooltip 说明）
    amountText: (c.expiringEstimated ? '≈' : '') + amt,
  }
}
// 该账号**最早到期**的批次。签到积分领取后 30 天作废，所以「最早到期」才是
// 需要提醒的那个——给全部批次会淹没在列表里。
// 数据来自本地账本 + 上游总余额的先领先扣推算（/qoder/grants）。
// 返回归一化对象（daysLeft 保证是数字），避免模板里到处判 null。
const grantOf = (id: number): {
  daysLeft: number
  expiresAt: number
  amount: number | null
  estimatedRemaining: number | null
  verification: 'claimed' | 'same_person' | 'unverified'
  verifyNote: string
} | null => {
  const list = grants.value.filter((g) => g.accountId === id)
  if (!list.length) return null
  const g = list.reduce((m, x) => (x.expiresAt < m.expiresAt ? x : m), list[0])
  return {
    daysLeft: g.daysLeft ?? 0,
    expiresAt: g.expiresAt,
    amount: g.amount,
    estimatedRemaining: g.estimatedRemaining,
    // 老行没有这个字段 → 按 unverified（**不能默认成 claimed**，那是假数据）
    verification: g.verification || 'unverified',
    verifyNote: g.verifyNote || '',
  }
}
const fmtQ = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })

// ---- 归属核验三态（P0-2）----
// claimed      CLAIMED + grantId 一致 → 真进账
// same_person  上游判同人 → 额度进了另一个号，本号没有进账
// unverified   问不出结论 → **如实标未核实，不猜**
function verifyText(v: string) {
  if (v === 'claimed') return '已核实进账'
  if (v === 'same_person') return '同人已领'
  return '未核实'
}
function verifyColor(v: string) {
  if (v === 'claimed') return 'green'
  if (v === 'same_person') return 'orange'
  return 'default'
}

// ---- 今日签到 ----
// checkedIn 三态：true=已签 / false=未签 / null=查不出。
// 「查不出」必须和「未签」区分开——都是提醒用户去点签到，但把查不出显示成
// 「未签到」等于用一个没查到的事实下结论。
function checkinColor(a: QoderAccount) {
  const c = creditOf(a.id)
  if (!c || c.checkedIn == null) return 'default'
  return c.checkedIn ? 'green' : 'orange'
}
function checkinText(a: QoderAccount) {
  const c = creditOf(a.id)
  if (!c) return '—'
  if (c.checkedIn == null) return '状态未查询'
  if (c.checkedIn) return '今日已签'
  // 有明确待领额度时说出来：「还能领 100」比「未签到」更可执行
  return c.checkinPending ? `未签到 · 可领 ${fmtQ(c.checkinPending)}` : '未签到'
}
/** 下次可签时刻。Qoder 是 10:00 (UTC+8) 刷新，不是 00:00——照抄千问会误导 */
function checkinNextText(a: QoderAccount) {
  const c = creditOf(a.id)
  if (!c || !c.checkinNextAt) return ''
  const ms = c.checkinNextAt - Date.now()
  if (ms <= 0) return '· 可签到'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return `· ${h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`}后可再签`
}
const dateText = (ts: number) =>
  new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

// ---- 登录 ----
const loginOpen = ref(false)
const loginStep = ref(0)
// 区域跟随顶栏切换器（当前区域视图）——两个独立视图各登各区的账号
const loginRegion = computed<'cn' | 'global'>(() => (regionStore.current === 'intl' ? 'global' : 'cn'))
const loginUrl = ref('')
const loginNonce = ref('')
const loginError = ref('')
const urlLoading = ref(false)
const waitedMs = ref(0)
let timer: number | null = null
const waitedText = computed(() => {
  const s = Math.floor(waitedMs.value / 1000)
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
})

function openLogin() {
  loginStep.value = 0
  loginUrl.value = ''
  loginNonce.value = ''
  loginError.value = ''
  waitedMs.value = 0
  loginOpen.value = true
}

async function genLoginUrl() {
  urlLoading.value = true
  loginError.value = ''
  try {
    const { data } = await qoderApi.loginStart(loginRegion.value)
    loginUrl.value = data.url
    loginNonce.value = data.nonce
    loginStep.value = 1
  } catch (e: any) {
    loginError.value = e?.response?.data?.error || '生成登录链接失败'
  } finally {
    urlLoading.value = false
  }
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null }
}

function startPolling() {
  loginStep.value = 2
  loginError.value = ''
  waitedMs.value = 0
  stopTimer()
  const started = Date.now()
  timer = window.setInterval(async () => {
    waitedMs.value = Date.now() - started
    if (waitedMs.value > 5 * 60 * 1000) {
      stopTimer()
      loginError.value = '登录超时（5 分钟），请返回重新生成链接'
      return
    }
    try {
      const { data } = await qoderApi.loginPoll(loginNonce.value)
      if (data.status === 'ok') {
        stopTimer()
        message.success(`已添加账号：${data.account?.nickname || data.account?.id || ''}`)
        loginOpen.value = false
        await load()
        // 新账号额度为 0——主动提示去签到，否则第一次对话会挂起
        message.info('新账号额度为 0，请点「一键签到」领取积分后再对话', 6)
      } else if (data.status === 'error') {
        stopTimer()
        loginError.value = data.error || '取票失败'
      }
    } catch (e: any) {
      stopTimer()
      loginError.value = e?.response?.data?.error || '取票请求失败'
    }
  }, 2000)
}

async function cancelLogin() {
  stopTimer()
  if (loginNonce.value) {
    try { await qoderApi.loginCancel(loginNonce.value) } catch (e) { /* 忽略 */ }
  }
  loginOpen.value = false
}

// ---- 账号操作 ----
async function load() {
  loading.value = true
  try {
    // 区域视图（2026-11-03）：账号列表/额度/批次都按当前区域出——
    // 不带 region 时是**全量**，切到国际视图会显示国内账号；
    // 且切区域必须重拉（下面 watch regionStore），否则页面停在上一区
    const r = regionParam() as 'cn' | 'intl' | undefined
    const [s, c, g, p] = await Promise.all([
      qoderApi.status(r),
      qoderApi.credits(r).catch(() => ({ data: { rows: [] as QoderCreditRow[] } })),
      qoderApi.grants(365, r).catch(() => ({ data: { rows: [] as QoderGrant[] } })),
      qoderApi.proEligibility().catch(() => ({ data: { rows: [], note: '' } })),
    ])
    rows.value = s.data.rows || []
    credits.value = (c.data.rows || []) as QoderCreditRow[]
    grants.value = (g.data.rows || []) as QoderGrant[]
    const next: Record<number, boolean> = {}
    for (const r of p.data.rows || []) {
      if (r.eligible === true) next[r.id] = true
    }
    proEligibility.value = next
    err.value = s.data.error || ''
  } catch (e: any) {
    rows.value = []
    credits.value = []
    grants.value = []
    proEligibility.value = {}
    err.value = e?.response?.data?.error || e?.message || '读取 Qoder 账号失败'
  } finally {
    loading.value = false
  }
}

async function toggle(a: QoderAccount, v: boolean) {
  try { await qoderApi.patchAccount(a.id, { enabled: v }); await load() }
  catch (e: any) { message.error(e?.response?.data?.error || '更新失败') }
}

async function setMain(a: QoderAccount) {
  try { await qoderApi.patchAccount(a.id, { preferred: true }); await load() }
  catch (e: any) { message.error(e?.response?.data?.error || '设置失败') }
}

async function remove(a: QoderAccount) {
  try { await qoderApi.removeAccount(a.id); await load(); message.success('已移入回收站（30 天内可恢复）') }
  catch (e: any) { message.error(e?.response?.data?.error || '删除失败') }
}

async function checkinOne(a: QoderAccount) {
  checkinBusy[a.id] = true
  try {
    const { data } = await qoderApi.checkin(a.id)
    const r = (data.results || [])[0] || {}
    const name = a.nickname || a.id
    // P0-5：领取响应成功 ≠ 积分到账；outcome 由后端按「响应 + 实测差值」判定。
    // 没有 outcome 的旧后端仍走 ok/gained 兜底，升级期间界面不会报错。
    if (r.outcome === 'claimed') {
      // 报**实际到账差值**，不是总额——上游从不直接告诉发了多少
      message.success(r.gained > 0
        ? `${name} 签到到账 ${r.gained} credits`
        : `${name} 签到完成（上游未回报到账数量）`)
    } else if (r.outcome === 'already') {
      message.info(`${name} 今日已签到`)
    } else if (r.outcome === 'none_available') {
      message.warning(`${name} 领取响应成功但到账 0，未记为签到成功`)
    } else if (r.outcome === 'same_person') {
      message.warning(`${name} 额度已被同一人的另一账号领取`)
    } else if (r.outcome === 'exhausted' || r.outcome === 'blocked') {
      message.warning(`${name} 今日无可领积分或上游拦截，未记为成功`)
    } else if (r.ok === false) {
      message.error(`${name} 签到失败：${r.error || '未知错误'}`)
    } else if (r.gained != null && r.gained > 0) {
      message.success(`${name} 签到到账 ${r.gained} credits`)
    } else if (r.alreadyChecked) {
      message.info(`${name} 今日已签到`)
    } else {
      message.info(`${name} 签到完成（上游未回报到账数量）`)
    }
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '签到失败')
  } finally {
    checkinBusy[a.id] = false
  }
}

async function claimPro(a: QoderAccount) {
  proBusy[a.id] = true
  try {
    const { data } = await qoderApi.proClaim(a.id)
    const r = (data.results || [])[0] || {}
    if (r.skipped) message.info(`${a.nickname || a.id}：${r.reason || '不可领取'}`)
    else if (r.already) message.info(`${a.nickname || a.id} 已领取过 Pro 福利包`)
    else if (r.ok) {
      message.success(r.gained != null
        ? `${a.nickname || a.id} 领取成功，到账 ${r.gained} credits`
        : `${a.nickname || a.id} 领取成功（上游未回报到账数量）`)
    } else message.error(r.error || '领取失败')
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '领取失败')
  } finally {
    proBusy[a.id] = false
  }
}

async function checkinAll() {
  checkinLoading.value = true
  try {
    const { data } = await qoderApi.checkin()
    const results = (data.results || []) as Array<{ nickname: string; ok?: boolean; outcome?: string; gained?: number; error?: string }>
    // P0-5：claimed 才算真签成；already 单列；none_available 等「响应成功但没到账」
    // 既不算成功也不混入失败——它们要明确可见，否则零到账会被读成成功。
    const succeeded = results.filter((r) => r.outcome ? r.outcome === 'claimed' : r.ok === true && (r.gained || 0) > 0)
    const already = results.filter((r) => r.outcome === 'already')
    const failed = results.filter((r) => r.ok === false || (r.outcome && !['claimed', 'already'].includes(r.outcome)))
    const vacant = results.filter((r) => !r.ok && !r.outcome)
    const total = succeeded.reduce((s, r) => s + (r.gained || 0), 0)
    // 部分失败也必须说出来：一律报 success 会把失败账号藏在成功里
    if (failed.length || vacant.length) {
      const first = failed[0] || vacant[0]
      message.warning(
        `签到完成：到账 ${succeeded.length}/${results.length}（已签 ${already.length}），合计 ${total.toFixed(4)} credits；` +
        `${first.nickname || ''} ${first.error || first.outcome || '未回报'}`,
      )
    } else {
      message.success(`签到完成：到账 ${succeeded.length} 个账号（已签 ${already.length}），合计 ${total.toFixed(4)} credits`)
    }
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '签到失败')
  } finally {
    checkinLoading.value = false
  }
}

onMounted(load)
onUnmounted(stopTimer)
watch(() => channelStore.current, (v) => { if (isQoder(v)) load() })
// 切区域重拉：账号列表与额度都按当前区域视图（顶栏国内版/国际版）。
// 少了这一条，切到国际视图后平台会停在上一区的数据（bsk 真机抓到：
// Qoder 账号页切国际后整页空白——status 不传 region 且没重拉）
watch(() => regionStore.current, () => { if (isQoder()) load() })
</script>
