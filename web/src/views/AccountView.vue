<template>
  <div class="page">
    <PageHeader
      title="登录态"
      :sub="isTw ? 'TRAE Work 登录态（凭证自持）'
        : isQd ? 'Qoder 登录态（凭证自持，无需客户端）'
        : isQw ? '千问办公客户端登录态（只读）'
        : isWb ? 'WorkBuddy 登录态（凭证自持，双区域）' : '客户端当前状态（只读）'"
    />

    <!-- ============ TRAE Work：凭证自持，可自动续期（与千问的只读相反） ============ -->
    <TraeworkLoginState v-if="isTw" />

    <!-- ============ Qoder：凭证自持（device flow），不需要任何客户端 ============ -->
    <QoderLoginState v-else-if="isQd" />

    <!-- ============ WorkBuddy：凭证自持（OAuth / 客户端导入 / 手动 token），双区域 ============ -->
    <WorkBuddyLoginState v-else-if="isWb" />

    <!-- ============ 千问办公：单账号直连，登录态在官方客户端的 auth-v2.dat ============ -->
    <template v-else-if="isQw">
      <a-alert type="info" show-icon message="只读页面">
        <template #description>
          千问办公的登录态由官方客户端维护（Electron safeStorage 加密的 auth-v2.dat）。
          管理端只读取，不做写入——两边各写一次会互相把对方的登录态刷掉。
          需要换账号请在千问办公客户端里操作。
        </template>
      </a-alert>

      <a-alert
        v-if="qw && !qw.ok"
        type="error"
        show-icon
        class="mt-4"
        :message="qw.error || '读取登录态失败'"
      />

      <template v-if="qw?.ok">
        <a-row :gutter="[16, 16]" class="mt-4">
          <a-col :span="8" :xs="24" :sm="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic title="登录账号" :value="qw.account?.name || '—'" />
              <div class="text-xs text-slate-500 mt-2">
                <template v-if="qw.account?.username">ID {{ qw.account.username }}</template>
                <span v-else>—</span>
              </div>
            </a-card>
          </a-col>
          <a-col :span="8" :xs="24" :sm="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic title="套餐" :value="qw.account?.tier || '—'" />
              <div class="text-xs text-slate-500 mt-2">
                {{ qw.account?.planName || '—' }}
                <a-tag v-if="qw.account?.planSubscriptionActive" color="green" class="ml-1">订阅中</a-tag>
              </div>
            </a-card>
          </a-col>
          <a-col :span="8" :xs="24" :sm="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                title="登录态"
                :value="tokenStateText"
                :value-style="`color:${tokenStateColor}`"
              />
              <div class="text-xs text-slate-500 mt-2">
                {{ qw.ready ? '通道就绪' : '通道未就绪' }}
                <template v-if="qw.wasm"> · 签名 {{ qw.wasm }}</template>
              </div>
            </a-card>
          </a-col>
        </a-row>

        <a-row :gutter="[16, 16]" class="mt-4">
          <a-col :span="12" :xs="24" :sm="12">
            <a-card title="账号信息" :bordered="false" class="h-full">
              <a-descriptions :column="1" size="small" bordered>
                <a-descriptions-item label="显示名">
                  {{ qw.account?.name || '—' }}
                </a-descriptions-item>
                <a-descriptions-item label="用户名">
                  {{ qw.account?.username || '—' }}
                </a-descriptions-item>
                <a-descriptions-item label="邮箱">
                  <span class="break-all text-xs">{{ qw.account?.email || '—' }}</span>
                </a-descriptions-item>
                <a-descriptions-item label="账号 ID">
                  <span class="break-all text-xs font-mono">{{ qw.account?.id || '—' }}</span>
                </a-descriptions-item>
                <a-descriptions-item label="套餐 ID">
                  <span class="font-mono text-xs">{{ qw.account?.planId || '—' }}</span>
                </a-descriptions-item>
                <a-descriptions-item label="企业账号">
                  {{ qw.account?.isBiz ? `是${qw.account?.orgName ? '（' + qw.account.orgName + '）' : ''}` : '否' }}
                </a-descriptions-item>
                <a-descriptions-item v-if="qw.account?.planNextDueDate" label="下次续费">
                  {{ qw.account.planNextDueDate }}
                </a-descriptions-item>
              </a-descriptions>
            </a-card>
          </a-col>

          <a-col :span="12" :xs="24" :sm="12">
            <a-card title="登录凭证" :bordered="false" class="h-full">
              <a-descriptions :column="1" size="small" bordered>
                <a-descriptions-item label="登录态文件">
                  <span class="break-all text-xs">{{ qw.file || '—' }}</span>
                </a-descriptions-item>
                <a-descriptions-item label="文件大小">
                  <span class="num">{{ qw.fileStat ? qw.fileStat.size + ' 字节' : '—' }}</span>
                </a-descriptions-item>
                <a-descriptions-item label="最后更新">
                  <span class="num">{{ qw.fileStat ? dateText(qw.fileStat.mtime) : '—' }}</span>
                </a-descriptions-item>
                <a-descriptions-item label="机器码">
                  <span class="font-mono text-xs break-all">{{ qw.machineId || '—' }}</span>
                </a-descriptions-item>
                <a-descriptions-item label="access token">
                  <!-- access 过期 ≠ 账号失效：refresh 还在就只是「待续期」，
                       下次请求会自动换票。只有 refresh 也过期才需要重新登录 -->
                  <a-tag :color="qw.token.refreshExpired ? 'red' : qw.token.accessExpired ? 'orange' : 'green'">
                    {{ qw.token.refreshExpired ? '需重新登录' : qw.token.accessExpired ? '待续期' : '有效' }}
                  </a-tag>
                  <span class="text-xs text-slate-500 ml-1 num">
                    {{ qw.token.accessExpiresAt ? dateText(qw.token.accessExpiresAt) : '—' }}
                  </span>
                </a-descriptions-item>
                <a-descriptions-item label="refresh token">
                  <a-tag :color="qw.token.refreshExpired ? 'red' : qw.token.refreshExpiringSoon ? 'orange' : 'green'">
                    {{ qw.token.refreshExpired ? '已过期' : qw.token.refreshExpiringSoon ? '临期' : '有效' }}
                  </a-tag>
                  <span class="text-xs text-slate-500 ml-1 num">
                    {{ qw.token.refreshExpiresAt ? dateText(qw.token.refreshExpiresAt) : '—' }}
                  </span>
                </a-descriptions-item>
              </a-descriptions>
              <a-alert
                v-if="qw.token.refreshExpiringSoon && !qw.token.refreshExpired"
                type="warning"
                show-icon
                class="mt-3"
                message="refresh token 24 小时内过期"
                description="过期后无法自动续期——请到「账号管理」重新登录这个账号。"
              />
              <a-alert
                v-if="qw.token.refreshExpired"
                type="warning"
                show-icon
                class="mt-3"
                message="refresh token 已过期"
                description="access token 到期后将无法自动续期，请重开千问办公客户端重新登录。"
              />
            </a-card>
          </a-col>
        </a-row>

        <a-card v-if="qw.account?.entitlements" title="套餐额度" :bordered="false" class="mt-4">
          <div class="text-xs text-slate-500 mb-3">
            千问办公按「页面数 / 月请求数 / 流量」限额，与积分是两套计量
          </div>
          <a-row :gutter="[16, 16]">
            <a-col :span="8" :xs="24" :sm="8">
              <div class="qw-pool">
                <div class="qw-pool-label">页面数</div>
                <div class="qw-pool-value num">{{ qw.account.entitlements.pageQuota ?? '—' }}</div>
              </div>
            </a-col>
            <a-col :span="8" :xs="24" :sm="8">
              <div class="qw-pool">
                <div class="qw-pool-label">月请求数</div>
                <div class="qw-pool-value num">
                  {{ qw.account.entitlements.monthRequests != null
                    ? qw.account.entitlements.monthRequests.toLocaleString('zh-CN') : '—' }}
                </div>
              </div>
            </a-col>
            <a-col :span="8" :xs="24" :sm="8">
              <div class="qw-pool">
                <div class="qw-pool-label">月流量</div>
                <div class="qw-pool-value num">{{ qw.account.entitlements.monthTraffic || '—' }}</div>
              </div>
            </a-col>
          </a-row>
        </a-card>
      </template>
    </template>

    <!-- ============ 百度搭子：原有页面 ============ -->
    <template v-else>
      <a-alert type="info" show-icon :message="data?.readonly_note || '只读页面'">
        <template #description>
          本页只展示客户端当前状态。修改登录态请使用 DuMate 客户端本身，
          管理端不做写入，以免两侧状态不一致。
        </template>
      </a-alert>

      <a-row :gutter="[16, 16]">
        <a-col :span="8" :xs="24" :sm="8">
          <a-card :bordered="false">
            <a-statistic title="客户端版本" :value="data?.version?.file_version || '未知'" />
            <div class="text-xs text-slate-500 mt-2">
              {{ data?.version?.company || '—' }}
              <template v-if="data?.version?.product_version">
                · {{ data.version.product_version }}
              </template>
            </div>
          </a-card>
        </a-col>
        <a-col :span="8" :xs="24" :sm="8">
          <a-card :bordered="false">
            <a-statistic title="登录账号" :value="activeAccount?.name || '未登录'" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="activeAccount">
                {{ activeAccount.age_days }} 天前登录 · {{ activeAccount.login_type || '—' }}
              </template>
              <span v-else>—</span>
            </div>
          </a-card>
        </a-col>
        <a-col :span="8" :xs="24" :sm="8">
          <a-card :bordered="false">
            <a-statistic
              title="后端进程"
              :value="data?.processes.length ? '运行中' : '未运行'"
            />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="data?.processes.length">
                <span v-for="p in data.processes" :key="p.pid" class="block">
                  {{ p.name }} #{{ p.pid }} · 端口 {{ p.port ?? '—' }}
                </span>
              </template>
              <span v-else>没有发现 dumate 进程</span>
            </div>
          </a-card>
        </a-col>
      </a-row>

      <a-row :gutter="[16, 16]" class="mt-4">
        <a-col :span="12" :xs="24" :sm="12">
          <a-card title="登录态" :bordered="false">
            <a-empty v-if="!data?.login.ok" :description="data?.login.reason || '读取失败'" />
            <template v-else>
              <a-descriptions :column="1" size="small" bordered>
                <a-descriptions-item label="登录态文件">
                  <span class="break-all text-xs">{{ data.login.file }}</span>
                </a-descriptions-item>
                <a-descriptions-item label="文件大小">
                  <span class="num">{{ data.login.file_stat?.size ?? '—' }} 字节</span>
                </a-descriptions-item>
                <a-descriptions-item label="最后更新">
                  <span class="num">{{ data.login.file_stat ? dateText(data.login.file_stat.mtime) : '—' }}</span>
                </a-descriptions-item>
                <a-descriptions-item label="当前凭证">
                  <a-tag :color="data.login.has_top_level_cookies ? 'green' : 'red'">
                    {{ data.login.has_top_level_cookies ? '存在' : '缺失' }}
                  </a-tag>
                  <span class="text-xs text-slate-500 ml-1">（顶层 cookies）</span>
                </a-descriptions-item>
                <a-descriptions-item label="凭证密钥文件">
                  <a-tag :color="data.login.cookie_key_present ? 'green' : 'red'">
                    {{ data.login.cookie_key_present ? '存在' : '缺失' }}
                  </a-tag>
                  <span class="text-xs text-slate-500 ml-1">（.cookie-key）</span>
                </a-descriptions-item>
                <a-descriptions-item label="登录提供方">
                  {{ data.login.active_provider || '—' }}
                </a-descriptions-item>
              </a-descriptions>
            </template>
          </a-card>
        </a-col>

        <a-col :span="12" :xs="24" :sm="12">
          <a-card title="账号列表" :bordered="false">
            <a-empty v-if="!data?.login.accounts?.length" description="没有已登录的账号" />
            <a-table
              v-else
              size="small"
              :pagination="false"
              :data-source="data.login.accounts"
              :columns="accountColumns"
              row-key="user_id"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'name'">
                  <div>{{ record.name }}</div>
                  <div class="text-xs text-slate-400 font-mono">
                    {{ (record.user_id || '').slice(0, 12) }}…
                  </div>
                </template>
                <template v-else-if="column.key === 'state'">
                  <a-tag :color="record.state === 'active' ? 'green' : 'orange'">
                    {{ record.state === 'active' ? '有效' : '失效' }}
                  </a-tag>
                  <a-tag v-if="record.active" color="blue">当前</a-tag>
                </template>
                <template v-else-if="column.key === 'last'">
                  <span class="num">{{ record.last_login ? dateText(record.last_login) : '—' }}</span>
                  <span v-if="record.age_days !== null" class="text-xs text-slate-400 ml-1 num">
                    ({{ record.age_days }} 天前)
                  </span>
                </template>
                <template v-else-if="column.key === 'cred'">
                  <a-tag :color="record.has_credentials ? 'green' : 'red'">
                    {{ record.has_credentials ? '有' : '无' }}
                  </a-tag>
                </template>
              </template>
            </a-table>
            <div class="text-xs text-slate-400 mt-2">
              上游不提供登录态过期时间，此处按凭证存在性与最后登录时间推断
            </div>
          </a-card>
        </a-col>
      </a-row>

      <a-card title="安装完整性" :bordered="false" class="mt-4">
        <a-table
          size="small"
          :pagination="false"
          :data-source="data?.install.checks ?? []"
          :columns="checkColumns"
          row-key="key"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'exists'">
              <a-tag :color="record.exists ? 'green' : 'red'">
                {{ record.exists ? '存在' : '缺失' }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'size'">
              <span class="text-slate-500 num">
                {{ record.kind === 'file' && record.size !== null ? record.size + ' 字节' : '—' }}
              </span>
            </template>
            <template v-else-if="column.key === 'path'">
              <span class="text-xs break-all">{{ record.path }}</span>
            </template>
          </template>
        </a-table>
        <div class="text-xs text-slate-400 mt-2">
          安装目录：<span class="break-all">{{ data?.install.dir }}</span>
        </div>
      </a-card>

      <a-card title="上游" :bordered="false" class="mt-4">
        <a-descriptions :column="2" size="small" bordered>
          <a-descriptions-item label="发现端口">
            {{ data?.upstream.port ?? '未发现' }}
          </a-descriptions-item>
          <a-descriptions-item label="归属">
            <a-tag :color="data?.upstream.is_managed ? 'blue' : 'default'">
              {{ data?.upstream.is_managed ? '自建（代理拉起）' : '外部实例' }}
            </a-tag>
          </a-descriptions-item>
        </a-descriptions>
      </a-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import { channelStore, isTraework, isQwenwork, isQoder, isWorkBuddy } from '@/stores/channel'
import TraeworkLoginState from '@/components/traework/TraeworkLoginState.vue'
import QoderLoginState from '@/components/qoder/QoderLoginState.vue'
import WorkBuddyLoginState from '@/components/workbuddy/WorkBuddyLoginState.vue'
import { qwenworkApi } from '@/api/qwenwork'
import type { QwLogin } from '@/api/qwenwork'
import type { AccountData } from '@/api/account'

const data = ref<AccountData | null>(null)
// 千问办公的登录态：来自官方客户端 auth-v2.dat，只读
const qw = ref<QwLogin | null>(null)

// 四条通道四种形态：搭子（有后端进程）、千问（单账号只读）、TRAE/Qoder（多账号自持）、
// WorkBuddy（多账号自持，双区域）。isDirectChannel 只分「搭子 vs 直连」，直连内部
// 还要再分——各通道的凭证来源与续期方式不同，共用一套模板会把「能不能自动续」说反。
const isTw = computed(() => isTraework())
const isQw = computed(() => isQwenwork())
const isQd = computed(() => isQoder())
const isWb = computed(() => isWorkBuddy())

const accountColumns = [
  { title: '账号', key: 'name' },
  { title: '状态', key: 'state' },
  { title: '最后登录', key: 'last' },
  { title: '凭证', key: 'cred', width: '14%' },
]
const checkColumns = [
  { title: '项目', key: 'label', dataIndex: 'label', width: '22%' },
  { title: '状态', key: 'exists', width: '12%' },
  { title: '大小', key: 'size', width: '14%' },
  { title: '路径', key: 'path' },
]

const activeAccount = computed(
  () => data.value?.login.accounts?.find((a) => a.active) ?? null,
)

const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN')

// 登录态总体判断：refresh 过期最严重（无法续期），其次 access 过期
const tokenStateText = computed(() => {
  const t = qw.value?.token
  if (!t) return '未知'
  if (t.refreshExpired) return '需重新登录'
  if (t.accessExpired) return '待续期'
  return '有效'
})
const tokenStateColor = computed(() => {
  const t = qw.value?.token
  if (!t) return 'var(--lab-text-mute)'
  if (t.refreshExpired) return 'var(--lab-danger)'
  if (t.accessExpired) return 'var(--lab-warn)'
  return 'var(--lab-ok)'
})

async function load() {
  // TRAE 的数据由子组件自己拉（它是自持凭证，字段与千问不同），
  // 这里只负责千问与搭子两条
  if (isTw.value) return
  if (isQw.value) {
    try {
      const { data: d } = await qwenworkApi.login()
      qw.value = d
    } catch (e: any) {
      qw.value = { ok: false, error: e?.message || '读取失败' } as QwLogin
    }
    return
  }
  const { data: d } = await client.get('/account')
  data.value = d
}

watch(() => channelStore.current, load)
onMounted(load)
</script>

<style scoped>
/* 千问套餐额度卡 .qw-pool 已收敛到全局 style.css（与其它页面共用一套视觉） */
</style>
