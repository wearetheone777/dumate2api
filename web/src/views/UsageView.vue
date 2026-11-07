<template>
  <div class="page">
    <PageHeader title="用量统计">
      <template #sub>
        按时间、模型与密钥维度统计 Token 消耗与请求量
        <template v-if="lastRefresh"> · 更新于 {{ lastRefresh }}</template>
      </template>
      <template #actions>
        <!-- 通道跟随顶栏的全局切换，不在这里另设选择器——两处各有一个
             开关必然出现互相矛盾的状态。这里只显示当前在看哪条通道 -->
        <a-tag :color="isQw ? 'cyan' : 'blue'" class="mr-1">{{ chLabel }}</a-tag>
        <a-select v-model:value="days" size="small" style="width: 110px" :options="dayOptions" />
        <!-- 月度账单 CSV（P2-18）：按当前页面选的月份导出，BOM + 公式注入防护在服务端 -->
        <a-select v-model:value="billMonth" size="small" style="width: 130px" :options="billMonthOptions" />
        <a-button size="small" class="ghost-btn" :loading="exporting" @click="exportMonthly">导出账单</a-button>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
    </PageHeader>

    <!-- 顶部卡片 -->
    <a-row :gutter="[16, 16]">
      <a-col :xs="24" :sm="12" :xl="6">
        <a-card :bordered="false" class="h-full">
          <a-spin v-if="loading && !data" size="small" />
          <template v-else>
            <a-statistic title="今日请求" :value="data?.cards.today.requests ?? '—'" value-style="color:var(--lab-primary)" />
            <div class="text-xs text-slate-500 mt-2">
              {{ data ? compact(data.cards.today.tokens) : '—' }} Token
            </div>
          </template>
        </a-card>
      </a-col>

      <a-col :xs="24" :sm="12" :xl="6">
        <a-card :bordered="false" class="h-full">
          <a-spin v-if="loading && !data" size="small" />
          <template v-else>
            <a-statistic title="本周请求" :value="data?.cards.week.requests ?? '—'" value-style="color:var(--lab-warn)" />
            <div class="text-xs text-slate-500 mt-2">
              {{ data ? compact(data.cards.week.tokens) : '—' }} Token
            </div>
          </template>
        </a-card>
      </a-col>

      <a-col :xs="24" :sm="12" :xl="6">
        <a-card :bordered="false" class="h-full">
          <!-- 四条通道四种账：搭子是上游账单（今日实付）、千问是剩余积分、
               TRAE 是按账号独立的剩余额度、WorkBuddy 是套餐包合计（国际版订阅制无口径）。
               同一张卡按通道换语义，但都要标出数字来源，否则额度政策一变没人知道数字错在哪 -->
          <a-spin v-if="(isQw && loading && !qw) || (isTw && loading && !twLoaded) || (isWb && loading && !wbLoaded) || (!isQw && !isTw && !isWb && loading && !data)" size="small" />
          <template v-else>
            <a-statistic
              :title="isTw ? '剩余额度' : isQw ? '剩余积分' : isWb ? '剩余积分' : '今日实付'"
              :value="isTw
                ? (twTotals.remain ?? '—')
                : isQw
                  ? (qw?.ok ? fmtQw(qw.total) : '—')
                  : isWb
                    ? (wbTotals.remain ?? '—')
                    : (data?.cards.today.consumed_points ?? '—')"
              :precision="isQw || isTw || isWb || data?.cards.today.consumed_points == null ? undefined : 2"
              :value-style="isQw || isTw || isWb ? 'color:var(--lab-primary)' : undefined"
            />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="isTw">
                <!-- 国际版是订阅制（按请求数计）：没有积分口径，remain 恒 null。
                     「取不到」与「这个口径不适用」是两回事——国际视图里写
                     「取不到 TRAE 额度」会让人以为上游坏了（bsk 真机点击抓到） -->
                <template v-if="twIntlPlanName">
                  <a-tag color="purple" class="mr-1">{{ twIntlPlanName }}</a-tag>
                  订阅制·按请求数计，无积分口径
                </template>
                <template v-else-if="twTotals.remain != null">
                  按账号独立计算<template v-if="twTotals.limit">
                    · 上限合计 <span class="num">{{ twTotals.limit.toLocaleString('zh-CN') }}</span>
                  </template>
                </template>
                <span v-else>取不到 TRAE 额度</span>
              </template>
              <template v-else-if="isQw">
                <template v-if="qw?.ok">
                  <!-- 2026-11-01 起上游不再发放每日免费额度（daily 池恒 0），
                       所以这里不再有「每日上限」的分母可标——只剩付费余额与刷新时刻 -->
                  <a-tag color="blue" class="qw-mini">付费</a-tag>
                  月度 + 长期
                  <template v-if="qw.resetAt"> · {{ fmtReset(qw.resetAt) }} 刷新</template>
                </template>
                <span v-else>{{ qw?.error || '取不到千问积分' }}</span>
              </template>
              <template v-else-if="isWb">
                <!-- 国际版是订阅制（按请求数计）：没有套餐包，与「取不到」是两回事 -->
                <template v-if="isIntlRegion() && wbLoaded && !wbRows.some((r) => r.total != null)">
                  <a-tag color="purple" class="mr-1">订阅制</a-tag>
                  按请求数计，无积分口径
                </template>
                <template v-else-if="wbTotals.remain != null">
                  billing 套餐包按账号独立
                  <template v-if="wbExpiring > 0">
                    · <span class="text-orange-700">7 天内到期 <span class="num">{{ wbExpiring }}</span></span>
                  </template>
                </template>
                <span v-else>取不到 WorkBuddy 额度</span>
              </template>
              <template v-else-if="data">{{ data.cards.today.point_records }} 条计费记录</template>
              <span v-else>—</span>
            </div>
          </template>
        </a-card>
      </a-col>

      <a-col :xs="24" :sm="12" :xl="6">
        <a-card :bordered="false" class="h-full">
          <a-spin v-if="loading && !data" size="small" />
          <template v-else>
            <a-statistic title="活跃密钥" :value="data?.cards.active_keys ?? '—'" value-style="color:var(--lab-ok)" />
            <div class="text-xs text-slate-500 mt-2">
              主力模型 {{ data?.cards.top_model || '—' }}
            </div>
          </template>
        </a-card>
      </a-col>
    </a-row>

    <!-- 今日概览：只有请求数与 token 说不清「今天跑得怎么样」，
         补上成功率、快慢与今日在用的模型 -->
    <a-card title="今日概览" :bordered="false" class="mt-4">
      <a-spin v-if="loading && !data" size="small" />
      <a-empty v-else-if="!data || !data.cards.today.requests" description="今天还没有请求" />
      <template v-else>
        <a-descriptions :column="{ xs: 1, sm: 2, xl: 4 }" size="small" bordered>
          <a-descriptions-item label="请求数">
            <span class="num">{{ fmt(data.cards.today.requests) }}</span>
            <a-tag v-if="data.cards.today.failed" color="red" class="ml-1">
              失败 <span class="num">{{ data.cards.today.failed }}</span>
            </a-tag>
          </a-descriptions-item>
          <a-descriptions-item label="成功率">
            <span class="num" :class="successRateColor">{{ successRateText }}</span>
          </a-descriptions-item>
          <a-descriptions-item label="Token">
            <span class="num">{{ compact(data.cards.today.tokens) }}</span>
          </a-descriptions-item>
          <a-descriptions-item label="实付积分">
            <template v-if="data.cards.today.consumed_points !== null">
              <span class="num">{{ fmt(data.cards.today.consumed_points) }}</span>
              <span class="text-xs text-slate-400 ml-1">
                （<span class="num">{{ data.cards.today.point_records }}</span> 条）
              </span>
            </template>
            <!-- 千问的积分不进搭子上游账单：如实显示 —，不补 0
                 （会被读成「今天没花钱」），具体数字在下方「千问办公积分」卡 -->
            <span v-else class="text-slate-400">—</span>
          </a-descriptions-item>
          <a-descriptions-item label="平均耗时">
            <span class="num">{{ data.cards.today.avg_ms !== null ? fmt(data.cards.today.avg_ms) + ' ms' : '—' }}</span>
          </a-descriptions-item>
          <a-descriptions-item label="平均首字">
            <template v-if="data.cards.today.avg_first_token_ms !== null">
              <span class="num">{{ fmt(data.cards.today.avg_first_token_ms) }} ms</span>
              <span class="text-xs text-slate-400 ml-1">
                （<span class="num">{{ data.cards.today.first_token_samples }}</span> 条样本）
              </span>
            </template>
            <span v-else class="text-slate-400">—</span>
          </a-descriptions-item>
          <a-descriptions-item label="输入 / 输出">
            <span class="num">{{ compact(data.cards.today.input_tokens) }}</span> /
            <span class="num">{{ compact(data.cards.today.output_tokens) }}</span>
          </a-descriptions-item>
          <a-descriptions-item label="流式请求">
            <span class="num">{{ fmt(data.cards.today.stream_count) }}</span>
          </a-descriptions-item>
        </a-descriptions>

        <div v-if="data.cards.today.models.length" class="mt-3">
          <div class="block-label">今日用量按模型</div>
          <div class="chip-list">
            <span v-for="m in data.cards.today.models" :key="m.model" class="usage-chip">
              <span class="usage-chip-name">{{ m.model }}</span>
              <span class="usage-chip-sep" />
              <span class="usage-chip-val num">{{ compact(m.tokens) }}</span>
            </span>
          </div>
        </div>

        <!-- 按通道：千问首帧实测 6.7s，与搭子混在同一均值里会让
             「平均首字延迟」既偏高又无法归因，所以分开列 -->
        <div v-if="data.by_channel?.length" class="mt-3">
          <div class="block-label">按通道</div>
          <div class="chip-list">
            <span
              v-for="c in data.by_channel"
              :key="c.id"
              class="usage-chip"
              :class="c.id === 'qwenwork' ? 'chip-cyan' : c.id === 'dumate' ? 'chip-blue' : ''"
            >
              <span class="usage-chip-name">{{ c.label }}</span>
              <span class="usage-chip-sep" />
              <span class="usage-chip-val num">{{ compact(c.total_tokens) }}</span>
              <span class="usage-chip-val num">{{ c.requests }} 次</span>
              <span v-if="c.avg_first_token_ms != null" class="usage-chip-dim">
                首字 {{ fmtMs(c.avg_first_token_ms) }}
              </span>
              <span v-if="c.failed" class="usage-chip-bad">失败 {{ c.failed }}</span>
            </span>
          </div>
          <div v-if="hasUntagged" class="text-xs text-slate-400 mt-1">
            「未标注」是分通道埋点上线前的历史记录，不并入任一通道。
          </div>
        </div>
      </template>
    </a-card>

    <!-- 全价请求洞察（hub v1.7.21 融合）：prompt ≥ 阈值且确认零缓存的请求——
         换前缀 / 新开会话 / 压缩后首轮的高成本形态，单行日志看不出来。 -->
    <a-card title="全价请求洞察" :bordered="false" class="mt-4">
      <template #extra>
        <span class="text-xs text-slate-400">阈值 ≥ {{ compact(agg?.full_price?.threshold ?? 100000) }} prompt token 且确认零缓存</span>
      </template>
      <a-spin v-if="loading && !agg" size="small" />
      <template v-else-if="agg?.full_price && agg.full_price.requests > 0">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <div class="block-label">请求次数</div>
            <div class="num text-lg">{{ fmt(agg.full_price.requests) }}</div>
          </div>
          <div>
            <div class="block-label">Prompt Token</div>
            <div class="num text-lg">{{ compact(agg.full_price.prompt_tokens) }}</div>
          </div>
          <div>
            <div class="block-label">占窗口 prompt 比例</div>
            <div class="num text-lg">{{ (agg.full_price.prompt_share * 100).toFixed(1) }}%</div>
          </div>
          <div>
            <div class="block-label">窗口内三段 Token</div>
            <div class="num text-sm">
              非缓存输入 {{ compact(agg.totals?.input_noncached_tokens ?? 0) }} /
              缓存命中 {{ compact(agg.totals?.cached_tokens ?? 0) }}
            </div>
          </div>
        </div>
        <div class="text-xs text-slate-400 mt-2">
          降本做法：保持会话前缀稳定（Qoder 已做前缀缓存亲和）、走压缩而不是重开会话；
          「确认零缓存」只统计上游回报了缓存字段且为 0 的成功请求——没回报的算未知，不虚增占比。
          积分占比不做：各通道积分口径不同且埋点无统一 credits 字段，不编数。
        </div>
      </template>
      <a-empty v-else description="窗口内没有全价请求——前缀复用良好" />
    </a-card>

    <a-alert
      v-if="data"
      type="info"
      show-icon
      class="mt-4"
      :message="data.note"
    />

    <!-- Token 消耗趋势 -->
    <a-card title="Token 消耗趋势" :bordered="false" class="mt-4">
      <template #extra><span class="text-xs text-slate-400">按天聚合</span></template>
      <a-spin v-if="loading && !data" size="small" />
      <a-empty v-else-if="!data || !data.daily.length" description="还没有请求记录" />
      <div v-else ref="chartEl" style="height: 280px"></div>
    </a-card>

    <!-- 按模型 / 按密钥 -->
    <a-row :gutter="[16, 16]" class="mt-4">
      <a-col :xs="24" :md="12">
        <a-card title="按模型" :bordered="false">
          <a-spin v-if="loading && !data" size="small" />
          <a-empty v-else-if="!data || !data.by_model.length" description="暂无数据" />
          <a-table
            v-else
            size="small"
            :pagination="{ pageSize: 10, size: 'small', showSizeChanger: false }"
            :data-source="data.by_model"
            :columns="modelColumns"
            row-key="model"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <span class="font-mono text-xs">{{ record.model }}</span>
              </template>
              <template v-else-if="column.key === 'tokens'">
                <span class="num">{{ compact(record.total_tokens) }}</span>
              </template>
              <template v-else-if="column.key === 'requests'">
                <span class="num">{{ fmt(record.requests) }}</span>
                <a-tag v-if="record.failed" color="red" class="ml-1">{{ record.failed }}</a-tag>
              </template>
            </template>
          </a-table>
        </a-card>
      </a-col>

      <a-col :xs="24" :md="12">
        <a-card title="按密钥" :bordered="false">
          <a-spin v-if="loading && !data" size="small" />
          <a-empty v-else-if="!data || !data.by_key.length" description="暂无数据" />
          <a-table
            v-else
            size="small"
            :pagination="false"
            :data-source="data.by_key"
            :columns="keyColumns"
            row-key="name"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                {{ record.name }}
              </template>
              <template v-else-if="column.key === 'tokens'">
                <span class="num">{{ compact(record.total_tokens) }}</span>
              </template>
              <template v-else-if="column.key === 'requests'">
                <span class="num">{{ fmt(record.requests) }}</span>
                <a-tag v-if="record.failed" color="red" class="ml-1">{{ record.failed }}</a-tag>
              </template>
            </template>
          </a-table>
          <div v-if="data && !data.cards.active_keys" class="text-xs text-slate-400 mt-2">
            网关鉴权当前关闭（所有请求都未带密钥），因此没有密钥维度的区分。
          </div>
        </a-card>
      </a-col>
    </a-row>

    <!-- 千问办公的积分池。与搭子的「按账号积分消耗」是两套账：
         千问的积分在 qwenwork.cn 的付费池里（每日免费额度上游已停发） -->
    <a-card v-if="isQw" title="千问办公积分" :bordered="false" class="mt-4">
      <a-spin v-if="loading && !qw" size="small" />
      <a-empty v-else-if="!qw || !qw.ok" :description="qw?.error || '取不到千问积分'" />
      <template v-else>
        <a-row :gutter="[16, 16]">
          <a-col v-for="w in qw.wallets" :key="w.id" :xs="24" :sm="8" :span="6">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">{{ w.label }}</span>
                <a-tag color="blue" class="qw-mini">付费</a-tag>
              </div>
              <div class="qw-pool-value num">
                {{ fmtQw(w.balance) }}
              </div>
              <div class="qw-pool-sub">
                <template v-if="w.id === 'monthly'">
                  按有效期<template v-if="w.resetAt"> · {{ fmtReset(w.resetAt) }} 刷新</template>
                </template>
                <template v-else>充值 / 赠送</template>
              </div>
            </div>
          </a-col>
          <a-col :xs="24" :sm="8" :span="6">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">今日消耗</span>
                <a-tag class="qw-mini">经本网关</a-tag>
              </div>
              <div class="qw-pool-value num">{{ fmtQw(qw.today.total) }}</div>
              <div class="qw-pool-sub">{{ qw.today.requests }} 次请求</div>
            </div>
          </a-col>
        </a-row>

        <!-- 消耗口径：只有「经本网关」这一套是实测的。
             「今日全部消耗（含客户端内对话）」需要「每日上限 − 余额」，
             而上游已不再发放每日额度（2026-11-01 起 daily 恒 0），推不出来。 -->
        <a-alert type="info" show-icon class="mt-3">
          <template #message>消耗口径</template>
          <template #description>
            <div>
              「今日消耗」= {{ fmtQw(qw.today.total) }} —— 只统计经过本网关转发的请求，
              按 req_id 逐条实测（前后余额差值）。
            </div>
            <div class="text-slate-400">
              在客户端 / 网页里直接对话的消耗不经过本网关，这里看不到；
              上游已停止发放每日免费额度，也无法再用「上限 − 余额」推算全天消耗。
            </div>
          </template>
        </a-alert>
      </template>
    </a-card>

    <!-- TRAE Work 的额度。与千问的三个池子、搭子的上游账单是三套账，
         不合并成一个「积分」区块——合并出来的数字没有任何一处对得上 -->
    <a-card v-if="isTw" title="TRAE Work 额度" :bordered="false" class="mt-4">
      <a-spin v-if="loading && !twLoaded" size="small" />
      <a-empty v-else-if="!twRows.length" description="还没有 TRAE Work 账号" />
      <template v-else>
        <a-table
          size="small"
          :pagination="false"
          :data-source="twRows"
          :columns="twColumns"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              {{ record.nickname || record.uid || '未命名' }}
              <div v-if="record.error" class="text-xs text-red-600">{{ record.error }}</div>
            </template>
            <template v-else-if="column.key === 'remain'">
              <!-- 国际版订阅制：积分口径恒 null，显示套餐名而不是 0 -->
              <span v-if="record.intlPlan" class="font-medium">
                {{ record.intlPlan.name }}
                <span class="text-xs text-slate-400">按请求数计</span>
              </span>
              <span v-else-if="record.remain != null" class="font-medium num">
                {{ record.remain.toLocaleString('zh-CN') }}
              </span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'limit'">
              <span v-if="record.limit" class="num">{{ record.limit.toLocaleString('zh-CN') }}</span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'checkin'">
              <a-tag v-if="record.checkedIn == null" color="default">—</a-tag>
              <a-tag v-else :color="record.checkedIn ? 'green' : 'orange'">
                {{ record.checkedIn ? '已签到' : '未签到' }}
              </a-tag>
            </template>
          </template>
        </a-table>
        <div class="text-xs text-slate-400 mt-2">
          额度按账号独立，不共享；取不到时显示 —，不补 0。
          签到每日一次且幂等，重复执行不会多领。
        </div>
      </template>
    </a-card>

    <!-- WorkBuddy 的额度。与千问的三个池子、TRAE 的单一 credits 都是不同的账：
         国内是套餐包（各包独立到期），国际是订阅制（无积分口径） -->
    <a-card v-if="isWb" title="WorkBuddy 额度" :bordered="false" class="mt-4">
      <a-spin v-if="loading && !wbLoaded" size="small" />
      <a-empty
        v-else-if="!wbRows.length"
        :description="`还没有${isIntlRegion() ? '国际' : '国内'}版账号`"
      />
      <template v-else>
        <a-table
          size="small"
          :pagination="false"
          :data-source="wbRows"
          :columns="wbColumns"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              {{ record.nickname || record.uid || '未命名' }}
              <div v-if="record.error" class="text-xs text-red-600">{{ record.error }}</div>
            </template>
            <template v-else-if="column.key === 'region'">
              <a-tag :color="record.region === 'global' ? 'purple' : 'blue'" class="mr-0">
                {{ record.region === 'global' ? '国际' : '国内' }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'remain'">
              <!-- 国际版订阅制：没有套餐包，显示口径说明而不是 0 -->
              <span v-if="record.total == null" class="text-slate-400">—</span>
              <span v-else class="font-medium num">
                {{ record.totalPrecise != null ? record.totalPrecise : record.total }}
              </span>
            </template>
            <template v-else-if="column.key === 'expiring'">
              <span v-if="wbRowExpiring(record) > 0" class="num text-orange-700">
                {{ wbRowExpiring(record) }}
              </span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'checkin'">
              <a-tag v-if="record.unsupportedCheckin || record.region === 'global'" color="default">不支持</a-tag>
              <a-tag v-else-if="record.checkedIn == null" color="default">—</a-tag>
              <a-tag v-else :color="record.checkedIn ? 'green' : 'orange'">
                {{ record.checkedIn ? '已签到' : '未签到' }}
              </a-tag>
            </template>
          </template>
        </a-table>
        <div class="text-xs text-slate-400 mt-2">
          套餐包按账号独立，不共享；到期即作废，已用完的包不计入临期。
          取不到时显示 —，不补 0。
        </div>
      </template>
    </a-card>

    <!-- 按账号积分消耗：只有搭子有上游计费账单。直连通道的账在各自的
         池子里，挂一张空表出来只会让人以为「这条通道没消耗」 -->
    <a-card v-if="!isQw && !isTw && !isWb" title="按账号积分消耗" :bordered="false" class="mt-4">
      <div class="text-xs text-slate-500 mb-2">
        来自上游计费记录（近 {{ data?.days ?? days }} 天）——本地日志算不出扣费，单价在上游。
      </div>
      <a-spin v-if="loading && !data" size="small" />
      <a-table
        v-else
        size="small"
        :pagination="false"
        :data-source="data?.points_by_account ?? []"
        :columns="accountColumns"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            {{ record.name }}
            <div v-if="!record.ok" class="text-xs text-red-600">{{ record.error }}</div>
          </template>
          <template v-else-if="column.key === 'consumed'">
            <span v-if="record.ok" class="num">{{ fmt(record.consumed_points) }}</span>
            <span v-else class="text-slate-400">—</span>
          </template>
          <template v-else-if="column.key === 'count'">
            <span v-if="record.ok" class="num">{{ fmt(record.count) }}</span>
            <span v-else class="text-slate-400">—</span>
          </template>
        </template>
      </a-table>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import { channelStore, CHANNELS, isTraework, isQwenwork, isWorkBuddy, channelParam } from '@/stores/channel'
import { regionParam, isIntlRegion } from '@/stores/region'
import { qwenworkApi } from '@/api/qwenwork'
import { traeworkApi } from '@/api/traework'
import { workbuddyApi } from '@/api/workbuddy'
import type { TraeworkCreditRow } from '@/api/traework'
import type { WorkBuddyCreditRow } from '@/api/workbuddy'
import type { QwCredits } from '@/api/qwenwork'
import type { UsageOverview } from '@/api/usage'
import { monthlyBillingApi } from '@/api/traeruntime'
import { App } from 'ant-design-vue'

const { message } = App.useApp()

// ECharts 按需引入：只加载柱状图需要的模块
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { SERIES, INK, TOOLTIP_BASE, axisStyle, compactNum, exactNum, barSeries } from '@/utils/chartTheme'

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

const data = ref<UsageOverview | null>(null)
const loading = ref(false)
const lastRefresh = ref('')
const days = ref(30)
// 月度账单：月份列表来自服务端账本（只列真有数据的月份），空 = 全量
const billMonth = ref('')
const billMonths = ref<string[]>([])
const exporting = ref(false)
const billMonthOptions = computed(() => [
  { label: '全部月份', value: '' },
  ...billMonths.value.map((m) => ({ label: m, value: m })),
])

async function loadBillMonths() {
  try {
    const { data } = await monthlyBillingApi.list()
    billMonths.value = data.months || []
  } catch { /* 账单入口故障不影响主视图 */ }
}

async function exportMonthly() {
  exporting.value = true
  try {
    // 走 axios 拿 blob：浏览器直接打开 URL 会丢掉管理端会话错误语义
    const res = await client.get(monthlyBillingApi.exportUrl(billMonth.value, channelParam()), { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `dumate2api-billing-${billMonth.value || 'all'}.csv`
    a.click()
    URL.revokeObjectURL(url)
    message.success('账单已导出（UTF-8 BOM）')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '导出失败')
  } finally {
    exporting.value = false
  }
}

// 全价请求洞察（/usage/agg 的 full_price 段）：与 overview 同窗口（days 天）。
// 聚合失败不挡用量主视图——静默给空，卡片回落到「没有全价请求」的空态。
interface FullPrice {
  threshold: number
  requests: number
  prompt_tokens: number
  prompt_share: number
}
interface AggSnapshot {
  full_price?: FullPrice
  totals?: { input_noncached_tokens?: number; cached_tokens?: number }
}
const agg = ref<AggSnapshot | null>(null)

// 当前通道。**服务端按通道过滤**而不是前端筛已聚合的数字——
// 卡片、折线、按模型表都建立在同一批行上，前端筛只能筛掉表里的行，
// 顶部卡片的数字仍是全通道的，两者会对不上。
// 三条通道：搭子的扣费在上游账单里（pointsUsage）；千问的在 qwenwork.cn
// 的三个池子里；TRAE 的是每个账号独立的 credits。三套账互不相干，
// 不能合并显示——合并出来的数字没有任何一处对得上。
const isTw = computed(() => isTraework())
const isQw = computed(() => isQwenwork())
const isWb = computed(() => isWorkBuddy())
const chLabel = computed(() => CHANNELS.find((c) => c.id === channelStore.current)?.label || channelStore.current)

// 千问积分。它是**另一套账**：搭子的扣费在上游账单里（pointsUsage），
// 千问的在 qwenwork.cn 的三个池子里，两边互不相干，不能合并显示。
// 拉取在 load() 里与用量并行做。
const qw = ref<QwCredits | null>(null)

// TRAE 的额度：按账号独立。与千问的三个池子不同，这里只看「剩余多少」。
const twRows = ref<TraeworkCreditRow[]>([])
// 首次拉取完成前 twRows 为空不代表「没有账号」——空态要等 loaded 才能下结论
const twLoaded = ref(false)
const twTotals = computed(() => {
  let remain: number | null = null
  let limit: number | null = null
  for (const r of twRows.value) {
    if (r.remain != null) remain = (remain ?? 0) + r.remain
    if (r.limit != null) limit = (limit ?? 0) + r.limit
  }
  return { remain, limit }
})
// 国际版订阅制（按请求数计）没有积分口径：行里有 intlPlan 就说明这是订阅账号，
// 额度卡要显示套餐名而不是「取不到 TRAE 额度」（两回事）
const twIntlPlanName = computed(() => {
  const hit = twRows.value.find((r) => r.intlPlan)
  return hit ? hit.intlPlan!.name : ''
})

// WorkBuddy 的额度：按账号独立的套餐包（国内）或订阅制（国际）。
// 与 TRAE 同构但口径不同：没有 limit 分母，临期合计按包的 expireAt 算。
const wbRows = ref<WorkBuddyCreditRow[]>([])
// 首次拉取完成前 wbRows 为空不代表「没有账号」——空态要等 loaded 才能下结论
const wbLoaded = ref(false)
const wbTotals = computed(() => {
  let remain: number | null = null
  let checked = 0
  for (const r of wbRows.value) {
    if (r.total != null) remain = (remain ?? 0) + (r.totalPrecise != null ? r.totalPrecise : r.total)
    if (r.checkedIn === true) checked++
  }
  return { remain, checked }
})
// 7 天内到期合计（已用完的包不计入——到期不构成损失）
const wbExpiring = computed(() => {
  const now = Date.now()
  let amount = 0
  for (const r of wbRows.value) {
    for (const p of r.packages || []) {
      if (p.expireAt && p.expireAt > now && p.expireAt <= now + 7 * 86400000 && p.remain > 0) {
        amount += p.remainPrecise != null ? p.remainPrecise : p.remain
      }
    }
  }
  return amount
})
const wbRowExpiring = (r: WorkBuddyCreditRow) => {
  const now = Date.now()
  let sum = 0
  for (const p of r.packages || []) {
    if (p.expireAt && p.expireAt > now && p.expireAt <= now + 7 * 86400000 && p.remain > 0) {
      sum += p.remainPrecise != null ? p.remainPrecise : p.remain
    }
  }
  return sum
}

const wbColumns = [
  { title: '账号', key: 'name', width: '28%' },
  { title: '区域', key: 'region', width: '10%' },
  { title: '套餐剩余', key: 'remain', width: '16%' },
  { title: '7 天内到期', key: 'expiring', width: '15%' },
  { title: '今日签到', key: 'checkin' },
]

// 积分保留 2~4 位：实测单次消耗 0.0025，按 2 位显示会变成 0
const fmtQw = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 })

// 额度刷新时刻（上游 active_wallet 的 valid_to = 月度额度刷新点）
const fmtReset = (s: string) => {
  const d = new Date(s)
  return Number.isFinite(d.getTime())
    ? d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : s
}

// 「未标注」= channel 字段上线前的历史记录。不并入任一通道——那会让
// 搭子的历史数字凭空变大，而用户无从察觉。
// 首字延迟的展示格式：与请求日志页保持一致（秒/毫秒自动切换）
function fmtMs(ms?: number | null) {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

// 已按单通道过滤时服务端不返回 by_channel（只会得到一行自己的数据），
// 此时不再显示「按通道」区块
const hasUntagged = computed(() => (data.value?.by_channel || []).some((c) => c.id === 'untagged'))

const dayOptions = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
]

const modelColumns = [
  { title: '模型', key: 'name' },
  { title: '请求', key: 'requests', width: '26%' },
  { title: 'Token', key: 'tokens', width: '26%' },
]
const keyColumns = [
  { title: '密钥', key: 'name' },
  { title: '请求', key: 'requests', width: '26%' },
  { title: 'Token', key: 'tokens', width: '26%' },
]
const accountColumns = [
  { title: '账号', key: 'name' },
  { title: '消耗积分', key: 'consumed', width: '24%' },
  { title: '计费记录', key: 'count', width: '20%' },
]
// TRAE 的额度表：剩余 / 上限 / 签到。没有「消耗积分」列——上游不给
// 逐笔账单，只有存量快照
const twColumns = [
  { title: '账号', key: 'name' },
  { title: '剩余额度', key: 'remain', width: '24%' },
  { title: '额度上限', key: 'limit', width: '24%' },
  { title: '今日签到', key: 'checkin', width: '20%' },
]

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const compact = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
    : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)

const successRateText = computed(() => {
  const r = data.value?.cards.today.success_rate
  return r === null || r === undefined ? '—' : r + '%'
})
const successRateColor = computed(() => {
  const r = data.value?.cards.today.success_rate ?? 0
  return r >= 99 ? 'text-green-700' : r >= 95 ? 'text-orange-700' : 'text-red-600'
})

const chartEl = ref<HTMLElement | null>(null)
let chartInst: echarts.ECharts | null = null

function renderChart() {
  if (!chartEl.value || !data.value) return
  if (!chartInst) chartInst = echarts.init(chartEl.value)

  const rows = data.value.daily
  chartInst.setOption({
    grid: { left: 60, right: 16, top: 12, bottom: 26 },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any[]) => {
        const row = rows[params[0].dataIndex]
        // 数值为主、名称次之：读者已经知道看的是哪一天，要的是数字
        return `<div style="color:${INK.muted};font-size:11px">${row.day}</div>`
          + `<div style="margin-top:2px">Token <b>${exactNum(row.total_tokens)}</b></div>`
          + `<div>请求 <b>${exactNum(row.requests)}</b></div>`
          + (row.failed ? `<div style="color:var(--lab-danger)">失败 <b>${exactNum(row.failed)}</b></div>` : '')
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.day.slice(5)),
      ...axisStyle({ showGrid: false }),
    },
    yAxis: {
      type: 'value',
      ...axisStyle({ formatter: (v: number) => compactNum(v) }),
    },
    // 单序列用槽位 1 一种颜色即可，不做「越大越深」的值映射——
    // 那会把长度已经表达过的信息再用色相编码一遍，白白占掉唯一的颜色通道
    series: [barSeries({ data: rows.map((r) => r.total_tokens), color: SERIES[0] })],
  })
}

async function load() {
  loading.value = true
  // 每次加载都重置 TRAE 的「已取到」标志：切通道时旧值 true 会先闪一次空态
  twLoaded.value = false
  try {
    // 服务端按通道过滤。TRAE 走 channelParam() 而不是硬编码——
    // 加第四条通道时不该再来改这里。区域视图（顶栏切换）也一并传给后端
    const ch = channelParam()
    const r = regionParam()
    const rQ = r ? `&region=${r}` : ''
    // 额度与用量并行拉：两者互不依赖，串行只会白等一个来回
    const [usage, credits, aggRes] = await Promise.all([
      client.get(`/usage/overview?days=${days.value}&channel=${ch}${rQ}`),
      isTw.value ? traeworkApi.credits(r as 'cn' | 'intl').catch(() => ({ data: { count: 0, rows: [] } }))
        : isQw.value ? qwenworkApi.credits()
        : isWb.value ? workbuddyApi.credits(r as 'cn' | 'intl').catch(() => ({ data: { count: 0, rows: [] } }))
        : Promise.resolve(null),
      // 全价窗口与 overview 对齐（hours=days*24）；失败不影响主视图
      client.get(`/usage/agg?hours=${days.value * 24}${ch ? `&channel=${ch}` : ''}`).catch(() => null),
    ])
    data.value = usage.data
    agg.value = (aggRes as any)?.data || null
    if (isTw.value) {
      twRows.value = (credits as any)?.data?.rows || []
      twLoaded.value = true
    } else if (isQw.value) qw.value = (credits as any).data
    else if (isWb.value) {
      wbRows.value = (credits as any)?.data?.rows || []
      wbLoaded.value = true
    }
    lastRefresh.value = new Date().toLocaleTimeString('zh-CN')
    await nextTick()
    renderChart()
  } catch {
    // 失败保留上一份数据（或显示 —），不把错误态伪装成加载态。
    // 千问卡的错误说明由 qw.error 自带；这里静默即可。
  } finally {
    loading.value = false
  }
}

function onResize() { chartInst?.resize() }

watch(days, load)
// 切通道要重新拉数据（服务端过滤），不能只改前端显示
watch(() => channelStore.current, load)

onMounted(() => {
  window.addEventListener('resize', onResize)
  load()
  loadBillMonths()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  chartInst?.dispose()
  chartInst = null
})
</script>

<style scoped>
/* 小节标题：卡片内的分组标签 */
.block-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--lab-text-mute);
  letter-spacing: 0.6px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

/* ---------- 用量 chip 列表：替代 AntD tag 的 flex-wrap 堆叠。
   名称与数值分区、等宽数字、悬停上浮——比一排色块更能读出「谁的用量大」 ---------- */
.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.usage-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 9px;
  background: var(--lab-surface-2);
  border: 1px solid var(--lab-border);
  font-size: 12px;
  color: var(--lab-text-sub);
  transition: all 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.usage-chip:hover {
  background: var(--lab-surface);
  border-color: var(--lab-border-strong);
  box-shadow: var(--lab-shadow-card);
  transform: translateY(-1px);
}
.usage-chip-name {
  font-weight: 500;
  color: var(--lab-text);
}
.usage-chip-sep {
  width: 1px;
  height: 12px;
  background: var(--lab-border-strong);
}
.usage-chip-val {
  font-size: 12px;
  color: var(--lab-text-sub);
}
.usage-chip-dim {
  font-size: 11px;
  color: var(--lab-text-mute);
}
.usage-chip-bad {
  font-size: 11px;
  color: var(--lab-danger);
  font-weight: 500;
}
/* 通道着色：淡底 + 同色边框，不再是实心色块 */
.usage-chip.chip-cyan {
  background: var(--lab-primary-dim);
  border-color: var(--lab-primary-line);
}
.usage-chip.chip-cyan .usage-chip-name {
  color: var(--lab-primary);
}
.usage-chip.chip-blue {
  background: var(--lab-info-dim);
  border-color: var(--lab-info-line);
}
.usage-chip.chip-blue .usage-chip-name {
  color: var(--lab-info);
}

/* 千问积分池 .qw-pool 系列已收敛到全局 style.css（三个页面共用），
   此处不再重复定义 */
</style>
