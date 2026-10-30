<template>
  <div class="page">
    <PageHeader title="模型管理" :sub="isTw
      ? 'TRAE Work 的模型表由上游下发，本地不可编辑'
      : isQd ? 'Qoder 的模型表由上游下发，带倍率（price_factor）'
        : isQw ? '千问办公的模型表由上游下发，本地不可编辑'
          : '客户端传来的模型名 → 上游实际使用的 ID'" />

    <!-- ============ TRAE Work：上游下发的完整模型表（含消耗倍率） ============ -->
    <a-card v-if="isTw" :bordered="false">
      <template #title>
        <span class="section-title">TRAE Work 模型</span>
        <a-tag class="ml-2" color="cyan">只读</a-tag>
        <span v-if="twModels.length" class="text-xs text-slate-500 ml-2">
          共 {{ twModels.length }} 个 · 可见 {{ twVisible.length }} 个
        </span>
        <!-- 上游拉取时间：模型表有 5 分钟缓存，没有这个时间戳就分不清
             「刷新后还是旧的」到底是缓存命中还是上游没变 -->
        <span v-if="twFetchedAt" class="text-xs text-slate-400 ml-2">
          数据时间 {{ fmtFetchedAt(twFetchedAt) }}
        </span>
      </template>
      <template #extra>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="loadTwModels(true)">
          刷新
        </a-button>
      </template>

      <!-- 通道元信息：这些是通道级的，不随模型变 -->
      <div v-if="twStatus" class="qw-channel-row">
        <div class="qw-channel-cell">
          <div class="cell-label">可用账号</div>
          <div class="cell-value num">{{ twStatus.accounts ?? '—' }}</div>
        </div>
        <div class="qw-channel-cell">
          <div class="cell-label">当前账号</div>
          <div class="cell-value">{{ twStatus.account || '—' }}</div>
        </div>
        <div class="qw-channel-cell">
          <div class="cell-label">Token 状态</div>
          <div class="cell-value">
            <a-tag :color="twStatus.refreshExpired ? 'red' : 'green'">
              {{ twStatus.refreshExpired ? 'refresh token 已过期' : '有效' }}
            </a-tag>
          </div>
        </div>
      </div>

      <a-alert v-if="twError" type="warning" show-icon class="mt-3" :message="twError" />

      <!-- 模型信息表：倍率 / 折扣 / 上下文 / 输出上限，字段带来源标记。
           与搭子、千问共用同一个组件——三条通道的字段形状统一，
           三份实现必然各自漂移 -->
      <ModelInfoTable :channel="'traework'" :preloaded="twInfoRows" class="mt-3" />

      <div class="text-xs text-slate-500 mt-3">
        调用时用前缀名（如 <span class="font-mono">traework/glm-5.2</span>）；不带前缀的名字一律走搭子。
      </div>
    </a-card>

    <!-- TRAE 的额度：与千问的三个池子不同，这里是每个账号独立的一份 credits，
         签到领取。放在模型页是因为「这个模型花什么」和「还剩多少」是同一问题的两面 -->
    <a-card v-if="isTw" title="TRAE Work 额度" :bordered="false">
      <a-empty v-if="!twRows.length" description="还没有 TRAE Work 账号" />
      <template v-else>
        <a-row :gutter="[16, 16]">
          <a-col :xs="24" :sm="12" :lg="12">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">剩余额度合计</span>
              </div>
              <div class="qw-pool-value num">
                {{ twTotals.remain == null ? '—' : twTotals.remain.toLocaleString('zh-CN') }}
                <span v-if="twTotals.limit" class="qw-pool-cap">/ {{ twTotals.limit.toLocaleString('zh-CN') }}</span>
              </div>
              <div class="qw-pool-sub">按账号独立计算，不共享</div>
            </div>
          </a-col>
          <a-col :xs="24" :sm="12" :lg="12">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">今日已签到</span>
              </div>
              <div class="qw-pool-value num">{{ twTotals.checked }} / {{ twRows.length }}</div>
              <div class="qw-pool-sub">签到每日一次，幂等</div>
            </div>
          </a-col>
        </a-row>
      </template>
    </a-card>

    <!-- ============ 千问办公：模型表由上游下发，本地改不了，所以只读展示 ============ -->
    <a-card v-else-if="isQw" :bordered="false">
      <template #title>
        <span class="section-title">千问办公模型</span>
        <a-tag class="ml-2" color="cyan">只读</a-tag>
      </template>
      <template #extra>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
      <a-empty v-if="!qwModels.length" :description="qwError || '未取到模型列表'" />
      <template v-else>
        <!-- 顶部三张并排：账号、套餐、token 状态。
             不放主表里是因为这些是「通道」级别的元信息，不随模型变 -->
        <div v-if="qwStatus" class="qw-channel-row">
          <div class="qw-channel-cell">
            <div class="cell-label">账号</div>
            <div class="cell-value">{{ qwStatus.account || '—' }}</div>
          </div>
          <div class="qw-channel-cell">
            <div class="cell-label">套餐</div>
            <div class="cell-value">
              {{ qwStatus.tier || '—' }}
              <span v-if="qwStatus.planId" class="cell-sub">({{ qwStatus.planId }})</span>
            </div>
          </div>
          <div class="qw-channel-cell">
            <div class="cell-label">Token 状态</div>
            <div class="cell-value">
              <a-tag :color="qwStatus.refreshExpired ? 'red' : (qwStatus.tokenExpired ? 'orange' : 'green')">
                {{ qwStatus.refreshExpired ? 'refresh token 已过期' : (qwStatus.tokenExpired ? 'token 已过期' : '有效') }}
              </a-tag>
            </div>
          </div>
        </div>

        <a-table
          size="small"
          :pagination="false"
          :data-source="modelRows"
          :columns="modelColumns"
          row-key="id"
          class="mt-3"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <div class="font-medium">{{ record.name }}</div>
              <div class="text-xs text-slate-400">中文显示名（来自上游）</div>
            </template>
            <template v-else-if="column.key === 'id'">
              <span class="font-mono text-xs">{{ record.id }}</span>
            </template>
            <template v-else-if="column.key === 'prefixed'">
              <span class="font-mono text-xs">{{ record.prefixed }}</span>
              <div class="text-xs text-slate-400">调用时使用的全名</div>
            </template>
            <template v-else-if="column.key === 'usage'">
              <div v-if="record.usage" class="qw-model-usage">
                <span class="font-medium num">{{ record.usage.requests }}</span>
                <span class="text-xs text-slate-400 ml-1">次</span>
                <div class="text-xs text-slate-500">
                  免费 {{ fmtQw(record.usage.free) }} · 付费 {{ fmtQw(record.usage.paid) }} 积分
                </div>
              </div>
              <span v-else class="text-xs text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'last'">
              <span v-if="record.last" class="text-xs num">{{ fmtTime(record.last) }}</span>
              <span v-else class="text-xs text-slate-400">—</span>
            </template>
          </template>
        </a-table>

        <div class="text-xs text-slate-500 mt-3">
          调用时用前缀名（如 <span class="font-mono">qwen/{{ qwModels[0]?.id || 'pro' }}</span>）；
          不带前缀的名字一律走搭子。
        </div>
      </template>
    </a-card>

    <!-- 千问模型信息：上下文 / 输出上限。**没有倍率**——千问按积分池计费，
         本地拿不到单价，如实显示「无此数据」 -->
    <a-card v-if="isQw" :bordered="false">
      <template #title>
        <span class="section-title">模型信息</span>
        <a-tag class="ml-2" color="cyan">只读</a-tag>
      </template>
      <ModelInfoTable :channel="'qwenwork'" :preloaded="qwInfoRows" />
    </a-card>

    <!-- 千问办公的积分池：这条通道的模型消耗走这里的额度，
         与搭子的积分是两套账。放在模型页是因为「这个模型要花什么」
         和「还剩多少」是同一个问题的两面。 -->
    <a-card v-if="isQw" title="千问办公积分" :bordered="false">
      <a-empty v-if="!qw?.ok" :description="qw?.error || '取不到千问积分'" />
      <template v-else>
        <a-row :gutter="[16, 16]">
          <a-col v-for="w in qw.wallets" :key="w.id" :xs="24" :sm="12" :lg="6">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">{{ w.label }}</span>
                <a-tag :color="w.kind === 'free' ? 'cyan' : 'blue'" class="qw-mini">
                  {{ w.kind === 'free' ? '免费' : '付费' }}
                </a-tag>
              </div>
              <div class="qw-pool-value num">
                {{ fmtQw(w.balance) }}
                <!-- 分母与分子同口径：分子是全账号合计余额，分母就是合计上限。
                     两账号各 100 时这里显示「200 / 200」，不是「200 / 100」 -->
                <span v-if="w.id === 'daily'" class="qw-pool-cap">/ {{ qw.dailyCap }}</span>
              </div>
              <div class="qw-pool-sub">
                <template v-if="w.id === 'daily'">
                  <template v-if="qw.accountCount > 1">{{ qw.accountCount }} 个账号合计 · </template>每日 00:00 重置
                </template>
                <template v-else-if="w.id === 'monthly'">订阅套餐内</template>
                <template v-else>充值 / 赠送</template>
              </div>
            </div>
          </a-col>
          <a-col :xs="24" :sm="12" :lg="6">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">今日消耗</span>
                <a-tag class="qw-mini">经本网关</a-tag>
              </div>
              <div class="qw-pool-value num">{{ fmtQw(qw.today.total) }}</div>
              <div class="qw-pool-sub">
                免费 {{ fmtQw(qw.today.free) }} · 付费 {{ fmtQw(qw.today.paid) }} ·
                {{ qw.today.requests }} 次
              </div>
            </div>
          </a-col>
        </a-row>
      </template>
    </a-card>

    <!-- ============ Qoder：模型表上游下发，带倍率（price_factor） ============ -->
    <a-card v-if="isQd" :bordered="false">
      <template #title>
        <span class="section-title">Qoder 模型</span>
        <a-tag class="ml-2" color="cyan">只读</a-tag>
        <span v-if="qdModels.length" class="text-xs text-slate-500 ml-2">
          共 {{ qdModels.length }} 个 · 低倍率 {{ qdCheapCount }} 个
        </span>
      </template>
      <template #extra>
        <a-button size="small" class="ghost-btn mr-2" :loading="billingChecking" @click="runBillingCheck">计费自检</a-button>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="loadQd(true)">刷新</a-button>
      </template>

      <!-- 通道元信息：账号数 / 当前账号 / token 状态。Qoder 不需要客户端，
           所以这里没有 wasm 那一栏 -->
      <div v-if="qdStatus" class="qw-channel-row">
        <div class="qw-channel-cell">
          <div class="cell-label">可用账号</div>
          <div class="cell-value num">{{ qdStatus.accounts ?? '—' }}</div>
        </div>
        <div class="qw-channel-cell">
          <div class="cell-label">当前账号</div>
          <div class="cell-value">
            {{ qdStatus.account || '—' }}
            <span class="cell-sub">无需客户端</span>
          </div>
        </div>
        <div class="qw-channel-cell">
          <div class="cell-label">Token 状态</div>
          <div class="cell-value">
            <a-tag :color="qdStatus.refreshExpired ? 'red' : 'green'">
              {{ qdStatus.refreshExpired ? 'refresh token 已过期' : '有效' }}
            </a-tag>
          </div>
        </div>
      </div>

      <a-alert v-if="qdError" type="warning" show-icon class="mt-3" :message="qdError" />

      <!-- 计费自检结果：上游静默改路由的可见性（billed_rate vs 标称倍率）。
           ratio≠1 不一定是改路由——错峰优惠与倍率元数据过期都是合法偏差 -->
      <a-alert
        v-if="billingResult"
        :type="billingResult.ok ? (billingResult.ratio != null && Math.abs(billingResult.ratio - 1) > 0.05 ? 'warning' : 'success') : 'error'"
        show-icon class="mt-3"
      >
        <template #message>
          <template v-if="billingResult.ok">
            计费自检 · {{ billingResult.model }}：标称 {{ billingResult.expected ?? '—' }}，
            实测 {{ billingResult.billed ?? '—' }}，
            比值 {{ billingResult.ratio ?? '—' }}
            <span v-if="billingResult.account" class="text-slate-500">（{{ billingResult.account }}，{{ billingResult.elapsedMs }}ms）</span>
          </template>
          <template v-else>计费自检失败：{{ billingResult.error }}</template>
        </template>
        <template #description>
          <span class="text-xs">{{ billingResult.note || '比值≈1 正常；≠1 不一定是改路由——错峰优惠与倍率元数据过期都会造成偏差，结合模型页标称值人工判读。' }}</span>
        </template>
      </a-alert>

      <!-- 模型信息表：倍率（可排序）/ 上下文 / 输出上限，字段带来源标记。
           与搭子、千问、TRAE 共用同一个组件——Qoder 原本是单独一份 a-table，
           那份没有输出上限、也没有倍率排序 -->
      <ModelInfoTable :channel="'qoder'" :preloaded="qdInfoRows" class="mt-3" />

      <div class="text-xs text-slate-500 mt-3">
        调用时用前缀名（如 <span class="font-mono">qoder/gfmodel</span>）；不带前缀的名字一律走搭子。
        <span class="text-amber-700">倍率是相对值（上游 price_factor），实际扣费 = 倍率 × 用量；开发调试请挑「省额度」的 0.1 档。</span>
        <span class="text-slate-500">倍率为 0 的是错峰/免费模型，旁边并列显示原价——0 表示当前不扣费，不是「这个模型不要钱」。</span>
      </div>
    </a-card>

    <!-- Qoder 的额度：userQuota（订阅内）与 addOnQuota（签到/赠送）**分开显示**，
         不能相加——Free 套餐的 userQuota 恒为 0，免费用户实际能用的就是 addOnQuota -->
    <a-card v-if="isQd" title="Qoder 额度" :bordered="false">
      <a-empty v-if="!qdCredits.length" description="还没有 Qoder 账号" />
      <template v-else>
        <a-row :gutter="[16, 16]">
          <a-col :xs="24" :sm="12" :lg="12">
            <div class="qw-pool">
              <div class="qw-pool-head"><span class="qw-pool-label">签到积分合计</span></div>
              <div class="qw-pool-value num text-cyan-700">{{ fmtQw(qdTotals.addOn) }}</div>
              <div class="qw-pool-sub">签到/赠送得到，免费用户实际可用</div>
            </div>
          </a-col>
          <a-col :xs="24" :sm="12" :lg="12">
            <div class="qw-pool">
              <div class="qw-pool-head"><span class="qw-pool-label">套餐内额度合计</span></div>
              <div class="qw-pool-value num">{{ fmtQw(qdTotals.user) }}</div>
              <div class="qw-pool-sub">订阅套餐内，Free 套餐恒为 0</div>
            </div>
          </a-col>
        </a-row>
        <div class="text-xs text-slate-500 mt-3">
          两份额度<b>不可相加</b>：前者是签到/赠送，后者是订阅套餐内。
        </div>
      </template>
    </a-card>

    <!-- 以下全部是搭子专用：别名映射、上游原生模型、对外暴露、网关实际返回。
         切到千问时不显示——它们描述的是搭子那条链路。 -->
    <template v-if="!isQw && !isTw && !isQd">
    <!-- 通道元信息行：与 TRAE 模型页同构（上游端口 / 托管 / 登录账号）。
         放在模型表上方是因为这些是**通道级**的，不随模型变 -->
    <div class="qw-channel-row">
      <div class="qw-channel-cell">
        <div class="cell-label">上游端口</div>
        <div class="cell-value">
          <span class="num">{{ dumateMeta.port ?? '—' }}</span>
          <a-tag v-if="dumateMeta.managed" color="blue" class="ml-1">自建</a-tag>
        </div>
      </div>
      <div class="qw-channel-cell">
        <div class="cell-label">桌面登录账号</div>
        <div class="cell-value">
          <!-- 桌面凭证失效时 activeProfile() 就是 null，这里必然显示 —。
               与「凭证来源：网页凭证回落」并排时容易被读成「桌面账号丢了」，
               所以补一句说明：此刻请求走的是网页池，— 是预期而不是故障。 -->
          <template v-if="dumateMeta.account">{{ dumateMeta.account }}</template>
          <template v-else>
            <span class="text-slate-400">—</span>
            <span v-if="dumateOnWebFallback" class="cell-sub">桌面凭证失效，当前走网页池</span>
          </template>
        </div>
      </div>
      <div class="qw-channel-cell">
        <div class="cell-label">凭证来源</div>
        <div class="cell-value">
          <!-- 桌面凭证不可用时会自动回落到网页池（见 fallback-web.js）。
               **两种「不可用」必须分开**：ready=false 且 fallback.available=true
               → 请求仍能成功（走网页池）；两者都不可用 → 请求真的全失败。
               把后者说成「网页凭证回落」会把排查引向错误方向。
               infos 未加载时显示 —，不下任何结论。 -->
          <template v-if="!channelStore.infos['dumate']">
            <span class="text-slate-400">—</span>
          </template>
          <template v-else-if="channelStore.infos['dumate']!.ready">
            <a-tag color="green">桌面凭证</a-tag>
          </template>
          <template v-else-if="channelStore.infos['dumate']!.fallback?.available">
            <a-tag color="orange">网页凭证回落</a-tag>
          </template>
          <template v-else>
            <a-tag color="red">凭证不可用</a-tag>
            <span class="cell-sub">回落也不可用</span>
          </template>
        </div>
      </div>
    </div>

    <!-- 模型信息：上下文 / 输出上限 / 类型。**没有倍率**——搭子的计费在
         上游账单里，本地拿不到单价，如实显示「无此数据」而不是估算一个 -->
    <a-card :bordered="false">
      <template #title>
        <span class="section-title">模型信息</span>
        <a-tag class="ml-2" color="blue">只读</a-tag>
      </template>
      <template #extra>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
      <ModelInfoTable :channel="'dumate'" :preloaded="dumateInfoRows" />
    </a-card>

    <!-- 搭子的积分：与 TRAE 的额度卡同构，回答「这些模型花的是哪份额度」。
         与千问的三池、TRAE 的 credits 是三套账，数字不能相加 -->
    <a-card title="搭子积分" :bordered="false">
      <a-empty v-if="!dumatePoints" description="取不到搭子积分" />
      <template v-else>
        <a-row :gutter="[16, 16]">
          <a-col :xs="24" :sm="12" :lg="8">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">可用余额</span>
                <a-tag class="qw-mini">上游账单</a-tag>
              </div>
              <div class="qw-pool-value num">
                {{ fmtQw(dumatePoints.left) }}
                <span class="qw-pool-cap">/ {{ fmtQw(dumatePoints.total) }}</span>
              </div>
              <div class="qw-pool-sub">已用 {{ fmtQw(dumatePoints.used) }}</div>
            </div>
          </a-col>
          <a-col :xs="24" :sm="12" :lg="8">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">额度包</span>
              </div>
              <div class="qw-pool-value num">{{ dumatePoints.packages?.length ?? '—' }}</div>
              <div class="qw-pool-sub">订阅 + 增量包</div>
            </div>
          </a-col>
          <a-col :xs="24" :sm="12" :lg="8">
            <div class="qw-pool">
              <div class="qw-pool-head">
                <span class="qw-pool-label">今日消耗</span>
                <a-tag class="qw-mini">经本网关</a-tag>
              </div>
              <div class="qw-pool-value num">
                {{ dumateTodayCost == null ? '—' : fmtQw(dumateTodayCost) }}
              </div>
              <div class="qw-pool-sub">
                <!-- 上游账单无法逐笔归因，这个数是余额游标差（见 points-cursor.js）。
                     取不到就显示 —，不补 0——0 会被读成「今天没花钱」 -->
                <template v-if="dumateTodayCost == null">上游未给出账单</template>
                <template v-else>来自上游账单</template>
              </div>
            </div>
          </a-col>
        </a-row>
      </template>
    </a-card>

    <a-card :bordered="false">
      <div class="card-head-row">
        <div>
          <span class="section-title">模型映射</span>
        </div>
        <a-space>
          <a-button size="small" :loading="probing" @click="probeAll">探测上游</a-button>
          <a-button size="small" @click="addAlias">新增别名</a-button>
          <a-popconfirm title="恢复为默认映射？当前改动会丢失" @confirm="reset">
            <a-button size="small" danger>恢复默认</a-button>
          </a-popconfirm>
          <a-button type="primary" size="small" :loading="saving" @click="save">保存</a-button>
        </a-space>
      </div>

      <a-alert
        type="info"
        show-icon
        class="mb-3"
        message="上游没有模型列表接口，只能逐个探测。探测会向上游发一个 1 token 的最小请求。"
      />

      <a-table
        size="small"
        :pagination="false"
        :data-source="rows"
        :columns="columns"
        row-key="name"
      >
        <template #bodyCell="{ column, record, index }">
          <template v-if="column.key === 'name'">
            <a-input v-model:value="record.name" size="small" placeholder="客户端模型名" />
          </template>
          <template v-else-if="column.key === 'target'">
            <a-select
              v-model:value="record.target"
              size="small"
              style="width: 100%"
              :options="targetOptions"
            />
          </template>
          <template v-else-if="column.key === 'native'">
            <a-tag v-if="record.upstream_native" color="green">上游原生</a-tag>
            <a-tag v-else color="default">别名转换</a-tag>
          </template>
          <template v-else-if="column.key === 'probe'">
            <template v-if="probeMap[record.name]">
              <a-tag v-if="probeMap[record.name].ok" color="green">接受</a-tag>
              <a-tooltip v-else :title="probeMap[record.name].error">
                <a-tag color="red">{{ probeMap[record.name].status || '错误' }}</a-tag>
              </a-tooltip>
            </template>
            <span v-else class="text-slate-400 text-xs">—</span>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-button type="link" size="small" danger @click="removeRow(index)">删除</a-button>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-row :gutter="[16, 16]">
      <a-col :xs="24" :sm="12" :lg="12">
        <a-card title="上游原生模型" :bordered="false">
          <div class="text-xs text-slate-500 mb-2">
            上游直接认识的 ID，无需转换。上游<b>没有模型列表接口</b>，这三个是探测出来的；
            其余名字（glm-5.2 / glm-5.1 / glm-4.6 等）实测一律 404。
          </div>
          <a-tag v-for="m in upstreamModels" :key="m" color="green" class="mb-1">{{ dumateLabel(m) }}</a-tag>
        </a-card>
      </a-col>
      <a-col :xs="24" :sm="12" :lg="12">
        <a-card title="对外暴露给客户端" :bordered="false">
          <div class="text-xs text-slate-500 mb-2">
            网关 /v1/models 返回的条目，Codex 与 Claude Code 从这里选模型。
          </div>
          <a-tag v-for="m in exposed" :key="m" color="blue" class="mb-1">
            {{ dumateLabel(m) }}
            <!-- 别名要标出实际落到哪个上游模型：不标的话「claude-3-5-sonnet」
                 看起来像独立模型，实际走的是 model-text -->
            <span v-if="dumateTarget(m)" class="opacity-70"> → {{ dumateTarget(m) }}</span>
          </a-tag>
          <div class="text-xs text-slate-500 mt-2">默认回落模型：{{ map?.fallback }}</div>
        </a-card>
      </a-col>
    </a-row>

    <a-card title="网关实际返回" :bordered="false">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-slate-500">直接读取网关的 /v1/models，确认改动已生效</span>
        <a-button size="small" :loading="loadingGateway" @click="loadGateway">刷新</a-button>
      </div>
      <a-table
        size="small"
        :pagination="false"
        :data-source="gatewayList"
        :columns="gatewayColumns"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'owned'">
            <a-tag :color="record.owned_by === 'dumate' ? 'green' : 'default'">
              {{ record.owned_by === 'dumate' ? '上游原生' : '代理转换' }}
            </a-tag>
          </template>
        </template>
      </a-table>
    </a-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { message } from 'ant-design-vue'
import client from '@/api/client'
import { channelStore, isTraework, isQwenwork, isQoder } from '@/stores/channel'
import { qwenworkApi } from '@/api/qwenwork'
import { traeworkApi } from '@/api/traework'
import { qoderApi, type QoderModel, type QoderCreditRow } from '@/api/qoder'
import type { TraeworkCreditRow, TraeworkModel } from '@/api/traework'
import type { QwCredits } from '@/api/qwenwork'
import type { ModelMapData, ProbeResult } from '@/api/models'
import type { SystemStatus } from '@/api/system'
import type { PointsData } from '@/api/points'
import { modelInfoApi, type ModelInfoRow } from '@/api/modelinfo'
import ModelInfoTable from '@/components/ModelInfoTable.vue'

interface Row {
  name: string
  target: string
  upstream_native: boolean
}

const map = ref<ModelMapData | null>(null)
// 当前通道。千问与 TRAE 的模型表都由上游下发（只读），搭子的别名映射是
// 另一套——三者互不适用，同页并列只会让人以为改别名能影响直连通道的路由。
// 千问与 TRAE 分开判定：两者的账不同（三池 vs 单 credits），
// 模型页下半部分的「额度」区块结构也不同。
const isTw = computed(() => isTraework())
const isQw = computed(() => isQwenwork())
const isQd = computed(() => isQoder())

// Qoder 模型表（上游下发，带倍率）与额度
const qdModels = ref<QoderModel[]>([])
const qdError = ref('')
const qdCredits = ref<QoderCreditRow[]>([])
// 计费自检：对最低倍率模型发探针，比对实测倍率与标称（上游改路由的可见性）
const billingChecking = ref(false)
const billingResult = ref<Awaited<ReturnType<typeof qoderApi.billingCheck>>['data'] | null>(null)
async function runBillingCheck() {
  // 选一个最低倍率的模型（免费/0.1 档即可验证，不烧高倍率额度）
  const ranked = [...qdModels.value]
    .filter((m) => m.key)
    .sort((a, b) => {
      const ra = a.rate != null && a.rate > 0 ? a.rate : (a.rateOriginal ?? 99)
      const rb = b.rate != null && b.rate > 0 ? b.rate : (b.rateOriginal ?? 99)
      return ra - rb
    })
  const target = ranked[0]?.key
  if (!target) {
    billingResult.value = { ok: false, model: '', account: null, expected: null, billed: null, ratio: null, credits: null, error: '模型表未加载，先刷新' }
    return
  }
  billingChecking.value = true
  try {
    const r = await qoderApi.billingCheck(target)
    billingResult.value = r.data
  } catch (e: any) {
    billingResult.value = { ok: false, model: target, account: null, expected: null, billed: null, ratio: null, credits: null, error: e?.message || '请求失败' }
  } finally {
    billingChecking.value = false
  }
}
// 通道元信息（账号数 / 当前账号 / token 到期）来自 /system/status 的 channels.qoder
const qdStatus = computed(() => channelStore.infos['qoder'] || null)
const qdCheapCount = computed(() => qdModels.value.filter((m) => m.cheap).length)
// 统一形状的模型信息行（倍率 / 原价 / 上下文 / 输出上限），交给 ModelInfoTable 排序
const qdInfoRows = ref<ModelInfoRow[] | null>(null)
const qdTotals = computed(() => {
  let addOn = 0, user = 0, ok = 0
  for (const r of qdCredits.value) {
    if (r.addOnQuota) { addOn += r.addOnQuota.remaining || 0; ok++ }
    if (r.userQuota) user += r.userQuota.remaining || 0
  }
  return { addOn, user, known: ok }
})

async function loadQd(force = false) {
  try {
    // 三份并行：/qoder/models（倍率 + 上下文，顶部计数用）、
    // /models/info?channel=qoder（统一形状，表格与倍率排序用）、额度
    const [m, info, c] = await Promise.all([
      qoderApi.models({ refresh: force }),
      modelInfoApi.list({ channel: 'qoder', refresh: force })
        .catch(() => ({ data: { rows: [] as ModelInfoRow[], error: '' } })),
      qoderApi.credits().catch(() => ({ data: { rows: [] as QoderCreditRow[] } })),
    ])
    qdModels.value = (m.data.models || []).slice().sort((a, b) => (a.rate ?? 99) - (b.rate ?? 99))
    qdError.value = m.data.error || ''
    qdInfoRows.value = info.data.rows || []
    qdCredits.value = (c.data.rows || []) as QoderCreditRow[]
  } catch (e: any) {
    qdModels.value = []
    qdInfoRows.value = []
    qdError.value = e?.response?.data?.error || e?.message || '读取 Qoder 模型失败'
  }
}

// TRAE 模型表与额度
const twModels = ref<TraeworkModel[]>([])
// 上游模型表的拉取时间（/traework/models 的 fetchedAt）。缓存命中时是上次
// 实际拉取的时刻，正好用来判断「刷新有没有真的打到上游」
const twFetchedAt = ref(0)
const fmtFetchedAt = (ts: number) => {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const twError = ref('')
const twRateNote = ref('')
// 统一形状的模型信息行（倍率 / 上下文 / 输出上限，字段带来源标记）。
// 由 /models/info 拉一次，三条通道共用同一个展示组件
const twInfoRows = ref<ModelInfoRow[] | null>(null)
const qwInfoRows = ref<ModelInfoRow[] | null>(null)
const dumateInfoRows = ref<ModelInfoRow[] | null>(null)

// 搭子的可读名与别名目标：来自 /models/info?channel=dumate（后端已按
// modelmap.displayName + 实际 target 给好），这里只做查表——前端不重复维护
// 一份名字映射，否则改一处漏一处
const dumateRowById = computed(() => {
  const m = new Map<string, ModelInfoRow>()
  for (const r of dumateInfoRows.value || []) m.set(r.id, r)
  return m
})
function dumateLabel(id: string) {
  const r = dumateRowById.value.get(id)
  return r && r.name && r.name !== id ? `${r.name}（${id}）` : id
}
function dumateTarget(id: string) {
  const r = dumateRowById.value.get(id)
  return r && r.target && r.target !== id ? r.target : ''
}
// 通道元信息（账号数 / 当前账号 / token 到期）来自 /system/status 的
// channels.traework——/traework/status 给的是账号数组，没有聚合后的这些字段
const twStatus = computed(() => channelStore.infos['traework'] || null)
const twRows = ref<TraeworkCreditRow[]>([])
const twUsage = ref<Array<{ model: string; ts: number }>>([])

// 搭子的通道元信息与积分。对齐 TRAE 模型页顶部的「通道信息行 + 额度卡」：
// 那条通道把「模型花什么」与「还剩多少」放在同一页，搭子原来只有模型表。
// 数据源与仪表盘/积分页相同（/system/status、/points/points、/usage/overview），
// 不新造接口——同一件事在三个页面必须给出同一个数。
const dumateSys = ref<SystemStatus | null>(null)
const dumatePoints = ref<PointsData | null>(null)
// 今日经网关的积分消耗。来自上游账单，**只有搭子有**（直连通道为 null）
const dumateTodayCost = ref<number | null>(null)
// 通道信息行：上游端口 / 托管方式 / 桌面登录账号
const dumateMeta = computed(() => {
  const s = dumateSys.value
  const ch = channelStore.infos['dumate'] || null
  return {
    port: s?.upstream?.port ?? ch?.port ?? null,
    managed: s?.upstream?.managed ?? !!ch?.managed,
    // **保留 null**，不要在这里折成 '—'：模板要据此区分「有账号」与
    // 「桌面凭证失效」，折成字符串就把两种情况抹平了
    account: s?.account?.name || null,
  }
})

// 桌面凭证失效、但回落可用——此刻请求走网页池，是正常状态不是故障
const dumateOnWebFallback = computed(() => {
  const ch = channelStore.infos['dumate']
  return !!ch && !ch.ready && !!ch.fallback?.available
})

const twVisible = computed(() => twModels.value.filter((m) => m.visible))

const twTotals = computed(() => {
  let remain: number | null = null
  let limit: number | null = null
  let checked = 0
  for (const r of twRows.value) {
    if (r.remain != null) remain = (remain ?? 0) + r.remain
    if (r.limit != null) limit = (limit ?? 0) + r.limit
    if (r.checkedIn) checked++
  }
  return { remain, limit, checked }
})

// 千问模型：直接问 /qwenwork/models，不再从 /models/map 的 channels 里蹭
const qwModels = ref<Array<{ id: string; name: string; prefixed: string }>>([])
const qwError = ref('')
// 千问积分池：与模型表一起展示，回答「这些模型花的是哪份额度」
const qw = ref<QwCredits | null>(null)
// 千问通道元信息：账号、套餐、token 状态
const qwStatus = ref<{ account: string; tier: string; planId: string; refreshExpired: boolean; tokenExpired: boolean } | null>(null)
const rows = ref<Row[]>([])
const saving = ref(false)
const probing = ref(false)
const loading = ref(false)
const loadingGateway = ref(false)
const probeMap = ref<Record<string, ProbeResult>>({})
const gatewayList = ref<Array<{ id: string; owned_by: string }>>([])
const upstreamModels = ref<string[]>([])
const exposed = ref<string[]>([])

const columns = [
  { title: '客户端模型名', key: 'name', width: '28%' },
  { title: '映射到', key: 'target', width: '24%' },
  { title: '类型', key: 'native', width: '16%' },
  { title: '探测结果', key: 'probe', width: '16%' },
  { title: '操作', key: 'action', width: '10%' },
]
const gatewayColumns = [
  { title: '模型 ID', key: 'id', dataIndex: 'id' },
  { title: '来源', key: 'owned' },
]

// 目标只允许选上游原生 ID：选一个上游不认的名字，请求会在上游 404，
// 而这正是「别名」要避免的事。
const targetOptions = computed(() =>
  upstreamModels.value.map((m) => ({ label: m, value: m })),
)

// 千问积分保留 4 位：实测单次消耗 0.0025，按 2 位显示会变成 0
const fmtQw = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
const fmtTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

// 千问通道下，每个模型的「近 7 天调用次数与积分消耗」。
// 数据来自 requests.jsonl（gateway 埋点）与 qwenwork-credits.jsonl（积分归因），
// 两个文件按 req_id 配对：每个模型对应一组 req_id，对每组取 credit.total 求和。
// 直接在前端算——数据量小（百行级），不必走后端聚合。
const modelRows = computed(() => {
  const map: Record<string, { id: string; name: string; prefixed: string; requests: number; last: number | null; free: number; paid: number }> = {}
  for (const m of qwModels.value) {
    map[m.id] = { id: m.id, name: m.name, prefixed: m.prefixed, requests: 0, last: null, free: 0, paid: 0 }
  }
  // 调用次数与最近一次
  const since = Date.now() - 7 * 86400000
  // 这里直接 fetch 后端 /admin/reqlogs 的成本不如复用本项目的客户端：
  // 切到「模型管理」时同时拉一次近 7 天的 qwenwork 行；为了不重复拉接口，
  // 这里由 qwUsagePromise 提供数据，watch qwModels 触发重新计算
  for (const r of qwUsage.value) {
    // r.model 是 qwen/pro 这种带前缀的形式，去掉前缀
    const id = (r.model || '').replace(/^qwen\//, '')
    const m = map[id]; if (!m) continue
    if (r.ts < since) continue
    m.requests++
    if (!m.last || r.ts > m.last) m.last = r.ts
    if (r.qw_free) m.free += r.qw_free
    if (r.qw_paid) m.paid += r.qw_paid
  }
  return Object.values(map).map((m) => ({
    ...m,
    usage: m.requests > 0 ? { requests: m.requests, free: m.free, paid: m.paid } : null,
  })).sort((a, b) => b.requests - a.requests)
})

const qwUsage = ref<Array<{ model: string; ts: number; qw_free?: number; qw_paid?: number }>>([])

const modelColumns = [
  { title: '显示名', key: 'name', width: '22%' },
  { title: '模型 ID', key: 'id', width: '16%' },
  { title: '调用前缀', key: 'prefixed', width: '18%' },
  { title: '近 7 天', key: 'usage', width: '28%' },
  { title: '最近调用', key: 'last', width: '16%' },
]

async function loadTwModels(force = false) {
  const [m, credits, usage, info] = await Promise.all([
    traeworkApi.models({ refresh: force })
      .catch((e: any) => ({ data: { models: [], total: 0, error: e?.message || '取模型列表失败', fetchedAt: 0, rateNote: '' } })),
    traeworkApi.credits().catch(() => ({ data: { count: 0, rows: [] } })),
    client.get('/reqlogs?days=7&status=all&channel=traework&limit=200&offset=0')
      .catch(() => ({ data: { rows: [] } })),
    modelInfoApi.list({ channel: 'traework', refresh: force })
      .catch(() => ({ data: { rows: [], error: '' } })),
  ])
  twModels.value = m.data.models || []
  twFetchedAt.value = m.data.fetchedAt || 0
  twError.value = m.data.error || ''
  twRateNote.value = m.data.rateNote || ''
  twRows.value = credits.data.rows || []
  twUsage.value = (usage.data.rows || []) as any
  twInfoRows.value = info.data.rows || []
  // 元信息（账号数 / token 到期）来自通道状态，进页面时顶栏可能还没拉过
  await channelStore.load()
}

async function load() {
  loading.value = true
  try {
    // TRAE 通道：模型表、额度、近 7 天使用——与千问同构但接口不同
    if (isTw.value) {
      await loadTwModels(false)
      return
    }
    // Qoder：模型表（带倍率）+ 额度，同样只取自己的
    if (isQd.value) {
      await loadQd(false)
      await channelStore.load()
      return
    }
    // 千问通道只取它自己的模型表，不拉搭子的映射——两者数据结构与
    // 可编辑性都不同，混在一起加载只会白打一次接口
    if (isQw.value) {
      qwError.value = ''
      // 模型表、积分状态、积分池、近 7 天使用、统一模型信息——五份并行拉
      const [models, status, credits, usage, info] = await Promise.all([
        qwenworkApi.models().catch((e: any) => ({ data: { models: [], error: e?.message || '取模型列表失败' } })),
        qwenworkApi.status().catch((e: any) => ({ data: { ready: false, error: e?.message, account: '', tier: '', planId: '', refreshExpired: false, tokenExpired: false } })),
        qwenworkApi.credits().catch((e: any) => ({ data: { ok: false, error: e?.message || '取不到千问积分' } })),
        client.get('/reqlogs?days=7&status=all&channel=qwenwork&limit=200&offset=0')
          .catch(() => ({ data: { rows: [] } })),
        modelInfoApi.list({ channel: 'qwenwork' }).catch(() => ({ data: { rows: [] } })),
      ])
      qwModels.value = models.data.models || []
      qwError.value = models.data.error || ''
      qw.value = credits.data as QwCredits
      qwStatus.value = status.data as any
      qwUsage.value = (usage.data.rows || []) as any
      qwInfoRows.value = info.data.rows || []
      return
    }
    // 搭子：映射表 + 统一模型信息（上下文 / 输出上限）+ 通道元信息与积分。
    // 后三样是为了与 TRAE 的模型页对齐——那条通道的模型页把「这个模型花什么」
    // 和「还剩多少」放在一起，搭子这边缺的正是这个视角。
    const [mapRes, info, sys, pts, usg] = await Promise.all([
      client.get('/models/map'),
      modelInfoApi.list({ channel: 'dumate' }).catch(() => ({ data: { rows: [] } })),
      client.get('/system/status').catch(() => ({ data: null })),
      client.get('/points/points').catch(() => ({ data: null })),
      client.get('/usage/overview?days=1&channel=dumate').catch(() => ({ data: null })),
    ])
    const data = mapRes.data
    dumateInfoRows.value = info.data.rows || []
    dumateSys.value = sys.data
    dumatePoints.value = pts.data
    dumateTodayCost.value = usg.data?.cards?.today?.consumed_points ?? null
    map.value = data
    upstreamModels.value = data.upstream_models
    exposed.value = data.exposed
    rows.value = data.entries.map((e: any) => ({
      name: e.name,
      target: e.target,
      upstream_native: e.upstream_native,
    }))
  } finally {
    loading.value = false
  }
}

async function loadGateway() {
  loadingGateway.value = true
  try {
    const { data } = await client.get('/models/gateway-list')
    gatewayList.value = data.data || []
  } finally {
    loadingGateway.value = false
  }
}

function addAlias() {
  rows.value.unshift({ name: '', target: upstreamModels.value[0] || '', upstream_native: false })
}

function removeRow(index: number) {
  rows.value.splice(index, 1)
}

async function save() {
  const aliases: Record<string, string> = {}
  for (const r of rows.value) {
    const name = r.name.trim()
    if (!name) {
      message.error('存在空的模型名')
      return
    }
    aliases[name] = r.target
  }
  saving.value = true
  try {
    await client.post('/models/map', {
      aliases,
      upstream_models: upstreamModels.value,
      exposed: exposed.value,
    })
    message.success('已保存，网关会在下次请求时读取')
    await load()
    await loadGateway()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function probeAll() {
  const models = Array.from(new Set(upstreamModels.value.concat(rows.value.map((r) => r.name.trim()).filter(Boolean))))
  if (!models.length) return
  probing.value = true
  try {
    const { data } = await client.post('/models/probe', { models: models.slice(0, 20) })
    const next: Record<string, ProbeResult> = {}
    for (const r of data.results as ProbeResult[]) next[r.model] = r
    probeMap.value = next
    message.success(`已探测 ${data.results.length} 个模型`)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '探测失败')
  } finally {
    probing.value = false
  }
}

async function reset() {
  await client.post('/models/map/reset')
  message.success('已恢复默认映射')
  await load()
  await loadGateway()
}

onMounted(async () => {
  await load()
  if (!isQw.value && !isTw.value && !isQd.value) await loadGateway()
})

// 切通道重拉：三条通道的数据源不同，切换时必须换成对应那份，
// 否则会停在上一通道的模型表上
watch(() => channelStore.current, async () => {
  await load()
  if (!isQw.value && !isTw.value && !isQd.value) await loadGateway()
})
</script>

<style scoped>
/* 千问积分池 .qw-pool 系列已收敛到全局 style.css（用量 / 模型 / 账号三页共用），
   此处不再重复定义 */

/* 千问通道顶部三联卡（账号 / 套餐 / token 状态） */
.qw-channel-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}
@media (max-width: 640px) {
  .qw-channel-row {
    grid-template-columns: 1fr;
  }
}
.qw-channel-cell {
  padding: 12px 16px;
  border: 1px solid var(--lab-border);
  border-radius: var(--lab-radius-sm);
  background: var(--lab-surface-2);
  transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.qw-channel-cell:hover {
  background: var(--lab-surface);
  border-color: var(--lab-border-strong);
  box-shadow: var(--lab-shadow-card);
}
.cell-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--lab-text-mute);
  letter-spacing: 0.4px;
  margin-bottom: 5px;
}
.cell-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--lab-text);
}
.cell-sub {
  font-weight: 400;
  font-size: 11px;
  color: var(--lab-text-mute);
  margin-left: 4px;
}
.qw-model-usage {
  font-size: 13px;
  color: var(--lab-text);
}
</style>
