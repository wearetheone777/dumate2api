<template>
  <a-layout class="min-h-screen lab-shell" :class="{ 'reading-mode': readingMode }">
    <a-layout-sider
      v-model:collapsed="siderCollapsed"
      :collapsible="!readingMode"
      :width="216"
      breakpoint="md"
      class="lab-sider"
    >
      <div class="lab-logo">
        <span class="logo-mark"><AppLogo :size="19" /></span>
        <span v-if="!collapsed" class="logo-text">DuMate<span class="logo-accent">控制台</span></span>
      </div>
      <a-menu theme="light" mode="inline" :selected-keys="selectedKeys" @click="onMenu">
        <a-menu-item v-if="showMenu('dashboard')" key="dashboard">
          <template #icon><DashboardOutlined /></template>
          <span>仪表盘</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('chatlab')" key="chatlab">
          <template #icon><CommentOutlined /></template>
          <span>聊天测试台</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('usage')" key="usage">
          <template #icon><BarChartOutlined /></template>
          <span>用量统计</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('reqlogs')" key="reqlogs">
          <template #icon><FileTextOutlined /></template>
          <span>请求日志</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('models')" key="models">
          <template #icon><DeploymentUnitOutlined /></template>
          <span>模型管理</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('keys')" key="keys">
          <template #icon><KeyOutlined /></template>
          <span>API Key</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('account')" key="account">
          <template #icon><UserOutlined /></template>
          <span>登录态</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('points')" key="points">
          <template #icon><WalletOutlined /></template>
          <span>积分明细</span>
        </a-menu-item>
        <a-menu-item v-if="showMenu('web-accounts')" key="web-accounts">
          <template #icon><TeamOutlined /></template>
          <a-badge :count="accountAlerts" :show-zero="false" :offset="[10, 0]" :number-style="badgeStyle">
            <span>账号管理</span>
          </a-badge>
        </a-menu-item>
        <!-- TRAE 运行策略：写的是 data/traework-runtime.json（降级 / Max 档 /
             选号策略 / 护栏），只对 TRAE 通道生效。与下面的 Qoder 运行策略
             同一规则——通道级配置套到别的通道上是误导（在搭子页点进去改
             TRAE 的降级开关，会以为改的是搭子）。 -->
        <a-menu-item v-if="isAdmin && channelStore.current === 'traework'" key="trae-runtime">
          <template #icon><ControlOutlined /></template>
          <span>TRAE 运行策略</span>
        </a-menu-item>
        <!-- 通道风控（P1-9）：并发/间隔/重试/限流上限 + 通道级复位，admin 专属 -->
        <a-menu-item v-if="isAdmin" key="channel-policy">
          <template #icon><SafetyCertificateOutlined /></template>
          <span>通道风控</span>
        </a-menu-item>
        <!-- Qoder 运行策略：超时/排队/冷却热生效 + 自动签到（P0-1/P0-3）。
             只在 Qoder 通道下出现——它是通道级配置，套到别的通道上是误导 -->
        <a-menu-item v-if="isAdmin && channelStore.current === 'qoder'" key="qoder-runtime">
          <template #icon><ControlOutlined /></template>
          <span>Qoder 运行策略</span>
        </a-menu-item>
        <!-- WorkBuddy 模型规则：按账号 deny/allow（批次十三）。只在 WorkBuddy
             通道下出现，理由同上——规则挂在 workbuddy 账号上，别的通道没有这回事 -->
        <a-menu-item v-if="isAdmin && channelStore.current === 'workbuddy'" key="model-rules">
          <template #icon><BlockOutlined /></template>
          <span>模型规则</span>
        </a-menu-item>
        <!-- 运行日志：进程 console，admin 专属 -->
        <a-menu-item v-if="isAdmin" key="logs">
          <template #icon><CodeOutlined /></template>
          <span>运行日志</span>
        </a-menu-item>
        <!-- 运维告警：viewer 也能看（阈值只读禁用），写由服务端拦 -->
        <a-menu-item v-if="showMenu('alerts')" key="alerts">
          <template #icon><AlertOutlined /></template>
          <a-badge :count="activeAlertCount" :show-zero="false" :offset="[10, 0]" :number-style="badgeStyle">
            <span>运维告警</span>
          </a-badge>
        </a-menu-item>
        <!-- 接入配置：写本机 Claude Code / Codex 配置，admin 专属、与通道无关，
             不走 menuKeys 的通道白名单 -->
        <a-menu-item v-if="isAdmin" key="setup">
          <template #icon><ApiOutlined /></template>
          <span>接入配置</span>
        </a-menu-item>
        <!-- 账户管理只对 admin 有意义（viewer 是只读角色），且与通道无关，
             不走 menuKeys 的通道白名单 -->
        <a-menu-item v-if="isAdmin" key="users">
          <template #icon><UsergroupAddOutlined /></template>
          <span>账户管理</span>
        </a-menu-item>
      </a-menu>
      <div v-if="!collapsed" class="lab-sider-foot">
        <span class="dot" />
        <span>网关控制台 · v1.1</span>
      </div>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="lab-header">
        <!-- 顶栏放面包屑而不是重复页名：页内已有大标题（PageHeader），
             两处都写会并排出现两个同名标题；写成「控制台 / 页面」则读作
             导航位置，同时补上侧边栏折叠后丢失的上下文 -->
        <div class="lab-left">
          <!-- 通道切换器放顶栏而不是侧栏：侧栏可折叠，折叠后它会消失，
               而「当前在看哪个通道」是全局上下文，任何时候都不该丢。
               顶栏是 sticky 的，滚动时始终可见。 -->
          <div class="ch-switch">
            <button
              v-for="c in CHANNELS"
              :key="c.id"
              class="ch-btn"
              :class="{ on: channelStore.current === c.id }"
              :title="titleFor(c.id)"
              @click="onChannel(c.id)"
            >
              <span class="ch-dot" :class="dotClass(c.id)" />
              {{ c.label }}
            </button>
          </div>
          <!-- 区域切换器（2026-11-03）：TRAE/Qoder 有国内、国际两套独立账号，
               页面按区域整体切换——这是「两个不同的页面」，不是一页里打标签。
               纯国内通道（搭子/千问）没有区域概念，切换器隐藏 -->
          <div v-if="regionVisible" class="ch-switch region-switch">
            <button
              class="ch-btn region-btn"
              :class="{ on: regionStore.current === 'cn' }"
              @click="regionStore.set('cn')"
            >
              国内版
            </button>
            <button
              class="ch-btn region-btn intl"
              :class="{ on: regionStore.current === 'intl' }"
              @click="regionStore.set('intl')"
            >
              国际版
            </button>
          </div>
          <div class="lab-crumb">
            <span class="crumb-root">控制台</span>
            <span class="crumb-sep">/</span>
            <span class="crumb-cur">{{ currentTitle }}</span>
          </div>
        </div>
        <a-space :size="10">
          <!-- 主题切换：三态下拉而不是单键翻转。
               单键只能两态，而 'auto' 是默认值——用户首次进站时是「跟随系统」，
               单键翻转会把他从 auto 里拽出来，之后就再也不跟随系统了。
               图标按**生效**主题画（不是按选择），这样 auto 下也能一眼看出现在是什么颜色。 -->
          <a-dropdown :trigger="['click']" placement="bottomRight">
            <a-button size="small" class="ghost-btn theme-btn" :title="themeTitle">
              <template #icon>
                <svg v-if="isDark" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"
                  />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                  <circle cx="12" cy="12" r="4.4" fill="currentColor" />
                  <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2" />
                    <path d="M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
                  </g>
                </svg>
              </template>
              <span class="theme-btn-text">{{ themeShort }}</span>
            </a-button>
            <template #overlay>
              <a-menu :selected-keys="[themeMode]" @click="onThemeMode">
                <a-menu-item key="light">浅色</a-menu-item>
                <a-menu-item key="dark">深色</a-menu-item>
                <a-menu-item key="auto">跟随系统</a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
          <!-- 自动刷新（P2-12）：共享一个定时器，页面不可见时不刷。
               挂看板时不用一直手点；间隔选项与「不自动刷新」同一份常量。 -->
          <a-select
            v-model:value="autoRefreshMs"
            size="small"
            class="refresh-select"
            :options="REFRESH_OPTIONS"
            :title="`自动刷新：${refreshingCount ? '正在更新' : '按间隔重新拉取当前页数据'}`"
          />
          <a-tag v-if="refreshingCount" color="processing" class="refresh-tag">更新中</a-tag>
          <!-- 阅读模式：只改排版（侧栏收起 + 字号/数字放大），**不隐藏任何数据** -->
          <a-button
            size="small"
            class="ghost-btn"
            :type="readingMode ? 'primary' : 'default'"
            :title="readingMode ? '退出阅读模式' : '阅读模式：放大数字、收起侧栏（不隐藏数据）'"
            @click="readingMode = !readingMode"
          >
            {{ readingMode ? '退出阅读' : '阅读模式' }}
          </a-button>
          <a-tag class="user-tag">{{ auth.user?.username }}</a-tag>
          <a-button size="small" class="ghost-btn" @click="onLogout">退出</a-button>
        </a-space>
      </a-layout-header>
      <a-layout-content class="lab-content">
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DashboardOutlined, DeploymentUnitOutlined, KeyOutlined, UserOutlined, WalletOutlined, TeamOutlined, BarChartOutlined, FileTextOutlined, CommentOutlined, UsergroupAddOutlined, ApiOutlined, ControlOutlined, CodeOutlined, AlertOutlined, SafetyCertificateOutlined, BlockOutlined } from '@ant-design/icons-vue'
import AppLogo from '@/components/AppLogo.vue'
import client from '@/api/client'
import { auth, isAdmin } from '@/stores/auth'
import { channelStore, CHANNELS } from '@/stores/channel'
import { regionStore, hasRegion } from '@/stores/region'
import { isDark, themeMode, setThemeMode, type ThemeMode } from '@/stores/theme'
import { autoRefreshMs, readingMode, refreshingCount, REFRESH_OPTIONS } from '@/stores/ui'

const collapsed = ref(false)
// 自动刷新与阅读模式（P2-12）：状态在 stores/ui.ts，跨页持久化
const siderCollapsed = computed({
  get: () => readingMode.value || collapsed.value,
  // 阅读模式下禁用折叠按钮，这个 setter 只在普通模式生效
  set: (v: boolean) => { collapsed.value = v },
})
const router = useRouter()
const route = useRoute()

// 侧栏角标（调研 P1-10）：TRAE /status 的 alerts 是账号健康跨页汇总，
// 只在 TRAE 通道视图下取——其他通道的账号结构不同，硬套会报不存在的故障。
// 角标颜色橙=待办，0 不显示；viewer 也能看（只读状态，不是配置）。
const accountAlerts = ref(0)
const badgeStyle = { backgroundColor: '#d97706', boxShadow: 'none' }
async function loadAccountAlerts() {
  if (channelStore.current !== 'traework') { accountAlerts.value = 0; return }
  try {
    const { data } = await client.get('/traework/status')
    const a = data.alerts || {}
    accountAlerts.value = (a.needRelogin || 0) + (a.exhausted || 0) + (a.disabled || 0)
  } catch { accountAlerts.value = 0 }
}

// 运维告警角标：未恢复的告警数。与账号角标分开——这个是通道无关的运维面，
// 通道无关所以不随顶栏切换器变化，只在进页面/手动刷新时更新。
const activeAlertCount = ref(0)
async function loadAlertCount() {
  try {
    const { data } = await client.get('/alerts')
    // 只数 actionable（warn/crit）：info 级的「非工作时段请求」深夜自己用一下
    // 就会命中，计入角标会让红灯天天常亮，等于把人训练成忽略告警。
    activeAlertCount.value = Array.isArray(data.actionable) ? data.actionable.length : 0
  } catch { activeAlertCount.value = 0 }
}

// 区域切换器只在有区域概念的通道显示（TRAE / Qoder）
const regionVisible = computed(() => hasRegion())

// 选中态跟着路由走，否则点进模型管理后侧边栏仍高亮仪表盘
const selectedKeys = computed(() => [String(route.meta.key || 'dashboard')])
// 面包屑当前段：取自路由 meta，避免顶栏与页内标题各写一份文案
const currentTitle = computed(() => String(route.meta.title || '仪表盘'))

// 菜单按通道过滤：搭子有账号池/积分/密钥，千问没有——与其让用户点进去
// 看到一片空，不如直接隐藏。白名单定义在 stores/channel.ts。
function showMenu(key: string): boolean {
  return (channelStore.menuKeys() as readonly string[]).includes(key)
}

// 切通道时若当前页在新通道里不存在，回仪表盘——否则会停在一个
// 已被隐藏的页面（菜单里没有入口，用户退不出去）。
function onChannel(id: string) {
  channelStore.set(id)
  const key = String(route.meta.key || 'dashboard')
  if (!showMenu(key)) router.push('/')
}

function titleFor(id: string): string {
  const i = channelStore.infos[id]
  if (!i) return ''
  if (!i.ready) {
    // 桌面凭证失效但网页池可用 → 请求仍能成功（走回落），不是「不可用」。
    // 与模型管理页「凭证来源」的三分支判定同口径。
    if (i.fallback?.available) return '桌面凭证失效 · 网页凭证回落中'
    return i.error || '不可用'
  }
  if (i.kind === 'direct') {
    // 千问的签名方式有 local / wasm 两种（默认 local，不需要客户端）；
    // Qoder/TRAE 没有这个概念，对它们显示「签名未知」是凭空报一个不存在的故障。
    const bits = ['直连']
    if (i.wasm) bits.push(`签名 ${i.wasm}`)
    if (i.accounts != null && i.accounts > 0) bits.push(`${i.accounts} 个账号`)
    if (i.account) bits.push(i.account)
    if (i.refreshExpired) bits.push('refresh token 已过期，需重新登录')
    return bits.join(' · ')
  }
  return `端口 ${i.port || '—'}` + (i.managed ? ' · 自托管' : '')
}

// 状态点：绿=就绪，黄=登录态将失效 / 桌面凭证失效但网页池回落可用（请求仍通），红=真不可用，灰=未知
function dotClass(id: string): string {
  const i = channelStore.infos[id]
  if (!i) return 'unknown'
  if (!i.ready) return i.fallback?.available ? 'warn' : 'bad'
  if (i.refreshExpired) return 'warn'
  return 'ok'
}

function onMenu({ key }: { key: string }) {
  router.push(key === 'dashboard' ? '/' : `/${key}`)
}

async function onLogout() {
  await auth.logout()
  router.push('/login')
}

// ---------- 主题切换 ----------
// 按钮上的短标签按「用户的选择」显示（auto 就写自动），图标按「生效结果」画：
// 两者会不一致（auto + 系统深色 = 写「自动」画月亮），这是刻意的——
// 标签回答「我选了什么」，图标回答「现在是什么」。
const themeShort = computed(() =>
  themeMode.value === 'auto' ? '自动' : themeMode.value === 'dark' ? '深色' : '浅色'
)
const themeTitle = computed(
  () =>
    `主题：${isDark.value ? '深色' : '浅色'}` +
    (themeMode.value === 'auto' ? '（跟随系统）' : '') +
    ' · 点击切换'
)
function onThemeMode({ key }: { key: string }) {
  setThemeMode(key as ThemeMode)
}

// URL 参数直达通道/区域视图（?channel=workbuddy&region=cn）：让「某通道某
// 区域的管理视图」可以被链接分享、被书签直达，也让自动化走查不必依赖点击
// 顶栏切换器。只认合法值，非法参数静默忽略（不报错——URL 是数据不是指令）。
onMounted(() => {
  try {
    const q = new URLSearchParams(window.location.search)
    const ch = q.get('channel')
    if (ch && CHANNELS.some((c) => c.id === ch)) channelStore.set(ch)
    const rg = q.get('region')
    if (rg === 'cn' || rg === 'intl') regionStore.set(rg)
  } catch { /* URL 解析失败不影响进入默认视图 */ }
  channelStore.load()
  loadAccountAlerts()
  loadAlertCount()
})
// 切通道时角标跟着换（TRAE 之外恒 0），切区域时 TRAE 账号集合也会变
watch(() => channelStore.current, () => { loadAccountAlerts() })
// 区域切换（顶栏国内版/国际版）：通道状态卡按区域重报（accounts 数与当前
// 账号都按区域过滤），不重拉会显示上一个区域的数字
watch(() => regionStore.current, () => { channelStore.load(); loadAccountAlerts() })
</script>

<style scoped>
.lab-shell {
  background: transparent;
}

/* 侧栏：比内容区再深一档灰，靠明度分层而不是靠边框 */
.lab-sider {
  background: var(--lab-sider-bg) !important;
  border-right: 1px solid var(--lab-border);
}
.lab-sider :deep(.ant-layout-sider-trigger) {
  background: var(--lab-sider-trigger);
  border-top: 1px solid var(--lab-border);
  color: var(--lab-text-mute);
}
.lab-logo {
  height: 60px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
  border-bottom: 1px solid var(--lab-border);
}
/* 折叠后侧栏只剩 80px，18px 的左内边距会让标记明显偏左。
   .ant-layout-sider-collapsed 是 AntD 折叠时加在 sider 根元素上的类 */
.lab-sider.ant-layout-sider-collapsed .lab-logo {
  padding: 0;
  justify-content: center;
}
.logo-mark {
  width: 30px;
  height: 30px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: linear-gradient(135deg, #0891b2, #0e7490);
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.28);
  transition: box-shadow 0.25s ease, transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.logo-mark:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(8, 145, 178, 0.4);
}
.logo-text {
  font-family: var(--lab-display);
  color: var(--lab-text);
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.6px;
  white-space: nowrap;
}
.logo-accent {
  color: var(--lab-primary);
  margin-left: 3px;
}
.lab-sider :deep(.ant-menu) {
  background: transparent;
  border-inline-end: none !important;
  padding: 10px 10px 0;
}
.lab-sider :deep(.ant-menu-item) {
  border-radius: 9px;
  margin: 2px 0;
  height: 40px;
  line-height: 40px;
  font-size: 13px;
  position: relative;
}
.lab-sider :deep(.ant-menu-item-selected) {
  background: var(--lab-primary-dim) !important;
  color: var(--lab-primary) !important;
  font-weight: 600;
}
/* 选中态左侧的信号条：比整行高亮更克制，也和「控制台」的语义一致 */
.lab-sider :deep(.ant-menu-item-selected)::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 0 3px 3px 0;
  background: var(--lab-primary);
  box-shadow: 0 0 8px rgba(8, 145, 178, 0.5);
}
.lab-sider :deep(.ant-menu-item-selected .anticon) {
  color: var(--lab-primary);
}
.lab-sider-foot {
  position: absolute;
  bottom: 52px;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 20px;
  font-size: 11px;
  color: var(--lab-text-mute);
  letter-spacing: 0.3px;
}
.lab-sider-foot .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--lab-ok);
  box-shadow: 0 0 6px rgba(5, 150, 105, 0.6);
}

/* 顶栏左区：切换器 + 面包屑 */
.lab-left {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
}
.ch-switch {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border-radius: 10px;
  background: var(--lab-surface-2);
  border: 1px solid var(--lab-border);
}
.ch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--lab-text-sub);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.16s ease;
  white-space: nowrap;
}
.ch-btn:hover {
  color: var(--lab-text);
  background: var(--lab-hover);
}
.ch-btn.on {
  background: var(--lab-primary-dim);
  color: var(--lab-primary);
  font-weight: 600;
}
/* 区域切换器：与通道切换器同构但视觉上低一档（它是通道内的二级维度），
   国际版选中态用紫色——与账号卡「国际」徽标同色系，两处看到的是同一个语义 */
.region-switch {
  padding: 2px;
}
.region-btn {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}
.region-btn.intl.on {
  background: rgba(147, 51, 234, 0.14);
  color: #c084fc;
}
.ch-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.ch-dot.ok {
  background: var(--lab-ok);
  box-shadow: 0 0 6px rgba(5, 150, 105, 0.5);
}
.ch-dot.warn {
  background: var(--lab-warn);
  box-shadow: 0 0 6px rgba(217, 119, 6, 0.5);
}
.ch-dot.bad {
  background: var(--lab-danger);
  box-shadow: 0 0 6px rgba(220, 38, 38, 0.5);
}
.ch-dot.unknown {
  background: var(--lab-text-mute);
}

/* 顶栏：半透明 + 毛玻璃，滚动时内容从下面透出来 */
.lab-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  height: 58px;
  line-height: 58px;
  background: var(--lab-header-bg);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--lab-border);
  position: sticky;
  top: 0;
  z-index: 10;
}
.lab-crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.crumb-root {
  color: var(--lab-text-mute);
}
.crumb-sep {
  color: var(--lab-border-strong);
}
.crumb-cur {
  color: var(--lab-text);
  font-weight: 600;
  font-family: var(--lab-display);
  letter-spacing: 0.3px;
}
.user-tag {
  border-radius: 999px;
  padding: 2px 12px;
  background: var(--lab-primary-dim);
  border-color: var(--lab-primary-line);
  color: var(--lab-primary);
  font-family: var(--lab-mono);
  font-size: 11.5px;
}

/* 内容区：给页面留一致的呼吸空间。宽屏上加大上边距，
   让 sticky 顶栏与首个卡片之间有一段明确的空气 */
.lab-content {
  margin: 20px;
}
@media (min-width: 1440px) {
  .lab-content {
    margin: 24px 28px 28px;
  }
}

/* 自动刷新选择器：窄一点，别把顶栏挤成两行 */
.refresh-select {
  width: 116px;
}
.refresh-tag {
  margin-inline-end: 0;
}

/* 阅读模式（P2-12）：**只改排版，不隐藏任何数据**。
   目标是「挂墙/投影时一眼看清数字」：收起侧栏、放大字号与关键数字、
   收紧表头与行的间隙。任何「为了清爽」而藏字段的做法都不在这里做——
   看板上少的那一列，就是下一次排障时的盲点。 */
.reading-mode :deep(.lab-content) {
  font-size: 15px;
}
.reading-mode :deep(.num) {
  font-size: 1.12em;
  letter-spacing: 0.2px;
}
.reading-mode :deep(.ant-table) {
  font-size: 13.5px;
}
.reading-mode :deep(.ant-table-tbody > tr > td) {
  padding-block: 10px;
}
.reading-mode :deep(.stat-value),
.reading-mode :deep(.block-label) {
  font-size: 13px;
}

/* 窄屏适配：面包屑只留当前页名，避免顶栏溢出 */
@media (max-width: 900px) {
  .lab-header {
    overflow-x: auto;
  }
  .crumb-root,
  .crumb-sep {
    display: none;
  }
}

@media (max-width: 640px) {
  .lab-content {
    margin: 12px;
  }
}


/* 主题切换按钮：太阳/月亮图标 + 极短标签。
   标签保留是因为纯图标在「自动」态下说不出当前是什么（图标只表达生效结果）。 */
.theme-btn {
  display: inline-flex;
  align-items: center;
}
.theme-btn-text {
  font-size: 12px;
  letter-spacing: 0.3px;
}
.theme-btn svg {
  display: block;
}
</style>
