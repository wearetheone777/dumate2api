<template>
  <div class="page">
    <PageHeader title="账号管理" :sub="subText">
      <template #actions>
        <a-button
          size="small"
          class="ghost-btn"
          :loading="loading"
          :disabled="!enabledCount"
          @click="checkinAll"
        >
          一键签到
        </a-button>
        <a-button size="small" class="ghost-btn" :loading="phoneLoading" @click="refreshPhone">
          补手机号
        </a-button>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
        <a-button type="primary" size="small" @click="openLogin">添加账号</a-button>
      </template>
    </PageHeader>

    <!-- 这条通道的结构说明。三条通道现在都是凭证自持，但登录方式不同，
         不写清楚的话用户会以为 TRAE 也能像千问那样「浏览器登录完自动取票」。 -->
    <a-alert type="info" show-icon>
      <template #message>TRAE Work 的凭证由本项目自己持有</template>
      <template #description>
        <div>
          凭证是我们自己走 OAuth 换来的，存在
          <code>data/traework-accounts.json</code>，不依赖 TRAE 客户端。
        </div>
        <div class="mt-1">
          所以这里可以<b>多账号并存、可增删</b>。换账号不用开 TRAE 客户端。
        </div>
        <div class="mt-1 text-xs">
          与千问办公的差别：TRAE 登录后要<b>把回调地址粘回来</b>（千问是程序自动取票）；
          TRAE 也<b>拿不到手机号</b>——它的用户信息接口已失效，只能从昵称碰运气抽。
        </div>
      </template>
    </a-alert>

    <a-alert
      v-if="status && !status.ready"
      type="warning"
      show-icon
      :message="status.error || '通道不可用'"
    />

    <a-card :bordered="false">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="section-title">账号列表</span>
          <span class="hint-text ml-2">
            共 {{ rows.length }} 个 · 启用 {{ enabledCount }} 个
          </span>
        </div>
      </div>

      <a-empty v-if="!rows.length && !loading" description="还没有 TRAE Work 账号">
        <a-button type="primary" @click="openLogin">添加第一个账号</a-button>
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
                <!-- 手机号：TRAE 没有官方手机号接口，多数账号取不到。
                     取不到就显示「手机号未知」，并说明原因——不猜、不补。 -->
                <div class="text-xs text-slate-400 font-mono mt-1 truncate">
                  <template v-if="a.phone">{{ a.phone }}</template>
                  <span v-else class="text-slate-500" :title="PHONE_NOTE">手机号未知</span>
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

            <!-- 每个账号的额度：credits 是落盘值（上次签到时刷的），
                 remain 是本次实时查的。两个都给，因为落盘值可能过期。 -->
            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div class="text-xs text-slate-400">剩余额度</div>
                <div class="num">
                  {{ creditOf(a.id)?.remain ?? a.credits ?? '—' }}
                  <span v-if="creditOf(a.id)?.limit" class="text-xs text-slate-400 num">
                    / {{ creditOf(a.id)!.limit }}
                  </span>
                </div>
              </div>
              <div>
                <div class="text-xs text-slate-400">今日签到</div>
                <div>
                  <a-tag :color="checkinColor(a)">
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
              <a-button size="small" :loading="busy[a.id]" @click="checkin(a)">签到</a-button>
              <a-popconfirm title="确定删除这个账号？" @confirm="remove(a)">
                <a-button size="small" danger>删除</a-button>
              </a-popconfirm>
            </div>

            <div class="mt-2 text-xs text-slate-400 font-mono break-all">
              设备 {{ a.deviceId ? a.deviceId.slice(0, 12) + '…' : '—' }}
            </div>
            <div class="text-xs text-slate-400">
              refresh …{{ a.refreshTail || '—' }}
            </div>
          </a-card>
        </a-col>
      </a-row>

      <div class="text-xs text-slate-400 mt-3">
        设备标识（device_id / machine_id）在登录时就与账号绑定，之后不要改——
        改了会被判成换设备，需要重新登录。
      </div>
    </a-card>

    <!-- 签到结果：逐账号反馈。幂等，已签的会标「已签到过」而不是报错 -->
    <a-alert
      v-if="checkinMsg"
      :type="checkinMsgType"
      show-icon
      class="mt-4"
      message="签到结果"
    >
      <template #description>
        <ul class="pl-4 mb-0 text-xs">
          <li v-for="(l, i) in checkinDetail" :key="i">{{ l }}</li>
        </ul>
      </template>
    </a-alert>

    <!-- 登录：两步。先拿授权链接（含本次的设备标识），用户浏览器登录后
         把回调地址粘回来。不做本地 http server——手动粘贴更透明，
         也少一个「端口被占用」的失败点。 -->
    <a-modal v-model:open="loginOpen" title="添加 TRAE Work 账号" :footer="null" width="620">
      <a-steps :current="loginStep" size="small" class="mb-4">
        <a-step title="获取登录链接" />
        <a-step title="浏览器登录" />
        <a-step title="粘贴回调地址" />
      </a-steps>

      <template v-if="loginStep === 0">
        <a-alert type="info" show-icon class="mb-3">
          <template #message>点下面的按钮生成一次登录所需的链接</template>
          <template #description>
            每次登录会生成一组新的设备标识（device_id / machine_id），
            它们会与这次登录的账号绑定。
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
              <li>在打开的页面里登录 TRAE 账号</li>
              <li>登录后浏览器会跳到 <code>127.0.0.1:18080</code>，<b>打不开是正常的</b></li>
              <li>复制地址栏里的<b>完整 URL</b>，粘到下一步</li>
            </ol>
          </template>
        </a-alert>
        <div class="text-xs text-slate-400 mb-2">登录链接（如按钮失效可手动复制）</div>
        <a-textarea :value="loginUrl" :rows="3" readonly class="font-mono text-xs" />
        <div class="mt-3 flex gap-2">
          <a-button @click="loginStep = 0">上一步</a-button>
          <a-button type="primary" @click="loginStep = 2">已登录，去粘贴回调</a-button>
        </div>
      </template>

      <template v-else>
        <a-alert type="warning" show-icon class="mb-3">
          <template #message>粘贴回调地址</template>
          <template #description>
            形如 <code>http://127.0.0.1:18080/authorize?refreshToken=...&amp;userInfo=...</code>
            ——必须带完整参数，只粘域名换不到凭证。
          </template>
        </a-alert>
        <a-textarea
          v-model:value="callbackText"
          :rows="4"
          placeholder="把浏览器地址栏的完整 URL 粘在这里"
        />
        <a-alert
          v-if="loginError"
          type="error"
          show-icon
          class="mt-3"
          :message="loginError"
        />
        <div class="mt-3 flex gap-2">
          <a-button @click="loginStep = 1">上一步</a-button>
          <a-button type="primary" block :loading="submitting" @click="submitCallback">
            完成添加
          </a-button>
        </div>
      </template>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { App } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import { channelStore, isTraework } from '@/stores/channel'
import { traeworkApi } from '@/api/traework'
import type { TraeworkAccount, TraeworkCreditRow, TraeworkStatus } from '@/api/traework'
import { lastErrorFresh, errorWhen } from '@/utils/lastError'

// message 走 App.useApp() 的实例（App.vue 已包 <a-app>），静态 import 拿不到上下文
const { message } = App.useApp()

const status = ref<TraeworkStatus | null>(null)
const credits = ref<{ count: number; rows: TraeworkCreditRow[] } | null>(null)
const loading = ref(false)
const rows = computed(() => status.value?.rows ?? [])

// TRAE 没有官方手机号接口（GetUserInfo 已 401），只在昵称恰好形如
// 「用户13800138000」时才能取到。这段文案在取不到时作为 title 提示。
const PHONE_NOTE = 'TRAE Work 无官方手机号接口（GetUserInfo 已 401），'
  + '仅当昵称形如「用户13800138000」时才能取到。'

const phoneLoading = ref(false)

/**
 * 回填手机号。
 *
 * 这条不发网络请求——只重扫一遍已有的 nickname。实测本机账号的昵称
 * （用户23062830688）不是手机号格式，所以多数情况下会「没拿到」，
 * 那是正确结果，不是失败。
 */
async function refreshPhone() {
  phoneLoading.value = true
  try {
    const { data } = await traeworkApi.refreshPhone()
    const ok = (data.results || []).filter((r) => r.ok).length
    if (ok) {
      message.success(`已取到 ${ok} 个账号的手机号`)
      await load()
    } else {
      message.warning('没能从昵称取到手机号——TRAE 侧无官方手机号接口')
    }
  } catch (e: any) {
    message.error(e?.response?.data?.error || '回填失败')
  } finally {
    phoneLoading.value = false
  }
}

const busy = reactive<Record<number, boolean>>({})

// 登录弹窗
const loginOpen = ref(false)
const loginStep = ref(0)
const loginUrl = ref('')
const callbackText = ref('')
const loginError = ref('')
const urlLoading = ref(false)
const submitting = ref(false)
// 设备标识由后端生成并返回，前端只负责原样回传——
// 自己生成会导致登录时的标识与换票时的不一致，上游判为换设备
const deviceIds = reactive({ deviceId: '', machineId: '' })

const checkinMsg = ref('')
const checkinMsgType = ref<'success' | 'warning' | 'error'>('success')
const checkinDetail = ref<string[]>([])

const subText = computed(() => {
  if (!status.value) return 'TRAE Work 账号（多账号，可增删）'
  if (!status.value.ready) return 'TRAE Work 账号 · 通道不可用'
  return `TRAE Work 账号 · 可用 ${status.value.accounts} 个`
})

const enabledCount = computed(() => rows.value.filter((a) => a.enabled).length)

function creditOf(id: number): TraeworkCreditRow | undefined {
  return credits.value?.rows.find((r) => r.id === id)
}

function checkinColor(a: TraeworkAccount) {
  // 9074 退避中是「等自动重试」，不是故障也不是可签到——单独一档橙色
  if (backoffLeft(a) > 0) return 'orange'
  const c = creditOf(a.id)
  if (!c || c.checkedIn == null) return 'default'
  return c.checkedIn ? 'green' : 'orange'
}
function checkinText(a: TraeworkAccount) {
  const left = backoffLeft(a)
  if (left > 0) return `9074 退避 ${Math.ceil(left / 1000)}s`
  const c = creditOf(a.id)
  if (!c) return '刷新中'
  if (c.error) return '查询失败'
  if (c.checkedIn == null) return '—'
  return c.checkedIn ? '今日已签' : '未签到'
}

/** 9074 退避剩余毫秒。自愈闭环（claimWithRetry）记的账，到期由轮询自然重试 */
function backoffLeft(a: TraeworkAccount) {
  const until = a.checkin9074Until || 0
  return until > Date.now() ? until - Date.now() : 0
}

function tokenExpired(a: TraeworkAccount) {
  return !!a.expiresAt && Date.now() >= a.expiresAt
}

const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

// lastError 只在换票/请求成功时才清空，会停在旧错误上。新鲜度判定收敛到
// utils/lastError.ts（无时间戳的旧数据一律当陈旧，不当成当前故障）。
const errAt = (a: TraeworkAccount) => a.lastErrorAt ?? null
const errFresh = (a: TraeworkAccount) => lastErrorFresh(a)

async function load() {
  loading.value = true
  try {
    const [s, c] = await Promise.all([
      traeworkApi.status().catch((e: any) => ({
        data: { ready: false, error: e?.message || '读取失败', accounts: 0, mode: 'multi', modeNote: '', rows: [] },
      })),
      traeworkApi.credits().catch(() => ({ data: { count: 0, rows: [] } })),
    ])
    status.value = s.data as TraeworkStatus
    credits.value = c.data
  } finally {
    loading.value = false
  }
}

async function toggle(a: TraeworkAccount, v: boolean) {
  await traeworkApi.patchAccount(a.id, { enabled: v })
  await load()
}

async function remove(a: TraeworkAccount) {
  await traeworkApi.removeAccount(a.id)
  message.success('已删除')
  await load()
}

async function checkin(a: TraeworkAccount) {
  busy[a.id] = true
  try {
    const { data } = await traeworkApi.checkin(a.id)
    reportCheckin(data)
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
    const { data } = await traeworkApi.checkin()
    reportCheckin(data)
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '签到失败')
  } finally {
    loading.value = false
  }
}

/**
 * 渲染签到结果。
 *
 * `gained` 是网关**实测的到账差值**（签到后余额 − 签到前余额），不是上游
 * 返回的发放数额——上游 claim 只回 {code:0,message:"success"}，从不报发了多少。
 * 所以这里把「签到前 → 签到后」一并写出来：只报一个总额时，用户看到
 * 「签到成功 + 余额」无从判断签到到底生效没有（上游 status 与 usage 不同步
 * 时还会出现「签到成功但余额没变」，被读成「显示的是旧积分」）。
 */
function reportCheckin(data: any) {
  const list = data?.results ?? []
  checkinDetail.value = list.map((r: any) => {
    const name = r.nickname || r.id
    if (!r.ok) return `${name}：失败 — ${r.error || '未知错误'}`
    const c = r.credits != null ? `，当前剩余 ${r.credits}` : ''
    // 已签到的分支也要给余额：跳过 ≠ 没有数据
    if (r.already) return `${name}：今日已签到过（跳过）${c}`
    // 差值 0 或负数如实说，不粉饰——它意味着奖励延迟入账或上游没发
    let g = ''
    if (r.gained != null && r.gained > 0) g = `，本次到账 ${r.gained}`
    else if (r.gained === 0) g = '，本次到账 0（奖励可能延迟入账）'
    else if (r.gained != null && r.gained < 0) g = `，本次到账 ${r.gained}（余额反降，请核对上游）`
    const b = (r.creditsBefore != null && r.credits != null)
      ? `（${r.creditsBefore} → ${r.credits}）` : ''
    return `${name}：签到成功${g}${b}${c}`
  })
  const failed = list.filter((r: any) => !r.ok).length
  checkinMsgType.value = failed ? (failed === list.length ? 'error' : 'warning') : 'success'
  checkinMsg.value = failed ? `${failed} 个失败` : '全部完成'
}

function openLogin() {
  loginStep.value = 0
  loginUrl.value = ''
  callbackText.value = ''
  loginError.value = ''
  deviceIds.deviceId = ''
  deviceIds.machineId = ''
  loginOpen.value = true
}

async function genLoginUrl() {
  urlLoading.value = true
  loginError.value = ''
  try {
    const { data } = await traeworkApi.loginUrl()
    loginUrl.value = data.url
    deviceIds.deviceId = data.deviceId
    deviceIds.machineId = data.machineId
    loginStep.value = 1
  } catch (e: any) {
    loginError.value = e?.response?.data?.error || '生成登录链接失败'
  } finally {
    urlLoading.value = false
  }
}

async function submitCallback() {
  if (!callbackText.value.trim()) {
    loginError.value = '请粘贴回调地址'
    return
  }
  submitting.value = true
  loginError.value = ''
  try {
    const { data } = await traeworkApi.loginCallback({
      callback: callbackText.value.trim(),
      deviceId: deviceIds.deviceId,
      machineId: deviceIds.machineId,
    })
    if (!data.ok) {
      loginError.value = data.error || '换票失败'
      return
    }
    message.success(`已添加账号：${data.account?.nickname || data.account?.uid || ''}`)
    loginOpen.value = false
    await load()
  } catch (e: any) {
    loginError.value = e?.response?.data?.error || '添加失败'
  } finally {
    submitting.value = false
  }
}

// 本页只在 TRAE 通道下有意义——其余通道由 WebAccountsView 的对应分支渲染
onMounted(() => { if (isTraework()) load() })
watch(() => channelStore.current, () => { if (isTraework()) load() })
</script>
