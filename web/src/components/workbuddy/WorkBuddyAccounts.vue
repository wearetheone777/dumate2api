<template>
  <div class="page">
    <PageHeader title="账号管理" :sub="subText">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" :disabled="!enabledCount" @click="checkinAll">
          一键签到
        </a-button>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
        <a-button type="primary" size="small" :loading="oauthLoading" :disabled="oauthPolling" @click="startOauthLogin">
          浏览器登录
        </a-button>
        <a-button size="small" @click="importOpen = true">导入账号</a-button>
      </template>
    </PageHeader>

    <!-- 结构说明。文案按当前区域视图出 -->
    <a-alert type="info" show-icon>
      <template #message>WorkBuddy {{ isIntl ? '国际版' : '国内版' }}的凭证由本项目自己持有</template>
      <template #description>
        <div>
          凭证存于 <code>data/workbuddy-accounts.json</code>。账号来源：
          <b>浏览器 OAuth 登录</b>（推荐，多账号就是每个账号各登录一次）、
          官方客户端认证文件导入、或手动粘贴 token。
        </div>
        <div class="mt-1 text-xs">
          <template v-if="isIntl">
            当前是<b>国际版（workbuddy.ai）</b>视图。国际版没有签到接口（上游不提供）；
            额度是套餐包积分。要加国内账号请切回「国内版」。
          </template>
          <template v-else>
            当前是<b>国内版（copilot.tencent.com）</b>视图，有签到体系。
            与国际版（workbuddy.ai）是两套独立账号，要加国际账号请切到「国际版」。
          </template>
        </div>
      </template>
    </a-alert>

    <a-alert
      v-if="status && !status.ready"
      type="warning"
      show-icon
      :message="status.error || '通道不可用'"
    />

    <!-- OAuth 登录进行中：说明轮询状态与多账号做法 -->
    <a-alert v-if="oauthPolling" type="info" show-icon>
      <template #message>等待浏览器完成登录…（最长 10 分钟，每 2 秒检查一次）</template>
      <template #description>
        在弹出的官方登录页里完成登录即会自动导入。
        要加<b>多个账号</b>：完成一个后，换另一个账号（或开无痕窗口）再点一次「浏览器登录」。
      </template>
    </a-alert>

    <a-card :bordered="false">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="section-title">账号列表</span>
          <span class="hint-text ml-2">共 {{ rows.length }} 个 · 启用 {{ enabledCount }} 个</span>
        </div>
      </div>

      <a-empty v-if="!rows.length && !loading" :description="`还没有${isIntl ? '国际' : '国内'}版账号`">
        <a-button type="primary" :loading="oauthLoading" @click="startOauthLogin">浏览器登录添加账号</a-button>
        <a-button class="ml-2" @click="importOpen = true">其他方式导入</a-button>
      </a-empty>

      <a-skeleton v-if="loading && !rows.length" active :paragraph="{ rows: 4 }" />

      <a-row v-else :gutter="[16, 16]">
        <a-col v-for="a in rows" :key="a.id" :span="8" :xs="24" :md="8">
          <a-card size="small" :bordered="true" class="h-full">
            <div class="flex items-start justify-between">
              <div class="min-w-0">
                <div class="font-medium truncate">
                  {{ a.nickname || a.uid || '未命名' }}
                  <a-tag v-if="!a.enabled" color="default" class="ml-1">已停用</a-tag>
                </div>
                <div class="text-xs text-slate-400 font-mono mt-1 truncate">
                  UID {{ a.uid || '—' }}
                </div>
                <div v-if="a.enterpriseName" class="text-xs text-slate-400 mt-1 truncate">
                  {{ a.enterpriseName }}
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
              :type="errFresh(a) ? 'error' : 'warning'"
              :message="errorWhen(errAt(a)) + a.lastError"
              show-icon
              class="mt-2"
              style="padding: 4px 8px"
            />

            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div class="text-xs text-slate-400">剩余积分</div>
                <div class="num">{{ creditOf(a.id)?.total ?? '—' }}</div>
              </div>
              <div>
                <div class="text-xs text-slate-400">今日签到</div>
                <div>
                  <a-tag v-if="isIntl" color="default">不支持</a-tag>
                  <a-tag v-else :color="checkinColor(a)">
                    {{ checkinText(a) }}
                  </a-tag>
                </div>
              </div>
              <div>
                <div class="text-xs text-slate-400">上次签到</div>
                <div class="text-xs">{{ a.lastCheckin ? dateText(a.lastCheckin) : '从未' }}</div>
              </div>
              <div>
                <div class="text-xs text-slate-400">token 到期</div>
                <div class="text-xs" :class="tokenExpired(a) ? 'text-red-600' : ''">
                  {{ a.expiresAt ? dateText(a.expiresAt) : '—' }}
                </div>
              </div>
            </div>

            <div class="mt-3 flex flex-wrap gap-1">
              <a-button v-if="!isIntl" size="small" :loading="busy[a.id]" @click="checkin(a)">签到</a-button>
              <a-popconfirm title="确定删除这个账号？" @confirm="remove(a)">
                <a-button size="small" danger>删除</a-button>
              </a-popconfirm>
            </div>

            <div class="mt-2 text-xs text-slate-400">
              来源 {{ sourceText(a.source) }}
              · refresh …{{ a.refreshTail || '—' }}
            </div>
          </a-card>
        </a-col>
      </a-row>
    </a-card>

    <!-- 导入账号：两条路——客户端认证文件导入 / 手动粘贴 token（登录流程后置） -->
    <a-modal v-model:open="importOpen" title="导入 WorkBuddy 账号" :footer="null" width="560">
      <a-alert type="info" show-icon class="mb-3">
        <template #message>当前导入到{{ isIntl ? '国际版' : '国内版' }}</template>
        <template #description>
          两套账号不通用。推荐用页面右上角的<b>「浏览器登录」</b>（OAuth 设备授权，
          多账号就是每个账号各登录一次）；这里的两种方式是没有浏览器登录条件时的替代——
          客户端导入读的是本机客户端的登录态文件，必须先在客户端里登录对应区域的账号。
        </template>
      </a-alert>
      <a-button type="primary" block :loading="importLoading" @click="doImportClient">
        从客户端认证文件导入
      </a-button>
      <a-divider plain class="text-xs text-slate-400">或手动粘贴 token</a-divider>
      <a-form layout="vertical">
        <a-form-item label="accessToken">
          <a-textarea v-model:value="tokenForm.accessToken" :rows="2" placeholder="粘贴 access token" />
        </a-form-item>
        <a-form-item label="refreshToken">
          <a-textarea v-model:value="tokenForm.refreshToken" :rows="2" placeholder="粘贴 refresh token" />
        </a-form-item>
        <div class="grid grid-cols-2 gap-2">
          <a-form-item label="uid（可选，缺失用 token 尾做占位）">
            <a-input v-model:value="tokenForm.uid" placeholder="uid" />
          </a-form-item>
          <a-form-item label="昵称（可选）">
            <a-input v-model:value="tokenForm.nickname" placeholder="nickname" />
          </a-form-item>
        </div>
        <a-button block :loading="tokenLoading" @click="doImportToken">导入</a-button>
      </a-form>
      <a-alert v-if="importError" type="error" show-icon class="mt-3" :message="importError" />
    </a-modal>

    <!-- 签到结果 -->
    <a-alert v-if="checkinMsg" :type="checkinMsgType" show-icon class="mt-4" message="签到结果">
      <template #description>
        <ul class="pl-4 mb-0 text-xs">
          <li v-for="(l, i) in checkinDetail" :key="i">{{ l }}</li>
        </ul>
      </template>
    </a-alert>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { App } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import { channelStore, isWorkBuddy } from '@/stores/channel'
import { regionStore, regionParam } from '@/stores/region'
import { workbuddyApi } from '@/api/workbuddy'
import type { WorkBuddyAccount, WorkBuddyCreditRow, WorkBuddyStatus } from '@/api/workbuddy'
import { lastErrorFresh, errorWhen } from '@/utils/lastError'

const { message } = App.useApp()

const status = ref<WorkBuddyStatus | null>(null)
const credits = ref<{ count: number; rows: WorkBuddyCreditRow[] } | null>(null)
const loading = ref(false)
const rows = computed(() => status.value?.rows ?? [])
const isIntl = computed(() => regionStore.current === 'intl')

const busy = reactive<Record<number, boolean>>({})
const importOpen = ref(false)
const importLoading = ref(false)
const tokenLoading = ref(false)
const importError = ref('')
const tokenForm = reactive({ accessToken: '', refreshToken: '', uid: '', nickname: '' })

const checkinMsg = ref('')
const checkinMsgType = ref<'success' | 'warning' | 'error'>('success')
const checkinDetail = ref<string[]>([])

const subText = computed(() => {
  const r = isIntl.value ? '国际版' : '国内版'
  if (!status.value) return `WorkBuddy ${r}账号（多账号，可增删）`
  if (!status.value.ready) return `WorkBuddy ${r}账号 · 通道不可用`
  return `WorkBuddy ${r}账号 · 可用 ${status.value.accounts} 个`
})

const enabledCount = computed(() => rows.value.filter((a) => a.enabled).length)

function creditOf(id: number): WorkBuddyCreditRow | undefined {
  return credits.value?.rows.find((r) => r.id === id)
}

function checkinColor(a: WorkBuddyAccount) {
  const c = creditOf(a.id)
  if (!c || c.checkedIn == null) return 'default'
  return c.checkedIn ? 'green' : 'orange'
}
function checkinText(a: WorkBuddyAccount) {
  const c = creditOf(a.id)
  if (!c) return '刷新中'
  if (c.error) return '查询失败'
  if (c.unsupportedCheckin) return '不支持'
  if (c.checkedIn == null) return '—'
  return c.checkedIn ? '今日已签' : '未签到'
}

function tokenExpired(a: WorkBuddyAccount) {
  return !!a.expiresAt && Date.now() >= a.expiresAt
}

const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

const errAt = (a: WorkBuddyAccount) => a.lastErrorAt ?? null
const errFresh = (a: WorkBuddyAccount) => lastErrorFresh(a)

async function load() {
  loading.value = true
  try {
    const r = regionParam() as 'cn' | 'intl' | undefined
    const [s, c] = await Promise.all([
      workbuddyApi.status(r).catch((e: any) => ({
        data: { ready: false, error: e?.message || '读取失败', accounts: 0, mode: 'multi' as const, modeNote: '', rows: [] },
      })),
      workbuddyApi.credits(r).catch(() => ({ data: { count: 0, rows: [] } })),
    ])
    status.value = s.data as WorkBuddyStatus
    credits.value = c.data
  } finally {
    loading.value = false
  }
}

async function toggle(a: WorkBuddyAccount, v: boolean) {
  await workbuddyApi.patchAccount(a.id, { enabled: v })
  await load()
}

async function remove(a: WorkBuddyAccount) {
  await workbuddyApi.removeAccount(a.id)
  message.success('已删除')
  await load()
}

async function checkin(a: WorkBuddyAccount) {
  busy[a.id] = true
  try {
    const { data } = await workbuddyApi.checkin(a.id)
    reportCheckin([data])
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '签到失败')
  } finally {
    busy[a.id] = false
  }
}

async function checkinAll() {
  loading.value = true
  try {
    const { data } = await workbuddyApi.checkin()
    reportCheckin(data?.results || [])
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '签到失败')
  } finally {
    loading.value = false
  }
}

function reportCheckin(list: any[]) {
  checkinDetail.value = list.map((r: any) => {
    const name = r.nickname || r.id
    if (r.unsupported) return `${name}：该版本暂不支持自动签到`
    if (!r.ok) return `${name}：失败 — ${r.error || '未知错误'}`
    if (r.already) return `${name}：今日已签到过（跳过）`
    return `${name}：签到成功`
  })
  const failed = list.filter((r: any) => !r.ok && !r.unsupported).length
  checkinMsgType.value = failed ? (failed === list.length ? 'error' : 'warning') : 'success'
  checkinMsg.value = failed ? `${failed} 个失败` : '全部完成'
}

async function doImportClient() {
  importLoading.value = true
  importError.value = ''
  try {
    const { data } = await workbuddyApi.importClient(regionStore.current)
    if (!data.ok) {
      importError.value = data.error || '导入失败'
      return
    }
    message.success(`已导入账号：${data.account?.nickname || data.account?.uid || ''}`)
    importOpen.value = false
    await load()
  } catch (e: any) {
    importError.value = e?.response?.data?.error || '导入失败'
  } finally {
    importLoading.value = false
  }
}

async function doImportToken() {
  if (!tokenForm.accessToken.trim() || !tokenForm.refreshToken.trim()) {
    importError.value = '请粘贴完整的 accessToken 与 refreshToken'
    return
  }
  tokenLoading.value = true
  importError.value = ''
  try {
    const { data } = await workbuddyApi.importToken({
      region: regionStore.current,
      accessToken: tokenForm.accessToken.trim(),
      refreshToken: tokenForm.refreshToken.trim(),
      uid: tokenForm.uid.trim() || undefined,
      nickname: tokenForm.nickname.trim() || undefined,
    })
    if (!data.ok) {
      importError.value = data.error || '导入失败'
      return
    }
    message.success(`已导入账号：${data.account?.nickname || data.account?.uid || ''}`)
    importOpen.value = false
    tokenForm.accessToken = ''
    tokenForm.refreshToken = ''
    tokenForm.uid = ''
    tokenForm.nickname = ''
    await load()
  } catch (e: any) {
    importError.value = e?.response?.data?.error || '导入失败'
  } finally {
    tokenLoading.value = false
  }
}

// 来源标记的人话
const sourceText = (s: string) =>
  s === 'oauth' ? '浏览器登录'
    : s === 'client-import' ? '客户端导入'
      : s === 'manual' ? '手动粘贴' : (s || '—')

// OAuth 设备授权登录（浏览器登录）：生成授权链接 → 打开浏览器 → 每 2 秒轮询，
// 完成即自动导入。多账号 = 换账号后再点一次（浏览器已登录当前账号时用无痕窗口）。
const oauthLoading = ref(false)
const oauthPolling = ref(false)
let oauthTimer: ReturnType<typeof setInterval> | null = null
let oauthState = ''
let oauthRegion: 'cn' | 'intl' = 'cn'

function stopOauth(err = '') {
  if (oauthTimer) { clearInterval(oauthTimer); oauthTimer = null }
  oauthPolling.value = false
  if (err) message.error(err)
}

async function startOauthLogin() {
  if (oauthPolling.value) return
  oauthLoading.value = true
  const region = regionStore.current
  try {
    const { data } = await workbuddyApi.loginUrl(region)
    if (!data.ok || !data.authUrl || !data.state) {
      message.error(data.error || '生成授权链接失败')
      return
    }
    window.open(data.authUrl, '_blank', 'noopener')
    oauthState = data.state
    oauthRegion = region
    oauthPolling.value = true
    message.info('已打开浏览器授权页；完成登录后会自动导入账号')
    const deadline = Date.now() + 10 * 60 * 1000
    oauthTimer = setInterval(async () => {
      if (Date.now() > deadline) { stopOauth('登录窗口已超时，请重新发起'); return }
      try {
        const { data: r } = await workbuddyApi.loginPoll(oauthRegion, oauthState)
        if (r.status === 'ok') {
          stopOauth()
          message.success(`已导入账号：${r.account?.nickname || r.account?.uid || ''}`)
          await load()
        } else if (r.status === 'error' || r.status === 'expired') {
          stopOauth(r.error || r.message || '登录失败')
        }
      } catch (e) { /* 网络抖动忽略，下一轮继续 */ }
    }, 2000)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '生成授权链接失败')
  } finally {
    oauthLoading.value = false
  }
}

// 本页只在 WorkBuddy 通道下有意义；区域切换也重新拉
onMounted(() => { if (isWorkBuddy()) load() })
watch(() => channelStore.current, () => { if (isWorkBuddy()) load() })
watch(() => regionStore.current, () => { if (isWorkBuddy()) load() })
onBeforeUnmount(() => stopOauth())
</script>
