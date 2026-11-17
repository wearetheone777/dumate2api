<template>
  <div class="page">
    <PageHeader title="通道风控" sub="并发帽 / 账号间隔 / 短故障重试 / 限流冷却上限 — 保存即热生效">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
        <a-button v-if="isAdmin" type="primary" size="small" :loading="saving" @click="save">保存</a-button>
      </template>
    </PageHeader>

    <a-alert type="info" show-icon class="mb-3">
      <template #message>优先级：本页面板 &gt; 环境变量 &gt; 内置默认</template>
      <template #description>
        落 <code>{{ file || 'data/livecfg.json' }}</code>，四个网关进程按 mtime 热读，<b>不需要重启</b>。
        三列的 <b>0 语义不同</b>：并发帽填 0 = 没设（回落到环境变量/池默认 4）；
        间隔与重试填 0 = <b>显式关断</b>（穿透环境变量）。清空输入框 = 删除该项配置。
      </template>
    </a-alert>

    <a-card :bordered="false" title="按通道" class="mb-4">
      <a-table
        size="small"
        :pagination="false"
        row-key="channel"
        :data-source="rows"
        :columns="columns"
        :loading="loading"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'inflightMax'">
            <a-input-number
              :value="panelOf(record.channel, 'inflightMax')"
              :min="0"
              :disabled="!isAdmin"
              :placeholder="String(record.knobs.inflightMax.fallback)"
              style="width: 100%"
              @change="(v: any) => setPanel(record.channel, 'inflightMax', v)"
            />
            <SourceLine :knob="record.knobs.inflightMax" />
          </template>
          <template v-else-if="column.key === 'minIntervalMs'">
            <a-input-number
              :value="panelOf(record.channel, 'minIntervalMs')"
              :min="0"
              :step="100"
              :disabled="!isAdmin"
              :placeholder="'0（关）'"
              style="width: 100%"
              @change="(v: any) => setPanel(record.channel, 'minIntervalMs', v)"
            />
            <SourceLine :knob="record.knobs.minIntervalMs" />
          </template>
          <template v-else-if="column.key === 'retryMax'">
            <a-input-number
              :value="panelOf(record.channel, 'retryMax')"
              :min="0"
              :disabled="!isAdmin"
              :placeholder="String(record.knobs.retryMax.fallback)"
              style="width: 100%"
              @change="(v: any) => setPanel(record.channel, 'retryMax', v)"
            />
            <SourceLine :knob="record.knobs.retryMax" />
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-space>
              <a-button size="small" danger ghost :loading="reviving === record.channel" @click="revive(record.channel)">
                恢复本通道
              </a-button>
              <a-button v-if="isAdmin" size="small" class="ghost-btn" @click="resetChannel(record.channel)">重置</a-button>
            </a-space>
          </template>
        </template>
      </a-table>
      <div class="text-xs text-slate-400 mt-2">
        「恢复本通道」只复位 <code>{{ '<通道>:' }}</code> 前缀的账号（清冷却 + 熔断 + 禁用 + 暂停），
        不动其它通道——四通道共用一台池，但故障原因是各自上游给的。
        并发帽按<b>账号</b>计（单号在途请求数），不是整条通道的并发。
      </div>
    </a-card>

    <a-card :bordered="false" title="内联图片上限（P1-6）" class="mb-4">
      <div class="space-y-2 max-w-3xl">
        <div class="grid gap-3" style="grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))">
          <label class="field-line">
            <span class="text-xs text-slate-400">单张上限（MB，0 = 不限）</span>
            <a-input-number
              v-model:value="imageForm.maxMb"
              :min="0"
              :step="1"
              :disabled="!isAdmin"
              style="width: 160px"
              :placeholder="String(effectiveMb('maxBytes'))"
            />
          </label>
          <label class="field-line">
            <span class="text-xs text-slate-400">长边上限（px，0 = 不缩）</span>
            <a-input-number
              v-model:value="imageForm.maxEdge"
              :min="0"
              :step="128"
              :disabled="!isAdmin"
              style="width: 160px"
              placeholder="如 1568"
            />
          </label>
          <label class="field-line">
            <span class="text-xs text-slate-400">单请求合计上限（MB，0 = 不限）</span>
            <a-input-number
              v-model:value="imageForm.totalMb"
              :min="0"
              :step="1"
              :disabled="!isAdmin"
              style="width: 160px"
              :placeholder="String(effectiveMb('maxTotalBytes'))"
            />
          </label>
        </div>
        <div class="text-xs text-slate-500">
          生效：单张 <b class="num">{{ imageBytesFmt(imageBudget.maxBytes) }}</b>
          <a-tag :color="sourceColor(imageBudget.source.maxBytes)" style="margin-left: 6px">{{ sourceLabel(imageBudget.source.maxBytes) }}</a-tag>
          · 合计 <b class="num">{{ imageBytesFmt(imageBudget.maxTotalBytes) }}</b>
          <a-tag :color="sourceColor(imageBudget.source.maxTotalBytes)" style="margin-left: 6px">{{ sourceLabel(imageBudget.source.maxTotalBytes) }}</a-tag>
        </div>
        <div class="text-xs text-slate-400">
          长边上限开启后，超限的内联 <b>PNG</b> 会被就地缩到该长边并重编码（纯 JS + zlib，面积平均）。
          结果按原图指纹缓存——会话历史每轮都重发同一张图，没有缓存等于每轮重算。
          <b>JPEG 不缩</b>（要 huffman 解码，另开一批），仍按上限判定。
        </div>
        <div class="text-xs text-slate-500">
          缓存：{{ imageBudget.cache.entries }} 条 / {{ imageBytesFmt(imageBudget.cache.bytes) }}
          （上限 {{ imageBytesFmt(imageBudget.cache.cap) }}）· 命中 {{ imageBudget.cache.hits }} / 未命中 {{ imageBudget.cache.misses }}
          <a-button size="small" class="ghost-btn" style="margin-left: 8px" :loading="clearingCache" @click="clearImageCache">
            清缓存
          </a-button>
        </div>
        <div class="text-xs text-slate-400">
          默认<b>不限</b>，只在超限时回 413 并说清「哪一张、多大、上限多少、怎么办」。
          体量统计<b>始终记录</b>（请求日志详情里有「内联图片」一行），外链图只计数不判上限——
          大小在上游手里。<b>本批不做压缩</b>，缩长边与重编码要另接编解码器。
        </div>
      </div>
    </a-card>

    <a-card :bordered="false" title="限流冷却上限（全局）">
      <div class="space-y-2 max-w-3xl">
        <div class="flex items-center gap-3">
          <a-input-number
            v-model:value="throttleMaxMsPanel"
            :min="0"
            :step="10000"
            :disabled="!isAdmin"
            style="width: 180px"
            :placeholder="String(throttleMaxMs.effective || 600000)"
          />
          <span class="text-xs text-slate-400">毫秒。上游按自己的队列长度给等待时长（实测给过 7015 秒），这里封顶。</span>
        </div>
        <div class="text-xs text-slate-500">
          生效 <b class="num">{{ throttleMaxMs.effective }}</b> ms
          <a-tag :color="sourceColor(throttleMaxMs.source)" style="margin-left: 8px">{{ sourceLabel(throttleMaxMs.source) }}</a-tag>
          <span class="ml-2">环境变量 <code>{{ throttleMaxMsEnv }}</code> = {{ throttleMaxMs.envValue ?? '未设' }}</span>
        </div>
        <div class="text-xs text-slate-400">
          下限 1000ms：填 0 或极小值会被抬到 1000 —— 封顶变 0 等于关掉封顶，上游给的 7015 秒会照单全收。
        </div>
      </div>
    </a-card>
  </div>
</template>

<script setup lang="ts">
// 通道风控（调研 P1-9）：把三平台风控设置里真正会影响上游行为的三项搬上台面。
//
// 为什么要有「来源」这一列：同一个旋钮有面板 / 环境变量 / 内置默认三个来源，
// 只在界面上显示一个数字时，「我明明填了 2 怎么还是 4」无从归因。这里每一行
// 都显示生效值与来源，并有「重置」回到 env/默认。
import { computed, defineComponent, h, onMounted, reactive, ref } from 'vue'
import { App } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import { throttleApi } from '@/api/throttle'
import type { ThrottleChannel, ThrottleKnob, ThrottleSnapshot } from '@/api/throttle'
import { isAdmin } from '@/stores/auth'

const { message } = App.useApp()
const loading = ref(false)
const saving = ref(false)
const reviving = ref('')
const file = ref('')
const channels = ref<ThrottleChannel[]>([])
const throttleMaxMs = reactive({ effective: 600000, source: 'default' as ThrottleKnob['source'], envValue: null as number | null })
const throttleMaxMsEnv = ref('DUMATE_THROTTLE_MAX_MS')
const throttleMaxMsPanel = ref<number | null>(null)
/** 图片上限（面板按 MB 编辑，提交时换成字节——后端面板值统一用字节） */
const imageForm = reactive({ maxMb: 0 as number | null, totalMb: 0 as number | null, maxEdge: 0 as number | null })
const clearingCache = ref(false)
const imageBudget = reactive({
  maxBytes: 0,
  maxTotalBytes: 0,
  maxEdge: 0,
  source: {
    maxBytes: 'default' as 'panel' | 'env' | 'default',
    maxTotalBytes: 'default' as 'panel' | 'env' | 'default',
    maxEdge: 'default' as 'panel' | 'env' | 'default',
  },
  cache: { entries: 0, bytes: 0, cap: 0, hits: 0, misses: 0 },
})

/** 面板里要提交的值：通道 → 旋钮 → 数值 | null */
const panel = reactive<Record<string, Record<string, number | null>>>({})

const columns = [
  { title: '通道', dataIndex: 'label', key: 'label', width: 130 },
  { title: '在途并发帽（每账号）', key: 'inflightMax', width: 200 },
  { title: '账号最小间隔', key: 'minIntervalMs', width: 200 },
  { title: '短故障重试次数', key: 'retryMax', width: 200 },
  { title: '操作', key: 'ops', width: 200 },
]

const rows = computed(() => channels.value)

/** 生效值 + 来源的一行小字（每个单元格下方） */
const SourceLine = defineComponent({
  props: { knob: { type: Object, required: true } },
  setup(props) {
    return () => {
      const k = props.knob as ThrottleKnob
      return h('div', { class: 'text-xs mt-1' }, [
        h('span', { class: 'text-slate-400' }, '生效 '),
        h('b', { class: 'num' }, String(k.effective)),
        h('span', { class: 'text-slate-400', style: 'margin-left:6px' }, `（${sourceLabel(k.source)}）`),
        k.source !== 'panel' && k.panel !== null
          ? h('span', { class: 'text-orange-500', style: 'margin-left:6px' }, '面板值未生效')
          : null,
        k.envValue !== null && k.source !== 'env'
          ? h('div', { class: 'text-slate-400' }, `${k.env} = ${k.envValue}（被面板覆盖）`)
          : null,
      ])
    }
  },
})

function sourceLabel(s: ThrottleKnob['source']) {
  if (s === 'panel') return '本页面板'
  if (s === 'env') return '环境变量'
  return '内置默认'
}
/** 生效值换算成 MB 显示（面板用 MB 编辑，后端存字节） */
function effectiveMb(k: 'maxBytes' | 'maxTotalBytes') {
  const v = imageBudget[k]
  if (!v) return 0
  return Math.round((v / (1024 * 1024)) * 100) / 100
}

/** 字节 → 人眼可读（与请求日志详情同口径） */
function imageBytesFmt(n?: number | null) {
  const v = Number(n || 0)
  if (!v) return '不限'
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(v / 1024)} KB`
}

function sourceColor(s: ThrottleKnob['source']) {
  if (s === 'panel') return 'blue'
  if (s === 'env') return 'orange'
  return 'default'
}

function panelOf(channel: string, knob: string): number | null {
  const row = panel[channel]
  return row && knob in row ? (row[knob] as number | null) : null
}

function setPanel(channel: string, knob: string, v: any) {
  if (!panel[channel]) panel[channel] = {}
  panel[channel][knob] = v === null || v === undefined || v === '' ? null : Number(v)
}

/** 上次保存/加载时的长边值：改了就顺手清缓存（键不含参数，不清会命中旧结果） */
let lastMaxEdge = 0

async function clearImageCache() {
  clearingCache.value = true
  try {
    const { data } = await throttleApi.clearImageCache()
    message.success(`已清 ${data.cleared} 条压缩缓存`)
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '清缓存失败')
  } finally { clearingCache.value = false }
}

function resetChannel(channel: string) {
  if (!panel[channel]) panel[channel] = {}
  for (const k of ['inflightMax', 'minIntervalMs', 'retryMax']) panel[channel][k] = null
  message.info(`${channel} 已标记为重置，点「保存」后生效`)
}

async function load() {
  loading.value = true
  try {
    const { data } = await throttleApi.get() as { data: ThrottleSnapshot }
    file.value = data.file || ''
    channels.value = data.channels || []
    throttleMaxMs.effective = data.throttleMaxMs?.value ?? 600000
    throttleMaxMs.source = data.throttleMaxMs?.source ?? 'default'
    throttleMaxMs.envValue = data.throttleMaxMs?.envValue ?? null
    throttleMaxMsEnv.value = data.throttleMaxMsEnv || 'DUMATE_THROTTLE_MAX_MS'
    throttleMaxMsPanel.value = data.throttleMaxMs?.panel ? data.throttleMaxMs.panel : null
    const ib = data.imageBudget
    if (ib) {
      imageBudget.maxBytes = ib.maxBytes || 0
      imageBudget.maxTotalBytes = ib.maxTotalBytes || 0
      imageBudget.maxEdge = ib.maxEdge || 0
      imageBudget.source.maxBytes = ib.source?.maxBytes || 'default'
      imageBudget.source.maxTotalBytes = ib.source?.maxTotalBytes || 'default'
      imageBudget.source.maxEdge = ib.source?.maxEdge || 'default'
      if (ib.cache) Object.assign(imageBudget.cache, ib.cache)
      imageForm.maxEdge = ib.panel?.maxEdge ? ib.panel.maxEdge : null
      lastMaxEdge = Number(imageForm.maxEdge) || 0
      // 面板里回填的是**面板值**（0 表示没设），不是生效值——否则「没设」会被
      // 回填成 env 的值，用户一保存就把它固化成了面板值
      imageForm.maxMb = ib.panel?.maxBytes ? Math.round((ib.panel.maxBytes / (1024 * 1024)) * 100) / 100 : null
      imageForm.totalMb = ib.panel?.maxTotalBytes ? Math.round((ib.panel.maxTotalBytes / (1024 * 1024)) * 100) / 100 : null
    }
    for (const ch of channels.value) {
      if (!panel[ch.channel]) panel[ch.channel] = {}
      for (const k of ['inflightMax', 'minIntervalMs', 'retryMax'] as const) {
        panel[ch.channel][k] = ch.knobs[k].panel
      }
    }
  } catch (e: any) {
    message.error(e?.response?.data?.error || '读取风控参数失败')
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const throttle: Record<string, Record<string, number | null>> = {}
    for (const ch of channels.value) {
      throttle[ch.channel] = {
        inflightMax: panelOf(ch.channel, 'inflightMax'),
        minIntervalMs: panelOf(ch.channel, 'minIntervalMs'),
        retryMax: panelOf(ch.channel, 'retryMax'),
      }
    }
    const patch: any = { throttle }
    // 0 在本项同样表示「未设」；null 与 0 都回落到 env/默认
    patch.throttleMaxMs = throttleMaxMsPanel.value ? Number(throttleMaxMsPanel.value) : 0
    patch.imageBudget = {
      maxBytes: imageForm.maxMb ? Math.round(Number(imageForm.maxMb) * 1024 * 1024) : 0,
      maxTotalBytes: imageForm.totalMb ? Math.round(Number(imageForm.totalMb) * 1024 * 1024) : 0,
      maxEdge: imageForm.maxEdge ? Math.round(Number(imageForm.maxEdge)) : 0,
    }
    // 改了长边就必须清缓存：缓存键是**原图指纹**、不含参数，不清会一直命中旧结果
    if ((Number(imageForm.maxEdge) || 0) !== lastMaxEdge) {
      try { await throttleApi.clearImageCache() } catch (e) { /* 清不掉不影响保存本身 */ }
    }
    await throttleApi.save(patch)
    message.success('已保存，即时生效（网关按 mtime 重读，无需重启）')
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function revive(channel: string) {
  reviving.value = channel
  try {
    const { data } = await throttleApi.revive(channel)
    if (data.sick === 0) message.info(`${data.label}：没有需要复位的账号（共 ${data.total} 个）`)
    else message.success(`${data.label}：已复位 ${data.revived}/${data.sick} 个账号`)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '复位失败')
  } finally {
    reviving.value = ''
  }
}

onMounted(load)
</script>
