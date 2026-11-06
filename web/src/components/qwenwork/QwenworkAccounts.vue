<template>
  <div class="page">
    <PageHeader title="账号管理" :sub="subText">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="phoneLoading" @click="refreshPhone">
          补手机号
        </a-button>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
        <a-button type="primary" size="small" @click="openLogin">添加账号</a-button>
      </template>
    </PageHeader>

    <!-- 这条通道的结构说明。以前的文案是「单账号只读、换账号要开客户端」，
         现在凭证是我们自己的，那条说明已经说反了——必须改。 -->
    <a-alert type="info" show-icon>
      <template #message>千问办公的凭证由本项目自己持有</template>
      <template #description>
        <div>
          凭证走官方的 OAuth device flow 换取，存在
          <code>data/qwenwork-accounts.json</code>，与官方客户端的登录态
          （<code>auth-v2.dat</code>）无关。
        </div>
        <div class="mt-1">
          所以这里可以<b>多账号并存、可增删</b>，换账号<b>不需要打开千问办公客户端</b>。
        </div>
        <div class="mt-1">
          请求默认走「主账号」，它失败时会<b>自动转移</b>到下一个可用账号——
          某个号额度耗尽时不会直接断。
        </div>
      </template>
    </a-alert>

    <a-alert
      v-if="err"
      type="warning"
      show-icon
      class="mt-4"
      :message="err"
    />

    <a-card :bordered="false" class="mt-4">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="section-title">账号列表</span>
          <span class="hint-text ml-2">
            共 {{ rows.length }} 个 · 启用 {{ enabledCount }} 个
          </span>
        </div>
      </div>

      <a-empty v-if="!rows.length && !loading" description="还没有千问办公账号">
        <a-button type="primary" @click="openLogin">添加第一个账号</a-button>
      </a-empty>

      <a-skeleton v-if="loading && !rows.length" active :paragraph="{ rows: 4 }" />

      <a-row v-else :gutter="[16, 16]">
        <a-col v-for="a in rows" :key="a.id" :span="12" :xs="24" :sm="12">
          <a-card size="small" :bordered="true" class="h-full">
            <div class="flex items-start justify-between">
              <div class="min-w-0">
                <div class="font-medium truncate">
                  {{ a.name || '未命名' }}
                  <a-tag v-if="a.active" color="blue" class="ml-1">主账号</a-tag>
                  <a-tag v-else-if="!a.enabled" color="default" class="ml-1">已停用</a-tag>
                </div>
                <div class="text-xs text-slate-400 mt-1">
                  <template v-if="a.username">ID {{ a.username }} · </template>
                  {{ a.tier || '—' }}
                </div>
                <div class="text-xs text-slate-400 font-mono mt-1">
                  {{ a.phone || '手机号未知' }}
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
              :type="errType(a)"
              :message="errMessage(a)"
              show-icon
              class="mt-2"
              style="padding: 4px 8px"
            />

            <!-- 三个积分池。千问按「每日免费 / 月度 / 长期」分开计量，
                 与 TRAE 的单一 credits 不同，不要合并显示。 -->
            <div v-if="a.wallets" class="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              <div class="qw-pool">
                <div class="qw-pool-label">每日免费</div>
                <div class="qw-pool-value num text-cyan-700">{{ fmt(a.wallets.daily) }}</div>
              </div>
              <div class="qw-pool">
                <div class="qw-pool-label">月度积分</div>
                <div class="qw-pool-value num">{{ fmt(a.wallets.monthly) }}</div>
              </div>
              <div class="qw-pool">
                <div class="qw-pool-label">长期积分</div>
                <div class="qw-pool-value num">{{ fmt(a.wallets.longterm) }}</div>
              </div>
            </div>

            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div class="text-xs text-slate-400">access token 到期</div>
                <!-- access token 过期不等于账号失效：refresh token 还在时，
                     下次请求会自动换票（管理端查余额时也会先换）。只有
                     凭证不可用（refresh 缺失/过期）才标红。 -->
                <div class="text-xs" :class="tokenExpired(a) && !a.usable ? 'text-red-600' : ''">
                  {{ a.tokenExpiresAt ? dateText(a.tokenExpiresAt) : '—' }}
                  <span v-if="tokenExpired(a) && a.usable" class="text-slate-400">
                    （已过期，下次调用自动续期）
                  </span>
                </div>
              </div>
              <div>
                <div class="text-xs text-slate-400">refresh token 到期</div>
                <div class="text-xs">
                  {{ a.refreshExpiresAt ? dateText(a.refreshExpiresAt) : '未知' }}
                  <a-tag v-if="a.refreshExpiringSoon" color="orange" class="ml-1">临期</a-tag>
                </div>
              </div>
            </div>

            <div class="mt-3 flex flex-wrap gap-1">
              <a-button
                size="small"
                :disabled="a.active"
                :loading="busy[a.id]"
                @click="setMain(a)"
              >
                {{ a.active ? '已是主账号' : '设为主账号' }}
              </a-button>
              <a-button size="small" danger :loading="busy[a.id]" @click="remove(a)">删除</a-button>
            </div>

            <div class="mt-2 text-xs text-slate-400">
              机器码 {{ a.machineId ? a.machineId.slice(0, 12) + '…' : '—' }}
              · refresh …{{ a.refreshTail || '—' }}
              <a-tag v-if="a.adoptedFrom === 'official-desktop'" color="purple" class="ml-1">官方收编</a-tag>
            </div>

            <a-alert
              v-if="a.refreshExpiringSoon && !a.refreshExpired"
              type="warning"
              show-icon
              class="mt-2"
              message="refresh token 24 小时内过期"
              description="过期后无法自动续期，账号会变成不可用——请尽快删除后重新登录这个账号。"
            />

            <a-alert
              v-if="a.refreshExpired"
              type="warning"
              show-icon
              class="mt-2"
              message="refresh token 已过期"
              description="access token 到期后无法自动续期，请删除后重新登录这个账号。"
            />
          </a-card>
        </a-col>
      </a-row>

      <div class="text-xs text-slate-400 mt-3">
        机器码在登录时与账号绑定，之后不要改——改了会被判成换设备。
      </div>
    </a-card>

    <!-- 添加账号：两步。与 TRAE 的「粘贴回调地址」不同——
         千问的授权结果记在服务端，浏览器登录后这里轮询即可，
         用户不需要复制任何东西。 -->
    <a-modal v-model:open="loginOpen" title="添加千问办公账号" :footer="null" width="640">
      <a-steps :current="loginStep" size="small" class="mb-4">
        <a-step title="获取登录链接" />
        <a-step title="浏览器登录" />
        <a-step title="等待取票" />
      </a-steps>

      <template v-if="loginStep === 0">
        <a-alert type="info" show-icon class="mb-3">
          <template #message>点下面的按钮生成一次登录所需的链接</template>
          <template #description>
            每次登录会生成一组新的 nonce 与机器码，它们会与这次登录的账号绑定。
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
              <li>在打开的页面里登录<b>要添加的那个</b>千问账号</li>
              <li>登录后浏览器会跳到 <code>qwenwork-cn://</code>，<b>打不开是正常的</b></li>
              <li>回来点下面的按钮，程序会自动取票</li>
            </ol>
          </template>
        </a-alert>
        <div class="text-xs text-slate-400 mb-2">登录链接（如按钮失效可手动复制）</div>
        <a-textarea :value="loginUrl" :rows="3" readonly class="font-mono text-xs" />

        <!-- 用 playwright 全新 profile 开窗口会被风控拦（实测），
             所以这里刻意不用「程序帮你开浏览器」，只给链接。 -->
        <a-alert
          v-if="urlHrefFailed"
          type="warning"
          show-icon
          class="mt-3"
          message="如果新开的浏览器遇到人机验证"
          description="请改用你自己正在用的浏览器打开上面的链接（它已有千问的登录态）；若 nonce 被判为重复使用，点「上一步」重新生成一个。"
        />

        <div class="mt-3 flex gap-2">
          <a-button @click="cancelLogin">取消</a-button>
          <a-button type="primary" @click="startPolling">已登录，开始取票</a-button>
        </div>
      </template>

      <template v-else>
        <a-alert v-if="!loginError" type="info" show-icon class="mb-3">
          <template #message>正在等待授权结果…</template>
          <template #description>
            已等待 {{ waitedText }}。登录完成后会自动落盘，不用做别的操作。
          </template>
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
import { channelStore, isQwenwork } from '@/stores/channel'
import { qwenworkApi } from '@/api/qwenwork'
import type { QwAccount, QwLoginPoll } from '@/api/qwenwork'
import { lastErrorFresh, errorWhen } from '@/utils/lastError'

// message 走 App.useApp() 的实例（App.vue 已包 <a-app>），静态 import 拿不到上下文
const { message } = App.useApp()

const rows = ref<QwAccount[]>([])
const err = ref('')
const loading = ref(false)
const phoneLoading = ref(false)
const busy = reactive<Record<string, boolean>>({})

const loginOpen = ref(false)
const loginStep = ref(0)
const loginUrl = ref('')
const loginNonce = ref('')
const loginError = ref('')
const urlLoading = ref(false)
const urlHrefFailed = ref(false)
const waitedMs = ref(0)

let timer: number | null = null

const subText = computed(() => {
  if (!rows.value.length) return '千问办公账号（多账号，可增删）'
  const main = rows.value.find((a) => a.active)
  return `千问办公账号 · 共 ${rows.value.length} 个${main ? ` · 主账号 ${main.name}` : ''}`
})

const enabledCount = computed(() => rows.value.filter((a) => a.enabled).length)
const waitedText = computed(() => `${Math.round(waitedMs.value / 1000)} 秒`)

function fmt(v: number | null | undefined) {
  if (v == null) return '—'
  return Number(v).toFixed(2)
}

const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

// lastError 只在换票/请求成功时才清空，会停在旧错误上。新鲜度判定收敛到
// utils/lastError.ts（无时间戳的旧数据一律当陈旧，不当成当前故障）：
// 新鲜的显示成 error（红），陈旧的显示成 warning（黄）。
const errType = (a: QwAccount) => (lastErrorFresh(a) ? 'error' : 'warning')
const errMessage = (a: QwAccount) => errorWhen(a.lastErrorAt) + a.lastError

function tokenExpired(a: QwAccount) {
  return !!a.tokenExpiresAt && Date.now() >= a.tokenExpiresAt
}

async function load() {
  loading.value = true
  try {
    const { data } = await qwenworkApi.accounts()
    rows.value = data.accounts || []
    err.value = data.count ? '' : (data.error || '没有千问账号')
  } catch (e: any) {
    rows.value = []
    err.value = e?.response?.data?.error || e?.message || '读取千问账号失败'
  } finally {
    loading.value = false
  }
}

async function toggle(a: QwAccount, v: boolean) {
  busy[a.id] = true
  try {
    await qwenworkApi.patchAccount(a.id, { enabled: v })
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '更新失败')
  } finally {
    busy[a.id] = false
  }
}

/**
 * 回填手机号。
 *
 * 手机号是后来才加的字段——这之前登录的账号没有它。按钮常驻（不是只在
 * 缺号时才显示）：用户也可能想确认一下当前号是不是还绑着同一个手机。
 */
async function refreshPhone() {
  phoneLoading.value = true
  try {
    const { data } = await qwenworkApi.refreshPhone()
    const ok = (data.results || []).filter((r) => r.ok).length
    const total = (data.results || []).length
    if (ok) {
      message.success(`已回填 ${ok}/${total} 个账号的手机号`)
      await load()
    } else {
      message.warning(`没拿到手机号（${total} 个账号）`)
    }
  } catch (e: any) {
    message.error(e?.response?.data?.error || '回填失败')
  } finally {
    phoneLoading.value = false
  }
}

async function setMain(a: QwAccount) {
  busy[a.id] = true
  try {
    await qwenworkApi.patchAccount(a.id, { preferred: true })
    message.success(`已设为主账号：${a.name || a.id}`)
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '设置失败')
  } finally {
    busy[a.id] = false
  }
}

async function remove(a: QwAccount) {
  busy[a.id] = true
  try {
    await qwenworkApi.removeAccount(a.id)
    message.success('已删除')
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '删除失败')
  } finally {
    busy[a.id] = false
  }
}

function openLogin() {
  loginStep.value = 0
  loginUrl.value = ''
  loginNonce.value = ''
  loginError.value = ''
  waitedMs.value = 0
  urlHrefFailed.value = false
  loginOpen.value = true
}

async function genLoginUrl() {
  urlLoading.value = true
  loginError.value = ''
  try {
    const { data } = await qwenworkApi.loginStart()
    loginUrl.value = data.url
    loginNonce.value = data.nonce
    loginStep.value = 1
  } catch (e: any) {
    loginError.value = e?.response?.data?.error || '生成登录链接失败'
    urlHrefFailed.value = true
  } finally {
    urlLoading.value = false
  }
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null }
}

/**
 * 轮询取票。
 *
 * 与 TRAE 的关键差别：那边要用户把回调地址粘回来，这边的授权结果记在
 * **服务端**，所以只要定时查一次就行，用户不用复制任何东西。
 * 5 分钟是客户端同样的窗口，超时就让用户重新发起。
 */
function startPolling() {
  loginStep.value = 2
  loginError.value = ''
  waitedMs.value = 0
  stopTimer()
  const started = Date.now()
  timer = window.setInterval(async () => {
    waitedMs.value = Date.now() - started
    // 超过 5 分钟：服务端那边也认为这次登录作废了
    if (waitedMs.value > 5 * 60 * 1000) {
      stopTimer()
      loginError.value = '登录超时（5 分钟），请返回重新生成链接'
      return
    }
    try {
      const { data } = await qwenworkApi.loginPoll(loginNonce.value)
      const r = data as QwLoginPoll
      if (r.status === 'ok') {
        stopTimer()
        message.success(`已添加账号：${r.account?.name || r.account?.id || ''}`)
        loginOpen.value = false
        await load()
      } else if (r.status === 'error') {
        stopTimer()
        loginError.value = r.error || '取票失败'
      }
      // pending：继续等，不打扰
    } catch (e: any) {
      stopTimer()
      loginError.value = e?.response?.data?.error || '取票请求失败'
    }
  }, 2000)
}

async function cancelLogin() {
  stopTimer()
  if (loginNonce.value) {
    try { await qwenworkApi.loginCancel(loginNonce.value) } catch (e) { /* 取消失败无所谓 */ }
  }
  loginOpen.value = false
}

onUnmounted(stopTimer)

// 本页只在千问通道下有意义——其余通道由 WebAccountsView 的对应分支渲染
onMounted(() => { if (isQwenwork()) load() })
watch(() => channelStore.current, () => { if (isQwenwork()) load() })
</script>

<style scoped>
.qw-pool {
  background: var(--lab-surface-2);
  border-radius: 6px;
  padding: 8px 10px;
}
.qw-pool-label {
  color: var(--lab-text-mute);
  font-size: 11px;
}
.qw-pool-value {
  color: var(--lab-text);
  font-size: 15px;
  margin-top: 2px;
}
</style>
