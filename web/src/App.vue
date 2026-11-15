<template>
  <!-- 全局主题：浅色控制台 + 夜间模式。
       走 ConfigProvider 的 token / darkAlgorithm，而不是逐个组件写 :deep 覆盖——
       Select 下拉、Modal、DatePicker、Message 这些浮层不在卡片内，
       scoped 样式够不到，只有 token 能一次改干净。
       深浅切换由 stores/theme.ts 决定，这里只负责把状态翻译成 AntD 配置。 -->
  <a-config-provider :theme="themeConfig" :locale="zhCN">
    <!-- a-app：为 useApp()（message/modal/notification 上下文）迁移提供挂载点 -->
    <a-app>
      <router-view />
    </a-app>
  </a-config-provider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { theme as antTheme } from 'ant-design-vue'
import { isDark } from '@/stores/theme'

// 两套配置共用的排版/圆角：与主题无关，抽出来避免两份各写一遍后漂移
const BASE = {
  borderRadius: 10,
  borderRadiusLG: 14,
  borderRadiusSM: 8,
  controlHeight: 34,
  fontSize: 13,
  wireframe: false,
  // 数据用等宽，正文用无衬线：数字列对齐后整张表稳定得多。
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
}

// 浅色配置：与 style.css 的 --lab-* 变量同源，改一处两边一起走。
// 这套值已经按视觉验收过，夜间模式不动它。
const LIGHT_THEME = {
  token: {
    ...BASE,
    colorPrimary: '#0891b2',
    colorInfo: '#0891b2',
    colorSuccess: '#059669',
    colorWarning: '#d97706',
    colorError: '#dc2626',

    colorBgBase: '#f2f4f8',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#f2f4f8',
    colorBorder: '#ccd4df',
    colorBorderSecondary: '#e2e7ee',

    colorText: '#1a2332',
    colorTextSecondary: '#4e5f75',
    colorTextTertiary: '#8494a9',
    colorTextQuaternary: '#bfc9d5',

    // 与 style.css 的 --lab-shadow 同值：AntD 的样式注入晚于全局 CSS，
    // .ant-card 的 box-shadow 若只写在 style.css 会被组件默认值盖掉——
    // 必须在 token 层覆盖 boxShadowTertiary（Card 默认阴影走的就是它）。
    boxShadowTertiary:
      '0 1px 2px rgba(16, 24, 40, 0.04), 0 4px 14px rgba(16, 24, 40, 0.05)',
  },
  components: {
    Card: { colorBgContainer: '#ffffff' },
    Table: {
      headerBg: 'var(--lab-surface-2)',
      headerColor: '#4e5f75',
      rowHoverBg: 'var(--lab-surface-hover)',
      borderColor: '#e2e7ee',
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemSelectedBg: 'var(--lab-primary-dim)',
      itemSelectedColor: '#0891b2',
      itemColor: '#4e5f75',
      itemHoverBg: 'rgba(15, 23, 42, 0.04)',
      itemHoverColor: '#1a2332',
    },
    // Tabs 的墨条与选中色与全站信号色对齐（AntD 默认蓝在青色体系里是外来色）
    Tabs: {
      inkBarColor: '#0891b2',
      itemSelectedColor: '#0891b2',
      itemHoverColor: '#0891b2',
    },
    // 浮层（Select 下拉等）圆角与卡片体系一致
    Dropdown: { borderRadiusSM: 10 },
    // 积分明细页「查看账号」切换器：选中底色走信号色
    Radio: { buttonSolidCheckedBg: '#0891b2', buttonSolidCheckedHoverBg: '#0e7490' },
  },
}

// 深色配置：算法负责派生（hover/active/描边/禁用态等几十个派生色不手写），
// 我们只钉住 seed 与基础面——多钉一个就多一处会漂移的常量。
// 数值与 style.css 的 html.dark 块一一对应。
const DARK_THEME = {
  algorithm: antTheme.darkAlgorithm,
  token: {
    ...BASE,
    colorPrimary: '#22d3ee',
    colorInfo: '#22d3ee',
    colorSuccess: '#34d399',
    colorWarning: '#fbbf24',
    colorError: '#f87171',

    colorBgBase: '#0b111c',
    colorBgContainer: '#111a29',
    colorBgElevated: '#16202f',
    colorBgLayout: '#0b111c',
    colorBorder: '#2f4159',
    colorBorderSecondary: '#223045',

    colorText: '#e6edf7',
    colorTextSecondary: '#a7b6cb',
    colorTextTertiary: '#8395ab',
    colorTextQuaternary: '#55657c',

    boxShadowTertiary:
      '0 1px 3px rgba(0, 0, 0, 0.26), 0 2px 8px rgba(0, 0, 0, 0.24)',
  },
  components: {
    Card: { colorBgContainer: 'var(--lab-surface)' },
    Table: {
      headerBg: 'var(--lab-surface-2)',
      headerColor: 'var(--lab-text-sub)',
      rowHoverBg: 'var(--lab-surface-hover)',
      borderColor: 'var(--lab-border)',
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemSelectedBg: 'var(--lab-primary-dim)',
      itemSelectedColor: 'var(--lab-primary)',
      itemColor: 'var(--lab-text-sub)',
      itemHoverBg: 'var(--lab-hover)',
      itemHoverColor: 'var(--lab-text)',
    },
    Tabs: {
      inkBarColor: 'var(--lab-primary)',
      itemSelectedColor: 'var(--lab-primary)',
      itemHoverColor: 'var(--lab-primary)',
    },
    Dropdown: { borderRadiusSM: 10 },
    Radio: {
      buttonSolidCheckedBg: 'var(--lab-primary)',
      buttonSolidCheckedHoverBg: 'var(--lab-primary)',
      // 亮青底上白字对比不足，与 style.css 里主按钮同口径
      buttonSolidCheckedText: '#04222b',
    },
  },
}

const themeConfig = computed(() => (isDark.value ? DARK_THEME : LIGHT_THEME))
</script>
