<template>
  <div class="login-wrap">
    <!-- 背景：网格 + 青色辉光，与内容区同源，登录页也读作「同一个控制台」 -->
    <div class="grid-layer" />
    <div class="glow glow-1" />
    <div class="glow glow-2" />

    <div class="login-card">
      <div class="brand">
        <div class="brand-mark">
          <AppLogo :size="28" />
        </div>
        <div class="brand-titles">
          <h1>DuMate <span class="accent">控制台</span></h1>
          <p>模型网关 · 账号池 · 用量监控</p>
        </div>
      </div>

      <div class="divider" />

      <a-form layout="vertical" @finish="onSubmit">
        <a-form-item label="用户名">
          <a-input v-model:value="form.username" size="large" placeholder="admin">
            <template #prefix><UserOutlined class="input-icon" /></template>
          </a-input>
        </a-form-item>
        <a-form-item label="密码">
          <a-input-password
            v-model:value="form.password"
            size="large"
            placeholder="初始密码见启动日志"
          >
            <template #prefix><LockOutlined class="input-icon" /></template>
          </a-input-password>
        </a-form-item>
        <a-alert v-if="error" :message="error" type="error" show-icon class="mb-4" />
        <a-button
          type="primary"
          html-type="submit"
          size="large"
          block
          :loading="loading"
          class="login-btn"
          @click="onSubmit"
        >
          登录
        </a-button>
      </a-form>

      <p class="foot">仅限本机访问 · 会话由 admin.secret 签名</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { UserOutlined, LockOutlined } from '@ant-design/icons-vue'
import AppLogo from '@/components/AppLogo.vue'
import { auth } from '@/stores/auth'

const router = useRouter()
const form = reactive({ username: 'admin', password: '' })
const loading = ref(false)
const error = ref('')

async function onSubmit() {
  // 按钮 click 与表单 finish 两条路都会进这里，重复提交会白白消耗一次
  // 失败计数（5 次就锁定）
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    await auth.login(form.username, form.password)
    router.push('/')
  } catch (e: any) {
    const status = e?.response?.status
    if (status === 429) {
      const secs = e?.response?.data?.retry_after ?? 0
      error.value = `尝试次数过多，请 ${Math.ceil(secs / 60)} 分钟后再试`
    } else {
      error.value = '用户名或密码错误'
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: var(--lab-bg);
  position: relative;
  overflow: hidden;
}
/* 背景图：抽象科技感线条，低透明度叠加在网格之上 */
.login-wrap::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='600' viewBox='0 0 800 600'%3E%3Cdefs%3E%3ClinearGradient id='g1' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%230891b2;stop-opacity:0.06'/%3E%3Cstop offset='100%25' style='stop-color:%230891b2;stop-opacity:0.02'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M0,300 Q200,200 400,280 T800,250' stroke='%230891b2' stroke-width='1.5' fill='none' opacity='0.08'/%3E%3Cpath d='M0,350 Q200,280 400,320 T800,300' stroke='%230891b2' stroke-width='1' fill='none' opacity='0.05'/%3E%3Cpath d='M0,200 Q300,150 500,220 T800,180' stroke='%230284c7' stroke-width='1' fill='none' opacity='0.04'/%3E%3Ccircle cx='200' cy='150' r='80' fill='url(%23g1)'/%3E%3Ccircle cx='650' cy='450' r='100' fill='url(%23g1)'/%3E%3Ccircle cx='500' cy='100' r='60' fill='url(%23g1)'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: center;
  background-size: cover;
}
.grid-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(var(--lab-grid-line-strong) 1px, transparent 1px),
    linear-gradient(90deg, var(--lab-grid-line-strong) 1px, transparent 1px);
  background-size: 46px 46px;
  mask-image: radial-gradient(circle at 50% 42%, #000 0%, transparent 72%);
}
.glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(100px);
  opacity: 0.3;
  pointer-events: none;
  animation: glow-drift 12s ease-in-out infinite alternate;
}
.glow-1 {
  width: 520px;
  height: 520px;
  background: #67e8f9;
  top: -160px;
  left: -120px;
}
.glow-2 {
  width: 420px;
  height: 420px;
  background: #a5f3fc;
  bottom: -180px;
  right: -100px;
  animation-delay: -6s;
}
@keyframes glow-drift {
  from { transform: translate(0, 0) scale(1); }
  to { transform: translate(20px, -15px) scale(1.05); }
}

/* 额外的装饰性粒子 */
.login-wrap::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    radial-gradient(2px 2px at 20% 30%, rgba(8, 145, 178, 0.15) 100%, transparent),
    radial-gradient(2px 2px at 40% 70%, rgba(8, 145, 178, 0.10) 100%, transparent),
    radial-gradient(1.5px 1.5px at 60% 20%, rgba(8, 145, 178, 0.12) 100%, transparent),
    radial-gradient(2px 2px at 80% 50%, rgba(8, 145, 178, 0.08) 100%, transparent),
    radial-gradient(1.5px 1.5px at 10% 80%, rgba(8, 145, 178, 0.10) 100%, transparent),
    radial-gradient(2px 2px at 90% 15%, rgba(8, 145, 178, 0.12) 100%, transparent);
}

.login-card {
  position: relative;
  z-index: 1;
  /* 窄屏留出 16px 边距，卡片不会贴边或被裁 */
  width: min(420px, calc(100vw - 32px));
  padding: 40px 40px 32px;
  background: var(--lab-login-card);
  backdrop-filter: blur(20px);
  border: 1px solid var(--lab-border-strong);
  border-radius: 20px;
  box-shadow:
    0 24px 64px rgba(16, 24, 40, 0.12),
    0 0 0 1px rgba(8, 145, 178, 0.05),
    0 0 80px rgba(8, 145, 178, 0.04);
  animation: card-enter 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes card-enter {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.brand {
  display: flex;
  align-items: center;
  gap: 16px;
}
.brand-mark {
  width: 52px;
  height: 52px;
  flex: none;
  border-radius: 15px;
  background: linear-gradient(135deg, #0891b2, #0e7490);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 4px 14px rgba(8, 145, 178, 0.35),
    0 0 0 1px rgba(255, 255, 255, 0.1) inset;
  position: relative;
  overflow: hidden;
}
.brand-mark::after {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: linear-gradient(
    135deg,
    transparent 40%,
    rgba(255, 255, 255, 0.15) 50%,
    transparent 60%
  );
  animation: shine 3s ease-in-out infinite;
}
@keyframes shine {
  0%, 100% { transform: translateX(-100%); }
  50% { transform: translateX(100%); }
}
.brand-titles h1 {
  margin: 0;
  font-family: var(--lab-display);
  font-size: 21px;
  font-weight: 700;
  color: var(--lab-text);
  letter-spacing: 0.5px;
  line-height: 1.2;
}
.brand-titles .accent {
  color: var(--lab-primary);
}
.brand-titles p {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--lab-text-mute);
  letter-spacing: 0.4px;
}
.divider {
  height: 1px;
  margin: 26px 0 24px;
  background: linear-gradient(90deg, transparent, var(--lab-border-strong) 22%, var(--lab-border-strong) 78%, transparent);
}

/* 表单标签 */
:deep(.ant-form-item-label > label) {
  font-size: 12px;
  font-weight: 500;
  color: var(--lab-text-sub);
  letter-spacing: 0.3px;
}

/* 输入框 */
:deep(.ant-input-affix-wrapper) {
  border-radius: 12px !important;
  border-color: var(--lab-border) !important;
  transition: all 0.25s ease;
}
:deep(.ant-input-affix-wrapper:hover) {
  border-color: var(--lab-border-strong) !important;
}
:deep(.ant-input-affix-wrapper:focus-within) {
  border-color: var(--lab-primary) !important;
  box-shadow: 0 0 0 3px var(--lab-primary-dim) !important;
}
:deep(.ant-input) {
  font-size: 14px;
}
:deep(.ant-input::placeholder) {
  color: var(--lab-text-mute);
  font-size: 13px;
}

.input-icon {
  color: var(--lab-text-mute);
  font-size: 14px;
}

/* 登录按钮 */
.login-btn {
  height: 46px;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 3px;
  margin-top: 6px;
  position: relative;
  overflow: hidden;
  transition: all 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.login-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(8, 145, 178, 0.35);
}
.login-btn:active {
  transform: translateY(0);
}

.foot {
  margin: 24px 0 0;
  text-align: center;
  font-size: 11px;
  color: var(--lab-text-mute);
  letter-spacing: 0.4px;
  opacity: 0.8;
}

/* 夜间模式：卡片底、辉光强度、投影按深色重算。
   辉光在深底上同强度会变成眩光，压到浅色的一半以下；
   卡片阴影改用纯黑（深底上带蓝的阴影会泛灰边）。 */
html.dark .glow {
  opacity: 0.14;
}
html.dark .login-card {
  box-shadow:
    0 24px 64px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(34, 211, 238, 0.06),
    0 0 80px rgba(34, 211, 238, 0.03);
}

/* 用户要求减少动效时：辉光漂浮、品牌扫光、卡片入场全部关掉 */
@media (prefers-reduced-motion: reduce) {
  .glow,
  .brand-mark::after,
  .login-card {
    animation: none;
  }
}
</style>
