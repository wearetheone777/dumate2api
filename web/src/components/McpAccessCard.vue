<template>
  <a-card :bordered="false" title="MCP / CLI 接入">
    <template #extra>
      <a-button size="small" @click="copyMcp">复制 MCP 配置</a-button>
    </template>
    <div class="text-xs text-slate-500 mb-2">
      让 Claude Desktop 等 MCP 宿主直接用搭子（走网页凭证池直连云端，不依赖桌面客户端在跑）。
      链路详情见 <code>src/mcp-server.js</code>。
    </div>
    <pre class="text-xs bg-slate-50 dark:bg-slate-800 rounded p-3 overflow-auto max-h-56">{{ mcpJson }}</pre>
    <a-divider class="my-3" />
    <div class="text-sm font-medium mb-1">CLI</div>
    <div class="text-xs space-y-1">
      <div><code>npm run cli "问题"</code> — 单次问答</div>
      <div><code>git diff | npm run cli -- "review 这段改动"</code> — 管道输入</div>
      <div><code>npm run cli</code> — 交互式 REPL</div>
    </div>
  </a-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { App as AntApp } from 'ant-design-vue'

const { message } = AntApp.useApp()

// 与 src/mcp-server.js 的实际启动命令一致：node src/mcp-server.js --mcp
const mcpJson = computed(() => JSON.stringify({
  mcpServers: {
    dumate2api: {
      command: 'node',
      args: ['<项目路径>\\src\\mcp-server.js', '--mcp'],
    },
  },
}, null, 2))

async function copyMcp() {
  try {
    await navigator.clipboard.writeText(mcpJson.value)
    message.success('MCP 配置已复制')
  } catch (e) {
    message.error('复制失败（浏览器剪贴板权限）')
  }
}
</script>
