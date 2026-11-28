<template>
  <div class="page">
    <PageHeader title="备份与还原" sub="表驱动：勾选分区导出 / 预览合并零写盘 / 确认后落盘 — 覆盖全部通道的账号与配置">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="loadAll">刷新</a-button>
        <a-button type="primary" size="small" :disabled="!selected.size" @click="openExportConfirm">导出选中</a-button>
      </template>
    </PageHeader>

    <a-alert type="info" show-icon class="mb-3">
      <template #message>导出默认脱敏 · 预览零写盘 · 导入按策略合并</template>
      <template #description>
        <div>
          账号分区的 token/cookie 默认**剥掉**（分区标 redacted）；API Key、管理账户这类
          <b>敏感分区</b>不勾「含凭据」直接拒绝导出，勾了还要过一次确认框——明文出网是显式动作。
        </div>
        <div class="mt-1">
          导入先「预览合并」（纯内存、不碰盘），看清 added / overwritten / skipped 再执行；
          策略：保留本地（默认）/ 覆盖本地 / 保留两者。脱敏备份**覆盖**本地账号时会保留本地凭据字段——
          「备份没带凭据」不等于「账号没有凭据」。
        </div>
      </template>
    </a-alert>

    <a-alert v-if="err" type="warning" show-icon class="mb-3" :message="err" />

    <!-- ========= 分区表 ========= -->
    <a-card :bordered="false" title="分区" class="mb-4">
      <template #extra>
        <a-button size="small" class="ghost-btn" @click="toggleAll">{{ allSelected ? '全不选' : '全选' }}</a-button>
      </template>
      <a-table
        :data-source="rows"
        :columns="cols"
        :loading="loading"
        row-key="id"
        size="small"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'pick'">
            <a-checkbox
              :checked="selected.has(record.id)"
              @change="(e: any) => togglePick(record.id, e.target.checked)"
            />
          </template>
          <template v-else-if="column.key === 'label'">
            <span>{{ record.label }}</span>
            <a-tag v-if="record.sensitive" color="red" style="margin-left: 6px">敏感</a-tag>
            <a-tag v-else-if="record.kind === 'accounts'" style="margin-left: 6px">账号</a-tag>
          </template>
          <template v-else-if="column.key === 'count'">
            <template v-if="record.exists">
              <span class="num">{{ record.count }}</span>
              <span class="text-xs text-slate-400">{{ record.kind === 'accounts' ? ' 条记录' : ' 个键' }}</span>
            </template>
            <span v-else class="text-xs text-slate-400">文件不存在（尚未写入）</span>
          </template>
          <template v-else-if="column.key === 'updatedAt'">
            <span class="num">{{ record.updatedAt ? timeText(record.updatedAt) : '—' }}</span>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- ========= 导入 ========= -->
    <a-card :bordered="false" title="导入（还原 / 迁移）" class="mb-4">
      <div class="space-y-3" style="max-width: 760px">
        <label class="field-line">
          <span class="text-xs text-slate-400">备份文件（dumate2api-backup 信封 JSON）</span>
          <input type="file" accept=".json,application/json" @change="onFile" />
          <div v-if="envelope" class="text-xs text-slate-400 mt-1">
            已加载：{{ Object.keys(envelope.sections).length }} 个分区 ·
            生成于 {{ timeText(envelope.generatedAt) }} ·
            {{ envelope.includeCredentials ? '含凭据（明文）' : '脱敏' }}
          </div>
        </label>

        <div class="field-line">
          <span class="text-xs text-slate-400">冲突策略（同一分区里已存在的记录/键怎么处置）</span>
          <a-radio-group v-model:value="policy">
            <a-radio value="keepLocal">保留本地（默认、最安全）</a-radio>
            <a-radio value="overwrite">覆盖本地（备份里的值赢了）</a-radio>
            <a-radio value="keepBoth">保留两者（命中的追加为分身）</a-radio>
          </a-radio-group>
        </div>

        <a-space>
          <a-button size="small" :disabled="!envelope" :loading="previewing" @click="doPreview">预览合并</a-button>
          <a-button
            size="small" type="primary"
            :disabled="!previewResult" :loading="importing"
            @click="importOpen = true"
          >执行导入</a-button>
        </a-space>
        <div class="text-xs text-slate-400">预览是纯内存计算、不碰任何文件；执行导入才落盘。</div>

        <a-alert v-if="ignored.length" type="warning" show-icon class="mt-2"
          :message="`备份里有 ${ignored.length} 个本版本不认识的分区已跳过：${ignored.join(', ')}`" />

        <!-- 预览/导入结果共用一张表 -->
        <a-table
          v-if="resultRows.length"
          :data-source="resultRows"
          :columns="resultCols"
          row-key="id"
          size="small"
          :pagination="false"
          class="mt-2"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'id'">
              <span class="mono">{{ record.id }}</span>
            </template>
            <template v-else-if="column.key === 'added'"><span class="num" :class="record.added ? 'text-emerald-400' : ''">{{ record.added }}</span></template>
            <template v-else-if="column.key === 'overwritten'"><span class="num" :class="record.overwritten ? 'text-amber-400' : ''">{{ record.overwritten }}</span></template>
            <template v-else-if="column.key === 'skipped'"><span class="num">{{ record.skipped }}</span></template>
            <template v-else-if="column.key === 'conflicts'">
              <span class="num">{{ record.conflicts }}</span>
              <div v-if="record.conflictKeys && record.conflictKeys.length" class="text-xs text-slate-400">
                {{ record.conflictKeys.slice(0, 6).join(', ') }}{{ record.conflictKeys.length > 6 ? ' …' : '' }}
              </div>
            </template>
            <template v-else-if="column.key === 'error'">
              <span v-if="record.error" class="text-xs" style="color: var(--ant-color-error, #ef4444)">{{ record.error }}</span>
            </template>
          </template>
        </a-table>
        <div v-if="lastAction" class="text-xs" :style="{ color: 'var(--ant-color-success, #34d399)' }">{{ lastAction }}</div>
      </div>
    </a-card>

    <!-- ========= 导出确认弹窗（含凭据时） ========= -->
    <a-modal
      v-model:open="exportOpen"
      title="确认导出"
      :confirm-loading="exporting"
      @ok="doExport"
      ok-text="确认导出"
      cancel-text="取消"
    >
      <div v-if="sensitivePicked.length" class="space-y-2">
        <a-alert type="error" show-icon
          message="选中了敏感分区：明文凭据将写入导出文件" />
        <div>
          敏感分区：<a-tag v-for="s in sensitivePicked" :key="s" color="red" class="mono">{{ s }}</a-tag>
        </div>
        <div class="text-xs text-slate-400">
          导出文件会包含 API Key 明文 / 口令哈希。请存放到可信位置；分享或上传前务必再想一次。
        </div>
      </div>
      <div v-else>
        将导出 {{ selected.size }} 个分区（脱敏，不含 token/cookie）。文件落在本机下载目录，不经过任何外部服务。
      </div>
    </a-modal>

    <!-- ========= 执行导入确认弹窗 ========= -->
    <a-modal
      v-model:open="importOpen"
      title="确认导入"
      :confirm-loading="importing"
      @ok="doImport"
      ok-text="确认写入"
      cancel-text="取消"
    >
      <div class="space-y-2">
        <div>
          策略 <b>{{ policyLabel }}</b>，预览计数：
          <span class="num">新增 {{ totalOf('added') }}</span> ·
          <span class="num">覆盖 {{ totalOf('overwritten') }}</span> ·
          <span class="num">跳过 {{ totalOf('skipped') }}</span>
        </div>
        <a-alert
          v-if="totalOf('overwritten') > 0"
          type="warning" show-icon
          message="有覆盖：本地将被备份里的值替换（脱敏账号分区的凭据字段除外——会保留本地凭据）"
        />
        <div class="text-xs text-slate-400">写入是逐分区原子落盘；账户/账号数据请确认已有一份导出再继续。</div>
      </div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
// 备份与还原页（批次十五）：分区勾选导出 + 文件导入预览/执行。
// 后端 /api/admin/backup（批次十四）——导出勾选与导入合并读同一张 SECTION_TABLE，
// 本页不维护任何分区清单副本，一切以 GET /sections 返回为准。
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import { backupApi, type BackupSectionRow, type BackupEnvelope, type BackupSectionResult } from '@/api/backup'

const loading = ref(false)
const err = ref('')
const rows = ref<BackupSectionRow[]>([])
const selected = ref(new Set<string>())

const cols = [
  { key: 'pick', title: '', width: 40 },
  { key: 'label', title: '分区' },
  { key: 'count', title: '现状', width: 220 },
  { key: 'updatedAt', title: '最后写入', width: 170 },
]

const resultCols = [
  { key: 'id', title: '分区' },
  { key: 'added', title: '新增', width: 70 },
  { key: 'overwritten', title: '覆盖', width: 70 },
  { key: 'skipped', title: '跳过', width: 70 },
  { key: 'conflicts', title: '命中', width: 200 },
  { key: 'error', title: '', width: 200 },
]

function timeText(v: number | string): string {
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString()
}

async function loadAll() {
  loading.value = true
  err.value = ''
  try {
    const { data } = await backupApi.sections()
    rows.value = data.sections || []
    // 已选里被后端移除的分区顺手清掉
    const ids = new Set(rows.value.map((r) => r.id))
    selected.value = new Set([...selected.value].filter((id) => ids.has(id)))
  } catch (e: any) {
    err.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function togglePick(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}

const allSelected = computed(() => rows.value.length > 0 && selected.value.size === rows.value.length)
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(rows.value.map((r) => r.id))
}

// ---- 导出 ----
const exportOpen = ref(false)
const exporting = ref(false)
const sensitivePicked = computed(() =>
  rows.value.filter((r) => selected.value.has(r.id) && r.sensitive).map((r) => r.id),
)

function openExportConfirm() {
  if (!selected.value.size) {
    message.warning('先勾选要导出的分区')
    return
  }
  exportOpen.value = true
}

async function doExport() {
  exporting.value = true
  try {
    const includeCreds = sensitivePicked.value.length > 0
    const { data } = await backupApi.exportBackup([...selected.value], includeCreds, includeCreds)
    downloadEnvelope(data.envelope)
    exportOpen.value = false
    message.success(`已导出 ${selected.value.size} 个分区${includeCreds ? '（含凭据）' : '（脱敏）'}`)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '导出失败')
  } finally {
    exporting.value = false
  }
}

function downloadEnvelope(envelope: BackupEnvelope) {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const day = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `dumate2api-backup-${day}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// ---- 导入 ----
const envelope = ref<BackupEnvelope | null>(null)
const policy = ref<'keepLocal' | 'overwrite' | 'keepBoth'>('keepLocal')
const previewing = ref(false)
const importing = ref(false)
const previewResult = ref<Record<string, BackupSectionResult> | null>(null)
const ignored = ref<string[]>([])
const importOpen = ref(false)
const lastAction = ref('')

const policyLabel = computed(() =>
  policy.value === 'overwrite' ? '覆盖本地' : policy.value === 'keepBoth' ? '保留两者' : '保留本地',
)

function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files && input.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result))
      if (parsed?.format !== 'dumate2api-backup' || parsed?.version !== 1) {
        message.error('不是 dumate2api-backup 信封（format/version 不对）')
        return
      }
      envelope.value = parsed
      previewResult.value = null
      ignored.value = []
      lastAction.value = ''
      message.success('备份文件已加载，先预览合并')
    } catch {
      message.error('文件不是合法 JSON')
    }
    input.value = '' // 允许重选同一文件
  }
  reader.readAsText(file)
}

const resultRows = computed(() => {
  const res = previewResult.value
  if (!res) return []
  return Object.entries(res).map(([id, r]) => ({ id, ...r }))
})

function totalOf(key: 'added' | 'overwritten' | 'skipped'): number {
  return resultRows.value.reduce((sum, r) => sum + (Number(r[key]) || 0), 0)
}

async function doPreview() {
  if (!envelope.value) return
  previewing.value = true
  lastAction.value = ''
  try {
    const { data } = await backupApi.preview(envelope.value, policy.value)
    previewResult.value = data.results || {}
    ignored.value = data.ignored || []
    message.success('预览完成（未写盘）')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '预览失败')
  } finally {
    previewing.value = false
  }
}

async function doImport() {
  if (!envelope.value) return
  importing.value = true
  try {
    const { data } = await backupApi.importBackup(envelope.value, policy.value)
    previewResult.value = data.results || {}
    ignored.value = data.ignored || []
    importOpen.value = false
    lastAction.value = `已导入：新增 ${totalOf('added')} · 覆盖 ${totalOf('overwritten')} · 跳过 ${totalOf('skipped')}`
    message.success('导入完成')
    await loadAll()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '导入失败')
  } finally {
    importing.value = false
  }
}

onMounted(loadAll)
</script>

<style scoped>
.field-line {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
