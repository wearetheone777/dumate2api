<template>
  <div class="page">
    <!-- ============ TRAE Work：凭证自持，多账号可增删 ============ -->
    <TraeworkAccounts v-if="isTw" />

    <!-- ============ 千问办公：多账号池，凭证自持（可增删、可设主账号） ============ -->
    <QwenworkAccounts v-else-if="isQw" />

    <!-- ============ Qoder：多账号池，凭证自持（device flow，不需要客户端） ============ -->
    <QoderAccounts v-else-if="isQd" />

    <!-- ============ WorkBuddy：第五通道，双区域，登录流程后置期用导入 ============ -->
    <WorkBuddyAccounts v-else-if="isWb" />

    <!-- ============ 百度搭子：原有页面 ============ -->
    <template v-else>
    <PageHeader title="账号管理" sub="网页凭证账号池：签到、抽奖、积分与模型轮询" />

    <a-alert type="info" show-icon>
      <template #message>百度搭子账号管理</template>
      <template #description>
        <div>签到、抽奖、积分都属于网页端（dumate.baidu.com），与本地代理网关是两套东西。</div>
        <div class="mt-1">
          登录态位于百度域（<code>baidu.com</code>），网页无法直接读取浏览器 cookie，
          所以添加账号时需要你手动复制一次。
        </div>
      </template>
    </a-alert>

    <a-card :bordered="false">
      <div class="card-head-row">
        <div>
          <span class="section-title">账号列表</span>
          <span class="hint-text ml-2">
            共 {{ accounts.length }} 个 · 启用 {{ enabledCount }} 个
          </span>
        </div>
        <a-space>
          <a-button
            :loading="checkingAll"
            :disabled="!enabledCount"
            @click="checkinAll"
          >
            一键签到
          </a-button>
          <a-button type="primary" size="small" @click="openAdd">添加账号</a-button>
        </a-space>
      </div>

      <a-empty v-if="!accounts.length" description="还没有添加账号">
        <a-button type="primary" @click="openAdd">添加第一个账号</a-button>
      </a-empty>

      <a-row v-else :gutter="[16, 16]">
        <a-col v-for="a in accounts" :key="a.id" :span="8">
          <a-card size="small" :bordered="true" class="h-full">
            <div class="flex items-start justify-between">
              <div>
                <div class="font-medium">
                  {{ a.name }}
                  <a-tag v-if="!a.enabled" color="default" class="ml-1">已停用</a-tag>
                </div>
                <div class="text-xs text-slate-400 font-mono mt-1">
                  BDUSS …{{ a.cookie_summary.bduss_tail }}
                </div>
              </div>
              <a-switch
                size="small"
                :checked="a.enabled"
                @change="(v: boolean) => toggle(a, v)"
              />
            </div>

            <a-alert
              v-if="a.last_error"
              type="error"
              :message="a.last_error"
              show-icon
              class="mt-2"
              style="padding: 4px 8px"
            />

            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div class="text-xs text-slate-400">今日签到</div>
                <div>
                  <a-tag :color="checkinColor(a.checkin.last_result)">
                    {{ checkinText(a.checkin.last_result) }}
                  </a-tag>
                </div>
              </div>
              <div>
                <div class="text-xs text-slate-400">积分余额</div>
                <div class="num">{{ a.points ? fmt(a.points.left) : '—' }}</div>
              </div>
              <div>
                <div class="text-xs text-slate-400">本月已签</div>
                <div class="num">{{ a.checkin.sign_in_days?.length ?? '—' }} 天</div>
              </div>
              <div>
                <div class="text-xs text-slate-400">抽奖次数</div>
                <div class="num">{{ a.lottery.remaining ?? '—' }}</div>
              </div>
            </div>

            <div class="mt-3 flex flex-wrap gap-1">
              <a-button size="small" :loading="busy[a.id]" @click="refreshStatus(a)">刷新</a-button>
              <a-button size="small" :loading="busy[a.id]" @click="checkin(a)">签到</a-button>
              <a-popconfirm
                title="确定用掉一次抽奖机会？"
                @confirm="draw(a)"
              >
                <a-button size="small" :disabled="!a.lottery.remaining">抽奖</a-button>
              </a-popconfirm>
              <a-button size="small" type="link" @click="openProxy(a)">
                代理{{ a.proxy ? '✓' : '' }}
              </a-button>
              <a-button size="small" type="link" @click="openDetail(a)">详情</a-button>
              <a-popconfirm title="删除后需重新添加并登录" @confirm="remove(a)">
                <a-button size="small" type="link" danger>删除</a-button>
              </a-popconfirm>
            </div>
          </a-card>
        </a-col>
      </a-row>
    </a-card>

    <!-- 任务执行历史不在这里。它和签到/抽奖记录是同一份数据（task-runner
         同时写 task-runs.jsonl 与统一记录流），已并入「积分明细 → 操作流水」。
         本页保留的是**操作台**：账号增删、跑任务、开轮询；记录是结果，
         放在操作台上会让「同一件事」在三个页面各有一个视图。
         跑完的即时反馈由上面的 lastRun 提示条给，历史去积分明细查。 -->

    <a-card title="任务与抽奖" :bordered="false" class="mt-4">
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs text-slate-500">
          可自动完成：发提示词给模型（QUERY_INPUT）、体验技能（USE_SKILL）。
          其余任务网页端无法自动做。
        </span>
        <a-space>
          <a-button size="small" :loading="loadingTasks" @click="refreshTasks">刷新</a-button>
          <a-button size="small" :loading="runningTasks" @click="runTasks">跑任务</a-button>
          <a-button type="primary" size="small" :loading="drawing" @click="drawAll">一键抽奖</a-button>
        </a-space>
      </div>

      <a-alert
        v-if="lastRun"
        :type="lastRun.includes('异常') || lastRun.includes('失败') ? 'warning' : 'success'"
        show-icon
        class="mb-3"
        :message="lastRun"
      >
        <template v-if="taskRunDetail.length" #description>
          <ul class="pl-4 mb-0 text-xs">
            <li v-for="(l, i) in taskRunDetail" :key="i">{{ l }}</li>
          </ul>
        </template>
      </a-alert>

      <div class="poll-bar flex items-center justify-between mb-3 p-3 rounded">
        <div>
          <div class="text-sm">
            <span class="font-medium">后台自动轮询</span>
            <a-tag :color="sched?.enabled ? 'green' : 'default'" class="ml-2">
              {{ sched?.enabled ? '已开启' : '已关闭' }}
            </a-tag>
          </div>
          <div class="text-xs text-slate-500 mt-1">
            <template v-if="sched?.enabled && sched.next_run_at">
              下次检查 {{ new Date(sched.next_run_at).toLocaleString('zh-CN') }} ·
              间隔 {{ sched.minutes }} 分钟（±{{ (sched.jitter_ratio * 100) }}% 抖动）
            </template>
            <template v-else>
              开启后每隔一段时间检查有无可完成任务，自动完成并领取抽奖次数
            </template>
          </div>
        </div>
        <a-space>
          <a-select
            v-model:value="schedMinutes"
            size="small"
            style="width: 110px"
            :options="minuteOptions"
          />
          <a-switch
            :checked="sched?.enabled"
            :loading="schedSaving"
            @change="toggleSchedule"
          />
        </a-space>
      </div>

      <a-alert
        v-if="sched"
        type="info"
        show-icon
        class="mb-3"
        message="间隔是怎么定的"
      >
        <template #description>
          <ul class="pl-4 mb-0 text-xs">
            <li v-for="(r, i) in sched.rationale" :key="i">{{ r }}</li>
          </ul>
        </template>
      </a-alert>

      <a-table
        size="small"
        :pagination="false"
        :data-source="taskAccounts"
        :columns="accountTaskColumns"
        row-key="account_id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div>{{ record.name }}</div>
            <div v-if="!record.ok" class="text-xs text-red-600">{{ record.error }}</div>
          </template>
          <template v-else-if="column.key === 'tasks'">
            <div v-for="t in record.tasks" :key="t.task_id" class="text-xs leading-5">
              <span :class="t.done ? 'text-green-700' : 'text-slate-400'">
                {{ t.done ? '✓' : '○' }}
              </span>
              <span class="ml-1">{{ t.title }}</span>
              <a-tag
                v-if="!t.done"
                :color="canAuto(t) ? 'blue' : 'default'"
                class="ml-1"
              >
                {{ canAuto(t) ? '可自动' : notAutoReason(t) }}
              </a-tag>
            </div>
          </template>
          <template v-else-if="column.key === 'draw'">
            <div class="num">{{ record.draw_remaining ?? '—' }} 次</div>
            <div class="text-xs text-slate-400 num">奖品 {{ record.my_prizes ?? '—' }} 个</div>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="模型网关" :bordered="false" class="mt-4">
      <a-alert
        :type="pool?.gateway_online ? 'success' : 'warning'"
        show-icon
        class="mb-3"
      >
        <template #message>
          <span v-if="pool?.gateway_online">
            网关运行中 · 端口 {{ pool.gateway_port }} · 可用账号
            {{ pool.health?.accounts_ready ?? 0 }} / {{ pool.health?.accounts_total ?? 0 }}
          </span>
          <span v-else>
            网关未启动（端口 {{ pool?.gateway_port ?? 9084 }}）
          </span>
        </template>
        <template #description>
          <div v-if="!pool?.gateway_online">
            启动方式：双击 <code>start-web-gateway.bat</code>，或运行
            <code>node src\web-gateway.js</code>
          </div>
          <div v-else>
            用下面的账号跑模型，多账号自动轮询。客户端把 Base URL 指向
            <code>http://127.0.0.1:{{ pool.gateway_port }}</code> 即可，
            协议与 9080 完全一致。
          </div>
        </template>
      </a-alert>

      <a-table
        size="small"
        :pagination="false"
        :data-source="pool?.accounts ?? []"
        :columns="poolColumns"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div>{{ record.name }}</div>
            <div v-if="record.last_error" class="text-xs text-red-600">
              {{ record.last_error }}
            </div>
          </template>
          <template v-else-if="column.key === 'enabled'">
            <a-tag :color="record.enabled ? 'green' : 'default'">
              {{ record.enabled ? '参与轮询' : '已排除' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'points'">
            {{ record.points !== null ? fmt(record.points) : '—' }}
          </template>
          <template v-else-if="column.key === 'action'">
            <a-button
              type="link"
              size="small"
              :loading="probing[record.id]"
              @click="probeModel(record)"
            >
              测试
            </a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- 添加账号 -->
    <a-modal
      v-model:open="addOpen"
      title="添加账号"
      :footer="null"
      width="560"
    >
      <a-tabs v-model:activeKey="addMode">
        <a-tab-pane key="browser" tab="浏览器登录（推荐）">
          <a-alert type="info" show-icon class="mb-3">
            <template #message>点下面的按钮会打开一个浏览器窗口</template>
            <template #description>
              在那个窗口里登录百度账号，程序检测到登录成功后会自动获取凭证并关闭窗口。
              无需手动复制任何东西。
            </template>
          </a-alert>

          <a-form layout="vertical">
            <a-form-item label="备注名称（可选）">
              <a-input v-model:value="form.name" placeholder="留空则用账号昵称" />
            </a-form-item>
          </a-form>

          <div v-if="loginSession && loginSession.status !== 'idle'" class="mb-3">
            <a-alert
              :type="loginAlertType"
              show-icon
              :message="loginAlertText"
            />
          </div>

          <a-space>
            <a-button
              type="primary"
              :loading="loginSession?.status === 'waiting'"
              :disabled="loginSession?.status === 'waiting'"
              @click="startBrowserLogin"
            >
              {{ loginSession?.status === 'waiting' ? '等待登录中…' : '打开登录窗口' }}
            </a-button>
            <a-button
              v-if="loginSession?.status === 'waiting'"
              @click="cancelBrowserLogin"
            >
              取消
            </a-button>
          </a-space>

          <div v-if="!browserAvailable" class="text-xs text-red-600 mt-2">
            未检测到 Edge 或 Chrome，请改用右侧的「手动粘贴」
          </div>
        </a-tab-pane>

        <a-tab-pane key="manual" tab="手动粘贴">
          <a-alert type="warning" show-icon class="mb-3">
            <template #message>
              <a :href="loginUrl" target="_blank" rel="noopener">① 点此打开登录页 →</a>
            </template>
            <template #description>
              <ol class="pl-4 mb-0 mt-1 text-xs">
                <li v-for="(s, i) in loginSteps" :key="i">{{ s }}</li>
              </ol>
            </template>
          </a-alert>

          <a-form layout="vertical">
            <a-form-item label="备注名称">
              <a-input v-model:value="form.name" placeholder="留空则用账号昵称" />
            </a-form-item>
            <a-form-item label="Cookie" required>
              <a-textarea
                v-model:value="form.cookie"
                :rows="5"
                placeholder="粘贴完整 Cookie，必须包含 BDUSS=..."
              />
            </a-form-item>
            <a-form-item v-if="verifyResult">
              <a-alert
                :type="verifyResult.ok ? 'success' : 'error'"
                :message="verifyResult.ok
                  ? `验证通过：${verifyResult.nickname || verifyResult.uid}`
                  : `验证失败：${verifyResult.error}`"
                show-icon
              />
            </a-form-item>
          </a-form>
          <a-button type="primary" :loading="saving" block @click="saveManual">
            验证并添加
          </a-button>
        </a-tab-pane>

        <a-tab-pane key="desktop" tab="桌面端直读（最简）">
          <a-alert type="info" show-icon class="mb-3">
            <template #message>读本机 DuMate 客户端的登录态，一键导入</template>
            <template #description>
              解密 <code>%APPDATA%\qianfan-desktop-app\auth.json</code>（AES-256-GCM，
              排布实测见 <code>src/auth-import.js</code>）——无需装客户端的机器用不了这个方式，
              改走「手动粘贴」。同一账号重复导入会被 BDUSS 去重如实挡住。
            </template>
          </a-alert>

          <a-form layout="vertical">
            <a-form-item label="备注名称（可选）">
              <a-input v-model:value="form.name" placeholder="留空则用账号昵称" />
            </a-form-item>
          </a-form>

          <a-button type="primary" :loading="desktopImporting" block @click="importDesktop">
            一键导入桌面端登录态
          </a-button>
          <div v-if="desktopImportResult" class="text-xs mt-2" :class="desktopImportResult.ok ? 'text-emerald-600' : 'text-red-600'">
            {{ desktopImportResult.text }}
          </div>
        </a-tab-pane>
      </a-tabs>
    </a-modal>

    <!-- 账号详情 -->
    <a-drawer
      v-model:open="detailOpen"
      :title="`账号详情 · ${detail?.name ?? ''}`"
      width="640"
    >
      <a-spin :spinning="detailLoading">
        <template v-if="detail">
          <a-alert
            v-if="detail.expired"
            type="error"
            show-icon
            message="登录态已失效，请删除后重新添加"
            class="mb-3"
          />

          <a-descriptions title="签到" :column="2" size="small" bordered class="mb-4">
            <a-descriptions-item label="今日状态">
              <a-tag :color="detail.checkin.has_issued ? 'green' : 'orange'">
                {{ detail.checkin.has_issued ? '已签到' : '未签到' }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="累计签到">
              {{ detail.checkin.total_times ?? '—' }} 次
            </a-descriptions-item>
            <a-descriptions-item label="本月已签">
              {{ detail.checkin.sign_in_days?.length ?? 0 }} 天
            </a-descriptions-item>
            <a-descriptions-item label="本月获得">
              {{ detail.checkin.month_points ?? '—' }} 积分
            </a-descriptions-item>
          </a-descriptions>

          <div class="mb-4">
            <div class="text-sm font-medium mb-2">本月签到日历</div>
            <div class="flex flex-wrap gap-1">
              <a-tag
                v-for="d in monthDays"
                :key="d.day"
                :color="d.signed ? 'green' : 'default'"
                :title="d.day"
              >
                {{ d.label }}
              </a-tag>
            </div>
          </div>

          <a-descriptions title="积分" :column="2" size="small" bordered class="mb-4">
            <a-descriptions-item label="可用余额">
              <span class="num">{{ detail.points.left ?? '—' }}</span>
            </a-descriptions-item>
            <a-descriptions-item label="累计总量">
              {{ detail.points.total ?? '—' }}
            </a-descriptions-item>
            <a-descriptions-item label="已用">
              {{ detail.points.used ?? '—' }}
            </a-descriptions-item>
            <a-descriptions-item label="限流">
              <a-tag :color="detail.points.throttled ? 'red' : 'green'">
                {{ detail.points.throttled ? '受限' : '正常' }}
              </a-tag>
            </a-descriptions-item>
          </a-descriptions>

          <a-descriptions title="抽奖" :column="2" size="small" bordered class="mb-4">
            <a-descriptions-item label="剩余次数">
              {{ detail.lottery.remaining_draws ?? 0 }}
            </a-descriptions-item>
            <a-descriptions-item label="我的奖品">
              {{ detail.lottery.my_prizes?.length ?? 0 }} 个
            </a-descriptions-item>
          </a-descriptions>

          <div v-if="detail.lottery.prizes?.length" class="mb-4">
            <div class="text-sm font-medium mb-2">奖品池</div>
            <a-table
              size="small"
              :pagination="false"
              :data-source="detail.lottery.prizes"
              :columns="prizeColumns"
              row-key="id"
            />
          </div>

          <div v-if="Array.isArray(detail.tasks) && detail.tasks.length" class="mb-4">
            <div class="text-sm font-medium mb-2">任务</div>
            <a-table
              size="small"
              :pagination="false"
              :data-source="detail.tasks"
              :columns="taskColumns"
              row-key="id"
            />
          </div>
        </template>
      </a-spin>
    </a-drawer>

    <!-- 出站代理编辑（per-account）：留空 = 走全局默认（无全局则直连）。
         后端 normalizeProxyField 归一化，非法 URL 会 400；显示的是脱敏形态
         （带 user:pass 的代理不出明文），重新输入完整地址即可覆盖。 -->
    <a-modal v-model:open="proxyOpen" :title="`出站代理：${proxyTarget?.name || ''}`" :confirm-loading="proxySaving" @ok="saveProxy">
      <a-form layout="vertical">
        <a-form-item
          label="代理地址"
          extra="支持 http/https/socks5，可带 user:pass；留空清除，走全局默认。当前显示为脱敏形态，覆盖请输入完整地址。"
        >
          <a-input
            v-model:value="proxyForm.proxy"
            placeholder="如 http://user:pass@127.0.0.1:7890 或 socks5://127.0.0.1:1080"
          />
        </a-form-item>
      </a-form>
      <div class="text-xs text-slate-400">
        该代理只影响这个账号的出站请求（签到/查余额/模型调用），用于多账号出口 IP 隔离；
        配置非法会在保存时报错，绝不静默回退直连。
      </div>
    </a-modal>

    <!-- 会话浏览器：网页端只读查询（会话/项目/connector），与账号管理同源凭证 -->
    <SessionBrowser />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { App } from 'ant-design-vue'
import client from '@/api/client'
import { channelStore, isTraework, isQwenwork, isQoder, isWorkBuddy } from '@/stores/channel'
import TraeworkAccounts from '@/components/traework/TraeworkAccounts.vue'
import QwenworkAccounts from '@/components/qwenwork/QwenworkAccounts.vue'
import QoderAccounts from '@/components/qoder/QoderAccounts.vue'
import WorkBuddyAccounts from '@/components/workbuddy/WorkBuddyAccounts.vue'
import SessionBrowser from '@/components/SessionBrowser.vue'
import type { WebAccount, AccountStatus, PoolData, PoolAccount } from '@/api/webaccounts'

// message 走 App.useApp() 的实例（App.vue 已包 <a-app>），静态 import 拿不到上下文
const { message } = App.useApp()

// 三条通道三种账号形态：搭子是网页凭证池、千问与 TRAE 都是凭证自持可增删。
// 后两者的数据由各自的子组件自己拉（字段与搭子不同），这里只做分支。
const isTw = computed(() => isTraework())
const isQw = computed(() => isQwenwork())
const isQd = computed(() => isQoder())
const isWb = computed(() => isWorkBuddy())

const accounts = ref<WebAccount[]>([])
const loginUrl = ref('')
const loginSteps = ref<string[]>([])
const addOpen = ref(false)
const detailOpen = ref(false)
const saving = ref(false)
const checkingAll = ref(false)
const detailLoading = ref(false)
const detail = ref<AccountStatus | null>(null)
const busy = reactive<Record<number, boolean>>({})
const probing = reactive<Record<number, boolean>>({})
const pool = ref<PoolData | null>(null)
const taskAccounts = ref<any[]>([])
const autoTypes = ref<string[]>([])
const notAutoMap = ref<Record<string, string>>({})
const runningTasks = ref(false)
const loadingTasks = ref(false)
const drawing = ref(false)
const lastRun = ref('')
// 最近一次跑任务的逐条明细（任务名 / 耗时 / 真实积分）
const taskRunDetail = ref<string[]>([])

// 任务执行历史列表已移走（并入「积分明细 → 操作流水」），这里只保留
// 本次跑完的即时反馈。用户切到积分明细时会重新拉取，本页不再持有那份列表。

const sched = ref<any>(null)
const schedMinutes = ref(30)
const schedSaving = ref(false)
// 只给不低于下限的选项——低于 5 分钟对封号只有风险没有收益
const minuteOptions = [
  { label: '15 分钟', value: 15 },
  { label: '30 分钟', value: 30 },
  { label: '1 小时', value: 60 },
  { label: '2 小时', value: 120 },
  { label: '6 小时', value: 360 },
]
const verifyResult = ref<{ ok: boolean; nickname?: string; uid?: string; error?: string } | null>(null)

const form = reactive({ name: '', cookie: '' })
const addMode = ref<'browser' | 'manual'>('browser')
const browserAvailable = ref(true)
const loginSession = ref<any>(null)
let pollTimer: any = null

const loginAlertType = computed(() => {
  const s = loginSession.value?.status
  if (s === 'waiting') return 'info'
  if (s === 'success' || s === 'saved') return 'success'
  if (s === 'failed') return 'error'
  return 'warning'
})
const loginAlertText = computed(() => {
  const s = loginSession.value
  if (!s) return ''
  if (s.status === 'waiting') return '已打开登录窗口，请在其中完成登录…'
  if (s.status === 'saved') return `已添加账号：${s.account?.name ?? ''}`
  if (s.status === 'success') return '登录成功，正在保存…'
  if (s.status === 'cancelled') return '已取消'
  return s.message || '登录失败'
})

const prizeColumns = [
  { title: '奖品', key: 'name', dataIndex: 'name' },
  { title: '类型', key: 'type', dataIndex: 'type' },
]
const taskColumns = [
  { title: '任务', key: 'title', dataIndex: 'title' },
  { title: '状态', key: 'status', dataIndex: 'status' },
]
const accountTaskColumns = [
  { title: '账号', key: 'name', width: '22%' },
  { title: '任务', key: 'tasks' },
  { title: '抽奖', key: 'draw', width: '18%' },
]
const poolColumns = [
  { title: '账号', key: 'name' },
  { title: '轮询', key: 'enabled', width: '18%' },
  { title: '积分', key: 'points', width: '20%' },
  { title: '操作', key: 'action', width: '14%' },
]

const enabledCount = computed(() => accounts.value.filter((a) => a.enabled).length)

// 本月日历：把 sign_in_days 里的日期映射到 1..今天
const monthDays = computed(() => {
  const signed = new Set(detail.value?.checkin.sign_in_days ?? [])
  const now = new Date()
  const today = now.getDate()
  const out = []
  for (let d = 1; d <= today; d++) {
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    out.push({ day: key, label: String(d), signed: signed.has(key) })
  }
  return out
})

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })

function checkinText(r: string) {
  return r === 'claimed' ? '已签到' : r === 'already' ? '今日已签' : r === 'failed' ? '签到失败' : '未签到'
}
function checkinColor(r: string) {
  return r === 'claimed' || r === 'already' ? 'green' : r === 'failed' ? 'red' : 'default'
}

async function load() {
  const { data } = await client.get('/web-accounts')
  accounts.value = data.accounts
  loginUrl.value = data.login_url
  // 池状态单独取：它依赖网关进程，网关没起时其余信息仍要能显示
  try {
    const { data: p } = await client.get('/web-accounts/pool')
    pool.value = p
  } catch (e) { /* 忽略 */ }
  await loadTasks()
}

async function loadTasks() {
  try {
    const { data } = await client.get('/web-accounts/tasks')
    taskAccounts.value = data.accounts
    autoTypes.value = data.auto_types || []
    notAutoMap.value = data.not_automatable || {}
  } catch (e) { /* 忽略 */ }
  try {
    const { data: sc } = await client.get('/web-accounts/tasks/schedule')
    sched.value = sc
    if (sc.minutes) schedMinutes.value = sc.minutes
  } catch (e) { /* 忽略 */ }
}

async function toggleSchedule(v: boolean) {
  schedSaving.value = true
  try {
    const { data } = await client.post('/web-accounts/tasks/schedule', {
      enabled: v,
      minutes: schedMinutes.value,
    })
    sched.value = data
    message.success(v ? `已开启，间隔 ${data.minutes} 分钟` : '已关闭')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '设置失败')
  } finally {
    schedSaving.value = false
  }
}

// 任务类型是否可自动完成
function canAuto(t: any) {
  return autoTypes.value.includes(t.task_type)
}
// 不可自动的原因（后端给出，避免界面自己编）
function notAutoReason(t: any) {
  return notAutoMap.value[t.task_type] || '需手动'
}

// 只重新拉取任务状态，不执行任何动作。
// 与「跑任务」区分开：想看最新状态时不该被迫触发一次任务执行。
async function refreshTasks() {
  loadingTasks.value = true
  try {
    await loadTasks()
    message.success('任务状态已刷新')
  } finally {
    loadingTasks.value = false
  }
}

async function runTasks() {
  runningTasks.value = true
  lastRun.value = ''
  try {
    const { data } = await client.post('/web-accounts/tasks/run', {})
    const parts = []
    if (data.done_count) parts.push(`完成 ${data.done_count} 个`)
    if (data.fail_count) parts.push(`失败 ${data.fail_count} 个`)
    // 没有可做任务时要说清原因，否则「什么都没发生」看起来像坏了
    const skipped = data.results.reduce((s: number, r: any) => s + (r.not_automatable?.length || 0), 0)
    if (!parts.length) {
      lastRun.value = skipped
        ? `没有可自动完成的任务（${skipped} 个任务需手动或前往客户端）`
        : '没有可自动完成的任务'
    } else {
      lastRun.value = parts.join('，') + (skipped ? `；${skipped} 个需手动` : '')
    }
    // 账号级异常透传：不显示的话代码炸了也只会看到「没有可自动完成的任务」
    if (data.errors?.length) {
      lastRun.value += `；异常：${data.errors.join('；')}`
    }
    // 每个任务的明细：跑了什么、耗时、真实积分
    const lines: string[] = []
    for (const r of data.results) {
      for (const t of r.results ?? []) {
        const ms = t.ms != null ? `，耗时 ${(t.ms / 1000).toFixed(1)}s` : ''
        const pd = typeof t.delta === 'number'
          ? (t.delta > 0 ? `，+${t.delta} 积分` : t.delta < 0 ? `，${t.delta} 积分（发消息消耗）` : '')
          : ''
        lines.push(`${r.name || r.account_id} · ${t.title}${ms}${pd}${t.error ? '，失败：' + t.error : ''}`)
      }
    }
    if (lines.length) taskRunDetail.value = lines
    // 跑完刷新任务状态表。历史记录不在这里——它已并入「积分明细 → 操作流水」，
    // 用户切过去时会重新拉取，不必在本页维护第二份。
    await loadTasks()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '跑任务失败')
  } finally {
    runningTasks.value = false
  }
}

async function drawAll() {
  drawing.value = true
  lastRun.value = ''
  try {
    const { data } = await client.post('/web-accounts/draw-all', {})
    if (!data.drawn_count) {
      lastRun.value = '没有可用的抽奖次数——先跑任务赚次数'
    } else {
      const won: string[] = []
      data.results.forEach((r: any) => (r.won || []).forEach((w: any) => won.push(w.name)))
      lastRun.value = `抽了 ${data.drawn_count} 次` + (won.length ? `，抽到：${won.join('、')}` : '')
    }
    await loadTasks()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '抽奖失败')
  } finally {
    drawing.value = false
  }
}

// 探测账号能否真的跑模型（走一次真实的 1-token 调用）
async function probeModel(a: PoolAccount) {
  probing[a.id] = true
  try {
    const { data } = await client.post(`/web-accounts/${a.id}/probe-model`)
    if (data.ok) message.success(`${a.name} 可以跑模型（${data.model}）`)
    else message.error(`${a.name} 调用失败：${data.error}`)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '探测失败')
  } finally {
    probing[a.id] = false
  }
}

async function loadLoginInfo() {
  const { data } = await client.get('/web-accounts/login-url')
  loginUrl.value = data.url
  loginSteps.value = data.steps
  browserAvailable.value = data.browser_available !== false
  // 没有可用浏览器时默认切到手动粘贴，否则用户会对着一个点不动的按钮
  if (!browserAvailable.value) addMode.value = 'manual'
}

function openAdd() {
  form.name = ''
  form.cookie = ''
  verifyResult.value = null
  loginSession.value = null
  addOpen.value = true
  stopPoll()
}

// 轮询登录状态。后端在检测到 cookie 时会直接落库，前端只需展示结果。
function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

async function startBrowserLogin() {
  try {
    const { data } = await client.post('/web-accounts/login/start', { name: form.name })
    loginSession.value = data
    message.info('已打开登录窗口，请在其中登录')
    stopPoll()
    pollTimer = setInterval(pollLogin, 1500)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '无法打开登录窗口')
  }
}

async function pollLogin() {
  const q = form.name ? `?name=${encodeURIComponent(form.name)}` : ''
  const { data } = await client.get(`/web-accounts/login/poll${q}`)
  loginSession.value = data
  if (data.status === 'saved') {
    stopPoll()
    message.success(`已添加账号：${data.account?.name ?? ''}`)
    await load()
    setTimeout(() => { addOpen.value = false }, 1200)
  } else if (data.status === 'failed' || data.status === 'cancelled') {
    stopPoll()
    if (data.status === 'failed') message.error(data.message || '登录失败')
  }
}

async function cancelBrowserLogin() {
  stopPoll()
  await client.post('/web-accounts/login/cancel')
  loginSession.value = null
}

async function saveManual() {
  if (!form.cookie.trim()) {
    message.error('请粘贴 Cookie')
    return
  }
  saving.value = true
  try {
    // 先验证再保存：避免存下一份不可用的 cookie 之后才在调用时发现
    const { data: v } = await client.post('/web-accounts/verify', { cookie: form.cookie })
    verifyResult.value = v
    if (!v.ok) {
      message.error('验证失败，未添加')
      return
    }
    await client.post('/web-accounts', {
      name: form.name || v.nickname || '',
      cookie: form.cookie,
    })
    message.success('已添加')
    addOpen.value = false
    await load()
  } catch (e: any) {
    const err = e?.response?.data
    verifyResult.value = { ok: false, error: err?.error || e.message }
    message.error(err?.error || '添加失败')
  } finally {
    saving.value = false
  }
}

// ── 出站代理编辑（per-account）──
// 展示的是脱敏形态（redactProxyUrl），覆盖时输入完整地址；空串 = 清除走全局默认。
const proxyOpen = ref(false)
const proxySaving = ref(false)
const proxyTarget = ref<WebAccount | null>(null)
const proxyForm = reactive({ proxy: '' })

function openProxy(a: WebAccount) {
  proxyTarget.value = a
  proxyForm.proxy = a.proxy || ''
  proxyOpen.value = true
}

async function saveProxy() {
  if (!proxyTarget.value) return
  proxySaving.value = true
  try {
    const { data } = await client.patch(`/web-accounts/${proxyTarget.value.id}`, {
      proxy: proxyForm.proxy.trim(),
    })
    message.success(data?.proxy ? `代理已设置：${data.proxy}` : '代理已清除，走全局默认')
    proxyOpen.value = false
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    proxySaving.value = false
  }
}

// ── 桌面端直读导入（清单项 6 尾巴）──
// 解密在后端 src/auth-import.js（排布实测）；前端只触发并展示结果。
const desktopImporting = ref(false)
const desktopImportResult = ref<{ ok: boolean; text: string } | null>(null)

async function importDesktop() {
  desktopImporting.value = true
  desktopImportResult.value = null
  try {
    const { data: r } = await client.post('/web-accounts/import-desktop', { name: form.name })
    desktopImportResult.value = {
      ok: true,
      text: `已导入 ${r.cookie_count} 条 cookie（跳过无关域 ${r.skipped_domains} 条）→ 账号「${r.account?.name}」`,
    }
    message.success('导入成功')
    await load()
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '导入失败'
    desktopImportResult.value = { ok: false, text: msg }
    message.error(msg)
  } finally {
    desktopImporting.value = false
  }
}

async function toggle(a: WebAccount, v: boolean) {  await client.patch(`/web-accounts/${a.id}`, { enabled: v })
  await load()
}

async function remove(a: WebAccount) {
  await client.delete(`/web-accounts/${a.id}`)
  message.success('已删除')
  await load()
}

async function checkin(a: WebAccount) {
  busy[a.id] = true
  try {
    const { data } = await client.post(`/web-accounts/${a.id}/checkin`)
    if (data.ok) message.success(data.already ? `${a.name} 今日已签到` : `${a.name} 签到成功`)
    else message.error(`${a.name} 签到失败：${data.error}`)
    await load()
  } finally {
    busy[a.id] = false
  }
}

async function checkinAll() {
  checkingAll.value = true
  try {
    const { data } = await client.post('/web-accounts/checkin-all')
    const { ok_count, fail_count } = data
    if (fail_count) message.warning(`签到完成：成功 ${ok_count}，失败 ${fail_count}`)
    else message.success(`全部签到成功（${ok_count} 个账号）`)
    await load()
  } finally {
    checkingAll.value = false
  }
}

async function draw(a: WebAccount) {
  busy[a.id] = true
  try {
    const { data } = await client.post(`/web-accounts/${a.id}/draw`, { times: 1 })
    const r = data.results?.[0]
    if (r?.ok) message.success('抽奖完成，详情里可看结果')
    else message.error(r?.error || '抽奖失败')
    await load()
  } finally {
    busy[a.id] = false
  }
}

async function refreshStatus(a: WebAccount) {
  busy[a.id] = true
  try {
    await client.get(`/web-accounts/${a.id}/status`)
    message.success('已刷新')
    await load()
  } finally {
    busy[a.id] = false
  }
}

async function openDetail(a: WebAccount) {
  detailOpen.value = true
  detailLoading.value = true
  detail.value = null
  try {
    const { data } = await client.get(`/web-accounts/${a.id}/status`)
    detail.value = data
  } finally {
    detailLoading.value = false
  }
}

onMounted(async () => {
  // 按当前通道初始化：顶栏已切到千问时不该去拉搭子的网页账号。
  // 千问与 TRAE 的数据由各自子组件自己拉（它们走自己的接口，与搭子的池子无关）
  if (isTw.value || isQw.value) return
  await Promise.all([load(), loadLoginInfo()])
})

// 切通道重拉
watch(() => channelStore.current, async () => {
  if (isTw.value || isQw.value) return
  await Promise.all([load(), loadLoginInfo()])
})
</script>

<style scoped>
/* 千问账号卡里的积分池小卡 .qw-pool 已收敛到全局 style.css */
.poll-bar {
  background: var(--lab-surface-2);
  border: 1px solid var(--lab-border);
  border-radius: var(--lab-radius-sm);
}
</style>
