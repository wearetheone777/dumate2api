// web/src/stores/channel.ts - 全局通道切换
//
// 项目有两个上游通道（搭子 / 千问办公），后续还可能加。这个 store 管
// 「当前在看哪个通道」，各页面据此决定显示什么、请求哪个接口。
//
// 为什么是全局状态而不是各页面各存一份：切换通道是**跨页面的上下文**——
// 在仪表盘切到千问，进请求日志也该是千问。各页自存会出现「仪表盘看千问、
// 日志看搭子」这种自相矛盾的状态。
//
// 选择持久化到 localStorage：刷新后保持，否则每次刷新都跳回搭子。
import { reactive, computed } from 'vue'
import client from '@/api/client'
// 通道能力声明的单一来源（批次二十二）：仓库根 channels.def.json，后端
// src/channels.js require 同一份——同一事实两处各写一份迟早不一致。
// vite 原生支持 JSON import；改通道清单/能力位只改 JSON 一处。
import DEF from '@def/channels'

export interface ChannelInfo {
  id: string
  label: string
  kind: 'http' | 'direct'
  ready: boolean
  port?: number | null
  managed?: boolean
  wasm?: string | null
  loggedIn?: boolean
  error?: string
  account?: string
  tier?: string
  tokenExpiresAt?: string | null
  refreshExpiresAt?: string | null
  refreshExpired?: boolean
  /** refresh token 临期（<24h）预警。目前只有千问 /status 给 */
  refreshExpiringSoon?: boolean
  /** ACP 链路上游实定档位（千问 /status；无 ACP 会话为 null） */
  acpMode?: string | null
  /** 账号数。TRAE Work 是多账号自持凭证，徽标与仪表盘要显示「可用几个」 */
  accounts?: number
  /**
   * 搭子的凭证回落状态（桌面凭证不可用时自动走网页池，见 fallback-web.js）。
   * 只有搭子通道有——直连通道没有「桌面/网页」两套凭证。
   * `available` 才决定「回落能不能救」，`ready` 只说明桌面凭证本身。
   */
  fallback?: { enabled: boolean; available: boolean } | null
}

const STORAGE_KEY = 'lab-channel'

/** 能力位（与 channels.def.json 的 capabilities 字段一一对应） */
export interface ChannelCaps {
  checkin: boolean
  credits: boolean
  growth: boolean
  media: boolean
  search: boolean
  regions: string[]
}

export interface ChannelDef {
  id: string
  label: string
  kind: 'http' | 'direct'
  capabilities: ChannelCaps
}

// JSON import 的类型是宽泛的 JsonValue，这里收敛成强类型（字段缺失/写错在
// vue-tsc 处不报——所以后端有 channels-caps 测试锁声明文件的形状）
export const CHANNEL_DEFS = DEF.channels as unknown as ChannelDef[]

const defOf = (id: string): ChannelDef | null => CHANNEL_DEFS.find((c) => c.id === id) || null

/**
 * 菜单白名单从能力位派生（批次二十二）：credits → 「积分明细」，其余菜单
 * 所有通道都有。派生顺序必须与历史 menuKeys 数组逐位一致（dashboard →
 * chatlab → usage → reqlogs → models → keys → account → points →
 * web-accounts → alerts），否则侧栏顺序会悄悄变。
 */
function menuKeysFor(c: ChannelDef): string[] {
  const keys = ['dashboard', 'chatlab', 'usage', 'reqlogs', 'models', 'keys', 'account']
  if (c.capabilities.credits) keys.push('points')
  keys.push('web-accounts', 'alerts')
  return keys
}

// 通道定义。新增通道只在 channels.def.json 加一条，这里与后端 channels.js
// 自动跟随——不再各自维护一份清单。
export const CHANNELS = CHANNEL_DEFS.map((c) => ({
  id: c.id,
  label: c.label,
  menuKeys: menuKeysFor(c),
}))

export function channelLabel(id: string): string {
  const c = CHANNELS.find((x) => x.id === id)
  return c ? c.label : id
}

/**
 * 当前通道是不是「直连型」（千问办公 / TRAE Work）。
 *
 * 直连通道与搭子的账单模型完全不同（搭子用上游账单+余额游标，
 * 直连通道用各自的积分池），所以界面上凡是要区分「看哪套账」的地方，
 * 都用这个判定而不是逐个比对 id——kind 从 channels.def.json 的声明读
 * （批次二十二），加通道不再改判定函数。
 */
export function isDirectChannel(id: string = channelStore.current): boolean {
  const c = defOf(id)
  return !!c && c.kind === 'direct'
}

/** 当前通道是否具备某能力位（批次二十二：能力位是声明不是分支） */
export function channelCan(cap: keyof ChannelCaps, id: string = channelStore.current): boolean {
  const c = defOf(id)
  return !!c && c.capabilities[cap] === true
}

/**
 * 当前是不是 TRAE Work。
 *
 * 千问与 TRAE 都是直连通道（账单与搭子不同，用 isDirectChannel 判定），
 * 但两者**彼此也不同**：千问是单账号只读、三个积分池；TRAE 是多账号自持
 * 凭证、单一 credits + 签到。所以页面在「非搭子」的骨架里还要再分一次。
 */
export function isTraework(id: string = channelStore.current): boolean {
  return id === 'traework'
}

export function isQwenwork(id: string = channelStore.current): boolean {
  return id === 'qwenwork'
}

/** 当前是不是 Qoder。与 TRAE 同构（多账号 + 签到 + 单一 credits） */
export function isQoder(id: string = channelStore.current): boolean {
  return id === 'qoder'
}

/** 当前是不是 WorkBuddy（第五通道，双区域） */
export function isWorkBuddy(id: string = channelStore.current): boolean {
  return id === 'workbuddy'
}

/**
 * 服务端通道筛选参数。usage / reqlogs / keys 三个接口都按它过滤，
 * 默认搭子——不传就返回全通道，卡片与表格会对不上。
 * 有效性从声明表判（不在清单里的 id 归搭子，与后端 normalize 同语义）。
 */
export function channelParam(): 'dumate' | 'qwenwork' | 'traework' | 'qoder' | 'workbuddy' {
  const id = channelStore.current
  return defOf(id) ? (id as 'dumate' | 'qwenwork' | 'traework' | 'qoder' | 'workbuddy') : 'dumate'
}

function initial(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && CHANNELS.some((c) => c.id === saved)) return saved
  } catch {
    /* localStorage 不可用（隐私模式）时用默认值 */
  }
  return 'dumate'
}

export const channelStore = reactive({
  current: initial(),
  // 后端报回的通道状态（含就绪、wasm 版本、登录态到期）
  infos: {} as Record<string, ChannelInfo>,
  loaded: false,

  set(id: string) {
    if (!CHANNELS.some((c) => c.id === id)) return
    this.current = id
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* 存不下也不影响本次会话 */
    }
  },

  async load() {
    try {
      // 区域视图（2026-11-03）：通道状态卡也按当前区域出——不带 region 时
      // TRAE/Qoder/WorkBuddy 的 accounts 是全量的，国际视图里会显示国内账号
      // （bsk 真机点击切换时抓到的 bug）。动态 import 避免 store 循环依赖。
      let rq = ''
      try {
        const { regionParam } = await import('@/stores/region')
        const r = regionParam()
        if (r) rq = `?region=${r}`
      } catch {
        /* region store 不可用（模块初始化早期）就不带 */
      }
      const { data } = await client.get(`/system/status${rq}`)
      this.infos = data?.channels || {}
      this.loaded = true
    } catch {
      // 状态拉不到不影响切换本身，只是徽标不显示
      this.loaded = false
    }
    return this.infos
  },

  /** 当前通道的菜单白名单 */
  menuKeys(): readonly string[] {
    const c = CHANNELS.find((x) => x.id === this.current)
    return c ? c.menuKeys : CHANNELS[0].menuKeys
  },

  info(): ChannelInfo | null {
    return this.infos[this.current] || null
  },

  /** 通道是否可用（用于顶栏徽标着色） */
  ready(): boolean {
    const i = this.info()
    return !!i && i.ready
  },

  /** 该通道是否有需要提醒的问题（就绪但登录态将失效，或未就绪） */
  warning(): string {
    const i = this.info()
    if (!i) return ''
    if (!i.ready) {
      // 与 MainLayout 的 titleFor 同口径：回落可用时请求仍能成功，不是「不可用」
      if (i.fallback?.available) return '桌面凭证失效，请求走网页凭证池'
      return i.error || '通道不可用'
    }
    if (i.refreshExpired) return 'refresh token 已过期，需重开客户端登录'
    return ''
  },
})

export const currentChannel = computed(() => channelStore.current)
