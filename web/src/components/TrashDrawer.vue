<template>
  <a-drawer
    :open="open"
    :title="`回收站 · ${channelLabel}`"
    width="620"
    @close="close"
  >
    <a-spin :spinning="loading">
      <!-- 损坏如实可见：列表退化为空但绝不装没事（后端 listTrash.corrupt） -->
      <a-alert
        v-if="data?.corrupt"
        type="error"
        show-icon
        class="mb-3"
        message="回收站文件损坏"
        description="解析失败，列表不可用；为防误清数据，恢复/清空/永久删除都会拒绝执行。请先手工检查数据目录下的回收站文件。"
      />
      <a-alert type="info" show-icon class="mb-3">
        <template #message>删除是软删除：{{ data?.retentionDays ?? 30 }} 天内可一键恢复</template>
        <template #description>
          <div>删除的账号连同凭据整体搬进回收站（不参与选号/签到/统计），恢复时记录逐字还原。</div>
          <div class="mt-1">超过 {{ data?.retentionDays ?? 30 }} 天自动清除，条数上限 {{ data?.maxEntries ?? 200 }}（先到先出）；「永久删除」与「清空」不可逆。</div>
        </template>
      </a-alert>

      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-slate-400">
          共 {{ entries.length }} 条
        </span>
        <a-popconfirm
          title="清空回收站？全部条目立即销毁，不可恢复。"
          ok-text="清空"
          cancel-text="取消"
          :ok-button-props="{ danger: true }"
          @confirm="doClear"
        >
          <a-button size="small" danger :disabled="!entries.length">清空回收站</a-button>
        </a-popconfirm>
      </div>

      <a-empty v-if="!entries.length" description="回收站是空的" />

      <a-table
        v-else
        :data-source="entries"
        :columns="cols"
        row-key="key"
        size="small"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div class="font-medium">{{ record.name }}</div>
            <div class="text-xs text-slate-500 num">id {{ record.id }}</div>
          </template>
          <template v-else-if="column.key === 'deletedAt'">
            <span class="num">{{ fmtTime(record.deletedAt) }}</span>
          </template>
          <template v-else-if="column.key === 'expiresAt'">
            <a-tag v-if="record.expiresInDays !== null && record.expiresInDays <= 3" color="red" class="num">
              {{ record.expiresInDays }} 天
            </a-tag>
            <a-tag v-else color="default" class="num">{{ record.expiresInDays ?? '—' }} 天</a-tag>
            <div class="text-xs text-slate-500 num">{{ fmtTime(record.expiresAt) }}</div>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-space>
              <a-popconfirm
                title="恢复这个账号？live 已有同 id 时会被拒绝。"
                ok-text="恢复"
                cancel-text="取消"
                @confirm="doRestore(record)"
              >
                <a-button size="small">恢复</a-button>
              </a-popconfirm>
              <a-button size="small" danger @click="confirmPurge(record)">永久删除</a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-spin>
  </a-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Modal } from 'ant-design-vue'
import { message } from 'ant-design-vue'
import { trashApi, type TrashEntry, type TrashList, type TrashChannel } from '@/api/trash'
import { CHANNELS } from '@/stores/channel'

const props = defineProps<{ open: boolean; channel: TrashChannel }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void; (e: 'restored'): void }>()

const loading = ref(false)
const data = ref<TrashList | null>(null)

const channelLabel = computed(
  () => CHANNELS.find((c) => c.id === props.channel)?.label ?? props.channel,
)
const entries = computed<TrashEntry[]>(() => data.value?.entries ?? [])

const cols = [
  { title: '账号', key: 'name' },
  { title: '删除时间', key: 'deletedAt', width: 170 },
  { title: '可恢复至', key: 'expiresAt', width: 140 },
  { title: '操作', key: 'action', width: 170 },
]

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

async function load() {
  loading.value = true
  try {
    data.value = (await trashApi.list(props.channel)).data
  } catch (e: unknown) {
    message.error(`回收站加载失败：${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

// 打开时与通道切换时都重拉——抽屉是五通道共用壳，通道是它唯一的取数维度
watch(
  () => [props.open, props.channel] as const,
  ([o]) => {
    if (o) load()
  },
  { immediate: true },
)

function close() {
  emit('update:open', false)
}

async function doRestore(record: TrashEntry) {
  try {
    const r = (await trashApi.restore(props.channel, record.key)).data
    if (!r.ok) {
      message.error(r.error || '恢复失败')
      return
    }
    message.success(`已恢复「${r.name ?? record.name}」`)
    await load()
    emit('restored') // 让账号列表立刻反映恢复结果（父级重挂/重拉）
  } catch (e: unknown) {
    message.error(`恢复失败：${(e as Error).message}`)
  }
}

function confirmPurge(record: TrashEntry) {
  Modal.confirm({
    title: '永久删除？',
    content: `「${record.name}」及其全部凭据将从回收站立即销毁，此操作不可恢复。`,
    okText: '永久删除',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      try {
        const r = (await trashApi.purge(props.channel, record.key)).data
        if (!r.ok) {
          message.error(r.error || '永久删除失败')
          return
        }
        message.success('已永久删除')
        await load()
      } catch (e: unknown) {
        message.error(`永久删除失败：${(e as Error).message}`)
      }
    },
  })
}

async function doClear() {
  try {
    const r = (await trashApi.clear(props.channel)).data
    if (!r.ok) {
      message.error(r.error || '清空失败')
      return
    }
    message.success(`已清空 ${r.removed} 条`)
    await load()
  } catch (e: unknown) {
    message.error(`清空失败：${(e as Error).message}`)
  }
}
</script>
