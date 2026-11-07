<template>
  <div class="page">
    <PageHeader title="TRAE 运行策略" sub="降级 / Max / 选号 / 护栏 / 全站暂停 — 保存即热生效">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
        <a-button v-if="isAdmin" type="primary" size="small" :loading="saving" @click="save">保存</a-button>
      </template>
    </PageHeader>

    <a-alert type="info" show-icon class="mb-3">
      <template #message>全部开关默认关闭</template>
      <template #description>
        配置落 <code>{{ file || 'data/traework-runtime.json' }}</code>，网关按 mtime 热读，无需重启。
        自动降级只认确证的额度/升级错误，且响应头显式带 <code>X-Trae-Degraded</code>；
        API Key 的区域绑定不会被 <code>fallbackRegion</code> 越过。
      </template>
    </a-alert>

    <a-card :bordered="false" title="账号健康（侧栏角标同源）" class="mb-4">
      <a-row :gutter="[12, 12]">
        <a-col v-for="c in healthCards" :key="c.label" :xs="12" :sm="8" :md="6">
          <div class="health-cell">
            <div class="text-xs text-slate-400">{{ c.label }}</div>
            <div class="num" :class="c.value ? 'text-orange-500' : ''">{{ c.value }}</div>
          </div>
        </a-col>
      </a-row>
      <div class="text-xs text-slate-400 mt-2">额度未知单独计一列：查不到不等于 0，也不计入「耗尽」。</div>
    </a-card>

    <a-card :bordered="false" title="自动降级" class="mb-4">
      <div class="space-y-3 max-w-3xl">
        <div class="flex items-center justify-between">
          <div><div>启用备用模型 / 区域</div><div class="text-xs text-slate-400">第一尝试吐出任何内容后不再降级</div></div>
          <a-switch v-model:checked="form.degrade.enabled" :disabled="!isAdmin" />
        </div>
        <div class="grid gap-2" style="grid-template-columns: 1fr 180px">
          <a-input v-model:value="form.degrade.fallbackModel" :disabled="!isAdmin" addon-before="备用模型" placeholder="如 deepseek-v4.1-flash（裸名）" />
          <a-select v-model:value="form.degrade.fallbackRegion" :disabled="!isAdmin" :options="regionOptions" />
        </div>
        <div class="flex flex-wrap gap-4">
          <a-checkbox v-model:checked="form.degrade.onQuota" :disabled="!isAdmin">额度耗尽时降级</a-checkbox>
          <a-checkbox v-model:checked="form.degrade.onUpgrade" :disabled="!isAdmin">订阅升级时降级</a-checkbox>
          <span class="text-xs text-slate-400">额度预警线</span>
          <a-input-number v-model:value="warnBelow" :min="0" :disabled="!isAdmin" style="width: 130px" />
        </div>
      </div>
    </a-card>

    <a-card :bordered="false" title="1M Max 模式" class="mb-4">
      <template #extra>
        <a-space>
          <a-button size="small" :loading="detecting" @click="detect">检测支持的模型</a-button>
          <a-button v-if="isAdmin" size="small" type="primary" :loading="applying" @click="applyMax">一键加入白名单</a-button>
        </a-space>
      </template>
      <div class="flex items-center justify-between mb-2">
        <div><div>全局开启</div><div class="text-xs text-slate-400">descriptor 显式声明 max_mode 才生效；不改环境变量、不重启</div></div>
        <a-switch v-model:checked="form.maxMode.enabled" :disabled="!isAdmin" />
      </div>
      <a-select v-model:value="form.maxMode.models" mode="tags" :disabled="!isAdmin" style="width: 100%" placeholder="模型白名单，留空 = 全部" :token-separators="[',', ' ']" />
      <div v-if="maxProbe" class="text-xs mt-2" :class="maxProbe.ok ? 'text-slate-400' : 'text-orange-500'">
        {{ maxProbe.ok ? `上游表 ${maxProbe.total} 个，声明 max_mode ${maxProbe.models.length} 个` : (maxProbe.error || '模型表不可用') }}
        <span v-if="maxProbe.ok && maxProbe.models.length">：{{ maxProbe.models.map((m: any) => m.id).join('、') }}</span>
      </div>
    </a-card>

    <a-card :bordered="false" title="选号与护栏" class="mb-4">
      <div class="space-y-3 max-w-3xl">
        <div class="flex items-center justify-between">
          <div><div>积分优先轮询</div><div class="text-xs text-slate-400">默认轮转 + FEFO；切到 credits-desc 后按已落盘余额降序，未知值沉底</div></div>
          <a-select v-model:value="form.pickStrategy" :disabled="!isAdmin" style="width: 180px" :options="strategyOptions" />
        </div>
        <div class="flex items-center justify-between">
          <div><div>保留积分护栏</div><div class="text-xs text-slate-400">余额低于阈值的账号不接新请求；余额未知不跳过</div></div>
          <a-switch v-model:checked="form.accountGuard.enabled" :disabled="!isAdmin" />
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-slate-400">保留积分阈值</span>
          <a-input-number v-model:value="reserveCredits" :min="0" :disabled="!isAdmin" style="width: 140px" />
        </div>

        <a-divider style="margin: 10px 0" />
        <div class="text-xs text-slate-400 mb-1">
          每日用量护栏 —— 「保留积分」看余额快照（还有没有钱），下面三项看当日已用量（今天是不是用过头了）。
          <b>0 = 不限</b>；未知用量不拦（查不到 ≠ 用完了）。
        </div>
        <div class="grid gap-2" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))">
          <label class="field-line">
            <span class="text-xs text-slate-400">每账号每日 token</span>
            <a-input-number v-model:value="dailyTokens" :min="0" :step="100000" :disabled="!isAdmin" style="width: 150px" />
          </label>
          <label class="field-line">
            <span class="text-xs text-slate-400">每账号每日积分</span>
            <a-input-number v-model:value="dailyCredits" :min="0" :step="100" :disabled="!isAdmin" style="width: 150px" />
          </label>
          <label class="field-line">
            <span class="text-xs text-slate-400">每账号每模型每日 token</span>
            <a-input-number v-model:value="modelTokens" :min="0" :step="100000" :disabled="!isAdmin" style="width: 150px" />
          </label>
        </div>

        <!-- 当日用量读数：回答「为什么这个号被拦了」。口径与护栏判定同源 -->
        <div class="flex items-center gap-2 mt-2">
          <a-button size="small" class="ghost-btn" :loading="usageLoading" @click="loadUsage">查看今日用量</a-button>
          <span v-if="usage" class="text-xs text-slate-500">
            {{ usage.day }} · token 合计 {{ usage.totals.tokens ?? '—' }} · 积分合计 {{ usage.totals.credits ?? '—' }}
          </span>
        </div>
        <a-table
          v-if="usage && usage.rows.length"
          size="small"
          class="mt-2"
          :pagination="false"
          row-key="id"
          :data-source="usage.rows"
          :columns="usageColumns"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'tokens'">
              <span class="num">{{ record.tokens ?? '—' }}</span>
              <div v-if="overOf(record, 'dailyTokens', record.tokens)" class="text-xs text-orange-500">已达上限</div>
            </template>
            <template v-else-if="column.key === 'credits'">
              <span class="num">{{ record.credits ?? '—' }}</span>
              <div v-if="overOf(record, 'dailyCredits', record.credits)" class="text-xs text-orange-500">已达上限</div>
            </template>
          </template>
        </a-table>
      </div>
    </a-card>

    <a-card :bordered="false" title="全站暂停">
      <div class="flex items-center justify-between max-w-3xl">
        <div>
          <div>暂停网关 /v1 数据面</div>
          <div class="text-xs text-slate-400">所有模型请求 503 service_paused；/health 与管理台照常可用</div>
        </div>
        <a-popconfirm v-if="isAdmin" title="暂停后全部客户端立即 503，确定？" @confirm="pauseNow">
          <a-switch :checked="form.gatewayPaused" />
        </a-popconfirm>
        <a-switch v-else :checked="form.gatewayPaused" disabled />
      </div>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { App } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import { traeRuntimeApi } from '@/api/traeruntime'
import type { TraeRuntimeConfig } from '@/api/traeruntime'
import { isAdmin } from '@/stores/auth'
import { regionParam } from '@/stores/region'

const { message } = App.useApp()
const loading = ref(false)
const saving = ref(false)
const detecting = ref(false)
const applying = ref(false)
const file = ref('')
const accounts = ref<any>({})
const maxProbe = ref<any>(null)
const usage = ref<any>(null)
const usageLoading = ref(false)
const usageColumns = [
  { title: '账号', key: 'name', dataIndex: 'name' },
  { title: '今日 token', key: 'tokens', width: 160 },
  { title: '今日积分', key: 'credits', width: 160 },
  { title: '请求数', dataIndex: 'requests', width: 90 },
]
async function loadUsage() {
  usageLoading.value = true
  try {
    const { data } = await traeRuntimeApi.usage()
    usage.value = data
    if (!data.ok) message.warning(data.error || '用量读取不完整')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '读取用量失败')
  } finally { usageLoading.value = false }
}
/** 某项是否已达上限（0 = 不限，不算超） */
function overOf(_row: any, key: 'dailyTokens' | 'dailyCredits', used: number | null) {
  const cap = Number((form.accountGuard as any)[key])
  return cap > 0 && used != null && used >= cap
}
const form = reactive<TraeRuntimeConfig>({
  degrade: { enabled: false, fallbackModel: '', fallbackRegion: '', warnBelow: null, onQuota: true, onUpgrade: true },
  maxMode: { enabled: false, models: [] },
  pickStrategy: 'round-robin',
  accountGuard: { enabled: false, reserveCredits: null, reserveBelow: null, dailyTokens: null, dailyCredits: null, modelTokens: null },
  gatewayPaused: false,
})
// a-input-number 不接受 null 作为 v-model 初值：用 0 做展示位，保存时转 null
const warnBelow = ref(0)
const reserveCredits = ref(0)
const dailyTokens = ref(0)
const dailyCredits = ref(0)
const modelTokens = ref(0)

const regionOptions = [
  { label: '不切区域', value: '' },
  { label: '国内 cn', value: 'cn' },
  { label: '国际 intl', value: 'intl' },
]
const strategyOptions = [
  { label: '轮转（默认）', value: 'round-robin' },
  { label: '积分优先', value: 'credits-desc' },
]
const healthCards = computed(() => [
  { label: '账号总数', value: accounts.value.total ?? '—' },
  { label: '需重新登录', value: accounts.value.needRelogin ?? '—' },
  { label: '额度耗尽', value: accounts.value.exhausted ?? '—' },
  { label: '关闭模型请求', value: accounts.value.pausedModel ?? '—' },
  { label: '冷却/暂停', value: accounts.value.cooling ?? '—' },
  { label: '额度未知', value: accounts.value.creditsUnknown ?? '—' },
])

function copyForm(c: TraeRuntimeConfig) {
  Object.assign(form, c)
  warnBelow.value = c.degrade.warnBelow ?? 0
  reserveCredits.value = c.accountGuard.reserveCredits ?? 0
  dailyTokens.value = c.accountGuard.dailyTokens ?? 0
  dailyCredits.value = c.accountGuard.dailyCredits ?? 0
  modelTokens.value = c.accountGuard.modelTokens ?? 0
}

async function load() {
  loading.value = true
  try {
    const { data } = await traeRuntimeApi.get()
    file.value = data.file
    accounts.value = data.accounts || {}
    copyForm(data.config)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '读取运行配置失败')
  } finally {
    loading.value = false
  }
}

function patch(): Partial<TraeRuntimeConfig> {
  return {
    degrade: { ...form.degrade, warnBelow: warnBelow.value > 0 ? warnBelow.value : null },
    maxMode: { ...form.maxMode, models: [...form.maxMode.models] },
    pickStrategy: form.pickStrategy,
    accountGuard: {
      ...form.accountGuard,
      reserveCredits: reserveCredits.value > 0 ? reserveCredits.value : null,
      reserveBelow: null,
      dailyTokens: dailyTokens.value > 0 ? dailyTokens.value : null,
      dailyCredits: dailyCredits.value > 0 ? dailyCredits.value : null,
      modelTokens: modelTokens.value > 0 ? modelTokens.value : null,
    },
    gatewayPaused: form.gatewayPaused,
  }
}

async function save() {
  saving.value = true
  try {
    const { data } = await traeRuntimeApi.save(patch())
    copyForm(data.config)
    message.success('已保存，网关按 mtime 热读生效')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function pauseNow() {
  form.gatewayPaused = !form.gatewayPaused
  await save()
}

async function detect() {
  detecting.value = true
  try {
    const { data } = await traeRuntimeApi.maxModels(regionParam() as 'cn' | 'intl' | undefined)
    maxProbe.value = data
  } catch (e: any) {
    message.error(e?.response?.data?.error || '检测失败')
  } finally {
    detecting.value = false
  }
}

async function applyMax() {
  applying.value = true
  try {
    const { data } = await traeRuntimeApi.applyMaxModels(regionParam() as 'cn' | 'intl' | undefined)
    form.maxMode.models = data.applied || []
    maxProbe.value = { ok: true, total: data.applied?.length || 0, models: (data.applied || []).map((id: string) => ({ id })), error: data.error }
    message.success(`已加入 ${data.applied?.length || 0} 个模型（开关仍需单独保存）`)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '应用失败')
  } finally {
    applying.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.health-cell {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 8px;
  padding: 8px 12px;
}
</style>
