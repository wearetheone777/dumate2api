<template>
  <!--
    账号导入 / 导出：以「按钮 + 弹窗」呈现，按钮挂在账号页的操作区里，
    与「添加账号」同一组——它们是账号池运维的同一件事的两个方向。

    为什么不再占一整张卡：那张卡一直悬在页面底部，把「加号 / 删号」的操作区
    和「把号搬走」割成两处；收进弹窗后，操作区只占一行，点击才展开细节。

    为什么按通道收窄：弹窗在五条通道的账号页里各出现一次，默认只处理
    **当前通道**。跨通道全量导出仍是同一个弹窗里的按钮——「换机」要一次带走
    所有号，那是唯一需要跨通道的场景。
  -->
  <a-button v-if="isAdmin" size="small" class="ghost-btn" @click="openModal">
    导入 / 导出
  </a-button>

  <a-modal
    v-if="isAdmin"
    v-model:open="open"
    title="导入 / 导出账号"
    :footer="null"
    width="720"
  >
    <div class="flex items-center justify-between mb-3">
      <span class="text-xs text-slate-400">
        {{ currentLabel }} 共 {{ currentTotal }} 个账号
      </span>
    </div>

    <a-alert type="warning" show-icon class="mb-3">
      <template #message>导出文件含账号明文凭证（cookie / refresh token）</template>
      <template #description>
        <div>
          迁移的必要条件，请按<b>密码级</b>敏感信息保管：不要提交到仓库、不要发到公开渠道。
          导出动作落管理审计（只记通道与条数，不记凭证内容）。
        </div>
        <div class="mt-1">
          导入按业务键 upsert（搭子按 BDUSS 尾号、直连通道按 uid + 区域），
          <code>id</code> 一律重新分配——直接拷 <code>data/*-accounts.json</code> 会撞号，
          改一个号会改到别人身上。
        </div>
      </template>
    </a-alert>

    <!-- ============ 导出 ============ -->
    <div class="flex flex-wrap items-center gap-2">
      <a-button
        type="primary"
        size="small"
        :disabled="!currentTotal"
        :loading="exporting === channel"
        @click="doExport(channel)"
      >
        导出{{ currentLabel }}（{{ currentTotal }}）
      </a-button>
      <a-button
        size="small"
        :disabled="!grandTotal"
        :loading="exporting === '__all__'"
        @click="doExport('')"
      >
        导出全部通道（{{ grandTotal }}）
      </a-button>
      <span class="text-xs text-slate-400">单文件 JSON</span>
    </div>

    <!-- ============ 导入 ============ -->
    <a-divider class="my-3" />
    <div class="grid gap-3 md:grid-cols-3">
      <div>
        <div class="text-xs text-slate-400 mb-1">冲突策略</div>
        <a-radio-group v-model:value="importMode" size="small">
          <a-radio-button value="skip">跳过已存在</a-radio-button>
          <a-radio-button value="overwrite">覆盖凭证</a-radio-button>
        </a-radio-group>
        <div class="text-xs text-slate-400 mt-1">
          源机换过 token 才用「覆盖」；日常补号用「跳过」。
        </div>
      </div>
      <div v-if="hasRegion">
        <div class="text-xs text-slate-400 mb-1">区域（记录自身没带时才用）</div>
        <a-select v-model:value="importRegion" size="small" style="width: 100%" :options="regionOptions" />
      </div>
      <div>
        <div class="text-xs text-slate-400 mb-1">文件</div>
        <a-upload :show-upload-list="false" accept="application/json,.json" :before-upload="onFile">
          <a-button size="small" :loading="importing">选择文件并导入</a-button>
        </a-upload>
      </div>
    </div>

    <a-alert v-if="importResult" type="success" show-icon class="mt-3">
      <template #message>
        导入完成：新增 <b class="num">{{ importResult.totals.created }}</b> ·
        更新 <b class="num">{{ importResult.totals.updated }}</b> ·
        跳过 <b class="num">{{ importResult.totals.skipped }}</b> ·
        失败 <b class="num">{{ importResult.totals.failed }}</b>
        （{{ importResult.mode === 'overwrite' ? '覆盖' : '跳过' }}）
      </template>
      <template #description>
        <div v-for="c in importResult.channels" :key="c.channel" class="text-xs">
          <b>{{ c.label }}</b>：收 {{ c.received }} · 新增 {{ c.created }} · 更新 {{ c.updated }} ·
          跳过 {{ c.skipped }} · 失败 {{ c.failed }}
          <a-tag v-if="c.refreshExpired" color="orange" class="ml-1">
            {{ c.refreshExpired }} 个凭证已过期
          </a-tag>
          <ul v-if="c.errors.length" class="pl-4 mb-0 mt-1">
            <li v-for="(e, i) in c.errors" :key="i" class="text-red-600">{{ e }}</li>
          </ul>
        </div>
        <div class="mt-1 text-xs text-slate-400">
          已过期凭证需重新登录该账号才能用；导入后按账号池既有规则选号。
        </div>
      </template>
    </a-alert>

    <a-alert v-if="err" type="error" show-icon class="mt-3" :message="err" />

    <a-collapse :bordered="false" class="mt-3">
      <a-collapse-panel key="fields" header="搬哪些字段（白名单）">
        <div v-for="c in fieldRows" :key="c.channel" class="mb-2">
          <div class="text-sm font-medium mb-1">
            {{ c.label }}
            <span class="text-xs text-slate-400 ml-2">必填：{{ c.required.join(' / ') || '—' }}</span>
          </div>
          <div class="flex flex-wrap gap-1">
            <a-tag v-for="f in c.fields" :key="f" :color="c.required.includes(f) ? 'blue' : 'default'">
              {{ f }}
            </a-tag>
          </div>
        </div>
        <div class="text-xs text-slate-400 mt-2">
          刻意不搬：<code>{{ excluded.join(' / ') }}</code>——{{ excludedNote }}
        </div>
      </a-collapse-panel>
    </a-collapse>
  </a-modal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { App } from 'ant-design-vue'
import { accountTransferApi } from '@/api/accounttransfer'
import type {
  TransferChannelField,
  TransferChannelSummary,
  TransferImportResult,
} from '@/api/accounttransfer'
import { isAdmin } from '@/stores/auth'
import { channelLabel, channelStore } from '@/stores/channel'
import { regionStore, hasRegion as hasRegionFn } from '@/stores/region'

const { message } = App.useApp()

const emit = defineEmits<{ (e: 'imported'): void }>()

const open = ref(false)
const summary = ref<TransferChannelSummary[]>([])
const fieldRows = ref<TransferChannelField[]>([])
const excluded = ref<string[]>([])
const excludedNote = ref('')
const exporting = ref('')
const importing = ref(false)
const importMode = ref<'skip' | 'overwrite'>('skip')
const importRegion = ref('')
const importResult = ref<TransferImportResult | null>(null)
const err = ref('')

const channel = computed(() => channelStore.current)
const currentLabel = computed(() => channelLabel(channel.value))
const hasRegion = computed(() => hasRegionFn(channel.value))
const currentRow = computed(() => summary.value.find((c) => c.channel === channel.value) || null)
const currentTotal = computed(() => currentRow.value?.total || 0)
const grandTotal = computed(() => summary.value.reduce((n, c) => n + c.total, 0))

const regionOptions = [
  { label: '自动（按记录自身 / 国内）', value: '' },
  { label: '国内', value: 'cn' },
  { label: '国际', value: 'intl' },
]

function openModal() {
  open.value = true
  err.value = ''
  // 每次打开都刷新概览：账号数是在别的操作里变的（加号 / 删号 / 签到），
  // 用挂载时那一份会把「导出 N 个」显示成旧值。
  loadSummary()
  if (!fieldRows.value.length) loadFields()
}

async function loadSummary() {
  try {
    const { data } = await accountTransferApi.summary()
    summary.value = data.channels || []
  } catch (e) {
    /* 概览失败不阻断弹窗：导出按钮会显示 0，用户仍可直接导出 */
  }
}

async function loadFields() {
  try {
    const { data } = await accountTransferApi.fields()
    fieldRows.value = data.channels || []
    excluded.value = data.excluded || []
    excludedNote.value = data.excludedNote || ''
  } catch (e) { /* 同上 */ }
}

async function doExport(ch: string) {
  exporting.value = ch || '__all__'
  err.value = ''
  try {
    // 导出不按区域过滤：同一个通道的两区账号都该带走，否则换机会丢号。
    const params: { channel?: string } = {}
    if (ch) params.channel = ch
    const payload = await accountTransferApi.exportFile(params)
    const n = Object.values(payload.channels || {})
      .reduce((acc: number, c: any) => acc + (c.accounts?.length || 0), 0)
    if (!n) message.warning('没有可导出的账号')
    else message.success(`已导出 ${n} 个账号（文件含明文凭证，按密码级保管）`)
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '导出失败'
    err.value = msg
    message.error(msg)
  } finally {
    exporting.value = ''
  }
}

/**
 * 前端先读文件再 POST（与「恢复配置备份」同一做法：before-upload 返回 false
 * 阻止 a-upload 自己上传）。JSON 解析失败在这里就报，不用等服务端。
 */
async function onFile(file: File) {
  importing.value = true
  importResult.value = null
  err.value = ''
  try {
    const payload = JSON.parse(await file.text())
    const opts: { mode: 'skip' | 'overwrite'; region?: string } = { mode: importMode.value }
    if (hasRegion.value) {
      // 未显式选时按当前区域视图兜底——在「国际版」页导入国内号会让人以为
      // 导入失败（列表里看不见），所以默认跟随视图
      opts.region = importRegion.value || (regionStore.current === 'intl' ? 'intl' : 'cn')
    }
    const { data } = await accountTransferApi.import(payload, opts)
    importResult.value = data
    const t = data.totals
    if (t.failed) message.warning(`导入完成，但有 ${t.failed} 条失败（见明细）`)
    else message.success(`导入完成：新增 ${t.created} · 更新 ${t.updated} · 跳过 ${t.skipped}`)
    await loadSummary()
    emit('imported')
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '导入失败'
    err.value = msg
    message.error(msg)
  } finally {
    importing.value = false
  }
  return false
}
</script>
