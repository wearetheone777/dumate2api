<template>
  <a-card :bordered="false">
    <div class="card-head-row">
      <div>
        <span class="section-title">会话浏览器</span>
        <span class="hint-text ml-2">
          网页端只读查询 · 不消耗额度{{ data?.account ? ` · 账号：${data.account}` : '' }}
        </span>
      </div>
      <a-space>
        <a-button size="small" :loading="loading" @click="loadAll">刷新</a-button>
      </a-space>
    </div>

    <a-alert v-if="error" type="warning" show-icon class="mb-3">
      <template #message>{{ error }}</template>
    </a-alert>

    <a-tabs v-model:active-key="tab" size="small">
      <!-- ============ 会话：主表，行展开看元数据 ============ -->
      <a-tab-pane key="sessions" :tab="`会话（${sessions.length}）`">
        <a-table
          size="small"
          :data-source="sessions"
          :columns="sessionColumns"
          :loading="loading"
          row-key="id"
          :pagination="{ pageSize: 10, showSizeChanger: false }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'title'">
              <span class="font-medium">{{ record.title || '(无标题)' }}</span>
              <a-tag v-if="record.isPinned" color="blue" class="ml-1">置顶</a-tag>
              <a-tag v-if="record.isSubagent" class="ml-1">子代理</a-tag>
            </template>
            <template v-else-if="column.key === 'updated'">
              {{ fmtTime(record.updated) }}
            </template>
            <template v-else-if="column.key === 'diff'">
              <span v-if="record.summary" class="font-mono text-xs">
                <span class="text-emerald-600">+{{ record.summary.additions ?? '?' }}</span>
                <span class="text-slate-300 mx-1">/</span>
                <span class="text-rose-600">-{{ record.summary.deletions ?? '?' }}</span>
              </span>
              <span v-else class="text-slate-300">—</span>
            </template>
            <template v-else-if="column.key === 'ops'">
              <a-button
                v-if="record.directory"
                type="link"
                size="small"
                @click="openLocalFiles(record)"
              >文件</a-button>
              <span v-else class="text-slate-300 text-xs">—</span>
            </template>
          </template>
          <template #expandedRowRender="{ record }">
            <a-descriptions size="small" :column="2" class="max-w-3xl">
              <a-descriptions-item label="会话 ID"><span class="font-mono text-xs">{{ record.id || '—' }}</span></a-descriptions-item>
              <a-descriptions-item label="slug"><span class="font-mono text-xs">{{ record.slug || '—' }}</span></a-descriptions-item>
              <a-descriptions-item label="类型">{{ record.type || '—' }}</a-descriptions-item>
              <a-descriptions-item label="来源">{{ record.source || '—' }}</a-descriptions-item>
              <a-descriptions-item label="执行环境">{{ record.execEnv || '—' }}</a-descriptions-item>
              <a-descriptions-item label="自动档位">{{ record.autoModelLevel || '—' }}</a-descriptions-item>
              <a-descriptions-item label="项目 ID">{{ record.projectId || '—' }}</a-descriptions-item>
              <a-descriptions-item label="创建时间">{{ fmtTime(record.created) }}</a-descriptions-item>
              <a-descriptions-item label="本机目录" :span="2">
                <span class="font-mono text-xs break-all">{{ record.directory || '—' }}</span>
              </a-descriptions-item>
            </a-descriptions>
            <div class="text-xs text-slate-400 mt-1">
              目录是发起会话那台机器的本机路径，换机器即失效；消息历史只存在本机
              （<code>~/.qianfan/workspace/</code>），上游没有拉取接口。
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ============ 项目：多数账号为空数组，空是真实结果 ============ -->
      <a-tab-pane key="projects" :tab="`项目（${projects.length}）`">
        <a-empty v-if="!projects.length" description="没有项目（空列表是上游真实返回）" />
        <a-table
          v-else
          size="small"
          :data-source="projects"
          :columns="genericColumns"
          row-key="__i"
          :pagination="false"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'raw'">
              <span class="font-mono text-xs break-all">{{ JSON.stringify(record) }}</span>
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ============ MCP connector：已装 + 官方模板 ============ -->
      <a-tab-pane key="connectors" :tab="`Connector（已装 ${connectors.length} / 模板 ${templates.length}）`">
        <a-empty v-if="!connectors.length && !templates.length" description="没有 connector 数据" />
        <template v-else>
          <div v-if="connectors.length" class="mb-4">
            <div class="text-sm font-medium mb-2">已安装</div>
            <a-table
              size="small"
              :data-source="connectors"
              :columns="connectorColumns"
              row-key="id"
              :pagination="false"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'name'">
                  <span class="font-medium">{{ record.name || record.code }}</span>
                  <div v-if="record.remark" class="text-xs text-slate-400">{{ record.remark }}</div>
                </template>
                <template v-else-if="column.key === 'status'">
                  <a-tag :color="record.enabled ? 'green' : 'default'">{{ record.enabled ? '启用' : '停用' }}</a-tag>
                  <a-tag v-if="record.connectionStatus" class="ml-1">{{ record.connectionStatus }}</a-tag>
                </template>
                <template v-else-if="column.key === 'serverUrl'">
                  <span class="font-mono text-xs break-all">{{ record.serverUrl || '—' }}</span>
                </template>
              </template>
            </a-table>
          </div>
          <div v-if="templates.length">
            <div class="text-sm font-medium mb-2">官方模板（<span class="text-slate-400">{{ templates.length }} 个，接入方式在备注里）</span></div>
            <a-table
              size="small"
              :data-source="templates"
              :columns="connectorColumns"
              row-key="id"
              :pagination="{ pageSize: 10, showSizeChanger: false }"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'name'">
                  <span class="font-medium">{{ record.name || record.code }}</span>
                  <div v-if="record.remark" class="text-xs text-slate-400">{{ record.remark }}</div>
                </template>
                <template v-else-if="column.key === 'status'">
                  <a-tag v-if="record.transProtocol">{{ record.transProtocol }}</a-tag>
                  <a-tag v-if="record.authType && record.authType !== 'none'" color="orange">{{ record.authType }}</a-tag>
                </template>
                <template v-else-if="column.key === 'serverUrl'">
                  <span class="font-mono text-xs break-all">{{ record.serverUrl || '—' }}</span>
                </template>
              </template>
            </a-table>
          </div>
        </template>
      </a-tab-pane>
    </a-tabs>

    <!-- 本地工作目录浏览：会话产物文件（markdown 章节 / outline 等）。
         不是对话消息——消息本体没有本地明文，标题如实叫「工作目录」。 -->
    <a-drawer
      v-model:open="localOpen"
      :title="`工作目录：${localSession?.title || ''}`"
      width="640"
    >
      <a-alert type="info" show-icon class="mb-3">
        <template #message>这里是会话的工作产物</template>
        <template #description>
          对话消息本身没有本地明文（上游接口也不提供拉取）；目录与文件内容只读，穿越保护已锚定在会话工作区根下。
        </template>
      </a-alert>
      <div v-if="localDir" class="text-xs text-slate-400 font-mono break-all mb-2">{{ localDir }}</div>
      <a-spin :spinning="localLoading">
        <a-alert v-if="localError" type="warning" show-icon class="mb-3" :message="localError" />
        <a-table
          v-if="!preview"
          size="small"
          :data-source="localEntries"
          :columns="localColumns"
          row-key="name"
          :pagination="false"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <a-button
                v-if="record.is_dir"
                type="link" size="small" class="px-0"
                @click="enterLocalDir(record.name)"
              >📁 {{ record.name }}</a-button>
              <a-button
                v-else-if="record.readable"
                type="link" size="small" class="px-0"
                @click="previewLocalFile(record.name)"
              >📄 {{ record.name }}</a-button>
              <span v-else class="text-slate-400">{{ record.name }}</span>
            </template>
            <template v-else-if="column.key === 'size'">
              {{ record.is_dir ? '—' : fmtSize(record.size) }}
            </template>
            <template v-else-if="column.key === 'mtime'">
              {{ fmtTime(record.mtime) }}
            </template>
          </template>
        </a-table>
        <template v-else>
          <div class="flex items-center justify-between mb-2">
            <a-space>
              <a-button v-if="relStack.length" size="small" @click="backLocalDir">← 上级目录</a-button>
              <a-button size="small" @click="preview = null">返回文件列表</a-button>
            </a-space>
            <span class="font-mono text-xs">{{ preview.name }}</span>
          </div>
          <pre class="text-xs bg-slate-50 dark:bg-slate-800 rounded p-3 overflow-auto max-h-[70vh] whitespace-pre-wrap">{{ preview.text }}</pre>
        </template>
      </a-spin>
    </a-drawer>
  </a-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  dumateApi,
  type DumateSession,
  type DumateConnector,
  type DumateSessionsResp,
  type DumateProjectsResp,
  type DumateConnectorsResp,
  type DumateTemplatesResp,
  type LocalFileEntry,
} from '@/api/dumate'

// 后端三处查询互相独立（sessions/projects/connectors 各自 pickCookieAccount），
// 一个失败不影响其余——catch 成空对象，Tab 上显示数量 0 而不是整卡空白。
const loading = ref(false)
const error = ref('')
const tab = ref('sessions')
const data = ref<DumateSessionsResp | null>(null)
const sessions = ref<DumateSession[]>([])
const projects = ref<Array<Record<string, unknown>>>([])
const connectors = ref<DumateConnector[]>([])
const templates = ref<DumateConnector[]>([])

const sessionColumns = [
  { title: '标题', key: 'title', ellipsis: true },
  { title: '更新时间', key: 'updated', width: 150 },
  { title: '来源', dataIndex: 'source', width: 90 },
  { title: '代码改动', key: 'diff', width: 130 },
  { title: '工作目录', key: 'ops', width: 90 },
]
// 项目行上游字段形状不定（多数账号为空）——一列 JSON 兜底，有结构了再拆列
const genericColumns = [{ title: '数据', key: 'raw', ellipsis: true }]
const connectorColumns = [
  { title: '名称', key: 'name', ellipsis: true },
  { title: '状态', key: 'status', width: 160 },
  { title: '服务地址', key: 'serverUrl', ellipsis: true },
]

const fmtTime = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

async function loadAll() {
  loading.value = true
  error.value = ''
  const [s, p, c, t] = await Promise.all([
    dumateApi.sessions().catch((e) => errShape<DumateSessionsResp>(e)),
    dumateApi.projects().catch((e) => errShape<DumateProjectsResp>(e)),
    dumateApi.connectors().catch((e) => errShape<DumateConnectorsResp>(e)),
    dumateApi.connectorTemplates().catch((e) => errShape<DumateTemplatesResp>(e)),
  ])
  data.value = s
  error.value = s.error || p.error || c.error || t.error || ''
  sessions.value = s.sessions || []
  projects.value = (p.projects || []).map((row, i) => ({ ...row, __i: i }))
  connectors.value = c.connectors || []
  templates.value = t.templates || []
  loading.value = false
}

// 后端错误形态（{ ok:false, error } 在 200 里返回）与 HTTP 失败统一成空形状
function errShape<T extends { ok: boolean; error?: string }>(e: any): T {
  const msg = e?.response?.data?.error || e?.message || '请求失败'
  return { ok: false, error: msg } as T
}

// ── 本地工作目录浏览 ──
// 锚定在后端做（safeLocalPath，穿越拒绝）；前端只带 dir + 相对路径。
const localOpen = ref(false)
const localLoading = ref(false)
const localSession = ref<DumateSession | null>(null)
const localDir = ref('')
const localEntries = ref<LocalFileEntry[]>([])
const localError = ref('')
const preview = ref<{ name: string; text: string } | null>(null)

const localColumns = [
  { title: '文件', key: 'name', ellipsis: true },
  { title: '大小', key: 'size', width: 90 },
  { title: '修改时间', key: 'mtime', width: 150 },
]

const fmtSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`

async function openLocalFiles(session: DumateSession) {
  localSession.value = session
  localOpen.value = true
  preview.value = null
  relStack.value = []
  await loadLocalDir(session.directory || '')
}

async function loadLocalDir(dir: string, rel = '') {
  localLoading.value = true
  localError.value = ''
  try {
    const r = await dumateApi.localFiles(rel ? `${dir}/${rel}` : dir)
    // 子目录进入：后端锚定校验的是**完整路径**，相对路径直接拼进 dir 传
    if (r.ok) {
      localDir.value = r.dir || dir
      localEntries.value = r.entries || []
    } else {
      localError.value = r.error || '读取失败'
      localEntries.value = []
    }
  } catch (e: any) {
    localError.value = e?.response?.data?.error || e?.message || '读取失败'
  } finally {
    localLoading.value = false
  }
}

function enterLocalDir(name: string) {
  if (!localSession.value) return
  // 相对路径拼接由后端 resolve 校验——这里只负责拼字符串
  const cur = currentRelPath.value
  const next = cur ? `${cur}/${name}` : name
  relStack.value.push(next)
  loadLocalDir(localSession.value.directory || '', next)
}

function previewLocalFile(name: string) {
  if (!localSession.value) return
  const rel = currentRelPath.value ? `${currentRelPath.value}/${name}` : name
  localLoading.value = true
  dumateApi.readLocalFile(localSession.value.directory || '', rel).then((r) => {
    if (r.ok && r.text != null) {
      preview.value = { name: r.name || name, text: r.text }
    } else {
      localError.value = r.error || '读取失败'
    }
  }).catch((e: any) => {
    localError.value = e?.response?.data?.error || e?.message || '读取失败'
  }).finally(() => { localLoading.value = false })
}

// 相对路径栈：进入子目录 push，返回列表 pop——比字符串切割可靠
const relStack = ref<string[]>([])
const currentRelPath = computed(() => relStack.value[relStack.value.length - 1] || '')

function backLocalDir() {
  relStack.value.pop()
  preview.value = null
  if (localSession.value) loadLocalDir(localSession.value.directory || '', currentRelPath.value)
}

onMounted(loadAll)
defineExpose({ loadAll })
</script>
