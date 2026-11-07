import { createRouter, createWebHashHistory } from 'vue-router'
import { auth } from '@/stores/auth'

const Login = () => import('@/views/LoginView.vue')
const MainLayout = () => import('@/layouts/MainLayout.vue')
const Dashboard = () => import('@/views/DashboardView.vue')
const Models = () => import('@/views/ModelsView.vue')
const Keys = () => import('@/views/KeysView.vue')
const Account = () => import('@/views/AccountView.vue')
const Points = () => import('@/views/PointsView.vue')
const WebAccounts = () => import('@/views/WebAccountsView.vue')
const Usage = () => import('@/views/UsageView.vue')
const ReqLogs = () => import('@/views/ReqLogsView.vue')
const ChatLab = () => import('@/views/ChatLabView.vue')
const AgentSetup = () => import('@/views/AgentSetupView.vue')
const Users = () => import('@/views/UsersView.vue')
const ServerLogs = () => import('@/views/ServerLogsView.vue')
const TraeRuntime = () => import('@/views/TraeRuntimeView.vue')
const OpsAlerts = () => import('@/views/OpsAlertsView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: Login, meta: { public: true } },
    {
      path: '/',
      component: MainLayout,
      children: [
        { path: '', component: Dashboard, meta: { title: '仪表盘', key: 'dashboard' } },
        { path: 'models', component: Models, meta: { title: '模型管理', key: 'models' } },
        { path: 'keys', component: Keys, meta: { title: 'API Key', key: 'keys' } },
        { path: 'account', component: Account, meta: { title: '登录态', key: 'account' } },
        { path: 'points', component: Points, meta: { title: '积分明细', key: 'points' } },
        { path: 'web-accounts', component: WebAccounts, meta: { title: '账号管理', key: 'web-accounts' } },
        { path: 'usage', component: Usage, meta: { title: '用量统计', key: 'usage' } },
        { path: 'reqlogs', component: ReqLogs, meta: { title: '请求日志', key: 'reqlogs' } },
        { path: 'chatlab', component: ChatLab, meta: { title: '聊天测试台', key: 'chatlab' } },
        // 接入配置写本机客户端文件，只对 admin 有意义（与账户管理同款限制）
        { path: 'setup', component: AgentSetup, meta: { title: '接入配置', key: 'setup', adminOnly: true } },
        { path: 'users', component: Users, meta: { title: '账户管理', key: 'users', adminOnly: true } },
        // 运行日志：进程内缓冲，读的是本管理端 console；admin 专属
        { path: 'logs', component: ServerLogs, meta: { title: '运行日志', key: 'logs', adminOnly: true } },
        // TRAE 运行策略：写运行期配置（降级/Max/护栏/暂停），admin 专属
        { path: 'trae-runtime', component: TraeRuntime, meta: { title: 'TRAE 运行策略', key: 'trae-runtime', adminOnly: true } },
        // 运维告警：七类规则阈值 + 活跃告警 + 指标端点。viewer 可看（只读），写操作服务端拦
        { path: 'alerts', component: OpsAlerts, meta: { title: '运维告警', key: 'alerts' } },
        // 「任务记录」已并入「积分明细」（见 CLAUDE.md）。这里保留重定向：
        // 旧书签、浏览器历史、后退键都会命中 #/records，没有它会渲染成空白页
        // （MainLayout 在、<router-view/> 空），只有一个 console 警告。
        { path: 'records', redirect: '/points' },
        // 兜底：任何未知路径回仪表盘。不加的话同样是白屏。
        { path: ':pathMatch(.*)*', redirect: '/' },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  if (!auth.user) await auth.load()
  if (!auth.user) return { path: '/login' }
  // adminOnly 页面（账户管理）对 viewer 回仪表盘——服务端也拦（403），
  // 这里只是别让用户停在一个必然失败的页面上
  if (to.meta.adminOnly && auth.user.role !== 'admin') return { path: '/' }
  return true
})

export default router
