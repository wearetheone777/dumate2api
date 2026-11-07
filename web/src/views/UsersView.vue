<template>
  <div class="page">
    <PageHeader title="账户管理" sub="管理端多账户：admin 全权限，viewer 只读" />

    <a-alert type="info" show-icon class="mb-3">
      <template #message>角色权限</template>
      <template #description>
        <b>admin</b>：全部操作，含查看/复制完整 API key。<b>viewer</b>：只读——
        可以看仪表盘、用量、模型、key 列表（名称与前缀），但看不到完整 key，
        所有写操作（创建/编辑/删除/签到/发消息）服务端一律拒绝。
        至少保留一个 admin；不能删除当前登录的账户。
      </template>
    </a-alert>

    <a-card :bordered="false" title="账户">
      <template #extra>
        <a-button type="primary" size="small" @click="openCreate">新建账户</a-button>
      </template>
      <a-table
        size="small"
        :pagination="false"
        :columns="columns"
        :data-source="users"
        row-key="username"
        :loading="loading"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'username'">
            <span>{{ record.username }}</span>
            <a-tag v-if="record.username === me" color="blue" class="ml-2">当前登录</a-tag>
          </template>
          <template v-else-if="column.key === 'role'">
            <a-tag :color="record.role === 'admin' ? 'gold' : 'default'">
              {{ record.role === 'admin' ? '管理员' : '只读' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'created_at'">
            <span class="num">{{ fmtTime(record.created_at) }}</span>
          </template>
          <template v-else-if="column.key === 'ops'">
            <a-button type="link" size="small" @click="openPassword(record)">改密码</a-button>
            <a-button
              v-if="record.role === 'viewer'"
              type="link" size="small"
              :disabled="record.username === me"
              @click="setRole(record, 'admin')"
            >提升为管理员</a-button>
            <a-button
              v-else
              type="link" size="small"
              :disabled="record.username === me"
              title="不能降级最后一个管理员"
              @click="setRole(record, 'viewer')"
            >降为只读</a-button>
            <a-popconfirm title="删除后该账户立即无法登录，确定？" @confirm="removeUser(record)">
              <a-button type="link" size="small" danger :disabled="record.username === me">删除</a-button>
            </a-popconfirm>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- 审计日志（admin-only，viewer 会 403）：auth.audit 在 15+ 处埋点，
         此前只有落盘没有读取口。倒序展示 + 动作/操作人筛选。 -->
    <a-card v-if="isAdmin" :bordered="false" title="审计日志" class="mt-4">
      <template #extra>
        <a-space>
          <a-select
            v-model:value="auditAction"
            size="small"
            allow-clear
            placeholder="全部动作"
            style="width: 180px"
            :options="auditActions.map((a) => ({ label: a, value: a }))"
          />
          <a-input v-model:value="auditActor" size="small" placeholder="操作人" style="width: 120px" allow-clear />
          <a-button size="small" :loading="auditLoading" @click="loadAudit">刷新</a-button>
        </a-space>
      </template>
      <a-table
        size="small"
        :columns="auditColumns"
        :data-source="auditRows"
        row-key="__i"
        :loading="auditLoading"
        :pagination="{ pageSize: 15, showSizeChanger: false }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <span class="num">{{ fmtTime(record.ts) }}</span>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-tag :color="auditTagColor(record.action)">{{ record.action }}</a-tag>
          </template>
          <template v-else-if="column.key === 'detail'">
            <span class="text-xs break-all">{{ record.detail || '—' }}</span>
          </template>
        </template>
      </a-table>
      <div class="text-xs text-slate-400 mt-2">共 {{ auditTotal }} 条 · 展示最近 {{ auditRows.length }} 条</div>
    </a-card>

    <!-- 运维动作（admin-only，清单项 11/13/14）：每个写操作都落审计 -->
    <a-card v-if="isAdmin" :bordered="false" title="运维动作" class="mt-4">
      <a-alert type="warning" show-icon class="mb-3">
        <template #message>这些是写操作，按下去立即生效</template>
        <template #description>
          池复位会把冷却/熔断/禁用的账号全部拉回健康——只在你确认是「误伤」时用；
          日常恢复走保活的余额解冻闭环（仪表盘 → 排程设置）。
        </template>
      </a-alert>
      <a-descriptions size="small" :column="1" class="max-w-2xl mb-3">
        <a-descriptions-item label="桌面客户端版本">
          <a-tag color="blue">{{ dupeVersion || '读取中…' }}</a-tag>
          <span class="text-xs text-slate-400 ml-2">客户端自动升级会改变端点行为，升级后请复核模型探测与端口假设</span>
        </a-descriptions-item>
      </a-descriptions>
      <a-space wrap>
        <a-popconfirm title="把所有冷却/熔断/禁用账号复位为健康？仅确认是误伤时使用。" @confirm="reviveAll">
          <a-button size="small" :loading="opsBusy.revive" danger>池一键复位</a-button>
        </a-popconfirm>
        <a-popconfirm title="8980 活着就不动；没在跑会拉起一个新 backend（需要 auth.json 有已登录账号）？" @confirm="relaunchUpstream">
          <a-button size="small" :loading="opsBusy.relaunch">拉起上游 8980</a-button>
        </a-popconfirm>
        <a-button size="small" :loading="opsBusy.backup" @click="downloadBackup">导出配置备份</a-button>
      </a-space>
      <div class="text-xs text-slate-400 mt-2">
        备份只含配置类文件（model-map / keys / 用户等）+ 账本行数清单；账本本体（requests/credits 等）请直接拷贝 data/ 目录。备份文件含 key 明文与密码哈希，按敏感凭据保管。
      </div>
    </a-card>

    <!-- 热配置开关（livecfg，admin-only 编辑）：保存即时生效（网关按 mtime 重读），
         不需要重启任何进程。viewer 看得到但控件禁用。 -->
    <a-card :bordered="false" title="运行时开关（热配置）" class="mt-4">
      <template #extra>
        <a-button
          v-if="isAdmin"
          type="primary"
          size="small"
          :loading="liveSaving"
          @click="saveLive"
        >保存</a-button>
      </template>
      <div class="space-y-3 max-w-xl">
        <div class="flex items-center justify-between">
          <div>
            <div>请求日志记录调用来源</div>
            <div class="text-xs text-slate-400">关闭后请求日志不再记录 ip / ua（请求日志页的来源列将恒为空）</div>
          </div>
          <a-switch v-model:checked="liveForm.recordClientInfo" :disabled="!isAdmin" />
        </div>
        <div>
          <div>隐藏模型（不进 /v1/models，客户端选不到）</div>
          <a-select
            v-model:value="liveForm.hiddenModels"
            mode="tags"
            :disabled="!isAdmin"
            placeholder="输入模型 ID 后回车，如 gpt-4o"
            style="width: 100%"
            :token-separators="[',', ' ']"
          />
          <div class="text-xs text-slate-400 mt-1">只是不对外列出，客户端显式传这些名字仍然可用</div>
        </div>
        <div class="flex items-center justify-between">
          <div>
            <div>软冷却基数（毫秒）</div>
            <div class="text-xs text-slate-400">0 = 回退内置默认；改的是 429/限流类退避的基数</div>
          </div>
          <a-input-number v-model:value="liveForm.softCooldownMs" :min="0" :disabled="!isAdmin" style="width: 140px" />
        </div>
      </div>
    </a-card>

    <!-- 新建账户 -->
    <a-modal v-model:open="createOpen" title="新建账户" :confirm-loading="saving" @ok="submitCreate">
      <a-form layout="vertical">
        <a-form-item label="用户名" required extra="2-32 位字母/数字/下划线/连字符">
          <a-input v-model:value="createForm.username" placeholder="如 ops-01" />
        </a-form-item>
        <a-form-item label="密码" required extra="至少 8 位">
          <a-input-password v-model:value="createForm.password" />
        </a-form-item>
        <a-form-item label="角色" required>
          <a-select v-model:value="createForm.role" :options="[{ label: '管理员（admin）', value: 'admin' }, { label: '只读（viewer）', value: 'viewer' }]" />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- 改密码 -->
    <a-modal v-model:open="pwdOpen" :title="`改密码：${pwdTarget?.username || ''}`" :confirm-loading="saving" @ok="submitPassword">
      <a-form layout="vertical">
        <a-form-item label="新密码" required extra="至少 8 位；保存后该账户的现有登录会立即失效">
          <a-input-password v-model:value="pwdForm.password" />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { App as AntApp } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import { auth } from '@/stores/auth'

// message 走 App.useApp() 的上下文实例（App.vue 已包 <a-app>）。
// 不能解构 App 组件对象本身——那是 undefined，调用 message.success()
// 会 TypeError，把成功路径（关弹窗、刷新列表）整个打断
const { message } = AntApp.useApp()

interface AdminUser {
  username: string
  role: 'admin' | 'viewer'
  created_at?: number
}

const users = ref<AdminUser[]>([])
const me = ref('')
const loading = ref(false)
const saving = ref(false)

// **必须显式给 columns**：a-table 靠 dataSource 非空时自动生成列，
// loading 阶段 users=[] 时列不存在，bodyCell 里读 column.key 直接
// TypeError——整个渲染树崩掉，之后数据到了也不再渲染（页面永远空表）
const columns = [
  { title: '用户名', key: 'username' },
  { title: '角色', key: 'role', width: 100 },
  { title: '创建时间', key: 'created_at', width: 170 },
  { title: '操作', key: 'ops', width: 280 },
]

const createOpen = ref(false)
const createForm = reactive({ username: '', password: '', role: 'viewer' })
const pwdOpen = ref(false)
const pwdTarget = ref<AdminUser | null>(null)
const pwdForm = reactive({ password: '' })

function fmtTime(t?: number) {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function load() {
  loading.value = true
  try {
    const { data } = await client.get('/auth/users')
    users.value = data.users || []
    me.value = data.me || auth.user?.username || ''
  } catch (e: any) {
    message.error(e?.response?.data?.error || '加载失败')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  createForm.username = ''
  createForm.password = ''
  createForm.role = 'viewer'
  createOpen.value = true
}

async function submitCreate() {
  saving.value = true
  try {
    await client.post('/auth/users', { ...createForm })
    message.success(`已创建 ${createForm.username}`)
    createOpen.value = false
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '创建失败')
  } finally {
    saving.value = false
  }
}

function openPassword(u: AdminUser) {
  pwdTarget.value = u
  pwdForm.password = ''
  pwdOpen.value = true
}

async function submitPassword() {
  if (!pwdTarget.value) return
  saving.value = true
  try {
    await client.patch(`/auth/users/${encodeURIComponent(pwdTarget.value.username)}`, { password: pwdForm.password })
    message.success('密码已更新，该账户旧会话已失效')
    pwdOpen.value = false
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '修改失败')
  } finally {
    saving.value = false
  }
}

async function setRole(u: AdminUser, role: 'admin' | 'viewer') {
  try {
    await client.patch(`/auth/users/${encodeURIComponent(u.username)}`, { role })
    message.success(`已将 ${u.username} 设为 ${role === 'admin' ? '管理员' : '只读'}`)
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '修改失败')
  }
}

async function removeUser(u: AdminUser) {
  try {
    await client.delete(`/auth/users/${encodeURIComponent(u.username)}`)
    message.success(`已删除 ${u.username}`)
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '删除失败')
  }
}

// ── 审计日志（admin-only）──
const isAdmin = computed(() => auth.user?.role === 'admin')
const auditRows = ref<Array<{ ts: number; actor: string; action: string; target: string; detail: string; __i: number }>>([])
const auditActions = ref<string[]>([])
const auditTotal = ref(0)
const auditLoading = ref(false)
const auditAction = ref<string | undefined>(undefined)
const auditActor = ref('')

const auditColumns = [
  { title: '时间', key: 'ts', width: 150 },
  { title: '操作人', dataIndex: 'actor', width: 110 },
  { title: '动作', key: 'action', width: 150 },
  { title: '对象', dataIndex: 'target', width: 150 },
  { title: '详情', key: 'detail', ellipsis: true },
]

function auditTagColor(action: string) {
  if (/delete|revoke|disable/i.test(action)) return 'red'
  if (/create|save|enable|login/i.test(action)) return 'green'
  return 'blue'
}

async function loadAudit() {
  auditLoading.value = true
  try {
    const params = new URLSearchParams({ limit: '500' })
    if (auditAction.value) params.set('action', auditAction.value)
    if (auditActor.value.trim()) params.set('actor', auditActor.value.trim())
    const { data } = await client.get(`/auth/audit?${params}`)
    auditRows.value = (data.rows || []).map((r: any, i: number) => ({ ...r, __i: i }))
    auditActions.value = data.actions || []
    auditTotal.value = data.total || 0
  } catch (e: any) {
    if (e?.response?.status === 403) {
      auditRows.value = []
    } else {
      message.error(e?.response?.data?.error || '审计加载失败')
    }
  } finally {
    auditLoading.value = false
  }
}

// ── 热配置开关（livecfg）──
const liveSaving = ref(false)
const liveForm = reactive({ recordClientInfo: true, hiddenModels: [] as string[], softCooldownMs: 0 })

async function loadLive() {
  try {
    const { data } = await client.get('/system/config')
    Object.assign(liveForm, data.config || {})
  } catch (e) { /* 保持默认 */ }
}

async function saveLive() {
  liveSaving.value = true
  try {
    await client.put('/system/config', { ...liveForm })
    message.success('已保存，即时生效（网关按 mtime 重读，无需重启）')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    liveSaving.value = false
  }
}

// ── 运维动作（清单项 11/13/14）──
const dupeVersion = ref('')
const opsBusy = reactive({ revive: false, relaunch: false, backup: false })

async function loadVersion() {
  try {
    const { data } = await client.get('/system/dumate-version')
    dupeVersion.value = data.version || '未检出'
  } catch (e) { dupeVersion.value = '未检出' }
}

async function reviveAll() {
  opsBusy.revive = true
  try {
    const { data } = await client.post('/system/pool-revive-all')
    message.success(`已复位 ${data.revived}/${data.sick} 个账号`)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '复位失败')
  } finally { opsBusy.revive = false }
}

async function relaunchUpstream() {
  opsBusy.relaunch = true
  try {
    const { data } = await client.post('/system/upstream-relaunch', {}, { timeout: 30000 })
    if (data.ok) message.success(data.detail)
    else message.error(data.detail || '失败')
  } catch (e: any) {
    message.error(e?.response?.data?.error || e?.message || '触发失败')
  } finally { opsBusy.relaunch = false }
}

async function downloadBackup() {
  opsBusy.backup = true
  try {
    const res = await client.get('/system/backup', { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `dumate2api-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    message.success('备份已下载（含 key 明文，按敏感凭据保管）')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '导出失败')
  } finally { opsBusy.backup = false }
}

onMounted(() => {
  load()
  if (isAdmin.value) {
    loadAudit()
    loadLive()
    loadVersion()
  }
})

// 筛选变化自动重查（不用手动点刷新）
watch([auditAction, auditActor], () => {
  if (isAdmin.value) loadAudit()
})
</script>
