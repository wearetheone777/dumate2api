<template>
  <div class="page">
    <PageHeader title="运维告警" sub="七类规则只读本地事实 · 静默窗与迟滞防狼来了">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
        <a-button size="small" :loading="evaluating" @click="evaluate(false)">立即评估</a-button>
        <a-popconfirm
          v-if="isAdmin"
          title="评估并立即推送（会用下面「推送通道」的配置真实发出消息）？"
          @confirm="evaluate(true)"
        >
          <a-button size="small" type="primary" :loading="evaluating">评估并推送</a-button>
        </a-popconfirm>
      </template>
    </PageHeader>

    <a-alert type="info" show-icon class="mb-3">
      <template #message>判据只认本地事实</template>
      <template #description>
        规则读请求日志、账号列表和任务轮结果；<b>余额/状态未知不猜 0</b>（查不到就不参与判断，
        不会被读成「耗尽」）。推送复用仪表盘的「健康告警推送」配置，当前
        <a-tag :color="notifyEnabled ? 'green' : 'default'" class="mx-1">{{ notifyEnabled ? '已启用' : '未启用' }}</a-tag>
        <a-button type="link" size="small" @click="goDashboard">去配置 →</a-button>
        <br />
        后台自动评估：
        <a-tag :color="scheduleActive ? 'green' : 'default'">
          {{ scheduleMinutes > 0 ? `每 ${scheduleMinutes} 分钟` : '未开启（DUMATE_ALERTS_SCHEDULE_MINUTES）' }}
        </a-tag>
        ——默认关闭，避免新排程悄悄跑起来。
      </template>
    </a-alert>

    <!-- 当前活跃告警：恢复后会带 resolved_at 消失，这里只显示「现在还没恢复」的。
         info 级（非工作时段）单独分开展示：它是提示不是待办，混在一起会让
         「有 2 条告警」看起来和「账号池见底」一样严重。 -->
    <a-card :bordered="false" class="mb-4">
      <template #title>
        <span class="section-title">当前活跃告警</span>
        <a-tag v-if="actionable.length" color="red" class="ml-2">{{ actionable.length }}</a-tag>
        <a-tag v-else color="green" class="ml-2">无</a-tag>
        <a-tag v-if="hints.length" color="default" class="ml-2">{{ hints.length }} 条提示</a-tag>
      </template>
      <a-empty v-if="!active.length" description="没有未恢复的告警" />
      <template v-else>
        <a-table
          size="small"
          :pagination="false"
          :columns="activeColumns"
          :data-source="actionable"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'level'">
              <a-tag :color="record.level === 'crit' ? 'red' : record.level === 'warn' ? 'orange' : 'default'">
                {{ record.level }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'rule'">{{ ruleLabel(record.rule) }}</template>
            <template v-else-if="column.key === 'at'">
              <span class="num">{{ fmtTime(record.at) }}</span>
            </template>
            <template v-else-if="column.key === 'notified'">
              <span class="num text-xs">{{ record.notified_at ? fmtTime(record.notified_at) : '尚未推送' }}</span>
            </template>
          </template>
        </a-table>
        <a-empty v-if="!actionable.length" description="没有需要处理的告警" />
        <div v-if="hints.length" class="mt-3 text-xs text-slate-500">
          提示（不计入待办、不推送）：
          <span v-for="h in hints" :key="h.id" class="mr-3">· {{ ruleLabel(h.rule) }} — {{ h.message }}</span>
        </div>
      </template>
    </a-card>

    <!-- 最近一次评估结果：candidates = 本轮命中，notify = 真正推送的（过了静默窗） -->
    <a-card v-if="lastRun" :bordered="false" class="mb-4">
      <template #title><span class="section-title">最近一次评估</span></template>
      <a-descriptions size="small" :column="3" class="mb-2">
        <a-descriptions-item label="本轮命中">{{ lastRun.candidates.length }}</a-descriptions-item>
        <a-descriptions-item label="实际推送">{{ lastRun.delivered.length }}</a-descriptions-item>
        <a-descriptions-item label="恢复">{{ lastRun.resolved.length }}</a-descriptions-item>
      </a-descriptions>
      <div class="text-xs text-slate-500">
        命中但未推送 = 仍在静默窗内（同一规则+对象在 {{ Math.round(form.silenceMs / 60000) }} 分钟内只推一次），
        不是规则失灵。
      </div>
      <ul v-if="lastRun.resolved.length" class="text-xs mt-2">
        <li v-for="r in lastRun.resolved" :key="r.id">
          已恢复：{{ ruleLabel(r.rule) }} / {{ r.object }}（{{ fmtTime(r.resolved_at) }}）
        </li>
      </ul>
      <a-alert
        v-if="lastRun.delivered.some((d) => !d.ok)"
        type="warning"
        show-icon
        class="mt-2"
        :message="`有 ${lastRun.delivered.filter((d) => !d.ok).length} 条推送失败`"
      >
        <template #description>
          <div v-for="d in lastRun.delivered.filter((x) => !x.ok)" :key="d.id" class="text-xs">
            {{ d.id }}：{{ d.error }}
          </div>
        </template>
      </a-alert>
    </a-card>

    <!-- 规则阈值 -->
    <a-card :bordered="false">
      <template #title>
        <span class="section-title">规则阈值</span>
        <a-tag v-if="!isAdmin" color="default" class="ml-2">只读（viewer）</a-tag>
      </template>
      <template #extra>
        <a-button v-if="isAdmin" type="primary" size="small" :loading="saving" @click="save">保存</a-button>
      </template>

      <div class="space-y-4">
        <div v-for="r in ALERT_RULES" :key="r.rule" class="rule-row">
          <div class="rule-head">
            <span class="rule-name">{{ r.label }}</span>
            <span class="text-xs text-slate-500">{{ r.desc }}</span>
          </div>
          <div class="rule-fields">
            <label v-for="f in r.fields" :key="f.key" class="field">
              <span class="text-xs text-slate-400">{{ f.label }}<template v-if="f.unit">（{{ f.unit }}）</template></span>
              <a-input-number
                v-model:value="form[f.key] as number"
                :min="0"
                :step="f.step ?? 1"
                :disabled="!isAdmin"
                size="small"
                style="width: 130px"
              />
            </label>
          </div>
        </div>

        <a-divider style="margin: 12px 0" />
        <div class="text-xs text-slate-400 mb-2">调节项（影响所有规则）</div>
        <div v-for="t in ALERT_TUNING" :key="t.key" class="rule-row">
          <div class="rule-head">
            <span class="rule-name">{{ t.label }}</span>
            <span class="text-xs text-slate-500">{{ t.desc }}</span>
          </div>
          <div class="rule-fields">
            <a-input-number
              v-model:value="form[t.key] as number"
              :min="0"
              :step="t.key === 'windowMs' || t.key === 'silenceMs' ? 60000 : 1"
              :disabled="!isAdmin"
              size="small"
              style="width: 150px"
            />
            <span v-if="t.key === 'silenceMs' || t.key === 'windowMs'" class="text-xs text-slate-500">
              = {{ Math.round((form[t.key] as number) / 60000) }} 分钟
            </span>
          </div>
        </div>
      </div>
    </a-card>

    <!-- 指标端点：后端做了却没有任何界面入口 = 等于没交付 -->
    <a-card :bordered="false" class="mt-4" title="Prometheus 指标">
      <div class="text-sm space-y-2">
        <div>
          抓取地址
          <code class="ml-1">{{ origin }}{{ metricsPaths.root }}</code>
          <a-tag color="green" class="ml-2">本机可匿名</a-tag>
        </div>
        <div class="text-xs text-slate-500">
          标签只有 channel / model / status / state，<b>不含账号 id、Key、req_id</b>——
          高基数维度会把时序库撑爆。设了 <code>DUMATE_METRICS_TOKEN</code> 后必须带
          <code>Authorization: Bearer &lt;token&gt;</code>（未设置时沿用管理端会话鉴权）。
        </div>
        <div>
          <a-button size="small" class="ghost-btn" :loading="metricsLoading" @click="peekMetrics">预览前 20 行</a-button>
        </div>
        <pre v-if="metricsPreview" class="metrics-preview">{{ metricsPreview }}</pre>
      </div>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { App } from 'ant-design-vue'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import { alertsApi, ALERT_RULES, ALERT_TUNING, metricsPaths } from '@/api/alerts'
import type { ActiveAlert, AlertConfig } from '@/api/alerts'
import { isAdmin } from '@/stores/auth'

const { message } = App.useApp()
const router = useRouter()

const loading = ref(false)
const saving = ref(false)
const evaluating = ref(false)
const notifyEnabled = ref(false)
const scheduleMinutes = ref(0)
const scheduleActive = ref(false)
const active = ref<ActiveAlert[]>([])
const actionable = computed(() => active.value.filter((a) => a.level !== 'info'))
const hints = computed(() => active.value.filter((a) => a.level === 'info'))
const lastRun = ref<Awaited<ReturnType<typeof alertsApi.evaluate>>['data'] | null>(null)
const metricsPreview = ref('')
const metricsLoading = ref(false)

const origin = typeof window !== 'undefined' ? window.location.origin : ''

// 阈值用 reactive 持有全量；保存时整包提交（服务端逐字段校验非负数字）
const form = reactive<AlertConfig>({
  minUsable: 1, taskFailStreak: 2, tokenWarnHours: 24,
  errorRate: 0.5, errorMinRequests: 5, keyBurst: 500,
  offHoursStart: 1, offHoursEnd: 6, budget: 1000000,
  windowMs: 3600000, silenceMs: 3600000, hysteresis: 2,
})

const activeColumns = [
  { title: '级别', key: 'level', width: 80 },
  { title: '规则', key: 'rule', width: 130 },
  { title: '对象', key: 'object', width: 160 },
  { title: '说明', dataIndex: 'message' },
  { title: '触发时刻', key: 'at', width: 170 },
  { title: '推送时刻', key: 'notified', width: 170 },
]

const fmtTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })
function ruleLabel(rule: string) {
  return ALERT_RULES.find((r) => r.rule === rule)?.label || rule
}

async function load() {
  loading.value = true
  try {
    const { data } = await alertsApi.get()
    Object.assign(form, data.config)
    notifyEnabled.value = data.notify_enabled
    scheduleMinutes.value = data.schedule_minutes
    scheduleActive.value = data.schedule_active
    active.value = data.active || []
  } catch (e: any) {
    message.error(e?.response?.data?.error || '读取告警配置失败')
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const { data } = await alertsApi.saveConfig({ ...form })
    Object.assign(form, data.config)
    message.success('已保存（规则在下一轮评估生效）')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function evaluate(withNotify: boolean) {
  evaluating.value = true
  try {
    const { data } = await alertsApi.evaluate(withNotify)
    lastRun.value = data
    active.value = data.active || []
    if (withNotify) {
      const bad = data.delivered.filter((d) => !d.ok)
      if (!data.delivered.length) message.info('本轮没有需要推送的告警（命中但仍在静默窗内不算）')
      else if (bad.length) message.warning(`${data.delivered.length - bad.length} 条推送成功，${bad.length} 条失败`)
      else message.success(`已推送 ${data.delivered.length} 条`)
    } else {
      message.success(`本轮命中 ${data.candidates.length} 条，活跃 ${data.active.length} 条`)
    }
  } catch (e: any) {
    message.error(e?.response?.data?.error || '评估失败')
  } finally {
    evaluating.value = false
  }
}

async function peekMetrics() {
  metricsLoading.value = true
  try {
    // 走管理端路径（有会话），根路径在配了 token 时会 401
    const res = await client.get(metricsPaths.admin, { responseType: 'text', transformResponse: [(d) => d] })
    metricsPreview.value = String(res.data).split('\n').slice(0, 20).join('\n')
  } catch (e: any) {
    metricsPreview.value = `读取失败：${e?.response?.data?.error || e?.message || '未知原因'}`
  } finally {
    metricsLoading.value = false
  }
}

function goDashboard() {
  router.push('/')
}

onMounted(load)
</script>

<style scoped>
.rule-row {
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 8px;
  padding: 10px 12px;
}
.rule-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.rule-name {
  font-weight: 600;
}
.rule-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}
.field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.metrics-preview {
  max-height: 320px;
  overflow: auto;
  background: rgba(15, 23, 42, 0.06);
  border-radius: 6px;
  padding: 10px;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
}
</style>
