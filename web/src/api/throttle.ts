// 通道风控参数（P1-9）：管理端读写 livecfg.json 里的 throttle 表。
//
// 为什么单独一个 api 文件而不是塞进 system.ts：system.ts 装的是网关/上游
// 状态这类只读探测，这里是**写运行策略**（与 traeruntime.ts 同定位）。
import client from './client'

/** 单个旋钮：面板值 + 环境变量值 + 生效值与来源 */
export interface ThrottleKnob {
  /** 面板值（null = 未设，回落 env → 兜底） */
  panel: number | null
  /** 环境变量值（null = 未设） */
  envValue: number | null
  /** 该旋钮对应的环境变量名（界面要能告诉用户「改这个 env 也行」） */
  env: string
  /** 生效值来源 */
  source: 'panel' | 'env' | 'default'
  /** 解析出的值；null = 交给兜底（此时看 fallback/effective） */
  value: number | null
  /** 兜底值（池默认 4 / 0 / repair 默认 1） */
  fallback: number
  /** 界面真正该显示的生效值 = value ?? fallback */
  effective: number
}

export interface ThrottleChannel {
  channel: string
  label: string
  knobs: {
    inflightMax: ThrottleKnob
    minIntervalMs: ThrottleKnob
    retryMax: ThrottleKnob
  }
}

/** 内联图片上限与压缩（P1-6）：字节上限 0 = 不限；maxEdge 是长边像素，0 = 不缩。 */
export interface ImageBudget {
  maxBytes: number
  maxTotalBytes: number
  maxEdge: number
  source: {
    maxBytes: 'panel' | 'env' | 'default'
    maxTotalBytes: 'panel' | 'env' | 'default'
    maxEdge: 'panel' | 'env' | 'default'
  }
  panel: { maxBytes: number; maxTotalBytes: number; maxEdge: number }
  env: { maxBytes: string; maxTotalBytes: string; maxEdge: string }
  /** 压缩结果缓存（键=原图指纹）。命中率低说明缓存没用，清掉即可 */
  cache: { entries: number; bytes: number; cap: number; hits: number; misses: number }
}

export interface ThrottleSnapshot {
  ok: boolean
  file: string
  throttleMaxMs: { value: number; source: 'panel' | 'env' | 'default'; panel: number; envValue: number | null }
  throttleMaxMsEnv: string
  fallback: { inflightMax: number; minIntervalMs: number; retryMax: number }
  channels: ThrottleChannel[]
  imageBudget: ImageBudget
}

/** patch 语义：{通道: {旋钮: 数值|null}}；null = 清该项；{通道: null} = 整条重置 */
export type ThrottlePatch = {
  throttle?: Record<string, Record<string, number | null> | null>
  throttleMaxMs?: number
  /** 字节；0 = 不限 */
  imageBudget?: { maxBytes?: number; maxTotalBytes?: number; maxEdge?: number }
}

export const throttleApi = {
  async get() {
    return client.get<ThrottleSnapshot>('/system/throttle')
  },
  async save(patch: ThrottlePatch) {
    return client.put('/system/config', patch)
  },
  /** 清图片压缩缓存（改了 maxEdge 之后必须清，否则旧结果仍按原图指纹命中） */
  async clearImageCache() {
    return client.post<{ ok: boolean; cleared: number }>('/system/image-cache/clear', {})
  },
  /** 通道级人工恢复：只复位 ${channel}: 前缀的账号 */
  async revive(channel: string) {
    return client.post<{ ok: boolean; channel: string; label: string; revived: number; sick: number; total: number }>(
      '/system/pool-revive',
      { channel },
    )
  },
}

export default throttleApi
