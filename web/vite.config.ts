import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // 通道能力声明（批次二十二）：与 tsconfig 的 @def/channels 同一映射——
      // JSON 在仓库根，web 与后端 src 共享同一份事实
      '@def/channels': path.resolve(__dirname, '../channels.def.json'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9081',
        changeOrigin: true,
      },
    },
  },
})
