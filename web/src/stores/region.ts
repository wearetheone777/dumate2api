// web/src/stores/region.ts - 区域视图（国内版 / 国际版）
//
// TRAE 与 Qoder 各有国内、国际两套独立账号（不通用），页面按**区域整体
// 切换**：切到哪个区域，所有页面（仪表盘/账号/模型/测试台/用量/积分/日志/
// 登录态）都只显示那个区域的数据——不是混在一页里打标签。
// 搭子与千问是纯国内产品，没有区域概念，切换器对它们隐藏。
import { reactive } from 'vue'
import { channelStore } from '@/stores/channel'

export type LabRegion = 'cn' | 'intl'

const STORAGE_KEY = 'lab-region'

function initial(): LabRegion {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'cn' || saved === 'intl') return saved
  } catch {
    /* localStorage 不可用（隐私模式）时用默认值 */
  }
  return 'cn'
}

export const regionStore = reactive({
  current: initial() as LabRegion,

  set(r: LabRegion) {
    this.current = r
    try {
      localStorage.setItem(STORAGE_KEY, r)
    } catch {
      /* 存不下也不影响本次会话 */
    }
  },
})

/** 当前通道有没有区域概念（TRAE / Qoder / WorkBuddy 有；搭子与千问纯国内） */
export function hasRegion(id: string = channelStore.current): boolean {
  return id === 'traework' || id === 'qoder' || id === 'workbuddy'
}

/** 当前视图是不是国际版（模板里判断文案用） */
export function isIntlRegion(): boolean {
  return hasRegion() && regionStore.current === 'intl'
}

/**
 * 服务端区域筛选参数。后端各接口认 `?region=`（'cn' | 'intl'；
 * qoder 的接口同时认自己的 'global' 术语）。纯国内通道返回 undefined——
 * 不给接口塞它不认识的参数。
 */
export function regionParam(): 'cn' | 'intl' | undefined {
  if (!hasRegion()) return undefined
  return regionStore.current
}

/** 拼到 query 串里（已带其它参数时传 true 用 & 连接） */
export function regionQuery(prefixWithAmp = false): string {
  const r = regionParam()
  if (!r) return ''
  return `${prefixWithAmp ? '&' : ''}region=${r}`
}
