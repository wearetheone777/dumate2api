<template>
  <div class="page">
    <PageHeader title="API Key" sub="网关鉴权密钥与来源白名单" />

    <a-alert
      :type="data?.require_key ? 'success' : data?.require_key === false ? 'warning' : 'info'"
      show-icon
    >
      <template #message>
        <span v-if="data?.require_key">
          网关鉴权已开启：所有模型请求必须带已登记的 API key
        </span>
        <span v-else-if="data?.require_key === false">
          网关鉴权当前<span class="font-medium">关闭</span>：运行的还是旧版网关（新版已强制鉴权）
        </span>
        <span v-else>网关不在线，鉴权状态未知</span>
      </template>
      <template #description>
        <span v-if="data?.require_key">
          状态探测自网关进程（/health 的 require_key）。鉴权已强制开启、无法关闭；
          没有登记 key 时所有模型请求都会 401。
        </span>
        <span v-else-if="data?.require_key === false">
          本页的 key 与白名单已生效保存，但只有开启鉴权后才会被校验。
          升级网关到最新版后鉴权自动强制开启。
        </span>
        <span v-else>网关进程未启动或不可达，启动后刷新本页。</span>
      </template>
    </a-alert>

    <a-card :bordered="false">
      <div class="card-head-row">
        <div>
          <span class="section-title">API Key</span>
          <span class="hint-text ml-2">近 {{ data?.days ?? 30 }} 天用量</span>
          <a-tag v-if="isQw" color="cyan" class="ml-2">千问办公</a-tag>
          <a-tag v-else-if="isTw" color="purple" class="ml-2">TRAE Work</a-tag>
        </div>
        <a-space v-if="isAdmin">
          <a-button size="small" @click="ccDlg?.openDialog()">配置到 cc-switch</a-button>
          <a-button type="primary" size="small" @click="openCreate">新建 Key</a-button>
        </a-space>
      </div>

      <!-- 列表全量展示；说明保留「key 与通道的关系」，避免被当成通道专用 key -->
      <a-alert type="info" show-icon class="mb-3">
        <template #message>显示全部 Key（跨通道）</template>
        <template #description>
          网关按**模型名前缀**分流（<code>qwen/</code> → 千问办公、
          <code>traework/</code> → TRAE Work，无前缀 → 搭子），而不是按 key 分流。
          所以这里的 key 只要能调对应前缀的模型就可用。
          若把 key 的「通道绑定」设为「仅{{ channelLabel(channelStore.current) }}」，
          它就只能调该通道的模型。
        </template>
      </a-alert>

      <a-table
        size="small"
        :pagination="false"
        :data-source="data?.keys ?? []"
        :columns="columns"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div>{{ record.name }}</div>
            <div class="text-xs text-slate-400 font-mono">
              {{ record.prefix }}…
              <a v-if="record.plain" class="ml-1" @click="openView(record)">查看</a>
              <a-tooltip v-else-if="isAdmin" title="明文未存：此 key 创建于明文记录启用前，无法回填，需要查看请重建">
                <span class="ml-1 text-slate-500 cursor-default">明文未存</span>
              </a-tooltip>
              <a-tooltip v-else title="完整 key 只有管理员能查看">
                <span class="ml-1 text-slate-500 cursor-default">仅管理员可见</span>
              </a-tooltip>
            </div>
            <div v-if="record.parent_id" class="text-xs mt-1">
              <a-tag color="purple">子 Key · 父 {{ parentName(record.parent_id) }}</a-tag>
            </div>
          </template>
          <template v-else-if="column.key === 'channel'">
            <a-tag v-if="record.channel === 'qwenwork'" color="cyan">仅千问</a-tag>
            <a-tag v-else-if="record.channel === 'traework'" color="purple">仅 TRAE</a-tag>
            <a-tag v-else-if="record.channel === 'dumate'" color="blue">仅搭子</a-tag>
            <a-tag v-else-if="record.channel === 'qoder'" color="geekblue">仅 Qoder</a-tag>
            <a-tag v-else color="default">不限</a-tag>
          </template>
          <template v-else-if="column.key === 'region'">
            <a-tag v-if="record.region === 'intl'" color="orange">国际</a-tag>
            <a-tag v-else-if="record.region === 'cn'" color="green">国内</a-tag>
            <span v-else class="text-xs text-slate-500">不限</span>
          </template>
          <template v-else-if="column.key === 'state'">
            <a-tag :color="stateColor(record)">{{ stateText(record) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'limits'">
            <div v-if="record.ip_allowlist.length" class="text-xs">
              IP: <span class="font-mono break-words min-w-0">{{ record.ip_allowlist.join(', ') }}</span>
            </div>
            <div v-else class="text-xs text-slate-400">IP: 不限</div>
            <div v-if="record.model_allowlist.length" class="text-xs mt-1">
              模型: <span class="font-mono break-words min-w-0">{{ record.model_allowlist.join(', ') }}</span>
            </div>
          </template>
          <template v-else-if="column.key === 'quota'">
            <div class="num" :class="quotaText(record).over ? 'text-rose-600' : ''">
              {{ quotaText(record).text }}
            </div>
            <div v-if="quotaText(record).over" class="text-xs text-rose-500">已超限 · 429 至本地零点</div>
          </template>
          <template v-else-if="column.key === 'usage'">
            <div class="num">{{ record.usage.requests }} 次</div>
            <div class="num text-xs text-slate-400">{{ compact(record.usage.total_tokens) }} tokens</div>
            <!-- 按通道拆开：同一把 key 可能两条通道都在用，合并就看不出分别跑了多少 -->
            <div v-if="record.usage.channels && Object.keys(record.usage.channels).length > 1" class="text-xs mt-1">
              <a-tag
                v-for="(v, ch) in record.usage.channels"
                :key="String(ch)"
                :color="tagFor(ch)[1]"
                class="mr-1"
              >
                {{ tagFor(ch)[0] }} <span class="num">{{ v.requests }}</span>
              </a-tag>
            </div>
            <a-tag v-if="record.usage.failed" color="red" class="mt-1">
              失败 <span class="num">{{ record.usage.failed }}</span>
            </a-tag>
          </template>
          <template v-else-if="column.key === 'expires'">
            <span :class="record.expires_at ? '' : 'text-slate-400'">
              {{ record.expires_at ? dateText(record.expires_at) : '不过期' }}
            </span>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-space>
              <a-button v-if="isAdmin" type="link" size="small" @click="openEdit(record)">编辑</a-button>
              <a-switch
                v-if="isAdmin"
                size="small"
                :checked="record.enabled"
                @change="(v: boolean) => toggle(record, v)"
              />
              <a-popconfirm v-if="isAdmin" :title="deleteHint(record)" @confirm="remove(record)">
                <a-button type="link" size="small" danger>删除</a-button>
              </a-popconfirm>
            </a-space>
          </template>
        </template>
      </a-table>

      <!-- 空态交给表格自带的 "No data"：再叠一个 a-empty 会并排出现两个空提示 -->
      <div v-if="!data?.keys.length" class="hint-text mt-2">
        还没有 API Key。{{ isAdmin ? '点右上角「新建 Key」签发第一把。' : '请联系管理员创建。' }}
      </div>
    </a-card>

    <a-modal
      v-model:open="modalOpen"
      :title="editing ? '编辑 Key' : '新建 Key'"
      :confirm-loading="saving"
      @ok="save"
    >
      <a-form layout="vertical">
        <a-form-item label="名称" required>
          <a-input v-model:value="form.name" placeholder="例如 生产环境" />
        </a-form-item>
        <a-form-item label="IP 白名单">
          <a-textarea
            v-model:value="form.ipText"
            :rows="3"
            placeholder="每行一条，如 127.0.0.1 或 10.0.0.0/8；留空表示不限制"
          />
          <div class="text-xs text-slate-500 mt-1">
            写错一条会让这把 key 拒绝**所有**来源（匹配不上任何 IP），保存前会校验
          </div>
          <a-alert v-if="ipError" type="error" :message="ipError" show-icon class="mt-2" />
        </a-form-item>
        <a-form-item label="通道绑定">
          <a-select v-model:value="form.channel" style="width: 100%" :options="channelOptions" />
          <div class="text-xs text-slate-500 mt-1">
            留空 = 不限通道（网关按模型名前缀分流）。选「仅千问办公」后，
            这把 key 只能调 <code>qwen/*</code> 模型，调搭子模型会被 403 拒绝。
          </div>
        </a-form-item>
        <a-form-item label="区域绑定">
          <a-select v-model:value="form.region" style="width: 100%" :options="regionOptions" />
          <div class="text-xs text-slate-500 mt-1">
            留空 = 不限区域。「国内/国际」只对 Qoder 与 TRAE 有区分度（按账号池
            过滤）；搭子与千问是纯国内产品，国际 key 打它们会被 403 拒绝。
            Qoder 与 TRAE 的国际版均已接入（国际 key 需先添加对应区域的账号，
            没有该区域账号时会拿到明确的报错而不是静默跑错区域）。
          </div>
        </a-form-item>
        <a-form-item label="模型白名单">
          <a-select
            v-model:value="form.models"
            mode="tags"
            style="width: 100%"
            placeholder="留空表示不限制；填写后仅允许这些模型名"
            :options="modelOptions"
          />
        </a-form-item>
        <a-form-item
          label="父 Key（子 Key 模式）"
          extra="选一个主 Key 后本 Key 成为子 Key：父 Key 停用/删除/过期时它一并失效；父 Key 的每日配额是全家共享上限，本 Key 自己的配额是额外收紧。只支持两级。"
        >
          <a-select
            v-model:value="form.parentId"
            :options="parentOptions"
            allow-clear
            placeholder="留空 = 独立 Key"
          />
        </a-form-item>
        <a-form-item label="有效期">
          <a-date-picker
            v-model:value="form.expiresAt"
            show-time
            style="width: 100%"
            placeholder="留空表示不过期"
          />
        </a-form-item>
        <a-form-item label="备注">
          <a-input v-model:value="form.note" placeholder="可选" />
        </a-form-item>
        <a-form-item label="每日配额" extra="0 = 不限。超限后该 key 的请求一律 429（客户端自动退避），本地零点重置。适合把 key 发给别人时设上限。">
          <a-space>
            <a-input-number v-model:value="form.quotaRequests" :min="0" :step="100" style="width: 130px" />
            <span class="text-xs text-slate-400">次 / 日</span>
            <a-input-number v-model:value="form.quotaTokens" :min="0" :step="10000" style="width: 150px" />
            <span class="text-xs text-slate-400">tokens / 日</span>
          </a-space>
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="tokenOpen"
      title="Key 已创建"
      :footer="null"
      :closable="false"
      :mask-closable="false"
    >
      <a-alert
        type="warning"
        show-icon
        message="key 已创建"
        description="明文已保存，之后可在列表点「查看」随时取用；建议仍立即复制保存一次。"
        class="mb-3"
      />
      <a-space-compact style="width: 100%">
        <a-input :value="newToken" readonly />
        <a-button type="primary" @click="copyToken">复制</a-button>
      </a-space-compact>
      <div class="text-right mt-4">
        <a-button @click="tokenOpen = false">我已保存</a-button>
      </div>
    </a-modal>

    <!-- 查看完整 key：明文随 key 落盘后随时可取 -->
    <a-modal v-model:open="viewOpen" title="查看 API Key" :footer="null" :width="560">
      <div class="mb-2 text-slate-400">{{ viewKey?.name }}</div>
      <a-space-compact style="width: 100%">
        <a-input :value="viewKey?.plain || ''" readonly />
        <a-button type="primary" @click="copyView">复制</a-button>
      </a-space-compact>
    </a-modal>

    <CcSwitchDialog ref="ccDlg" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import CcSwitchDialog from '@/components/CcSwitchDialog.vue'
import { App as AntApp } from 'ant-design-vue'
import dayjs, { type Dayjs } from 'dayjs'
import client from '@/api/client'
import { channelStore, isTraework, isQwenwork, isQoder, channelLabel } from '@/stores/channel'
import { isAdmin } from '@/stores/auth'
import type { ApiKey, KeysData } from '@/api/keys'

const data = ref<KeysData | null>(null)
// message 走 App.useApp() 的上下文（App.vue 已包 <a-app>），静态方法拿不到主题上下文
const { message } = AntApp.useApp()
const modelOptions = ref<Array<{ label: string; value: string }>>([])
const modalOpen = ref(false)
const ccDlg = ref<InstanceType<typeof CcSwitchDialog> | null>(null)
const tokenOpen = ref(false)
const newToken = ref('')
const saving = ref(false)
const editing = ref<ApiKey | null>(null)
const ipError = ref('')

// 通道绑定选项。留空 = 不限（兼容已有 key）
// 四条通道都要在列：Qoder 接入时这里漏过一次，表现是「key 没法只绑 Qoder」
const channelOptions = [
  { label: '不限通道', value: '' },
  { label: '仅百度搭子', value: 'dumate' },
  { label: '仅千问办公', value: 'qwenwork' },
  { label: '仅 TRAE Work', value: 'traework' },
  { label: '仅 Qoder', value: 'qoder' },
]

// 通道用量标签：channel id → [显示名, AntD 语义色]。
// 未知通道如实显示原始 id，不猜成搭子
const usageTag: Record<string, [string, string]> = {
  dumate: ['搭子', 'blue'],
  qwenwork: ['千问', 'cyan'],
  traework: ['TRAE', 'purple'],
  qoder: ['Qoder', 'geekblue'],
}
const tagFor = (ch: string | number): string[] => usageTag[String(ch)] ?? [String(ch), 'default']

// 千问与 TRAE 分开判定：两者都是直连，但前缀与额度体系不同，
// 页面上的说明文案与默认绑定值都要各自对应
const isTw = computed(() => isTraework())
const isQw = computed(() => isQwenwork())
const isQd = computed(() => isQoder())

const form = reactive({
  name: '',
  ipText: '',
  models: [] as string[],
  channel: '' as '' | 'dumate' | 'qwenwork' | 'traework' | 'qoder',
  region: '' as '' | 'cn' | 'intl',
  expiresAt: null as Dayjs | null,
  note: '',
  // 每日配额：0 = 不限（提交时 0 值字段不上送，后端 normalize 收敛成 null）
  quotaRequests: 0,
  quotaTokens: 0,
  // 父 Key id（子 Key 模式）：undefined = 独立 Key
  parentId: undefined as number | undefined,
})

// 可选父 Key：只列独立 Key（两级限制），编辑时排除自己
const parentOptions = computed(() =>
  (data.value?.keys ?? [])
    .filter((k) => !k.parent_id && k.id !== editing.value?.id)
    .map((k) => ({ label: `${k.name} (#${k.id})`, value: k.id })),
)
function parentName(id: number): string {
  const p = (data.value?.keys ?? []).find((k) => k.id === id)
  return p ? p.name : `#${id}（已删除）`
}
function childCount(k: ApiKey): number {
  return (data.value?.keys ?? []).filter((x) => x.parent_id === k.id).length
}
function deleteHint(k: ApiKey): string {
  const n = childCount(k)
  return '删除后无法恢复，使用该 key 的客户端会立即失败'
    + (n ? `；它的 ${n} 个子 Key 也会一并失效` : '')
}

const regionOptions = [
  { label: '不限区域', value: '' },
  { label: '仅国内（cn）', value: 'cn' },
  { label: '仅国际（intl）', value: 'intl' },
]

const columns = [
  { title: '名称', key: 'name', width: '15%' },
  { title: '通道', key: 'channel', width: '8%' },
  { title: '区域', key: 'region', width: '7%' },
  { title: '状态', key: 'state', width: '8%' },
  { title: '限制', key: 'limits', width: '17%' },
  { title: '今日/限额', key: 'quota', width: '15%' },
  { title: '用量', key: 'usage', width: '16%' },
  { title: '有效期', key: 'expires', width: '10%' },
  { title: '操作', key: 'action', width: '15%' },
]

// 配额列：今日用量 vs 每日限额。超限红色（网关正在对该 key 回 429）。
function quotaText(k: ApiKey) {
  const lim = k.daily_limit
  const used = k.quota_today || { requests: 0, tokens: 0 }
  if (!lim || (!lim.requests && !lim.tokens)) {
    return { used, over: false, text: `${used.requests} 次 · 不限` }
  }
  const parts: string[] = []
  let over = false
  if (lim.requests) {
    parts.push(`${used.requests}/${lim.requests} 次`)
    if (used.requests >= lim.requests) over = true
  }
  if (lim.tokens) {
    parts.push(`${compact(used.tokens)}/${compact(lim.tokens)} tok`)
    if (used.tokens >= lim.tokens) over = true
  }
  return { used, over, text: parts.join(' · ') }
}

const compact = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)
const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN')

function stateText(k: ApiKey) {
  if (!k.enabled) return '已停用'
  if (k.expires_at && Date.now() > k.expires_at) return '已过期'
  return '启用中'
}
function stateColor(k: ApiKey) {
  if (!k.enabled) return 'default'
  if (k.expires_at && Date.now() > k.expires_at) return 'red'
  return 'green'
}

const ipList = computed(() =>
  form.ipText.split('\n').map((s) => s.trim()).filter(Boolean),
)

async function load() {
  // 列表全量（2026-11-01 用户要求）：API Key 管理页显示所有 key，
  // 不再随顶栏通道切换过滤——通道归属在「通道」列一眼可见
  const { data: d } = await client.get('/keys')
  data.value = d
  try {
    const { data: g } = await client.get('/models/gateway-list')
    modelOptions.value = (g.data || []).map((m: any) => ({ label: m.id, value: m.id }))
  } catch (e) { /* 网关没起也不影响 key 管理 */ }
}

function openCreate() {
  editing.value = null
  form.name = ''
  form.ipText = ''
  form.models = []
  // 在千问/TRAE 通道下新建，默认绑定到该通道——用户在这一页点「新建」，
  // 想要的显然是能调该通道模型的 key
  form.channel = isQw.value ? 'qwenwork' : isTw.value ? 'traework' : isQd.value ? 'qoder' : ''
  form.expiresAt = null
  form.note = ''
  form.quotaRequests = 0
  form.quotaTokens = 0
  form.parentId = undefined
  ipError.value = ''
  modalOpen.value = true
}

function openEdit(k: ApiKey) {
  editing.value = k
  form.name = k.name
  form.ipText = k.ip_allowlist.join('\n')
  form.models = [...k.model_allowlist]
  form.channel = (k.channel || '') as '' | 'dumate' | 'qwenwork' | 'traework' | 'qoder'
  form.expiresAt = k.expires_at ? dayjs(k.expires_at) : null
  form.note = k.note || ''
  form.quotaRequests = k.daily_limit?.requests || 0
  form.quotaTokens = k.daily_limit?.tokens || 0
  form.parentId = k.parent_id || undefined
  ipError.value = ''
  modalOpen.value = true
}

async function save() {
  ipError.value = ''
  if (!form.name.trim()) {
    message.error('名称不能为空')
    return
  }
  const items = ipList.value
  if (items.length) {
    const { data: check } = await client.post('/keys/check-ip', { items })
    const bad = check.results.filter((r: any) => !r.ok)
    if (bad.length) {
      ipError.value = bad.map((b: any) => b.reason).join('；')
      return
    }
  }

  const payload: any = {
    name: form.name.trim(),
    ip_allowlist: items,
    model_allowlist: form.models,
    channel: form.channel,
    region: form.region,
    note: form.note,
    expires_at: form.expiresAt ? form.expiresAt.valueOf() : null,
    // 0 值字段不上送——后端 normalize 把缺省收敛成 null（不限）
    daily_limit: {
      ...(form.quotaRequests > 0 ? { requests: form.quotaRequests } : {}),
      ...(form.quotaTokens > 0 ? { tokens: form.quotaTokens } : {}),
    },
    // 父 Key（子 Key 模式）：null = 独立 Key
    parent_id: form.parentId ?? null,
  }

  saving.value = true
  try {
    if (editing.value) {
      await client.patch(`/keys/${editing.value.id}`, payload)
      message.success('已保存')
    } else {
      const { data: created } = await client.post('/keys', payload)
      newToken.value = created.token
      tokenOpen.value = true
    }
    modalOpen.value = false
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function toggle(k: ApiKey, v: boolean) {
  await client.patch(`/keys/${k.id}`, { enabled: v })
  message.success(v ? '已启用' : '已停用')
  await load()
}

async function remove(k: ApiKey) {
  await client.delete(`/keys/${k.id}`)
  message.success('已删除')
  await load()
}

const viewOpen = ref(false)
const viewKey = ref<ApiKey | null>(null)
function openView(k: ApiKey) {
  viewKey.value = k
  viewOpen.value = true
}
async function copyView() {
  try {
    await navigator.clipboard.writeText(viewKey.value?.plain || '')
    message.success('已复制到剪贴板')
  } catch (e) {
    message.warning('复制失败，请手动选中复制')
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(newToken.value)
    message.success('已复制到剪贴板')
  } catch (e) {
    message.warning('复制失败，请手动选中复制')
  }
}

onMounted(load)
</script>
