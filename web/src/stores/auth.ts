import { computed, reactive } from 'vue'
import client from '@/api/client'

export interface User {
  username: string
  role: string
}

export const auth = reactive({
  user: null as User | null,
  async load() {
    try {
      const { data } = await client.get('/auth/me')
      this.user = data
    } catch {
      this.user = null
    }
    return this.user
  },
  async login(username: string, password: string) {
    const { data } = await client.post('/auth/login', { username, password })
    this.user = { username: data.username, role: data.role }
    return this.user
  },
  async logout() {
    await client.post('/auth/logout')
    this.user = null
  },
})

// viewer 是只读角色：非 GET 的管理操作服务端一律 403，前端据此隐藏
// 写按钮（服务端过滤才是权威，这里只是别让用户点到必然失败的按钮）。
// 独立导出而不是挂在 auth 上——reactive 字面量内自引用会让 TS 推导失败。
export const isAdmin = computed(() => auth.user?.role === 'admin')
