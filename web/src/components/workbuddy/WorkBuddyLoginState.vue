<template>
  <div class="page">
    <PageHeader title="登录态" :sub="subText">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
    </PageHeader>

    <!-- 与 TRAE 的差异必须写清楚：同是凭证自持，WorkBuddy 双区域账号互不通用，
         登录态文件按区域分（copilot.tencent.com / workbuddy.ai）。 -->
    <a-alert type="info" show-icon>
      <template #message>凭证由本项目持有，可自动续期</template>
      <template #description>
        <div>
          WorkBuddy 的凭证存于 <code>data/workbuddy-accounts.json</code>，
          来自浏览器 OAuth 登录、官方客户端认证文件导入或手动粘贴 token。
          access token 到期时网关会用 refresh token 自动换新（国内走
          <code>X-Auth-Refresh-Source: workbuddy</code>，国际走 <code>plugin</code>），
          <b>不需要打开官方客户端</b>。只有 refresh token 过期才要重新登录。
        </div>
        <div class="mt-1 text-xs">
          当前是<b>{{ isIntl ? '国际版（workbuddy.ai）' : '国内版（copilot.tencent.com）' }}</b>视图，
          两套账号互不通用；区域切换在顶栏。
        </div>
      </template>
    </a-alert>

    <a-alert
      v-if="status && !status.ready"
      type="warning"
      show-icon
      :message="status.error || '通道不可用'"
    />

    <a-row :gutter="[16, 16]">
      <a-col :span="8">
        <a-card :bordered="false" class="h-full">
          <a-statistic title="可用账号" :value="status?.accounts ?? '—'">
            <template #suffix><span class="text-sm text-slate-400">个</span></template>
          </a-statistic>
          <div class="text-xs text-slate-500 mt-2">
            共 {{ rows.length }} 个 · 停用 {{ rows.length - enabledCount }} 个
          </div>
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card :bordered="false" class="h-full">
          <a-statistic
            title="通道状态"
            :value="status?.ready ? '就绪' : '不可用'"
            :value-style="status?.ready ? 'color:var(--lab-ok)' : 'color:var(--lab-danger)'"
          />
          <div class="text-xs text-slate-500 mt-2">
            {{ status?.ready ? '至少有一个启用且凭证完整的账号' : (status?.error || '—') }}
          </div>
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card :bordered="false" class="h-full">
          <a-statistic
            title="最近到期"
            :value="soonestText"
            :value-style="soonestSoon ? 'color:var(--lab-warn)' : undefined"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="soonestAt">access token 最早到期的账号</template>
            <span v-else>—</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-alert
      v-if="anyRefreshExpired"
      type="warning"
      show-icon
      class="mt-4"
      message="有账号的 refresh token 已过期"
      description="access token 到期后无法自动续期，该账号会失效。请到「账号管理」删除后重新登录（浏览器 OAuth / 客户端导入 / 手动粘贴 token）。"
    />

    <a-card title="账号凭证" :bordered="false" class="mt-4">
      <a-empty v-if="!rows.length" :description="`还没有${isIntl ? '国际' : '国内'}版账号`">
        <a-button type="primary" @click="goAccounts">去添加账号</a-button>
      </a-empty>
      <a-table
        v-else
        size="small"
        :pagination="false"
        :data-source="rows"
        :columns="columns"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div>{{ record.nickname || record.uid || '未命名' }}</div>
            <div class="text-xs text-slate-400 font-mono">UID {{ record.uid || '—' }}</div>
            <div v-if="record.enterpriseName" class="text-xs text-slate-400">
              {{ record.enterpriseName }}
            </div>
          </template>
          <template v-else-if="column.key === 'enabled'">
            <a-tag :color="record.enabled ? 'green' : 'default'">
              {{ record.enabled ? '启用' : '停用' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'access'">
            <a-tag :color="expired(record.expiresAt) ? 'red' : 'green'">
              {{ expired(record.expiresAt) ? '已过期' : '有效' }}
            </a-tag>
            <div class="text-xs text-slate-400 mt-1 num">
              {{ record.expiresAt ? dateText(record.expiresAt) : '—' }}
            </div>
          </template>
          <template v-else-if="column.key === 'refresh'">
            <a-tag :color="expired(record.refreshExpiresAt) ? 'red' : 'green'">
              {{ record.hasRefresh ? (expired(record.refreshExpiresAt) ? '已过期' : '有效') : '缺失' }}
            </a-tag>
            <div class="text-xs text-slate-400 mt-1 num">
              {{ record.refreshExpiresAt ? dateText(record.refreshExpiresAt) : '—' }}
            </div>
          </template>
          <template v-else-if="column.key === 'source'">
            <span class="text-xs">{{ sourceText(record.source) }}</span>
            <div class="text-xs text-slate-400 font-mono">
              {{ record.domain || '—' }}
            </div>
          </template>
          <template v-else-if="column.key === 'refreshTail'">
            <span class="font-mono text-xs">…{{ record.refreshTail || '—' }}</span>
          </template>
          <template v-else-if="column.key === 'err'">
            <span v-if="record.lastError" :class="errFresh(record) ? 'text-xs text-red-600' : 'text-xs text-slate-500'">
              <span class="text-slate-500">{{ errTime(record.lastErrorAt) }}</span>{{ record.lastError }}
            </span>
            <span v-else class="text-slate-400">—</span>
          </template>
        </template>
      </a-table>
      <div class="text-xs text-slate-400 mt-2">
        refresh token 只显示尾部 6 位用于人工核对，全量不外传。
        凭证域（domain）与账号所在区域绑定，换区域要重新登录对应版本的账号。
      </div>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '@/components/PageHeader.vue'
import { channelStore, isWorkBuddy } from '@/stores/channel'
import { regionStore } from '@/stores/region'
import { workbuddyApi } from '@/api/workbuddy'
import type { WorkBuddyAccount, WorkBuddyStatus } from '@/api/workbuddy'
import { lastErrorFresh, errorWhen } from '@/utils/lastError'
const router = useRouter()
const status = ref<WorkBuddyStatus | null>(null)
const loading = ref(false)
const isIntl = computed(() => regionStore.current === 'intl')

const rows = computed(() => status.value?.rows ?? [])
const enabledCount = computed(() => rows.value.filter((a) => a.enabled).length)

const subText = computed(() => {
  const r = isIntl.value ? '国际版' : '国内版'
  return status.value?.ready
    ? `WorkBuddy ${r}登录态与 token 到期（凭证自持）`
    : `WorkBuddy ${r}登录态 · 不可用`
})

function expired(ts: number | null) {
  return !!ts && Date.now() >= ts
}

const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

// lastError 的新鲜度判定收敛在 utils/lastError（无时间戳=陈旧）。
const errFresh = (a: WorkBuddyAccount) => lastErrorFresh(a)
const errTime = (ts: number | null | undefined) => errorWhen(ts ?? null)

// 来源标记（与账号管理页同口径）
const sourceText = (s: string) =>
  s === 'oauth' ? '浏览器登录'
    : s === 'client-import' ? '客户端导入'
      : s === 'manual' ? '手动粘贴' : (s || '—')

// 最早到期的 access token：这是「通道还能撑多久」的指标
const soonestAt = computed(() => {
  const list = rows.value.filter((a) => a.enabled && a.expiresAt)
  if (!list.length) return null
  return Math.min(...list.map((a) => a.expiresAt as number))
})
const soonestText = computed(() => (soonestAt.value ? dateText(soonestAt.value) : '—'))
// 24 小时内到期算「快了」：提前一天提醒才有时间去处理
const soonestSoon = computed(
  () => !!soonestAt.value && soonestAt.value - Date.now() < 24 * 3600 * 1000,
)

const anyRefreshExpired = computed(
  () => rows.value.some((a) => a.enabled && expired(a.refreshExpiresAt)),
)

const columns = [
  { title: '账号', key: 'name', width: '22%' },
  { title: '状态', key: 'enabled', width: '9%' },
  { title: 'access token', key: 'access', width: '17%' },
  { title: 'refresh token', key: 'refresh', width: '17%' },
  { title: '来源 / 凭证域', key: 'source', width: '13%' },
  { title: 'refresh 尾', key: 'refreshTail', width: '10%' },
  { title: '最近错误', key: 'err' },
]

function goAccounts() {
  router.push('/web-accounts')
}

async function load() {
  loading.value = true
  try {
    const r = regionStore.current as 'cn' | 'intl'
    const { data } = await workbuddyApi.status(r)
    status.value = data
  } catch (e: any) {
    status.value = {
      ready: false, error: e?.message || '读取失败', accounts: 0,
      mode: 'multi', modeNote: '', rows: [],
    }
  } finally {
    loading.value = false
  }
}

// 本页只在 WorkBuddy 通道下有意义；区域切换也重新拉
onMounted(() => { if (isWorkBuddy()) load() })
watch(() => channelStore.current, () => { if (isWorkBuddy()) load() })
watch(() => regionStore.current, () => { if (isWorkBuddy()) load() })
</script>
