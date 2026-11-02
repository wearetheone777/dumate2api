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
import { onMounted, reactive, ref } from 'vue'
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

onMounted(load)
</script>
