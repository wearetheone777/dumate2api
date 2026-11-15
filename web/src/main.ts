import { createApp } from 'vue'
import Antd from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
import './style.css'
import App from './App.vue'
import router from './router'
import { initTheme } from './stores/theme'

// 必须在 mount 之前定主题：否则首帧会按浅色渲染一次再翻成深色（白闪）。
// index.html 里另有一小段同步脚本做同一件事，用来覆盖「JS 包还没下载完」的窗口。
initTheme()

createApp(App).use(Antd).use(router).mount('#app')
