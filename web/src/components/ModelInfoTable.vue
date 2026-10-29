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
        </template>
        <template v-else-if="channel === 'qoder'">
          倍率（price_factor）与上下文来自上游下发（{{ rows.length }} 个模型）·
          输出上限由网关下发
        </template>
        <template v-else-if="channel === 'qwenwork'">
          千问的模型表接口会 403，当前为静态表（{{ rows.length }} 个）
        </template>
        <template v-else>
          上游没有模型列表接口，这些名字来自探测（{{ rows.length }} 个）
        </template>
      </div>
      <a-space v-if="channel === 'traework' || channel === 'qoder'">
        <a-switch
          v-if="channel === 'traework'"
          v-model:checked="visibleOnly"
          size="small"
          checked-children="仅可见"
          un-checked-children="全部"
        />
        <a-select v-model:value="sort" size="small" style="width: 130px" :options="sortOptions" />
      </a-space>
    </div>

    <a-table
      size="small"
      :loading="loading"
      :scroll="{ x: 860 }"
      :pagination="rows.length > 20 ? { pageSize: 20, size: 'small', showSizeChanger: false } : false"
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

        <template v-else-if="column.key === 'name'">
          <div class="font-medium">
            {{ record.name }}
            <a-tag v-if="record.isDefault" color="blue" class="ml-1">默认</a-tag>
            <a-tag v-if="record.isNew" color="green" class="ml-1">新</a-tag>
            <a-tag v-if="record.isBeta" color="orange" class="ml-1">Beta</a-tag>
            <a-tag v-if="record.visible === false" color="default" class="ml-1">隐藏</a-tag>
          </div>
          <div class="text-xs text-slate-500 font-mono">{{ record.id }}</div>
          <div v-if="!record.native" class="text-xs text-slate-500">
            别名 → {{ record.target }}
          </div>
        </template>

        <template v-else-if="column.key === 'rate'">
          <!-- 倍率条：长度表达相对高低、数字给精确值。量程用当前列表最高倍率，
               固定量程在倍率整体偏低时全是短条，看不出差异 -->
          <div v-if="record.rate != null" class="rate-cell">
            <div class="rate-bar-wrap">
              <div class="rate-bar" :class="rateClass(record.rate)" :style="{ width: rateWidth(record.rate) }" />
            </div>
            <div class="rate-num num">{{ record.rate.toFixed(2) }}×</div>
          </div>
          <!-- Qoder 的错峰/免费模型 rate 就是 0，只显示 0 会被读成「完全不扣费」
               而它的原价（original_price_factor）其实是 0.1——两个一起给 -->
          <div v-if="record.rateOriginal != null && record.rateOriginal !== record.rate" class="text-xs text-slate-500">
            原价 {{ record.rateOriginal.toFixed(2) }}×
          </div>
          <!-- 拿不到就显示「—」并说明原因，**不估算**：
               编一个数字会让人以为真能按那个价扣 -->
          <a-tooltip v-else-if="record.rate == null" :title="rateHint">
            <span class="text-xs text-slate-500">— <span class="src-tag">无此数据</span></span>
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
            <span class="num">{{ compactNum(record.maxTokens) }}</span>
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
        </template>

        <template v-else-if="column.key === 'prefixed'">
          <span class="font-mono text-xs">{{ record.prefixed }}</span>
        </template>
      </template>
    </a-table>

    <div class="text-xs text-slate-500 mt-3">
      <span class="src-tag">上游</span> 接口下发 ·
      <span class="src-tag">实测</span> 本项目实测 ·
      <span class="src-tag">配置</span> 本地配置。
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
}>()

const rows = ref<ModelInfoRow[]>([])
const error = ref('')
const loading = ref(false)
const visibleOnly = ref(true)
const sort = ref<'rate-desc' | 'rate-asc' | 'name'>('rate-desc')
const sortOptions = [
  { label: '倍率 高→低', value: 'rate-desc' },
  { label: '倍率 低→高', value: 'rate-asc' },
  { label: '名称', value: 'name' },
]

const columns = [
  { title: '#', key: 'rank', width: '5%' },
  { title: '模型', key: 'name', width: '22%' },
  { title: '消耗倍率', key: 'rate', width: '16%' },
  // TRAE 有会员折扣，Qoder 没有——同一列按通道换标题，换成两套组件会各自漂移
  { title: props.channel === 'qoder' ? '档位属性' : '会员折扣', key: 'discount', width: '14%' },
  { title: '上下文', key: 'ctx', width: '13%' },
  { title: '输出上限', key: 'maxtok', width: '11%' },
  { title: '类型', key: 'cap', width: '9%' },
  { title: '调用前缀', key: 'prefixed', width: '10%' },
]

const rateHint = computed(() =>
  props.channel === 'dumate'
    ? '搭子没有倍率概念：计费在上游账单里，本地拿不到单价'
    : '上游未下发该模型的倍率',
)

const srcText = (s?: ModelFieldSource | null) =>
  s === 'upstream' ? '上游' : s === 'measured' ? '实测' : s === 'config' ? '配置' : '—'

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
