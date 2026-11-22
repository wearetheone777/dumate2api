// web/src/stores/theme.ts - 深浅色主题的唯一状态源
//
// 为什么需要这一层：全站配色有四个消费方，彼此不知道对方存在——
//   1. style.css 的 --lab-* 变量（自定义卡片/表格/骨架样式）
//   2. App.vue 的 AntD token（组件内部颜色、浮层、下拉）
//   3. ECharts（canvas 渲染，读不到 CSS 变量，只能读 JS 常量）
//   4. index.html 的 theme-color（浏览器地址栏/移动端状态栏）
// 每个消费方各存一份主题状态就必然漂移，所以只在这里判定一次，
// 再由 syncDom() 分发给四方。
//
// 三态而不是两态：'auto' 才是默认值——用户在系统里设置了深色，
// 控制台不该反过来硬塞白底。手动选 light/dark 后即固定，不再跟系统变。

import { computed, reactive } from 'vue'
import { applyChartDark } from '@/utils/chartTheme'

export type ThemeMode = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'dumate.admin.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'
/** 与 style.css 的 --lab-bg 同值：深色页底 */
const DARK_THEME_COLOR = '#0b111c'
const LIGHT_THEME_COLOR = '#f2f4f8'

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw
  } catch {
    // 隐私模式/禁用存储时 localStorage 会抛：回落到 auto，不影响使用
  }
  return 'auto'
}

const mql =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY)
    : null

const state = reactive({
  mode: readStoredMode(),
  systemDark: !!mql?.matches,
})

/** 用户选择（可能是 auto） */
export const themeMode = computed<ThemeMode>(() => state.mode)
/** 实际生效的深浅：所有 UI 判定都用它，不要用 themeMode */
export const isDark = computed(() =>
  state.mode === 'auto' ? state.systemDark : state.mode === 'dark'
)

function syncDom() {
  const dark = isDark.value
  const root = document.documentElement
  // class 而非 data 属性：style.css 里用 html.dark 前缀覆盖，直观且好 grep
  root.classList.toggle('dark', dark)
  // 让浏览器原生控件（滚动条、表单、日期选择器）跟着换配色
  root.style.colorScheme = dark ? 'dark' : 'light'

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR)

  // canvas 层读不到 CSS 变量：先换图表主题常量，再广播让页面重绘。
  // 顺序不能反——页面监听者会立刻按新常量构造 option。
  applyChartDark(dark)
  window.dispatchEvent(new CustomEvent('lab:theme', { detail: { dark } }))
}

export function setThemeMode(mode: ThemeMode) {
  state.mode = mode
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // 存不下只影响下次进站的默认值，本次切换仍然生效
  }
  syncDom()
}

/** 在 app.mount 之前调用：避免首帧白底闪一下 */
export function initTheme() {
  if (mql) {
    // addEventListener 是标准写法；老 Safari 只有 addListener
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', (e) => {
        state.systemDark = e.matches
        // 只有 auto 才跟随；手动选定后系统变化不该改用户的选择
        if (state.mode === 'auto') syncDom()
      })
    } else if (typeof (mql as MediaQueryList & { addListener?: (cb: (e: MediaQueryListEvent) => void) => void }).addListener === 'function') {
      ;(mql as MediaQueryList & { addListener: (cb: (e: MediaQueryListEvent) => void) => void }).addListener(
        (e: MediaQueryListEvent) => {
          state.systemDark = e.matches
          if (state.mode === 'auto') syncDom()
        }
      )
    }
  }
  syncDom()
}
