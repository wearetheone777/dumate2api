<template>
  <div class="page">
    <PageHeader title="Qoder 运行策略" sub="计时器 / 排队 / 冷却 / 自动签到 — 保存即热生效">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="loadAll">刷新</a-button>
        <a-button v-if="isAdmin" type="primary" size="small" :loading="saving" @click="saveRuntime">保存配置</a-button>
      </template>
    </PageHeader>

    <a-alert type="info" show-icon class="mb-3">
      <template #message>全部参数热生效，改阈值不用重启网关</template>
      <template #description>
        <div>
          落盘 <code>{{ file || 'data/qoder-runtime.json' }}</code>，网关每次判定按 mtime 重读。
          <b>环境变量仍是默认值来源</b>——只设 env 不碰面板的部署行为不变；
          面板一旦写入就以面板为准，点「回落 env 默认」删掉面板文件即可。
        </div>
        <div class="mt-1">
          显示的是<b>真正生效值</b>（还要过调用方自己的兜底）；与落盘值不一致时会标出来。
        </div>
      </template>
    </a-alert>

    <a-alert v-if="err" type="warning" show-icon class="mb-3" :message="err" />

    <!-- ========= 自动签到 ========= -->
    <a-card :bordered="false" title="自动签到（P0-1）" class="mb-4">
      <template #extra>
        <a-space>
          <a-button size="small" class="ghost-btn" :loading="autoBusy" @click="runAuto">立即跑一轮</a-button>
          <a-button size="small" class="ghost-btn" :loading="loading" @click="loadAuto">刷新结果</a-button>
        </a-space>
      </template>

      <a-alert type="warning" show-icon class="mb-3" style="padding: 6px 10px">
        <template #message>Qoder 零额度时聊天是「挂起」而不是报错——漏签一天等于通道不可用</template>
      </a-alert>

      <div class="space-y-3 max-w-3xl">
        <div class="flex items-center justify-between">
          <div>
            <div>启用每日自动签到</div>
            <div class="text-xs text-slate-400">打开时立即跑一轮（点开关就想看到结果）；关闭会取消排程并中断进行中一轮</div>
          </div>
          <a-switch :checked="auto.enabled" :disabled="!isAdmin" @change="(v: boolean) => toggleAuto(v)" />
        </div>

        <div class="grid gap-3" style="grid-template-columns: repeat(auto-fit, minmax(190px, 1fr))">
          <label class="field-line">
            <span class="text-xs text-slate-400">时点（时）</span>
            <a-input-number v-model:value="auto.hour" :min="0" :max="23" :disabled="!isAdmin" style="width: 120px" />
          </label>
          <label class="field-line">
            <span class="text-xs text-slate-400">时点（分）</span>
            <a-input-number v-model:value="auto.minute" :min="0" :max="59" :disabled="!isAdmin" style="width: 120px" />
          </label>
          <label class="field-line">
            <span class="text-xs text-slate-400">随机后延上限（分钟）</span>
            <a-input-number v-model:value="auto.jitter_minutes" :min="0" :max="120" :disabled="!isAdmin" style="width: 120px" />
          </label>
        </div>
        <div class="text-xs text-slate-400">
          默认 <b>10:15</b>：上游活动 <code>Daily reset: 10:00 (UTC+8)</code>，00:00 去签会撞在「昨天已领、今天没开」的格子里。
          抖动<b>只后延不提前</b>（整池齐发是明显的机器特征）。
        </div>

        <div class="flex items-center justify-between">
          <div>
            <div>把国际版账号也纳入</div>
            <div class="text-xs text-slate-400">campaigns 端点只在国内版有活动；打开后国际号会多打一次只读 GET（查空按「今日无可领」记，不重试）</div>
          </div>
          <a-switch :checked="auto.include_intl" :disabled="!isAdmin" @change="(v: boolean) => toggleAuto(undefined, v)" />
        </div>

        <div v-if="isAdmin" class="flex items-center gap-2">
          <a-button size="small" :loading="saving" @click="saveAuto">保存签到配置</a-button>
          <span class="text-xs text-slate-400">
            状态：{{ auto.running ? '进行中' : (auto.enabled ? '已启用' : '已关闭') }}
            <template v-if="auto.next_run_at"> · 下次 {{ dateText(auto.next_run_at) }}</template>
          </span>
        </div>
      </div>

      <!-- 上一轮结果 -->
      <template v-if="auto.last_result">
        <a-divider style="margin: 14px 0 10px" />
        <div class="flex flex-wrap items-center gap-3 mb-2 text-xs">
          <a-tag color="blue">{{ triggerText(auto.last_result.trigger) }}</a-tag>
          <span>账号 {{ auto.last_result.accounts }}</span>
          <span class="text-cyan-700">签成 {{ auto.last_result.claimed }}</span>
          <span>已签 {{ auto.last_result.already }}</span>
          <span v-if="auto.last_result.skipped">今日无可领 {{ auto.last_result.skipped }}</span>
          <span v-if="auto.last_result.unknown" class="text-orange-600">状态未知 {{ auto.last_result.unknown }}</span>
          <span v-if="auto.last_result.backoff">退避中 {{ auto.last_result.backoff }}</span>
          <span v-if="auto.last_result.failed" class="text-red-600">失败 {{ auto.last_result.failed }}</span>
          <span v-if="auto.last_result.gained" class="text-cyan-700">到账合计 {{ fmtQ(auto.last_result.gained) }}</span>
          <span class="text-slate-400">{{ auto.last_result.duration_ms }}ms · {{ dateText(auto.last_result.started_at) }}</span>
        </div>
        <div class="text-xs text-slate-400 mb-2">
          「到账合计」是上游余额前后差值（不是领取额合计）。状态未知的号<b>没有被签</b>——未知状态不拿盲签去赌。
        </div>
        <a-table
          size="small"
          :pagination="false"
          row-key="rowKey"
          :data-source="autoRows"
          :columns="autoColumns"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'action'">
              <a-tag :color="actionColor(record.action)">{{ actionText(record.action) }}</a-tag>
            </template>
            <template v-else-if="column.key === 'gained'">
              <span class="num">{{ record.gained != null ? fmtQ(record.gained) : '—' }}</span>
            </template>
            <template v-else-if="column.key === 'error'">
              <span v-if="record.error" class="text-xs text-red-600">{{ record.error }}</span>
              <span v-else-if="record.note" class="text-xs text-slate-400">{{ record.note }}</span>
              <span v-else class="text-xs text-slate-300">—</span>
            </template>
          </template>
        </a-table>
        <div class="text-xs text-slate-500 mt-2">
          {{ auto.rationale?.join(' · ') }}
        </div>
      </template>
    </a-card>

    <!-- ========= 凭证健康（P2-1，只读本地状态，不打上游） ========= -->
    <a-card :bordered="false" title="Qoder 凭证健康" class="mb-4">
      <div class="text-xs text-slate-400 mb-3">
        只读展示 <code>/qoder/status</code> 的本地凭证信息：<b>null 显示「未知」，不显示 0</b>。
        续期状态由后台轮转探针写；没记录就标「未观测」，不猜成正常。
      </div>
      <a-table size="small" :pagination="false" row-key="id" :data-source="credentialRows"
        :columns="[
          { title: '账号', dataIndex: 'nickname', key: 'nickname' },
          { title: '区域', key: 'region', width: 90 },
          { title: '凭证族', key: 'family', width: 100 },
          { title: '凭证完整', key: 'cred', width: 160 },
          { title: 'refresh 到期', key: 'exp', width: 180 },
          { title: '最近续期', key: 'refresh', width: 200 },
        ]">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'nickname'">
            <span>{{ record.nickname || '未命名' }}</span>
            <span class="text-xs text-slate-400 ml-1">#{{ record.id }}</span>
          </template>
          <template v-else-if="column.key === 'region'">
            <a-tag size="small" :color="record.region === 'cn' ? 'blue' : 'purple'">
              {{ record.region === 'cn' ? '国内' : '国际' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'family'">
            <span>{{ record.tokenFamily || 'unknown' }}</span>
          </template>
          <template v-else-if="column.key === 'cred'">
            <a-tag size="small" :color="record.hasRefresh && record.hasAccess ? 'green' : 'orange'">
              {{ record.hasRefresh && record.hasAccess ? '完整' : '缺失' }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'exp'">
            <span :class="record.refreshExpiresAt && record.refreshExpiresAt <= Date.now() ? 'text-red-500' : ''">
              {{ refreshText(record) }}
            </span>
          </template>
          <template v-else-if="column.key === 'refresh'">
            <span :class="record.tokenRefresh && !record.tokenRefresh.ok ? 'text-orange-500' : ''">
              {{ tokenRefreshText(record) }}
            </span>
            <span v-if="record.tokenRefresh?.error" class="text-xs text-slate-400 ml-1">{{ record.tokenRefresh.error }}</span>
          </template>
        </template>
      </a-table>
      <div v-if="!credentialRows.length" class="text-xs text-slate-400 mt-2">当前区域没有 Qoder 账号。</div>
    </a-card>

    <!-- ========= 计时器 ========= -->
    <a-card :bordered="false" title="超时与体积（P0-3）" class="mb-4">
      <div class="text-xs text-slate-400 mb-3">
        这三组计时器此前在模块加载时读一次 env 就定死，调阈值要重启网关。
        <b>0 = 关闭</b>该项计时器。读空闲必须大于首字节超时，否则两个计时器会抢跑。
      </div>
      <a-row :gutter="[16, 12]">
        <a-col v-for="f in timeoutFields" :key="f.key" :xs="24" :sm="12" :md="6">
          <div class="cfg-cell">
            <div class="text-xs text-slate-400">{{ f.label }}</div>
            <div class="flex items-center gap-2 mt-1">
              <a-input-number
                v-model:value="(rt.timeouts as any)[f.key]"
                :min="f.min" :max="f.max" :step="f.step"
                :disabled="!isAdmin" style="width: 100%"
              />
              <span class="text-xs text-slate-400 shrink-0">{{ f.unit }}</span>
            </div>
            <div class="text-xs text-slate-400 mt-1">{{ f.hint }}</div>
            <div v-if="diffOf('timeouts', f.key)" class="text-xs text-orange-600 mt-1">
              {{ diffOf('timeouts', f.key) }}
            </div>
          </div>
        </a-col>
      </a-row>
    </a-card>

    <!-- ========= 排队 ========= -->
    <a-card :bordered="false" title="排队与限流" class="mb-4">
      <div class="space-y-3 max-w-3xl">
        <div class="flex items-center justify-between">
          <div>
            <div>官方排队轮询协议</div>
            <div class="text-xs text-slate-400">
              同一 requestSetId 稳定 + 每轮重签防 103 去重 + queue/status 放行信号。
              关掉回到纯快速轮询（拿到限流就 429 交还客户端）
            </div>
          </div>
          <a-switch v-model:checked="rt.queue.pollEnabled" :disabled="!isAdmin" />
        </div>
        <a-row :gutter="[16, 12]">
          <a-col v-for="f in queueFields" :key="f.key" :xs="24" :sm="12" :md="8">
            <div class="cfg-cell">
              <div class="text-xs text-slate-400">{{ f.label }}</div>
              <div class="flex items-center gap-2 mt-1">
                <a-input-number
                  v-model:value="(rt.queue as any)[f.key]"
                  :min="f.min" :max="f.max" :step="f.step"
                  :disabled="!isAdmin" style="width: 100%"
                />
                <span class="text-xs text-slate-400 shrink-0">{{ f.unit }}</span>
              </div>
              <div class="text-xs text-slate-400 mt-1">{{ f.hint }}</div>
            </div>
          </a-col>
        </a-row>
      </div>
    </a-card>

    <!-- ========= 冷却与额度 ========= -->
    <a-card :bordered="false" title="冷却与 FEFO" class="mb-4">
      <a-row :gutter="[16, 12]">
        <a-col v-for="f in limitFields" :key="f.key" :xs="24" :sm="12" :md="8">
          <div class="cfg-cell">
            <div class="text-xs text-slate-400">{{ f.label }}</div>
            <div class="flex items-center gap-2 mt-1">
              <a-input-number
                v-model:value="(rt.limits as any)[f.key]"
                :min="f.min" :max="f.max" :step="f.step"
                :disabled="!isAdmin" style="width: 100%"
              />
              <span class="text-xs text-slate-400 shrink-0">{{ f.unit }}</span>
            </div>
            <div class="text-xs text-slate-400 mt-1">{{ f.hint }}</div>
          </div>
        </a-col>
      </a-row>
      <div class="text-xs text-slate-400 mt-3">
        冷却上限是<b>千问与 Qoder 共用</b>的那一个（上游按队列长度给过 7015 秒，照单全收等于封号两小时）。
      </div>
    </a-card>

    <!-- ========= 播报即收尾 ========= -->
    <a-card :bordered="false" title="「播报即收尾」修复" class="mb-4">
      <a-row :gutter="[16, 12]">
        <a-col v-for="f in repairFields" :key="f.key" :xs="24" :sm="12" :md="8">
          <div class="cfg-cell">
            <div class="text-xs text-slate-400">{{ f.label }}</div>
            <div class="flex items-center gap-2 mt-1">
              <a-input-number
                v-model:value="(rt.repair as any)[f.key]"
                :min="f.min" :max="f.max" :step="f.step"
                :disabled="!isAdmin" style="width: 100%"
              />
              <span class="text-xs text-slate-400 shrink-0">{{ f.unit }}</span>
            </div>
            <div class="text-xs text-slate-400 mt-1">{{ f.hint }}</div>
          </div>
        </a-col>
      </a-row>
    </a-card>

    <!-- ========= 并发与选号 ========= -->
    <a-card :bordered="false" title="单号并发与选号策略（P1-6 / P1-7）" class="mb-4">
      <div class="text-xs text-slate-400 mb-3">
        <b>默认全关（0）</b>——调研建议 Qoder 默认并发 1，但那是「先埋点观察 10605 排队率
        再定阈值」的结论。升级时静默把吞吐砍四分之三不是该做的事，所以要不要收紧是显式决定。
        设 1 之后超出部分在<b>本地排队</b>，比撞上游限流再走换号/冷却链路便宜得多。
      </div>
      <a-row :gutter="[16, 12]">
        <a-col :xs="24" :sm="12" :md="8">
          <div class="cfg-cell">
            <div class="text-xs text-slate-400">单号在途上限</div>
            <div class="flex items-center gap-2 mt-1">
              <a-input-number v-model:value="rt.concurrency.inflightMax" :min="0" :max="64" :disabled="!isAdmin" style="width: 100%" />
              <span class="text-xs text-slate-400 shrink-0">个</span>
            </div>
            <div class="text-xs text-slate-400 mt-1">0 = 用池默认 4；1 = 单号串行（超出本地排队）</div>
          </div>
        </a-col>
        <a-col :xs="24" :sm="12" :md="8">
          <div class="cfg-cell">
            <div class="text-xs text-slate-400">单号最小请求间隔</div>
            <div class="flex items-center gap-2 mt-1">
              <a-input-number v-model:value="rt.concurrency.minIntervalMs" :min="0" :max="600000" :step="100" :disabled="!isAdmin" style="width: 100%" />
              <span class="text-xs text-slate-400 shrink-0">ms</span>
            </div>
            <div class="text-xs text-slate-400 mt-1">0 = 关。约束发射节奏，不是请求时长</div>
          </div>
        </a-col>
        <a-col :xs="24" :sm="12" :md="8">
          <div class="cfg-cell">
            <div class="text-xs text-slate-400">选号策略</div>
            <a-select
              v-model:value="rt.concurrency.pickStrategy"
              :disabled="!isAdmin" style="width: 100%; margin-top: 4px"
              :options="strategyOptions"
            />
            <div class="text-xs text-slate-400 mt-1">
              默认加权抽签会把流量压到余额高的号（那恰是最容易排队的时候）
            </div>
            <div v-if="effConcurrency" class="text-xs text-slate-500 mt-1">
              生效：在途上限 {{ effConcurrency.inflightMax || '池默认 4' }} ·
              间隔 {{ effConcurrency.minIntervalMs || '关' }} ·
              {{ effConcurrency.pickStrategy || '池默认' }} ·
              保底 {{ effConcurrency.creditFloor || '关' }}
            </div>
          </div>
        </a-col>
        <a-col :xs="24" :sm="12" :md="8">
          <div class="cfg-cell">
            <div class="text-xs text-slate-400">积分保底</div>
            <div class="flex items-center gap-2 mt-1">
              <a-input-number
                v-model:value="rt.concurrency.creditFloor"
                :min="0" :max="1000000" :step="1" :disabled="!isAdmin"
                style="width: 100%"
              />
              <span class="text-xs text-slate-400 shrink-0">分</span>
            </div>
            <div class="text-xs text-slate-400 mt-1">
              0 = 关。低于此值的账号不进候选；全部低于时按余额最高者继续
            </div>
          </div>
        </a-col>
      </a-row>
      <div class="text-xs text-slate-400 mt-3">
        <b>粘性优先于 least-inflight</b>：前缀缓存命中率直接影响实付 token，而在途均衡只影响排队概率。
        两者冲突时选前者；least-inflight 只在暖列表全不可用时接管分配。
      </div>
    </a-card>

    <!-- ========= 出站身份句守卫（P0-1） ========= -->
    <a-card :bordered="false" title="出站身份句守卫（P0-1）" class="mb-4">
      <div class="flex items-start justify-between gap-4">
        <div class="text-xs text-slate-400">
          <p class="mb-1">
            上游实测（受控 A/B，2026-11-23）：<code>You are Codex,</code> /
            <code>powered by DeepSeekRuntime.</code> 这类身份句会触发
            <b>10605 / p1 硬拒绝</b>（伪装成排队，等待不会放行）。
          </p>
          <p class="mb-0">
            开启后只在品牌名后的标点前插一个空格（<code>You are Codex ,</code>），
            不改语义、不动自家品牌 Qoder，幂等；前缀缓存字节稳定。
            <b>默认关闭</b>，与 env <code>DUMATE_QODER_IDENTITY_GUARD=1</code> 等价。
          </p>
        </div>
        <a-switch v-model:checked="rt.identityGuard.enabled" :disabled="!isAdmin" />
      </div>
    </a-card>

    <!-- ========= 模型锁池（P2-19） ========= -->
    <a-card :bordered="false" title="模型锁池（P2-19）" class="mb-4">
      <template #extra>
        <a-space>
          <span class="text-xs text-slate-500">
            可选 {{ modelLocks.available }} / {{ modelLocks.totalAccounts }} 个号
          </span>
          <a-button size="small" class="ghost-btn" :loading="locksLoading" @click="loadLocks">刷新</a-button>
        </a-space>
      </template>

      <a-alert v-if="modelLocks.cleared" type="success" show-icon style="padding: 6px 10px">
        <template #message>所有模型均可选（没有任何模型级冷却）</template>
      </a-alert>

      <template v-else>
        <div class="text-xs text-slate-400 mb-2">
          限流是 <b>(账号, 模型)</b> 粒度的——「某个模型用不了」不等于通道挂了，换模型往往立刻可用。
          <b>最早解锁</b>是「有一个号能用了」，<b>全池解锁</b>才是「这个模型彻底恢复」，两者别混。
        </div>
        <a-table
          size="small"
          :pagination="false"
          :data-source="modelLocks.models"
          :columns="lockColumns"
          row-key="model"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'model'">
              <span class="font-mono text-xs">{{ record.model }}</span>
              <a-tag :color="lockKindColor(record.kind)" class="ml-1">{{ lockKindText(record.kind) }}</a-tag>
              <a-tag v-if="record.queueKind" :color="record.queueKind === 'hard' ? 'red' : 'blue'" class="ml-1"
                     :title="record.queueKind === 'hard'
                       ? '伪装成排队的身份拒绝（p1/serviceAvailable:false）——等待不会放行，需中和 system 身份句'
                       : '真排队（p4/queueCount>0）——等着会放行'">
                {{ lockQueueKindText(record.queueKind) }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'accounts'">
              <span class="text-xs">{{ record.accountCount }} 个号</span>
              <span class="text-xs text-slate-400">（{{ record.accounts.join('、') }}）</span>
            </template>
            <template v-else-if="column.key === 'earliest'">
              <span class="num text-xs">{{ msText(record.earliestInMs) }}</span>
            </template>
            <template v-else-if="column.key === 'allClear'">
              <span class="num text-xs font-medium" :class="record.allClearInMs > 600000 ? 'text-orange-600' : ''">
                {{ msText(record.allClearInMs) }}
              </span>
            </template>
            <template v-else-if="column.key === 'reason'">
              <span class="text-xs text-slate-500" :title="record.reason">{{ record.reason || '—' }}</span>
            </template>
          </template>
        </a-table>
      </template>
      <div class="text-xs text-slate-400 mt-2">{{ modelLocks.note }}</div>
    </a-card>

    <div v-if="isAdmin" class="flex items-center gap-2">
      <a-button type="primary" size="small" :loading="saving" @click="saveRuntime">保存配置</a-button>
      <a-popconfirm title="删除面板配置，全部字段回落到环境变量默认值？" @confirm="resetRuntime">
        <a-button size="small" danger>回落 env 默认</a-button>
      </a-popconfirm>
      <span class="text-xs text-slate-400">
        <template v-if="runtime.restartFields?.length">
          需重启字段：{{ runtime.restartFields.join('、') }}
        </template>
        <template v-else>无「需重启」字段——全部热生效</template>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { App } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import { qoderApi } from '@/api/qoder'
import type { QoderAccount, QoderAutoCheckin, QoderRuntime, QoderRuntimeConfig, QoderModelLocks } from '@/api/qoder'
import { regionParam } from '@/stores/region'
import { isAdmin } from '@/stores/auth'

const { message } = App.useApp()
const loading = ref(false)
const saving = ref(false)
const autoBusy = ref(false)
const credentialRows = ref<QoderAccount[]>([])
const err = ref('')
const file = ref('')
const runtime = ref<QoderRuntime>({
  file: '', fields: [], subfields: {},
  config: emptyConfig(), envDefaults: emptyConfig(),
  effective: { timeouts: emptyConfig().timeouts, concurrency: null },
  restartFields: [], note: '',
})

function emptyConfig(): QoderRuntimeConfig {
  return {
    timeouts: { firstByteMs: 60000, contentMs: 90000, readIdleMs: 120000, maxBodyMb: 29 },
    queue: { pollEnabled: true, pollBudgetMs: 60000, patienceMs: 6000, stepMs: 1500, pollIntervalMs: 0, cooldownMs: 5000 },
    limits: { throttleMaxMs: 600000, fefoDays: 3 },
    repair: { retry: 1, holdCap: 600 },
    concurrency: { inflightMax: 0, minIntervalMs: 0, pickStrategy: '', creditFloor: 0 },
    identityGuard: { enabled: false },
  }
}

const strategyOptions = [
  { label: '池默认（加权抽签）', value: '' },
  { label: '最少在途优先', value: 'least-inflight' },
]
const effConcurrency = computed(() => runtime.value.effective?.concurrency || null)

const rt = reactive<QoderRuntimeConfig>(emptyConfig())

const auto = reactive<QoderAutoCheckin>({
  enabled: false, hour: 10, minute: 15, jitter_minutes: 10, include_intl: false,
  per_account_delay_ms: 2500, retry_backoff_ms: 1800000,
  last_run_at: null, next_run_at: null, running: false, last_result: null, rationale: [],
})

const timeoutFields = [
  { key: 'firstByteMs', label: '首字节超时', unit: 'ms', min: 0, max: 1800000, step: 1000, hint: '挡「连响应头都不给」的挂起。0 = 关' },
  { key: 'contentMs', label: '无内容超时', unit: 'ms', min: 0, max: 1800000, step: 1000, hint: '排队先回空 ack 再沉默，只杀沉默。0 = 关' },
  { key: 'readIdleMs', label: '读空闲超时', unit: 'ms', min: 0, max: 1800000, step: 1000, hint: '每块数据重置。必须大于首字节超时' },
  { key: 'maxBodyMb', label: '请求体上限', unit: 'MB', min: 1, max: 100, step: 1, hint: '对齐 SLB 30MB 硬限，超限本地 413' },
]
const queueFields = [
  { key: 'pollBudgetMs', label: '排队等待预算', unit: 'ms', min: 0, max: 3600000, step: 5000, hint: '整次请求共享。0 = 不等待' },
  { key: 'patienceMs', label: '快速轮询总预算', unit: 'ms', min: 0, max: 300000, step: 500, hint: '0 = 拿到限流立刻 429' },
  { key: 'stepMs', label: '快速轮询间隔', unit: 'ms', min: 200, max: 60000, step: 100, hint: '过长会直接累加到用户等待' },
  { key: 'pollIntervalMs', label: '每轮排队睡眠', unit: 'ms', min: 0, max: 600000, step: 500, hint: '0 = 按上游 retryAfter（夹 [5s,20s]）' },
  { key: 'cooldownMs', label: '排队短冷却', unit: 'ms', min: 0, max: 600000, step: 500, hint: '排队不是账号坏了，别套 5 分钟基数' },
]
const limitFields = [
  { key: 'throttleMaxMs', label: '冷却时长上限', unit: 'ms', min: 1000, max: 86400000, step: 60000, hint: '上游给过 7015 秒，必须封顶' },
  { key: 'fefoDays', label: 'FEFO 临期窗口', unit: '天', min: 0, max: 365, step: 1, hint: '有临期批次时优先接流量。0 = 关' },
]
const repairFields = [
  { key: 'retry', label: '修复重试上限', unit: '次', min: 0, max: 5, step: 1, hint: '0 = 关闭整个修复' },
  { key: 'holdCap', label: '正文缓冲门阈值', unit: '字符', min: 0, max: 100000, step: 100, hint: '超过就转直发，长回答不被扣住' },
]

const autoColumns = [
  { title: '账号', dataIndex: 'name', key: 'name' },
  { title: '区域', dataIndex: 'region', key: 'region', width: 80 },
  { title: '结果', key: 'action', width: 130 },
  { title: '到账', key: 'gained', width: 100 },
  { title: '说明', key: 'error' },
]
const autoRows = computed(() => (auto.last_result?.results || []).map((r, i) => ({ ...r, rowKey: `${r.id}-${r.action}-${i}` })))

// ---- 模型锁池（P2-19）----
const locksLoading = ref(false)
const modelLocks = ref<QoderModelLocks>({
  models: [], cleared: true, totalAccounts: 0, lockedAccounts: 0, available: 0, note: '',
})
const lockColumns = [
  { title: '模型', key: 'model', width: '26%' },
  { title: '被锁账号', key: 'accounts', width: '20%' },
  { title: '最早解锁', key: 'earliest', width: '13%' },
  { title: '全池解锁', key: 'allClear', width: '13%' },
  { title: '原因', key: 'reason' },
]
function lockKindText(k: string) {
  return ({ queue: '排队', quota: '配额', model: '模型', other: '其它' } as Record<string, string>)[k] || k
}
function lockKindColor(k: string) {
  return ({ queue: 'blue', quota: 'orange', model: 'purple', other: 'default' } as Record<string, string>)[k] || 'default'
}
/** 排队形态：真排队 vs 伪装硬拒绝（2026-11-28 真机实测的字段差异） */
function lockQueueKindText(k: string) {
  return ({ real: '真排队', hard: '硬拒绝' } as Record<string, string>)[k] || k
}
/** 毫秒 → 「N 分」/「N 秒」/「N 小时 M 分」。0 显示「现在」 */
function msText(ms: number) {
  if (!(ms > 0)) return '现在'
  if (ms < 60000) return `${Math.ceil(ms / 1000)} 秒`
  if (ms < 3600000) return `${Math.ceil(ms / 60000)} 分`
  const h = Math.floor(ms / 3600000)
  const m = Math.ceil((ms % 3600000) / 60000)
  return `${h} 小时${m ? ` ${m} 分` : ''}`
}
async function loadLocks() {
  locksLoading.value = true
  try {
    const { data } = await qoderApi.modelLocks(regionParam() as 'cn' | 'intl' | undefined)
    modelLocks.value = data
  } catch (e: any) {
    message.error(e?.response?.data?.error || '读取模型锁池失败')
  } finally { locksLoading.value = false }
}

function fmtQ(v: number | null | undefined) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2)
}
function dateText(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
function triggerText(t: string) {
  return ({ scheduled: '定时', catchup: '补跑', manual: '手动', enable: '启用即跑' } as Record<string, string>)[t] || t
}
function actionText(a: string) {
  return ({
    claim: '已领取', already: '今日已签', skipped: '今日无可领',
    unknown: '状态未知（未签）', backoff: '退避中', refresh: '换票失败',
  } as Record<string, string>)[a] || a
}
function actionColor(a: string) {
  return ({
    claim: 'cyan', already: 'default', skipped: 'default',
    unknown: 'orange', backoff: 'blue', refresh: 'red',
  } as Record<string, string>)[a] || 'default'
}

/** 生效值与落盘值不一致时给一句说明（「我明明改过」不能变成悬案） */
function diffOf(group: 'timeouts', key: string) {
  const eff = (runtime.value.effective as any)?.[group]?.[key]
  const cur = (rt as any)?.[group]?.[key]
  if (eff == null || cur == null) return ''
  if (Number(eff) === Number(cur)) return ''
  return `生效值 ${eff}（本次未保存或读到了非法值，已回落）`
}

function copyConfig(c: QoderRuntimeConfig) {
  Object.assign(rt.timeouts, c.timeouts)
  Object.assign(rt.queue, c.queue)
  Object.assign(rt.limits, c.limits)
  Object.assign(rt.repair, c.repair)
  Object.assign(rt.concurrency, c.concurrency)
  if (c.identityGuard) Object.assign(rt.identityGuard, c.identityGuard)
}

function copyAuto(a: QoderAutoCheckin) {
  auto.enabled = a.enabled
  auto.hour = a.hour
  auto.minute = a.minute
  auto.jitter_minutes = a.jitter_minutes
  auto.include_intl = a.include_intl
  auto.per_account_delay_ms = a.per_account_delay_ms
  auto.retry_backoff_ms = a.retry_backoff_ms
  auto.last_run_at = a.last_run_at
  auto.next_run_at = a.next_run_at
  auto.running = a.running
  auto.last_result = a.last_result
  auto.rationale = a.rationale || []
}

async function loadRuntime() {
  try {
    const { data } = await qoderApi.runtime()
    runtime.value = data
    file.value = data.file
    copyConfig(data.config)
    err.value = ''
  } catch (e: any) {
    err.value = e?.response?.data?.error || '读取运行配置失败'
  }
}

async function loadAuto() {
  try {
    const { data } = await qoderApi.autocheckin()
    if (data.ok === false) err.value = data.error || '自动签到排程不可用'
    copyAuto(data)
  } catch (e: any) {
    err.value = e?.response?.data?.error || '读取自动签到状态失败'
  }
}

async function loadCredentials() {
  try {
    const { data } = await qoderApi.status(regionParam() as 'cn' | 'intl' | undefined)
    credentialRows.value = data.rows || []
  } catch (e: any) {
    err.value = e?.response?.data?.error || '读取凭证健康状态失败'
  }
}

async function loadAll() {
  loading.value = true
  try { await Promise.all([loadRuntime(), loadAuto(), loadLocks(), loadCredentials()]) } finally { loading.value = false }
}

function refreshText(a: QoderAccount) {
  if (!a.refreshExpiresAt) return '未知'
  const ms = a.refreshExpiresAt - Date.now()
  if (ms <= 0) return `已过期 ${dateText(a.refreshExpiresAt)}`
  return dateText(a.refreshExpiresAt)
}

function tokenRefreshText(a: QoderAccount) {
  if (!a.tokenRefresh) return '未观测'
  return a.tokenRefresh.ok ? `已续期 ${dateText(a.tokenRefresh.at)}` : `失败 ${dateText(a.tokenRefresh.at)}`
}

async function saveRuntime() {
  saving.value = true
  try {
    const { data } = await qoderApi.saveRuntime({
      timeouts: { ...rt.timeouts },
      queue: { ...rt.queue },
      limits: { ...rt.limits },
      repair: { ...rt.repair },
      concurrency: { ...rt.concurrency },
      identityGuard: { ...rt.identityGuard },
    })
    if (data.ok === false) { message.error(data.error || '保存失败'); return }
    await loadRuntime()
    message.success('已保存，网关下一次判定即生效')
  } catch (e: any) {
    // 未知键/越界值后端 400，原样显示——不吞成「保存失败」
    message.error(e?.response?.data?.error || '保存失败')
  } finally { saving.value = false }
}

async function resetRuntime() {
  try {
    const { data } = await qoderApi.resetRuntime()
    await loadRuntime()
    message.success(data.removed ? '已删除面板配置，回落到 env 默认值' : '面板配置本来就不存在，当前即 env 默认值')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '回落失败')
  }
}

async function saveAuto() {
  saving.value = true
  try {
    const { data } = await qoderApi.saveAutocheckin({
      hour: auto.hour, minute: auto.minute,
      jitter_minutes: auto.jitter_minutes, include_intl: auto.include_intl,
    })
    if (data.ok === false) { message.error(data.error || '保存失败'); return }
    copyAuto(data)
    message.success('签到配置已保存')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally { saving.value = false }
}

/** 开关切换：打开时后端会立即跑一轮（用户点了就想看到结果） */
async function toggleAuto(enabled?: boolean, includeIntl?: boolean) {
  try {
    const payload: any = {}
    if (enabled !== undefined) payload.enabled = enabled
    if (includeIntl !== undefined) payload.include_intl = includeIntl
    const { data } = await qoderApi.saveAutocheckin(payload)
    if (data.ok === false) { message.error(data.error || '保存失败'); return }
    copyAuto(data)
    if (enabled === true) message.success('已启用，正在跑一轮（结果稍后刷新）')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  }
}

async function runAuto() {
  autoBusy.value = true
  try {
    await qoderApi.runAutocheckin()
    message.success('已触发，一轮完成后刷新可见结果')
    // 一轮要打上游若干次，给一点时间再回读
    setTimeout(loadAuto, 4000)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '触发失败')
  } finally { autoBusy.value = false }
}

onMounted(loadAll)
</script>

<style scoped>
.cfg-cell {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 8px;
  padding: 8px 12px;
}
.field-line {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
