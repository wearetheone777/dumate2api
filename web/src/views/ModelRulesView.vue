<template>
  <div class="page">
    <PageHeader title="模型规则" sub="按账号 deny / allow — 改规则内容，所有挂了它的账号一起生效（mtime 热读，无需重启）">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="loadAll">刷新</a-button>
        <a-button v-if="isAdmin" type="primary" size="small" @click="openCreate">新建规则</a-button>
      </template>
    </PageHeader>

    <a-alert type="info" show-icon class="mb-3">
      <template #message>deny 黑名单 / allow 白名单 · 多条并集 · deny 优先</template>
      <template #description>
        <div>
          模型名可带 <code>cn:</code> / <code>global:</code> 前缀（裸名 = 两个域都命中；
          <code>global:hy4std</code> 与裸名 <code>hy4std</code> 是两个条目）。
          白名单规则在账号所属域<b>一个模型都没命中</b>时视作没挂——防跨域误挂把号封死。
        </div>
        <div class="mt-1">
          全部候选账号都被拦时网关回 <b>400 model_not_allowed</b>（不回 503：规则不会自愈，503 会被客户端当上游抖动重试白打）。
          <code>auto</code> 档位不做规则判断（实际模型由账号决定）。
        </div>
      </template>
    </a-alert>

    <a-alert v-if="err" type="warning" show-icon class="mb-3" :message="err" />

    <!-- ========= 规则列表 ========= -->
    <a-card :bordered="false" title="规则" class="mb-4">
      <a-table
        :data-source="rules"
        :columns="ruleCols"
        :loading="loading"
        row-key="id"
        size="small"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'mode'">
            <a-tag :color="record.mode === 'deny' ? 'red' : 'green'">
              {{ record.mode === 'deny' ? 'deny 禁用' : 'allow 白名单' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'models'">
            <a-tag v-for="m in record.models" :key="m" class="mono" style="margin: 1px">{{ m }}</a-tag>
          </template>
          <template v-else-if="column.key === 'counts'">
            <span class="num">{{ counts[record.id] || 0 }}</span> 个账号
          </template>
          <template v-else-if="column.key === 'updatedAt'">
            <span class="num">{{ timeText(record.updatedAt) }}</span>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-space :size="4">
              <a-button size="small" class="ghost-btn" @click="openEdit(record)">编辑</a-button>
              <a-button size="small" class="ghost-btn" @click="openApply(record)">应用到账号</a-button>
              <a-popconfirm title="删除规则会从所有账号上摘掉引用，确定？" @confirm="removeRule(record)">
                <a-button size="small" danger class="ghost-btn">删除</a-button>
              </a-popconfirm>
            </a-space>
          </template>
        </template>
      </a-table>
      <div v-if="!loading && !rules.length" class="text-xs text-slate-400 mt-2">
        还没有任何规则。新建一条 → 编辑模型清单 → 「应用到账号」或到下面的账号表里逐个挂载。
      </div>
    </a-card>

    <!-- ========= 账号挂载 ========= -->
    <a-card :bordered="false" title="账号挂载" class="mb-4">
      <template #extra>
        <span class="text-xs text-slate-400">每个账号可挂多条规则；「配置」是整体替换</span>
      </template>
      <a-table
        :data-source="accounts"
        :columns="accCols"
        :loading="loading"
        row-key="id"
        size="small"
        :pagination="false"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'account'">
            <span>{{ record.nickname || record.uid || `账号 ${record.id}` }}</span>
            <a-tag :color="record.region === 'global' ? 'purple' : 'blue'" style="margin-left: 6px">
              {{ record.region === 'global' ? '国际' : '国内' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'rules'">
            <template v-if="ruleIdsOf(record.id).length">
              <a-tag
                v-for="r in ruleNamesOf(record.id)"
                :key="r.id"
                :color="r.mode === 'deny' ? 'red' : 'green'"
                style="margin: 1px"
              >{{ r.name }}</a-tag>
            </template>
            <span v-else class="text-xs text-slate-400">未挂规则（不受模型限制）</span>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-button size="small" class="ghost-btn" @click="openAssign(record)">配置</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- ========= 规则编辑弹窗 ========= -->
    <a-modal
      v-model:open="editOpen"
      :title="editing ? '编辑规则' : '新建规则'"
      :confirm-loading="saving"
      @ok="saveRule"
      @cancel="editOpen = false"
      ok-text="保存"
      cancel-text="取消"
    >
      <div class="space-y-3" style="max-width: 520px">
        <label class="field-line block">
          <span class="text-xs text-slate-400">规则名（≤40 字）</span>
          <a-input v-model:value="form.name" placeholder="如：贵模型白名单" :maxlength="40" />
        </label>
        <div class="field-line">
          <span class="text-xs text-slate-400">模式</span>
          <a-radio-group v-model:value="form.mode">
            <a-radio value="deny">deny 黑名单（名单内的模型不可用）</a-radio>
            <a-radio value="allow">allow 白名单（只有名单内的可用）</a-radio>
          </a-radio-group>
        </div>
        <label class="field-line block">
          <span class="text-xs text-slate-400">
            模型清单（可从目录选，也可手输；前缀 <code>cn:</code> / <code>global:</code> 手输）
          </span>
          <a-select
            v-model:value="form.models"
            mode="tags"
            style="width: 100%"
            :options="modelOptions"
            placeholder="选或输模型名"
            :max-tag-count="12"
          />
          <div class="text-xs text-slate-400 mt-1">
            至少一个；去重按整串比对，<code>global:hy4std</code> 与 <code>hy4std</code> 不合并。
          </div>
        </label>
        <label class="field-line block">
          <span class="text-xs text-slate-400">备注（可选）</span>
          <a-input v-model:value="form.note" placeholder="为什么建这条规则" />
        </label>
      </div>
    </a-modal>

    <!-- ========= 账号挂载弹窗（整体替换） ========= -->
    <a-modal
      v-model:open="assignOpen"
      :title="`配置挂载 — ${assignTarget ? assignTarget.nickname || ('账号 ' + assignTarget.id) : ''}`"
      :confirm-loading="saving"
      @ok="saveAssign"
      @cancel="assignOpen = false"
      ok-text="保存"
      cancel-text="取消"
    >
      <div class="text-xs text-slate-400 mb-2">
        保存后该账号挂的规则就是这个集合（整体替换）；不选 = 全摘、不受模型限制。
      </div>
      <a-select
        v-model:value="assignIds"
        mode="multiple"
        style="width: 100%"
        :options="ruleOptions"
        placeholder="选择挂到该账号的规则"
      />
    </a-modal>

    <!-- ========= 规则批量应用弹窗（只增删这一条） ========= -->
    <a-modal
      v-model:open="applyOpen"
      :title="`应用到账号 — ${applyTarget ? applyTarget.name : ''}`"
      :confirm-loading="saving"
      @cancel="applyOpen = false"
    >
      <div class="text-xs text-slate-400 mb-2">
        只增删这一条规则，账号原有的其它规则原样保留；已是目标状态的账号不计入、不落盘。
      </div>
      <div class="max-h-72 overflow-auto">
        <a-checkbox-group v-model:value="applyIds" style="display: flex; flex-direction: column; gap: 6px">
          <a-checkbox v-for="a in accounts" :key="a.id" :value="a.id">
            {{ a.nickname || a.uid || `账号 ${a.id}` }}
            <a-tag :color="a.region === 'global' ? 'purple' : 'blue'" style="margin-left: 4px">
              {{ a.region === 'global' ? '国际' : '国内' }}
            </a-tag>
          </a-checkbox>
        </a-checkbox-group>
      </div>
      <template #footer>
        <a-button @click="applyOpen = false">取消</a-button>
        <a-button danger :loading="saving" @click="saveApply(false)">从勾选账号摘除</a-button>
        <a-button type="primary" :loading="saving" @click="saveApply(true)">挂到勾选账号</a-button>
      </template>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
// 模型规则页（批次十三）：规则 CRUD + 账号挂载 + 单规则批量应用。
// 后端在 /api/admin/workbuddy/model-rules（批次十二），mtime 热读、零重启生效。
// 本页只对 workbuddy 通道 + admin 可见（路由 meta.adminOnly + 菜单条件同 TRAE 运行策略）。
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import { isAdmin } from '@/stores/auth'
import { workbuddyApi, type WorkBuddyAccount, type WorkBuddyModelRule } from '@/api/workbuddy'
import { type WorkBuddyModel } from '@/api/workbuddy'

const loading = ref(false)
const err = ref('')
const saving = ref(false)

const rules = ref<WorkBuddyModelRule[]>([])
const counts = ref<Record<string, number>>({})
const assignments = ref<Record<string, string[]>>({})
const accounts = ref<WorkBuddyAccount[]>([])
const catalog = ref<WorkBuddyModel[]>([])

// 目录选项：cn + global 两份目录合并去重（裸名两域命中，是默认推荐形态）
const modelOptions = computed(() => {
  const seen = new Set<string>()
  const out: { value: string; label: string }[] = []
  for (const m of catalog.value) {
    if (!m.id || seen.has(m.id)) continue
    seen.add(m.id)
    out.push({ value: m.id, label: m.free ? `${m.id}（免费）` : m.id })
  }
  return out
})

const ruleOptions = computed(() =>
  rules.value.map((r) => ({ value: r.id, label: `${r.name}（${r.mode === 'deny' ? '禁用' : '白名单'}）` })),
)

function ruleIdsOf(accId: number): string[] {
  return assignments.value[String(accId)] || []
}
function ruleNamesOf(accId: number) {
  return ruleIdsOf(accId)
    .map((id) => rules.value.find((r) => r.id === id))
    .filter(Boolean)
    .map((r) => ({ id: r!.id, name: r!.name, mode: r!.mode }))
}

function timeText(v: string): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString()
}

const ruleCols = [
  { key: 'name', dataIndex: 'name', title: '规则名' },
  { key: 'mode', title: '模式', width: 130 },
  { key: 'models', title: '模型清单' },
  { key: 'counts', title: '挂载', width: 90 },
  { key: 'updatedAt', title: '更新时间', width: 150 },
  { key: 'action', title: '', width: 240 },
]

const accCols = [
  { key: 'account', title: '账号' },
  { key: 'rules', title: '已挂规则' },
  { key: 'action', title: '', width: 90 },
]

async function loadAll() {
  loading.value = true
  err.value = ''
  try {
    const [rulesRes, accRes, cn, gl] = await Promise.all([
      workbuddyApi.modelRules(),
      workbuddyApi.status(),
      workbuddyApi.models({ region: 'cn' }).catch(() => ({ data: { models: [] as WorkBuddyModel[] } })),
      workbuddyApi.models({ region: 'intl' }).catch(() => ({ data: { models: [] as WorkBuddyModel[] } })),
    ])
    rules.value = rulesRes.data.rules || []
    counts.value = rulesRes.data.counts || {}
    assignments.value = rulesRes.data.assignments || {}
    accounts.value = accRes.data.rows || []
    catalog.value = [...(cn.data.models || []), ...(gl.data.models || [])]
  } catch (e: any) {
    err.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

// ---- 规则编辑 ----
const editOpen = ref(false)
const editing = ref<WorkBuddyModelRule | null>(null)
const form = reactive<{ id?: string; name: string; mode: 'deny' | 'allow'; models: string[]; note: string }>({
  name: '',
  mode: 'deny',
  models: [],
  note: '',
})

function openCreate() {
  editing.value = null
  form.id = undefined
  form.name = ''
  form.mode = 'deny'
  form.models = []
  form.note = ''
  editOpen.value = true
}

function openEdit(r: WorkBuddyModelRule) {
  editing.value = r
  form.id = r.id
  form.name = r.name
  form.mode = r.mode
  form.models = [...r.models]
  form.note = r.note || ''
  editOpen.value = true
}

async function saveRule() {
  if (!form.name.trim()) {
    message.error('规则名不能为空')
    return
  }
  if (!form.models.length) {
    message.error('至少要勾选一个模型')
    return
  }
  saving.value = true
  try {
    await workbuddyApi.saveModelRule({
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      mode: form.mode,
      models: form.models.map((x) => x.trim()).filter(Boolean),
      note: form.note.trim() || undefined,
    })
    message.success('已保存')
    editOpen.value = false
    await loadAll()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function removeRule(r: WorkBuddyModelRule) {
  try {
    await workbuddyApi.deleteModelRule(r.id)
    message.success('已删除（引用已从账号上摘掉）')
    await loadAll()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '删除失败')
  }
}

// ---- 账号挂载（整体替换） ----
const assignOpen = ref(false)
const assignTarget = ref<WorkBuddyAccount | null>(null)
const assignIds = ref<string[]>([])

function openAssign(a: WorkBuddyAccount) {
  assignTarget.value = a
  assignIds.value = [...ruleIdsOf(a.id)]
  assignOpen.value = true
}

async function saveAssign() {
  if (!assignTarget.value) return
  saving.value = true
  try {
    await workbuddyApi.assignModelRules(assignTarget.value.id, assignIds.value)
    message.success(assignIds.value.length ? '已保存挂载' : '已全部摘除')
    assignOpen.value = false
    await loadAll()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

// ---- 单规则批量应用 ----
const applyOpen = ref(false)
const applyTarget = ref<WorkBuddyModelRule | null>(null)
const applyIds = ref<number[]>([])

function openApply(r: WorkBuddyModelRule) {
  applyTarget.value = r
  // 预勾当前挂着这条的账号，改起来是「在现状基础上增删」
  applyIds.value = Object.entries(assignments.value)
    .filter(([, ids]) => ids.includes(r.id))
    .map(([accId]) => Number(accId))
  applyOpen.value = true
}

async function saveApply(assigned: boolean) {
  if (!applyTarget.value) return
  saving.value = true
  try {
    const { data } = await workbuddyApi.applyModelRule(applyTarget.value.id, applyIds.value, assigned)
    message.success(`${assigned ? '已挂载' : '已摘除'}，变化 ${data.changed} 个账号`)
    applyOpen.value = false
    await loadAll()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '应用失败')
  } finally {
    saving.value = false
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
