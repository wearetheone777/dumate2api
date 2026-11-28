<template>
  <div class="page">
    <PageHeader title="存储管理" sub="data/ 目录体量四类视图：凭证与配置只读，流水与缓存先预览再清理">
      <template #actions>
        <a-space>
          <span v-if="snap" class="text-xs text-slate-400">
            {{ snap.cached ? `缓存于 ${fmtTime(snap.generatedAt)}（${Math.round(snap.ttlMs / 1000)}s 内切页不重扫）` : `扫描于 ${fmtTime(snap.generatedAt)}` }}
          </span>
          <a-button size="small" :loading="loading" @click="load(true)">重新扫描</a-button>
        </a-space>
      </template>
    </PageHeader>

    <a-alert type="info" show-icon>
      <template #message>这里是「回收空间」的入口，不是「删配置」的入口</template>
      <template #description>
        <div v-for="(w, i) in snap?.warnings ?? []" :key="i">{{ w }}</div>
      </template>
    </a-alert>

    <a-spin :spinning="loading">
      <!-- 总量 + 四类视图 -->
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
        <a-card size="small" :bordered="true" class="lab-stat">
          <div class="text-xs text-slate-400">data/ 总量</div>
          <div class="num text-lg">{{ fmtBytes(snap?.totals.bytes ?? 0) }}</div>
          <div class="text-xs text-slate-500 num">{{ snap?.totals.files ?? 0 }} 个文件 · {{ snap?.files.length ?? 0 }} 个条目</div>
        </a-card>
        <a-card v-for="c in snap?.categories ?? []" :key="c.id" size="small" :bordered="true" class="lab-stat">
          <div class="flex items-center justify-between">
            <span class="text-xs text-slate-400">{{ c.label }}</span>
            <a-tag v-if="c.deletable" color="cyan" class="!text-xs">可清理</a-tag>
            <a-tag v-else color="default" class="!text-xs">只读</a-tag>
          </div>
          <div class="num text-lg">{{ fmtBytes(c.bytes) }}</div>
          <div class="text-xs text-slate-500 num">{{ c.count }} 个条目</div>
        </a-card>
      </div>

      <!-- 清理条：只收可清理项 -->
      <a-card size="small" :bordered="true">
        <div class="flex items-center justify-between mb-2">
          <span class="section-title">条目明细</span>
          <a-space>
            <span class="text-xs text-slate-400">
              已选 <span class="num text-slate-200">{{ selectedNames.length }}</span> 项 /
              <span class="num">{{ fmtBytes(selectedBytes) }}</span>
            </span>
            <a-button size="small" type="primary" danger :disabled="!selectedNames.length" @click="openPreview">
              预览清理
            </a-button>
          </a-space>
        </div>

        <div class="mb-2">
          <a-radio-group v-model:value="catFilter" size="small">
            <a-radio-button value="">全部</a-radio-button>
            <a-radio-button v-for="c in snap?.categories ?? []" :key="c.id" :value="c.id">
              {{ c.label }}
            </a-radio-button>
          </a-radio-group>
        </div>

        <a-table
          :data-source="filtered"
          :columns="cols"
          row-key="name"
          size="small"
          :pagination="{ pageSize: 20, showSizeChanger: false }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'pick'">
              <a-checkbox
                v-if="record.deletable"
                :checked="selected.includes(record.name)"
                @change="(e: any) => togglePick(record.name, e.target.checked)"
              />
              <span v-else class="text-slate-600">—</span>
            </template>
            <template v-else-if="column.key === 'name'">
              <div class="font-medium flex items-center gap-2">
                <span>{{ record.name }}</span>
                <a-tag v-if="record.isDir" color="default" class="!text-xs">目录</a-tag>
              </div>
              <div v-if="record.note" class="text-xs text-slate-500">{{ record.note }}</div>
            </template>
            <template v-else-if="column.key === 'category'">
              <a-tag :color="catColor(record.category)">{{ catLabel(record.category) }}</a-tag>
            </template>
            <template v-else-if="column.key === 'bytes'">
              <span class="num">{{ fmtBytes(record.bytes) }}</span>
              <div v-if="record.files > 1" class="text-xs text-slate-500 num">{{ record.files }} 个文件</div>
            </template>
            <template v-else-if="column.key === 'mtimeMs'">
              <span class="num">{{ fmtTime(record.mtimeMs) }}</span>
            </template>
            <template v-else-if="column.key === 'deletable'">
              <a-tag v-if="record.deletable" color="cyan" class="!text-xs">可清理</a-tag>
              <a-tag v-else color="default" class="!text-xs">保护</a-tag>
            </template>
          </template>
        </a-table>
      </a-card>
    </a-spin>

    <!-- 预览 → 确认两步；预览零写盘，清单与执行同源 -->
    <a-modal v-model:open="previewOpen" title="清理预览" :footer="null" width="640px">
      <a-alert type="warning" show-icon class="mb-3"
        message="以下文件将被永久删除（不可恢复）" />
      <a-table
        v-if="previewItems.length"
        :data-source="previewItems"
        :columns="pvCols"
        row-key="name"
        size="small"
        :pagination="false"
        class="mb-3"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div>{{ record.name }}</div>
            <div v-if="record.note" class="text-xs text-slate-500">{{ record.note }}</div>
          </template>
          <template v-else-if="column.key === 'bytes'">
            <span class="num">{{ fmtBytes(record.bytes) }}</span>
          </template>
        </template>
      </a-table>
      <div class="text-sm mb-3">
        合计释放：<span class="num text-lg">{{ fmtBytes(previewTotal) }}</span>
      </div>
      <a-alert
        v-if="previewRefused.length"
        type="error" show-icon class="mb-3"
        :message="`以下 ${previewRefused.length} 项被拒绝（未计入删除）`"
      >
        <template #description>
          <div v-for="r in previewRefused" :key="r.name" class="text-xs">
            <span class="num">{{ r.name }}</span> — {{ r.reason }}
          </div>
        </template>
      </a-alert>
      <div class="flex justify-end gap-2">
        <a-button @click="previewOpen = false">取消</a-button>
        <a-button type="primary" danger :loading="cleaning" @click="doCleanup">
          确认清理（{{ previewItems.length }} 个文件）
        </a-button>
      </div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { App } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import {
  storageApi,
  type StorageSnapshot,
  type StorageFileRow,
  type StorageCategoryId,
  type CleanupItem,
  type CleanupRefused,
} from '@/api/storage'

const { message } = App.useApp()

const loading = ref(false)
const snap = ref<StorageSnapshot | null>(null)
const selected = ref<string[]>([])
const catFilter = ref<'' | StorageCategoryId>('')

const previewOpen = ref(false)
const previewItems = ref<CleanupItem[]>([])
const previewRefused = ref<CleanupRefused[]>([])
const previewTotal = ref(0)
const cleaning = ref(false)

const cols = [
  { title: '', key: 'pick', width: 44 },
  { title: '条目', key: 'name' },
  { title: '分类', key: 'category', width: 110 },
  { title: '体量', key: 'bytes', width: 120 },
  { title: '最后写入', key: 'mtimeMs', width: 170 },
  { title: '处置', key: 'deletable', width: 90 },
]

const pvCols = [
  { title: '文件', key: 'name' },
  { title: '体量', key: 'bytes', width: 120 },
]

const filtered = computed<StorageFileRow[]>(() => {
  const rows = snap.value?.files ?? []
  return catFilter.value ? rows.filter((r) => r.category === catFilter.value) : rows
})

const selectedNames = computed(() => selected.value)
const selectedBytes = computed(() => {
  const rows = snap.value?.files ?? []
  return rows.filter((r) => selected.value.includes(r.name)).reduce((s, r) => s + r.bytes, 0)
})

function catLabel(id: StorageCategoryId): string {
  return snap.value?.categories.find((c) => c.id === id)?.label ?? id
}
function catColor(id: StorageCategoryId): string {
  const map: Record<StorageCategoryId, string> = {
    credentials: 'red',
    config: 'orange',
    logs: 'cyan',
    cache: 'blue',
    other: 'default',
  }
  return map[id]
}

function fmtBytes(n: number | undefined): string {
  if (!n && n !== 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function togglePick(name: string, on: boolean) {
  const set = new Set(selected.value)
  if (on) set.add(name)
  else set.delete(name)
  selected.value = [...set]
}

async function load(refresh = false) {
  loading.value = true
  try {
    snap.value = (await storageApi.scan(refresh)).data
    // 重新扫描后清掉已不存在的选择，避免「选中了已被外部删除的文件」
    const names = new Set(snap.value.files.map((f) => f.name))
    selected.value = selected.value.filter((n) => names.has(n))
  } catch (e: unknown) {
    message.error(`扫描失败：${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function openPreview() {
  try {
    const r = (await storageApi.preview(selected.value)).data
    previewItems.value = r.items
    previewRefused.value = r.refused
    previewTotal.value = r.totalBytes
    previewOpen.value = true
  } catch (e: unknown) {
    message.error(`预览失败：${(e as Error).message}`)
  }
}

async function doCleanup() {
  cleaning.value = true
  try {
    const r = (await storageApi.cleanup(selected.value)).data
    previewOpen.value = false
    if (r.removed.length) message.success(`已清理 ${r.removed.length} 个文件，释放 ${fmtBytes(r.freedBytes)}`)
    for (const f of r.failed) message.error(`${f.name}：${f.reason}`)
    selected.value = []
    await load(true)
  } catch (e: unknown) {
    message.error(`清理失败：${(e as Error).message}`)
  } finally {
    cleaning.value = false
  }
}

onMounted(() => load())
</script>
