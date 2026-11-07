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

// 通道定义。新增通道只需在这里加一条 + 后端 channels 里报出来。
// menuKeys 是该通道**有意义**的菜单：搭子有账号池/积分/密钥，千问没有——
// 与其让用户点进去看到一片空，不如直接隐藏。
export const CHANNELS = [
  {
    id: 'dumate',
    label: '百度搭子',
    menuKeys: ['dashboard', 'chatlab', 'usage', 'reqlogs', 'models', 'keys', 'account', 'points', 'web-accounts', 'alerts'],
  },
  {
    id: 'qwenwork',
    label: '千问办公',
    // 千问办公：单账号直连，没有「任务记录」（无签到/抽奖任务）。
    // 账号管理先只读展示当前账号，后续接入多账号再开放写入。
    menuKeys: ['dashboard', 'chatlab', 'usage', 'reqlogs', 'models', 'keys', 'account', 'points', 'web-accounts', 'alerts'],
  },
  {
    id: 'traework',
    label: 'TRAE Work',
    // TRAE Work：凭证自持（OAuth 换取），有签到体系，但积分结构与搭子不同
    // （是 credits 而非额度包），所以不显示搭子的「任务记录」。
    menuKeys: ['dashboard', 'chatlab', 'usage', 'reqlogs', 'models', 'keys', 'account', 'points', 'web-accounts', 'alerts'],
  },
  {
    id: 'qoder',
    label: 'Qoder',
    // Qoder：凭证自持（device flow 自取），与 TRAE 同构——多账号、有签到、
    // 单一 credits 结构。签名纯本地，不需要任何客户端。
    menuKeys: ['dashboard', 'chatlab', 'usage', 'reqlogs', 'models', 'keys', 'account', 'points', 'web-accounts', 'alerts'],
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    // WorkBuddy：第五通道（2026-11-03），标准 OpenAI 协议 + 双区域账号
    // （国内 copilot.tencent.com / 国际 workbuddy.ai）。凭证自持（登录流程
    // 后置期从客户端认证文件导入），有签到（仅国内版）。
    menuKeys: ['dashboard', 'chatlab', 'usage', 'reqlogs', 'models', 'keys', 'account', 'points', 'web-accounts', 'alerts'],
  },
] as const

export function channelLabel(id: string): string {
  const c = CHANNELS.find((x) => x.id === id)
  return c ? c.label : id
}

/**
 * 当前通道是不是「直连型」（千问办公 / TRAE Work）。
 *
 * 这两个通道与搭子的账单模型完全不同（搭子用上游账单+余额游标，
 * 直连通道用各自的积分池），所以界面上凡是要区分「看哪套账」的地方，
 * 都用这个判定而不是逐个比对 id——否则加一条通道就要改八个页面。
 */
export function isDirectChannel(id: string = channelStore.current): boolean {
  return id === 'qwenwork' || id === 'traework' || id === 'qoder' || id === 'workbuddy'
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
 */
export function channelParam(): 'dumate' | 'qwenwork' | 'traework' | 'qoder' | 'workbuddy' {
  const id = channelStore.current
  if (id === 'qwenwork' || id === 'traework' || id === 'qoder' || id === 'workbuddy') return id
  return 'dumate'
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
