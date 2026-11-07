<template>
  <a-card :bordered="false" title="全部通道额度">
    <template #extra>
      <a-space :size="10">
        <span class="text-xs text-slate-500">
          更新于 {{ atText }}<span v-if="cached"> · 缓存</span>
        </span>
        <a-button size="small" :loading="loading" @click="load(true)">刷新</a-button>
      </a-space>
    </template>

    <a-alert type="info" show-icon class="mb-2">
      <template #message>各通道额度单位不同，不可相加</template>
      <template #description>
        搭子 / 千问问「积分」，TRAE / Qoder 问「credits」，WorkBuddy 国际版按请求数计。
        这张卡只是把五条通道并排放在一起，不给总计——不同单位的数字加起来没有意义。
      </template>
    </a-alert>

    <a-spin :spinning="loading">
      <div v-for="r in rows" :key="r.id" class="cb-row">
        <div class="cb-cell">
          <div class="cb-name">{{ r.label }}</div>
          <div class="text-xs text-slate-500">
            <a-tag v-if="r.expiring" color="orange" class="cb-tag">
              {{ r.expiring.accounts }} 个账号临期
            </a-tag>
            <a-tag v-else class="cb-tag">无临期</a-tag>
          </div>
        </div>

        <div class="cb-cell">
          <span v-if="r.ok && r.unlimited" class="cb-unlimited">不限量</span>
          <span v-else-if="r.ok && r.remaining != null" class="cb-num num">
            {{ fmt(r.remaining) }} <span class="cb-unit">{{ r.unit }}</span>
          </span>
          <span v-else class="cb-unknown">—</span>
        </div>

        <div class="cb-cell text-xs">
          <span :class="r.accounts.fail ? 'text-orange-400' : 'text-slate-400'">
            {{ r.accounts.ok }}/{{ r.accounts.total }} 账号
          </span>
        </div>

        <div class="cb-cell text-xs">
          <!-- 三种状态分开：整通道失败（红）、部分账号失败（橙，明细进 tooltip）、
               全部正常（口径说明）。只显示 "1/2 账号" 而不给原因，用户会以为
               是显示问题——失败原因必须能点开看到 -->
          <a-tooltip v-if="r.error" :title="errorDetail(r)">
            <a-tag color="red" class="cb-tag">{{ r.error }}</a-tag>
          </a-tooltip>
          <a-tooltip v-else-if="r.accounts.fail" :title="errorDetail(r)">
            <a-tag color="orange" class="cb-tag">{{ r.accounts.fail }} 个账号查询失败</a-tag>
          </a-tooltip>
          <span v-else class="text-slate-500">{{ r.note }}</span>
        </div>
      </div>
      <div v-if="!rows.length && !loading" class="hint-text">暂无通道数据</div>
    </a-spin>
  </a-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { channelBalanceApi, type ChannelBalanceRow } from '@/api/channelbalance'

const rows = ref<ChannelBalanceRow[]>([])
const at = ref(0)
const cached = ref(false)
const loading = ref(false)

const atText = computed(() =>
  at.value ? new Date(at.value).toLocaleTimeString('zh-CN') : '—',
)

function fmt(n: number): string {
  return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

/** 失败明细拼成 tooltip（不隐藏失败账号——「有几个挂了」是这张卡的核心信息） */
function errorDetail(r: ChannelBalanceRow): string {
  const parts: string[] = []
  if (r.error) parts.push(r.error)
  if (r.failed && r.failed.length) {
    parts.push(r.failed.map((f) => `${f.name}：${f.error}`).join('；'))
  }
  return parts.join('\n')
}

async function load(force = false) {
  loading.value = true
  try {
    const { data } = await channelBalanceApi.snapshot(force)
    if (data.ok) {
      rows.value = data.channels || []
      at.value = data.at || 0
      cached.value = !!data.cached
    }
  } catch (e) {
    /* 卡片拉不到不影响仪表盘其他区块；下次刷新再试 */
  } finally {
    loading.value = false
  }
}

defineExpose({ load })
onMounted(() => load())
</script>

<style scoped>
.cb-row {
  display: grid;
  grid-template-columns: 1.1fr 1fr 0.7fr 1.8fr;
  gap: 12px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
}
.cb-row:last-of-type {
  border-bottom: none;
}
.cb-cell {
  min-width: 0;
}
.cb-name {
  font-size: 14px;
  font-weight: 600;
}
.cb-tag {
  margin-top: 2px;
}
.cb-num {
  font-size: 16px;
}
.cb-unit {
  font-size: 11px;
  color: rgb(148 163 184);
}
.cb-unlimited {
  color: rgb(34 211 238);
  font-weight: 600;
}
.cb-unknown {
  color: rgb(100 116 139);
}
@media (max-width: 768px) {
  .cb-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
