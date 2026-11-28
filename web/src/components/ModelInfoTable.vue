<template>
  <div>
    <a-alert
      v-if="error"
      type="warning"
      show-icon
      class="mb-3"
      :message="error"
    />

    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <div class="text-xs text-slate-500">
        <template v-if="channel === 'traework'">
          倍率与上下文来自上游下发（{{ rows.length }} 个模型）
          <span v-if="scope" class="block mt-1 text-[11px] text-slate-400">
            缓存作用域：账号 {{ scope.accountId || '（该区任意）' }} · function {{ scope.fn }} · v{{ scope.version }}
            · 指纹 {{ scope.id }}{{ cached ? ' · 命中缓存' : ' · 刚重取' }}
            <span v-if="merged" class="text-amber-600">· 多账号合并（能力取宽、上限取窄）</span>
            <span v-if="scopes && scopes.length > 1" class="ml-1">
              · 本区共 {{ scopes.length }} 份（{{
                scopes.map((x) => (x.accountId || '?') + '@' + ageText(x.ageMs) + (x.stale ? ' 已过期' : '')).join('、')
              }}）
            </span>
          </span>
        </template>
        <template v-else-if="channel === 'qoder'">
          倍率（price_factor）与上下文来自上游下发（{{ rows.length }} 个模型）·
          输出上限由网关下发
        </template>
        <template v-else-if="channel === 'qwenwork'">
          千问的模型表接口会 403，当前为静态表（{{ rows.length }} 个）
        </template>
        <template v-else>
          上游没有模型列表接口；真实后端与上限来自真机实测（{{ rows.length }} 个）
        </template>
      </div>
      <a-space v-if="channel === 'traework' || hasRate">
        <a-switch
          v-if="channel === 'traework'"
          v-model:checked="visibleOnly"
          size="small"
          checked-children="仅可见"
          un-checked-children="全部"
        />
        <!-- 清缓存重取：换了会员等级 / 新加账号后不必等 TTL 到期 -->
        <a-button v-if="channel === 'traework'" size="small" @click="emit('clear-cache')">
          清缓存重取
        </a-button>
        <!-- 排序：只要有倍率数据就给下拉。早先写死「TRAE / Qoder 才有」，
             结果搭子拿到 22 个实测倍率后反而没法排序（2026-11-15 用户反馈） -->
        <a-select v-if="hasRate" v-model:value="sort" size="small" style="width: 130px" :options="sortOptions" />
      </a-space>
    </div>

    <a-table
      size="small"
      :loading="loading"
      :scroll="{ x: 860 }"
      :pagination="rows.length > 30 ? { pageSize: 30, size: 'small', showSizeChanger: false } : false"
      :data-source="displayRows"
      :columns="columns"
      row-key="prefixed"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'rank'">
          <span v-if="record.rank" class="rank-badge" :class="record.rank <= 3 ? 'rank-top' : ''">
            {{ record.rank }}
          </span>
          <span v-else class="text-xs text-slate-500">—</span>
        </template>

        <template v-else-if="column.key === 'realModel'">
          <div class="font-mono text-xs">{{ record.backend || '—' }}</div>
          <!-- 同后端的其他调用名：让人一眼看出「这几个其实是同一个模型」 -->
          <div v-if="record.alsoKnownAs?.length" class="text-xs text-slate-500 mt-0.5">
            亦称 {{ record.alsoKnownAs.join(' / ') }}
          </div>
        </template>
        <template v-else-if="column.key === 'name'">
          <div class="font-medium">
            {{ record.name }}
            <a-tag v-if="record.isDefault" color="blue" class="ml-1">默认</a-tag>
            <a-tag v-if="record.isNew" color="green" class="ml-1">新</a-tag>
            <a-tag v-if="record.isBeta" color="orange" class="ml-1">Beta</a-tag>
            <a-tag v-if="record.visible === false" color="default" class="ml-1">隐藏</a-tag>
            <!-- P0-2：上游 enable=false 的模型（管理端仍列出，客户端 /v1/models 不给） -->
            <a-tooltip v-if="record.status === 'disabled'" :title="record.disabledReason || '上游模型表声明 enable=false'">
              <a-tag color="default" class="ml-1">上游禁用</a-tag>
            </a-tooltip>
            <!-- P0-2：第三方清单称已下线、本项目未真机复核。**不删条目**，
                 灰显提示；显式调用仍会透传给上游自己判 -->
            <a-tooltip v-else-if="record.retiredCandidate" title="第三方清单称已下线，本项目尚未真机复核；显式调用仍会透传，可用聊天测试台验证">
              <a-tag color="orange" class="ml-1">疑似下线</a-tag>
            </a-tooltip>
            <!-- 套餐门槛（P2-11）：只在上游 descriptor 显式声明时显示，
                 不按隐藏状态/模型名猜，也不伪装成风控错误 -->
            <a-tooltip v-if="record.upgradeRequired === true" title="上游模型目录明确标注需要升级套餐">
              <a-tag color="gold" class="ml-1">需升级</a-tag>
            </a-tooltip>
          </div>
          <div class="text-xs text-slate-500 font-mono">{{ record.id }}</div>
          <!-- 真实后端（搭子：X-Dumate-Gw-Realmodel 实测；其他通道上游直接给）
               ——请求的模型可能被服务端静默换掉，这一行是唯一真相 -->
          <div v-if="record.realModel" class="text-xs text-slate-500 font-mono">
            实跑 {{ record.realModel }}
          </div>
          <!-- 同后端的其他名字（后端已合并成一行）。列出来是为了「名字没丢」——
               用户仍能用这些名字调用，只是价格与主名相同，不值得单占一行 -->
          <div v-if="record.alsoKnownAs?.length" class="text-xs text-slate-400 font-mono">
            也叫 {{ record.alsoKnownAs.join(' / ') }}
          </div>
          <!-- target === id 时不是「别名」，是直传：桌面清单条目就属于这种，
               早先只判 !native 会显示成「别名 → 自己」，读起来像配错了 -->
          <div v-if="!record.native && record.target !== record.id" class="text-xs text-slate-500">
            别名 → {{ record.target }}
          </div>
          <div v-else-if="!record.native" class="text-xs text-slate-500">
            直传（桌面清单）
          </div>
        </template>

        <template v-else-if="column.key === 'rate'">
          <!-- 倍率条：长度表达相对高低、数字给精确值。量程用当前列表最高倍率，
               固定量程在倍率整体偏低时全是短条，看不出差异 -->
          <div v-if="record.rate != null" class="rate-cell">
            <div class="rate-bar-wrap">
              <div class="rate-bar" :class="rateClass(record.rate)" :style="{ width: rateWidth(record.rate) }" />
            </div>
            <!-- 搭子是实测口径（积分/千token），不是标称倍率（×）——单位混着
                 显示会让人拿它跟 TRAE/Qoder 的倍率比大小 -->
            <a-tooltip v-if="record.channel === 'dumate'" :title="record.rateNote || ''">
              <div class="rate-num num">
                {{ record.rate.toFixed(2) }}
                <span class="text-xs text-slate-500">{{ record.rateUnitText || '积分/千tok' }}</span>
              </div>
            </a-tooltip>
            <div v-else class="rate-num num">{{ record.rate.toFixed(2) }}×</div>
          </div>
          <!-- Qoder 的错峰/免费模型 rate 就是 0，只显示 0 会被读成「完全不扣费」
               而它的原价（original_price_factor）其实是 0.1——两个一起给 -->
          <div v-if="record.rateOriginal != null && record.rateOriginal !== record.rate" class="text-xs text-slate-500">
            原价 {{ record.rateOriginal.toFixed(2) }}×
          </div>
          <!-- 拿不到就显示「—」并说明原因，**不估算**：
               编一个数字会让人以为真能按那个价扣 -->
          <a-tooltip v-else-if="record.rate == null" :title="rateHint">
            <span class="text-xs text-slate-500">— <span class="src-tag">{{ channel === 'dumate' ? '未实测' : '无此数据' }}</span></span>
          </a-tooltip>
        </template>

        <template v-else-if="column.key === 'discount'">
          <template v-if="record.memberDiscount">
            <a-tag :color="record.discountMatched ? 'green' : 'default'">
              {{ record.memberDiscount }}% off
            </a-tag>
            <div class="text-xs text-slate-500 num">
              {{ record.rateOriginal }} → {{ record.rateDiscounted }}
            </div>
            <div class="text-xs" :class="record.discountMatched ? 'text-green-700' : 'text-slate-500'">
              {{ record.discountMatched ? '本账号已命中' : '未命中（按原价扣）' }}
            </div>
          </template>
          <!-- Qoder 没有会员折扣，这一列用来标「免费/推理」这类上游属性，
               不硬套 TRAE 的折扣语义 -->
          <template v-else-if="record.channel === 'qoder'">
            <a-tag v-if="record.isFree" color="cyan" class="mr-1">免费档</a-tag>
            <a-tag v-if="record.capability === 'reasoning_model'" color="purple">推理</a-tag>
            <!-- 错峰优惠：系数与时段是上游原值（discount_factor 的乘性方向
                 未实测，不解读成「x 折」）；无窗口期时不显示 -->
            <a-tag v-if="record.offPeak && record.offPeak.window" color="orange" class="mr-1">
              错峰 {{ record.offPeak.window }}{{ record.offPeak.discountFactor != null ? ` ×${record.offPeak.discountFactor}` : '' }}
            </a-tag>
            <span v-if="!record.isFree && record.capability !== 'reasoning_model' && !(record.offPeak && record.offPeak.window)" class="text-xs text-slate-500">—</span>
          </template>
          <span v-else class="text-xs text-slate-500">—</span>
        </template>

        <template v-else-if="column.key === 'ctx'">
          <!-- 实测硬限优先。上游下发的 context_window_tokens 是**客户端压缩阈值**，
               不是服务端上限：GLM-5.3-Flash / DeepSeek-V4.1-Flash 都声明 200K，
               实测 1M 输入照样 200。把声明值当上限展示会让人以为只能用 200K。 -->
          <template v-if="record.contextWindowHard">
            <div class="num">{{ compactNum(record.contextWindowHard) }}</div>
            <div class="text-xs text-slate-500">
              <span class="src-tag">实测</span>
            </div>
            <div v-if="record.contextWindow" class="text-xs text-slate-500">
              上游声明 {{ compactNum(record.contextWindow) }}
            </div>
            <a-tooltip v-if="record.contextNote" :title="record.contextNote">
              <div class="text-xs text-slate-500 ctx-note">实测说明</div>
            </a-tooltip>
          </template>
          <template v-else-if="record.contextWindow">
            <!-- 搭子给的是区间（32K 通过 / 128K 超时），只报单值会让人
                 以为上限真的能用满 -->
            <div class="num">
              <template v-if="record.contextWindowMin && record.contextWindowMin !== record.contextWindow">
                {{ compactNum(record.contextWindowMin) }} ~ {{ compactNum(record.contextWindow) }}
              </template>
              <template v-else>{{ compactNum(record.contextWindow) }}</template>
            </div>
            <div class="text-xs text-slate-500">
              <span class="src-tag">{{ srcText(record.contextSource) }}</span>
              <!-- TRAE 的这个值只是压缩阈值。没测过的模型必须标出来，
                   否则会被读成「上限就是这样」 -->
              <span v-if="record.channel === 'traework'" class="ml-1">压缩阈值 · 未实测</span>
            </div>
            <a-tooltip v-if="record.contextNote" :title="record.contextNote">
              <div class="text-xs text-slate-500 ctx-note">实测说明</div>
            </a-tooltip>
          </template>
          <span v-else class="text-xs text-slate-500">— <span class="src-tag">无此数据</span></span>
        </template>

        <template v-else-if="column.key === 'maxtok'">
          <template v-if="record.maxTokens">
            <a-tooltip v-if="record.maxTokensNote" :title="record.maxTokensNote">
              <span class="num">{{ compactNum(record.maxTokens) }}</span>
            </a-tooltip>
            <span v-else class="num">{{ compactNum(record.maxTokens) }}</span>
            <div class="text-xs text-slate-500">
              <span class="src-tag">{{ srcText(record.maxTokensSource) }}</span>
            </div>
          </template>
          <span v-else class="text-xs text-slate-500">—</span>
        </template>

        <template v-else-if="column.key === 'cap'">
          <a-tag v-if="record.capability === 'reasoning_model'" color="purple">推理</a-tag>
          <a-tag v-else-if="record.capability === 'chat_model'" color="blue">对话</a-tag>
          <span v-else class="text-xs text-slate-500">{{ record.capability || '—' }}</span>
          <div v-if="record.multimodal" class="text-xs text-slate-400">多模态</div>
          <!-- 搭子思考档位：清单里只有 deepseek-v41-flash 带 variants（四档实测口径） -->
          <div v-if="record.reasoningEfforts?.length" class="text-xs text-slate-400">
            档位 {{ record.reasoningEfforts.join('/') }}
          </div>
          <!-- verified === false 只出现在桌面清单条目上：名字存在但本仓没实测过 -->
          <a-tag v-if="record.verified === false" color="orange" class="mt-1">未实测</a-tag>
        </template>

        <template v-else-if="column.key === 'prefixed'">
          <span class="font-mono text-xs">{{ record.prefixed }}</span>
        </template>
      </template>
    </a-table>

    <div class="text-xs text-slate-500 mt-3">
      <span class="src-tag">上游</span> 接口下发 ·
      <span class="src-tag">实测</span> 本项目实测 ·
      <span class="src-tag">配置</span> 本地配置 ·
      <span class="src-tag">清单</span> 桌面客户端模型清单声明（未实测）。
      拿不到的字段显示「—」——<b>不估算</b>，因为一个编出来的上下文上限会让人
      以为真能用满，直到请求失败才发现。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import client from '@/api/client'
import { compactNum } from '@/utils/chartTheme'
import type { ModelFieldSource, ModelInfoRow } from '@/api/modelinfo'

const props = defineProps<{
  /** 要看哪条通道。缺省跟随当前通道 */
  channel: 'dumate' | 'qwenwork' | 'traework' | 'qoder'
  /** 外部传入的数据（模型页已按通道拉过时可复用，避免重复请求） */
  preloaded?: ModelInfoRow[] | null
  /**
   * 模型表缓存的**作用域**（2026-11-16 P0-1，只有 TRAE 有）。
   * 展示它是因为「能力判断错了」时必须能回答「这张表是谁取的」。
   */
  scope?: { id: string; accountId: string; fn: string; version: string } | null
  /** 该区缓存里的全部作用域（账号多了以后谁的表现在在被用） */
  scopes?: Array<{ id: string; accountId: string; fn: string; version: string; ageMs: number; stale: boolean; models: number }>
  /** 本次数据是命中缓存还是重取的 */
  cached?: boolean
  /** 行是由多个账号作用域合并出来的（能力取宽、上限取窄） */
  merged?: boolean
}>()

const emit = defineEmits<{ (e: 'clear-cache'): void }>()

/** 缓存年龄说人话：「12 分钟前」比时间戳有用 */
function ageText(ms: number) {
  const m = Math.max(0, Math.round((ms || 0) / 60000))
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  return `${Math.round(m / 60)} 小时前`
}

const rows = ref<ModelInfoRow[]>([])
const error = ref('')
const loading = ref(false)
const visibleOnly = ref(true)
const sort = ref<'rate-desc' | 'rate-asc' | 'name'>('rate-desc')
/** 有没有任何一行带倍率——决定排序下拉是否出现（搭子从 2026-11-15 起有实测倍率） */
const hasRate = computed(() => rows.value.some((r) => r.rate != null))
const sortOptions = [
  { label: '倍率 高→低', value: 'rate-desc' },
  { label: '倍率 低→高', value: 'rate-asc' },
  { label: '名称', value: 'name' },
]

const columns = computed(() => [
  { title: '#', key: 'rank', width: '5%' },
  { title: '模型', key: 'name', width: '20%' },
  // 搭子专用：多个模型名常指向同一个后端（model-text / deepseek-v41-flash /
  // dm-auto-model/*.L0 全是 deepseek-v4.1-flash）。不标出来会让人以为
  // 「有 20 个不同模型」，实际只有几个真后端。其他通道上游直接给模型表，
  // 模型名即后端，不需要这一列。
  ...(props.channel === 'dumate' ? [{ title: '真实后端', key: 'realModel', width: '18%' }] : []),
  // 搭子的数字是**实测积分成本**（积分/千 output token），不是标称倍率；
  // 表头带「（实测）」避免被当成官方价目表。排序下拉见左上角。
  { title: props.channel === 'dumate' ? '消耗倍率（实测）' : '消耗倍率', key: 'rate', width: '15%' },
  // TRAE 有会员折扣，Qoder 没有——同一列按通道换标题，换成两套组件会各自漂移
  { title: props.channel === 'qoder' ? '档位属性' : '会员折扣', key: 'discount', width: '13%' },
  { title: '上下文', key: 'ctx', width: '12%' },
  { title: '输出上限', key: 'maxtok', width: '10%' },
  { title: '类型', key: 'cap', width: '8%' },
  { title: '调用前缀', key: 'prefixed', width: '9%' },
])

const rateHint = computed(() =>
  props.channel === 'dumate'
    ? '未实测：搭子没有标称倍率，点上方「计费自检」可实测该列（积分/千token，7 天有效）；想一次测多个可用 node test/probe-dumate-rates.js'
    : '上游未下发该模型的倍率',
)

const srcText = (s?: ModelFieldSource | null) =>
  s === 'upstream' ? '上游'
    : s === 'measured' ? '实测'
      : s === 'config' ? '配置'
        : s === 'desktop' ? '清单' : '—'

const maxRate = computed(() => {
  const list = rows.value.map((m) => m.rate).filter((r): r is number => r != null)
  return list.length ? Math.max(...list) : 1
})
function rateWidth(rate: number) {
  const pct = maxRate.value > 0 ? (rate / maxRate.value) * 100 : 0
  // 最短留 4%，否则低倍率看起来像 0（会被读成「免费」）
  return `${Math.max(4, Math.min(100, pct))}%`
}
// 倍率分档着色：倍率是离散档位，连续色阶会暗示不存在的连续性
function rateClass(rate: number) {
  if (rate >= 0.7) return 'rate-high'
  if (rate >= 0.2) return 'rate-mid'
  return 'rate-low'
}

const displayRows = computed(() => {
  let list = props.channel === 'traework' && visibleOnly.value
    ? rows.value.filter((m) => m.visible !== false)
    : rows.value.slice()
  if (sort.value === 'rate-desc') list.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))
  else if (sort.value === 'rate-asc') list.sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity))
  else list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  // 排名只在按倍率排序时给——按名称排序还显示倍率位次会让人误读
  const out = list.map((m) => ({ ...m, rank: 0 }))
  if (sort.value === 'rate-desc' || sort.value === 'rate-asc') {
    let n = 0
    for (const m of out) if (m.rate != null) m.rank = ++n
  }
  return out
})

async function load() {
  // 已预载就直接用（模型页按通道拉过一份，不必再打一次）
  if (props.preloaded && props.preloaded.length) {
    rows.value = props.preloaded
    error.value = ''
    return
  }
  loading.value = true
  try {
    const { data } = await client.get('/models/info', { params: { channel: props.channel } })
    rows.value = data.rows || []
    error.value = data.error || ''
  } catch (e: any) {
    rows.value = []
    error.value = e?.response?.data?.error || e?.message || '取模型信息失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [props.channel, props.preloaded], load)
</script>

<style scoped>
/* 来源徽标：字段可信度不同，必须能一眼分辨哪个是上游给的 */
.src-tag {
  display: inline-block;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--lab-surface-3);
  color: var(--lab-text-mute);
  font-size: 10.5px;
  line-height: 16px;
}
.ctx-note {
  text-decoration: underline dotted;
  cursor: help;
}

.rank-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 7px;
  background: var(--lab-surface-3);
  color: var(--lab-text-sub);
  font-family: var(--lab-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.rank-badge.rank-top {
  background: var(--lab-primary-dim);
  color: var(--lab-primary);
  font-weight: 600;
}

.rate-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rate-bar-wrap {
  flex: 1;
  min-width: 40px;
  height: 6px;
  border-radius: 3px;
  background: var(--lab-surface-3);
  overflow: hidden;
}
.rate-bar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.rate-bar.rate-high { background: var(--lab-danger); }
.rate-bar.rate-mid { background: var(--lab-warn); }
.rate-bar.rate-low { background: var(--lab-ok); }
.rate-num {
  flex: none;
  font-size: 12.5px;
  color: var(--lab-text);
}
</style>
