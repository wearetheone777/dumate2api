// web/src/stores/ui.ts - 看板层的两个跨页开关（调研 P2-12）
//
// ① 自动刷新：挂看板时全靠手点刷新。做成**一个共享定时器**而不是每页各开一个
//    setInterval——十几个页面各持一个定时器时，切页/后台标签都会各打各的接口，
//    而它们打的是同一批 API。
//
// ② 阅读模式：只改**排版**（侧栏收起、字号与数字放大），**不隐藏任何数据**。
//    这个仓库的纪律是「每个事实必须可观测」，为了「看起来清爽」而把字段藏掉，
//    看板上少的那一列就会变成下一次排障时的盲点。
//
// 三条与「自动刷新」有关的具体决定：
//   - 页面**不可见时不刷**（document.visibilityState）。挂一夜的看板不该白打
//     几万次请求，而且这些请求会写进请求日志与用量——那是在污染统计。
//   - 同一个回调**单飞**：上一次还没回来就跳过这一轮，避免慢接口堆积成雪崩。
//   - 回调抛错**只记不炸**：自动刷新是附加能力，一个页面的接口坏了不能让
//     整个定时器停摆（否则「刷新按钮还在转」这种假象更难查）。
import { onUnmounted, ref, watch } from 'vue'

/** 可选间隔（毫秒）。0 = 关闭。列表做成常量，界面与存储共用一份。 */
export const REFRESH_OPTIONS = [
  { label: '不自动刷新', value: 0 },
  { label: '10 秒', value: 10_000 },
  { label: '30 秒', value: 30_000 },
  { label: '1 分钟', value: 60_000 },
  { label: '5 分钟', value: 300_000 },
]

const LS_REFRESH = 'dumate.ui.autoRefreshMs'
const LS_READING = 'dumate.ui.readingMode'

function readNum(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  } catch (e) {
    return fallback // 隐私模式/禁用存储：按默认值走，不报错
  }
}

function writeStr(key: string, v: string) {
  try { localStorage.setItem(key, v) } catch (e) { /* 存不了也不影响本次会话 */ }
}

/** 当前自动刷新间隔（毫秒，0 = 关） */
export const autoRefreshMs = ref<number>(readNum(LS_REFRESH, 0))
/** 阅读模式（只影响排版） */
export const readingMode = ref<boolean>(readNum(LS_READING, 0) === 1)
/** 正在跑的刷新任务数（界面上给一个很小的「更新中」提示，不做成遮罩） */
export const refreshingCount = ref(0)

watch(autoRefreshMs, (v) => { writeStr(LS_REFRESH, String(v)); restart() })
watch(readingMode, (v) => { writeStr(LS_READING, v ? '1' : '0') })

type RefreshFn = () => unknown
const subs = new Set<RefreshFn>()
const pending = new WeakSet<object>()
let timer: ReturnType<typeof setInterval> | null = null

function stop() {
  if (timer) { clearInterval(timer); timer = null }
}

function tick() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  for (const fn of subs) {
    // 单飞：同一个回调上一轮还没结束就跳过（慢接口不该堆成雪崩）
    if (pending.has(fn as unknown as object)) continue;
    pending.add(fn as unknown as object);
    refreshingCount.value += 1;
    try {
      const r = fn();
      if (r && typeof (r as any).finally === 'function') {
        (r as Promise<unknown>).finally(() => {
          pending.delete(fn as unknown as object);
          refreshingCount.value = Math.max(0, refreshingCount.value - 1);
        });
      } else {
        pending.delete(fn as unknown as object);
        refreshingCount.value = Math.max(0, refreshingCount.value - 1);
      }
    } catch (e) {
      // 页面自己的接口坏了不能让定时器停摆（否则会以为「刷新还在跑」）
      pending.delete(fn as unknown as object);
      refreshingCount.value = Math.max(0, refreshingCount.value - 1);
    }
  }
}

function restart() {
  stop();
  if (!autoRefreshMs.value || !subs.size) return;
  timer = setInterval(tick, autoRefreshMs.value);
}

/** 页面注册自己的刷新函数；返回取消注册的句柄（组件卸载时调） */
export function registerRefresh(fn: RefreshFn): () => void {
  subs.add(fn);
  restart();          // 第一个订阅者出现时启动定时器
  return () => {
    subs.delete(fn);
    pending.delete(fn as unknown as object);
    if (!subs.size) stop();
  };
}

/** 仅供测试/调试：当前订阅者数量与定时器状态 */
export function _autoRefreshState() {
  return { subs: subs.size, running: !!timer, intervalMs: autoRefreshMs.value };
}

/**
 * 页面侧一行接入：`useAutoRefresh(load)`。
 * 必须在 setup 里调用（内部用 onUnmounted 自动注销）——这就是**页面卸载后
 * 定时器还在打接口**那个坑的解法，手写注册很容易忘掉注销。
 */
export function useAutoRefresh(fn: RefreshFn): () => void {
  const off = registerRefresh(fn);
  onUnmounted(off);
  return off;
}
