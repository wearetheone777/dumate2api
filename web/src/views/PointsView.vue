<template>
  <div class="page">
    <PageHeader
      :title="isTw ? 'TRAE 额度' : isQw ? '千问积分' : isQd ? 'Qoder 积分' : '积分明细'"
      :sub="isTw ? 'TRAE Work 额度与签到（按账号独立）'
        : isQw ? '千问办公积分池与逐笔消耗（真实数据）'
        : isQd ? 'Qoder 真实消耗（上游 quota/usage 直给）' : undefined"
    >
      <template #sub>
        <template v-if="isTw">
          TRAE Work 的额度按账号独立 · 与搭子积分、千问积分是三套账
        </template>
        <template v-else-if="isQw">
          千问办公积分池与逐笔消耗 · 经本网关的请求
        </template>
        <template v-else-if="isQd">
          已消耗与剩余来自上游 quota/usage · 逐笔明细只覆盖本网关记录
        </template>
        <template v-else-if="loading">加载中…</template>
        <template v-else-if="current">共 {{ accountOptions.length }} 个账号可选</template>
        <template v-else>没有可用数据</template>
      </template>
      <template #actions>
        <a-button
          size="small"
          class="ghost-btn"
          :loading="loading"
          @click="isTw ? loadTw() : isQw ? loadQw() : isQd ? loadQd() : load(true)"
        >
          刷新
        </a-button>
      </template>
    </PageHeader>

    <!-- ============ TRAE Work：单一 credits + 签到，与千问三个池子不同 ============ -->
    <template v-if="isTw">
      <a-empty
        v-if="!twRows.length"
        :description="twStatus?.ready ? '还没有 TRAE Work 账号' : (twStatus?.error || '通道不可用')"
      />
      <template v-else>
        <a-row :gutter="[16, 16]">
          <a-col :span="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic title="剩余额度合计" :value="twTotals.remain ?? '—'" />
              <div class="text-xs text-slate-500 mt-2">
                <template v-if="isIntlRegion()">国际版订阅制按请求数计，无积分口径</template>
                <template v-else-if="twTotals.limit">
                  上限合计 <span class="num">{{ twTotals.limit.toLocaleString('zh-CN') }}</span>
                </template>
                <span v-else>上游未给出额度上限</span>
              </div>
            </a-card>
          </a-col>
          <a-col :span="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                :title="isIntlRegion() ? '今日已签到（国际版无签到接口）' : '今日已签到'"
                :value="isIntlRegion() ? '—' : `${twTotals.checked} / ${twRows.length}`"
              />
              <div class="text-xs text-slate-500 mt-2">
                {{ isIntlRegion() ? '国际版只有订阅制额度，没有签到' : '签到每日一次，幂等——重复点不会多领' }}
              </div>
            </a-card>
          </a-col>
          <a-col :span="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic title="启用账号" :value="`${twRows.length}`" />
              <div class="text-xs text-slate-500 mt-2">
                额度按账号独立计算，不共享
              </div>
            </a-card>
          </a-col>
        </a-row>

        <a-card title="按账号额度" :bordered="false" class="mt-4">
          <a-table
            size="small"
            :pagination="false"
            :data-source="twRows"
            :columns="twColumns"
            row-key="id"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <div>{{ record.nickname || record.uid || '未命名' }}</div>
                <div class="text-xs text-slate-400 font-mono">UID {{ record.uid || '—' }}</div>
              </template>
              <template v-else-if="column.key === 'region'">
                <span class="text-xs text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'remain'">
                <!-- 国际版是订阅制（按请求数计），积分口径恒 null——显示套餐名，
                     补 0 会被读成「额度用完了」 -->
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
              <template v-else-if="column.key === 'consumed'">
                <span v-if="record.consumed != null" class="num">
                  {{ record.consumed.toLocaleString('zh-CN') }}
                </span>
                <span v-else class="text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'checkinCredits'">
                <span v-if="record.checkinCredits != null" class="num">
                  {{ record.checkinCredits.toLocaleString('zh-CN') }}
                </span>
                <span v-else class="text-slate-400">—</span>
                <div v-if="record.checkinExtra" class="text-xs text-slate-400 num">
                  +{{ record.checkinExtra.toLocaleString('zh-CN') }} 额外
                </div>
              </template>
              <template v-else-if="column.key === 'checkin'">
                <a-tag v-if="record.checkedIn == null" color="default">—</a-tag>
                <a-tag v-else :color="record.checkedIn ? 'green' : 'orange'">
                  {{ record.checkedIn ? '已签到' : '未签到' }}
                </a-tag>
              </template>
              <template v-else-if="column.key === 'last'">
                <span v-if="record.lastCheckin" class="text-xs">
                  {{ dateText(record.lastCheckin) }}
                </span>
                <span v-else class="text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'err'">
                <span v-if="record.error" class="text-xs text-red-600">{{ record.error }}</span>
                <span v-else class="text-slate-400">—</span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            「剩余额度」= 额度上限 − 已消耗（上游 usage_summary 的实时值）；
            「签到可得」是今天签到能领到的额度，不是余额。
            取不到时显示 —，不补 0——0 会被读成「额度用完了」。
          </div>
        </a-card>

        <!-- 逐笔消耗：按账号的 consumed 游标做差（不是累计值） -->
        <a-card title="积分消耗明细" :bordered="false" class="mt-4">
          <template #extra>
            <span class="text-xs text-slate-400">
              最近 {{ twRecords.length }} 条 · 合计 {{ fmtTw(twWindow.cost) }}
              <template v-if="twWindow.requests !== twWindow.exact">
                · {{ twWindow.requests - twWindow.exact }} 条并发（差值可能含相邻请求）
              </template>
            </span>
          </template>
          <a-empty v-if="!twRecords.length" description="还没有经网关的积分记录" />
          <a-table
            v-else
            size="small"
            :data-source="twRecords"
            :columns="twRecordColumns"
            row-key="req_id"
            :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'ts'">
                <span class="text-xs">{{ dateTimeText(record.ts) }}</span>
              </template>
              <template v-else-if="column.key === 'model'">
                <span class="font-mono text-xs">{{ record.model || '—' }}</span>
              </template>
              <template v-else-if="column.key === 'cost'">
                <!-- 国际订阅行没有积分口径——「订阅制」与「无参照点」是两回事 -->
                <span v-if="record.region === 'intl'" class="text-xs text-slate-400">— 订阅制不计积分</span>
                <span v-else-if="record.cost != null" class="font-medium num">{{ fmtTw(record.cost) }}</span>
                <span v-else class="text-xs text-slate-400">— 无参照点</span>
                <!-- 并发时的差值里可能混着相邻请求的消耗，必须标出来 -->
                <a-tooltip
                  v-if="!record.exact && record.region !== 'intl'"
                  title="与相邻请求并发，差值可能含对方的消耗"
                >
                  <a-tag color="orange" class="ml-1">并发</a-tag>
                </a-tooltip>
              </template>
              <template v-else-if="column.key === 'ms'">
                <span v-if="record.ms != null" class="text-xs num">{{ fmtMs(record.ms) }}</span>
                <span v-else class="text-xs text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'remain'">
                <span v-if="record.remain != null" class="text-xs text-slate-400 num">
                  {{ record.remain.toLocaleString('zh-CN') }}
                </span>
                <span v-else class="text-xs text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'account'">
                <span class="text-xs">{{ record.account || '—' }}</span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            消耗 = 该账号相邻两条请求的「已消耗」之差（上游只给累计值，没有单请求
            扣费字段）。首条没有参照点，显示「无参照点」而不补 0；并发请求的差值
            可能含对方的消耗，已标「并发」。合计只统计本页这段窗口。
          </div>
        </a-card>
      </template>
    </template>

    <!-- ============ 千问办公积分：三个池子 + 逐笔消耗 ============ -->
    <template v-else-if="isQw">
      <a-alert
        v-if="qwCredits && !qwCredits.ok"
        type="error"
        show-icon
        :message="qwCredits.error || '取不到千问积分'"
      />
      <template v-else-if="qwCredits">
        <a-row :gutter="[16, 16]">
          <a-col v-for="w in qwCredits.wallets" :key="w.id" :span="6">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                :title="w.label"
                :value="fmtQw(w.balance)"
                value-style="color:var(--lab-info)"
              />
              <div class="text-xs text-slate-500 mt-2">
                <a-tag color="blue">付费</a-tag>
                <template v-if="w.id === 'monthly'">
                  <template v-if="qwCredits.accountCount > 1">{{ qwCredits.accountCount }} 个账号合计 · </template>
                  按有效期<template v-if="w.resetAt"> · {{ fmtReset(w.resetAt) }} 刷新</template>
                </template>
                <template v-else>充值 / 赠送</template>
              </div>
            </a-card>
          </a-col>
          <a-col :span="6">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                title="今日消耗"
                :value="fmtQw(qwCredits.today.total)"
                value-style="color:var(--lab-warn)"
              />
              <div class="text-xs text-slate-500 mt-2">
                经本网关 · {{ qwCredits.today.requests }} 次请求
              </div>
            </a-card>
          </a-col>
        </a-row>

        <!-- 消耗口径：只有「经本网关」这一套是实测的。
             「今日全部消耗（含客户端内对话）」需要「每日上限 − 余额」，
             而上游已不再发放每日额度（2026-11-01 起 daily 恒 0），推不出来——
             与其编一个数，不如如实说明缺什么。 -->
        <a-alert type="info" show-icon class="mt-4">
          <template #message>消耗口径</template>
          <template #description>
            <div>
              「今日消耗」= {{ fmtQw(qwCredits.today.total) }}
              —— 只统计经过本网关转发的请求，按 req_id 逐条实测（前后余额差值）。
            </div>
            <div class="text-slate-400">
              在千问客户端 / 网页里直接对话的消耗**不经过本网关**，这里看不到。
              上游已停止发放每日免费额度（2026-11-01 起 daily 池恒 0），
              因此也无法再用「上限 − 余额」推算全天消耗。
            </div>
            <div v-if="qwCredits.partial" class="text-orange-700">
              注意：{{ qwCredits.accountCount - qwCredits.totalKnown }} 个账号余额未知，
              上面各池合计只含余额已知的 {{ qwCredits.totalKnown }} 个账号。
            </div>
            <div v-if="qwCredits.failedAccounts > 0" class="text-orange-700">
              另有 {{ qwCredits.failedAccounts }} 个账号余额查询失败。
            </div>
          </template>
        </a-alert>
      </template>

      <!-- 逐笔消耗：来自积分归因（按 req_id 与请求日志配对） -->
      <a-card title="逐笔消耗" :bordered="false" class="mt-4">
        <template #extra>
          <span class="text-xs text-slate-400">
            最近 {{ qwRecords.length }} 条 · 合计 {{ fmtQw(qwWindow.total) }}
          </span>
        </template>
        <a-empty v-if="!qwRecords.length" description="还没有经网关的积分记录" />
        <a-table
          v-else
          size="small"
          :data-source="qwRecords"
          :columns="qwRecordColumns"
          row-key="req_id"
          :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'ts'">
              <span class="text-xs">{{ dateTimeText(record.ts) }}</span>
            </template>
            <template v-else-if="column.key === 'model'">
              <span class="font-mono text-xs">{{ record.model }}</span>
            </template>
            <template v-else-if="column.key === 'total'">
              <span class="font-medium">{{ fmtQw(record.total) }}</span>
              <a-tooltip v-if="record.concurrent" title="与相邻请求并发，差值可能含其它请求的消耗">
                <a-tag color="orange" class="ml-1">并发</a-tag>
              </a-tooltip>
            </template>
            <template v-else-if="column.key === 'balance'">
              <!-- 余额快照只给两个付费池：daily 池上游已停发，不再展示 -->
              <span v-if="record.balance" class="text-xs text-slate-400">
                月 {{ fmtQw(record.balance.monthly) }} · 长 {{ fmtQw(record.balance.longterm) }}
              </span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'account'">
              <span v-if="record.account" class="text-xs">{{ record.account.name }}</span>
              <span v-else class="text-xs text-slate-400">—</span>
            </template>
          </template>
        </a-table>
      </a-card>
    </template>

    <!-- ============ Qoder：两份额度（不可相加）+ 逐笔消耗 ============ -->
    <template v-else-if="isQd">
      <a-empty
        v-if="!qdRows.length"
        :description="qdError || '还没有 Qoder 账号'"
      />
      <template v-else>
        <!-- 真实消耗放最上面：这三个数字是上游 quota/usage 直接给的累积值，
             含客户端直连对话，是「这个账号到底花了多少」的唯一真值。 -->
        <a-row :gutter="[16, 16]">
          <a-col :span="6">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                title="已消耗（签到积分）"
                :value="qdUsed.addOn ?? '—'"
                value-style="color:var(--lab-warn)"
              />
              <div class="text-xs text-slate-500 mt-2">
                上游累积真值 · 含客户端直连
              </div>
            </a-card>
          </a-col>
          <a-col :span="6">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                title="已消耗（订阅额度）"
                :value="qdUsed.user ?? '—'"
                value-style="color:var(--lab-warn)"
              />
              <div class="text-xs text-slate-500 mt-2">
                Free 套餐恒为 0
              </div>
            </a-card>
          </a-col>
          <a-col :span="6">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                title="剩余可用合计"
                :value="qdTotals.left ?? '—'"
                value-style="color:var(--lab-primary)"
              />
              <div class="text-xs text-slate-500 mt-2">
                签到 {{ fmtQw(qdTotals.addOn) }} · 订阅 {{ fmtQw(qdTotals.user) }}
              </div>
            </a-card>
          </a-col>
          <a-col :span="6">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                title="今日已签到"
                :value="`${qdTotals.checked} / ${qdRows.length}`"
              />
              <div class="text-xs text-slate-500 mt-2">
                <template v-if="qdTotals.pending">
                  有 {{ qdTotals.pending }} 个账号待领取
                </template>
                <template v-else>每日 10:00（UTC+8）刷新，不是 00:00</template>
              </div>
            </a-card>
          </a-col>
        </a-row>

        <!-- 两份额度分开报：相加会得出一个既不是订阅也不是签到的数字 -->
        <a-alert type="info" show-icon class="mt-4">
          <template #message>两份额度，<b>不要相加</b></template>
          <template #description>
            <div>
              签到积分（addOnQuota）是签到 / 赠送得到的，订阅额度（userQuota）是套餐内的——
              上游分两个池子返回，合起来没有意义。
            </div>
            <div v-if="qdExpiring.count" class="text-orange-700">
              {{ qdExpiring.count }} 个批次将在 7 天内到期，按先领先扣推算还剩
              {{ fmtQw(qdExpiring.amount) }}
              <template v-if="qdExpiring.estimated === false">（余额没查到，此为领取额口径）</template>
              <template v-else-if="qdExpiring.amount === 0">——这些批次按消耗顺序已用完，到期不损失余额</template>
            </div>
          </template>
        </a-alert>

        <a-card title="按账号真实消耗" :bordered="false" class="mt-4">
          <template #extra>
            <span class="text-xs text-slate-400">
              上游 quota/usage 直接给的累积值，不是本网关估算
            </span>
          </template>
          <a-table
            size="small"
            :pagination="false"
            :data-source="qdRows"
            :columns="qdColumns"
            row-key="id"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <div>{{ record.nickname || `账号 ${record.id}` }}</div>
                <div class="text-xs text-slate-400 font-mono">{{ record.region }}<template v-if="record.planName"> · {{ record.planName }}</template></div>
              </template>
              <!-- 已消耗：上游累积真值。带占比条——只有数字看不出还剩多少 -->
              <template v-else-if="column.key === 'used'">
                <template v-if="record.addOnQuota || record.userQuota">
                  <div v-if="record.addOnQuota" class="mb-1">
                    <div class="flex items-center justify-between text-xs">
                      <span class="text-slate-400">签到</span>
                      <span class="num">
                        <b>{{ fmtQw(record.addOnQuota.used) }}</b>
                        <span class="text-slate-400"> / {{ fmtQw(record.addOnQuota.total) }}</span>
                      </span>
                    </div>
                    <div class="used-bar-wrap">
                      <div class="used-bar" :class="usedClass(record.addOnQuota.percentage)" :style="{ width: pctWidth(record.addOnQuota.percentage) }" />
                    </div>
                    <div class="text-xs text-slate-400">
                      已用 {{ pctText(record.addOnQuota.percentage) }}
                      <span v-if="record.addOnQuota.used === 0" class="text-slate-500">（额度整数粒度，小额请求可能不累加）</span>
                    </div>
                  </div>
                  <div v-if="record.userQuota">
                    <div class="flex items-center justify-between text-xs">
                      <span class="text-slate-400">订阅</span>
                      <span class="num">
                        <b>{{ fmtQw(record.userQuota.used) }}</b>
                        <span class="text-slate-400"> / {{ fmtQw(record.userQuota.total) }}</span>
                      </span>
                    </div>
                    <div class="used-bar-wrap">
                      <div class="used-bar" :class="usedClass(record.userQuota.percentage)" :style="{ width: pctWidth(record.userQuota.percentage) }" />
                    </div>
                  </div>
                </template>
                <span v-else class="text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'addOn'">
                <span v-if="record.addOnQuota" class="font-medium num">
                  {{ fmtQw(record.addOnQuota.remaining) }}
                </span>
                <span v-else class="text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'user'">
                <span v-if="record.userQuota" class="num">{{ fmtQw(record.userQuota.remaining) }}</span>
                <span v-else class="text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'checkin'">
                <a-tag v-if="record.checkedIn === true" color="green">今日已签</a-tag>
                <a-tag v-else-if="record.checkedIn === false" color="orange">未签</a-tag>
                <span v-else class="text-xs text-slate-400">查不出</span>
                <div v-if="record.checkinPending" class="text-xs text-slate-400">
                  待领 {{ fmtQw(record.checkinPending) }}
                </div>
              </template>
              <template v-else-if="column.key === 'err'">
                <span v-if="record.error" class="text-xs text-red-600">{{ record.error }}</span>
                <a-tag v-else-if="record.isQuotaExceeded" color="red">已超限</a-tag>
                <span v-else class="text-slate-400">—</span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            这些数字由上游 <span class="font-mono">/api/v2/quota/usage</span> 直接返回，
            含你在 Qoder 客户端 / 网页里的对话——不是本网关的估算。
            <b>已消耗是整数粒度</b>：单条小额请求（约 0.02 credits）不会立刻推动它，
            所以「已消耗」会滞后于逐笔明细的累加值。
            <template v-if="qdError">（{{ qdError }}）</template>
          </div>
        </a-card>

        <!-- 逐笔消耗：上游 usage.credits 直给，不做游标差。
             两个口径必须并列——只给逐笔合计会让人以为「总共才花了这么点」，
             而它的账本起点晚于通道接入时间，之前的消耗没有逐笔记录。 -->
        <a-card title="积分消耗明细" :bordered="false" class="mt-4">
          <template #extra>
            <span class="text-xs text-slate-400">
              <template v-if="qdRecords.length">
                本账本 {{ qdRecords.length }} 条 · 合计 {{ fmtQw(qdWindow.cost) }}
                <span class="text-slate-500">· 上游直给，精确</span>
              </template>
            </span>
          </template>

          <a-alert type="warning" show-icon class="mb-3">
            <template #message>逐笔合计 <b>不等于</b>你的总消耗</template>
            <template #description>
              <div>
                上游累积已消耗（上方「已消耗」卡）：
                <b class="num">{{ fmtQw((qdUsed.addOn ?? 0) + (qdUsed.user ?? 0)) }}</b>
                ——这是<b>全部</b>消耗，含本网关之外的客户端直连对话。
              </div>
              <div>
                本页逐笔合计（本网关账本）：
                <b class="num">{{ fmtQw(qdWindow.cost) }}</b>
                <template v-if="qdSince">
                  ——只覆盖 <b>{{ dateTimeText(qdSince) }}</b> 之后
                  （账本从那时才开始记，更早的请求<b>没有逐笔记录、无法追溯</b>）。
                </template>
                <template v-else>——账本还没有记录。</template>
              </div>
              <div class="text-slate-400">
                两份数字<b>不该相等</b>：一个是上游全量，一个是本网关的部分窗口。
                差值是账本起点之前的消耗与客户端直连部分。
              </div>
            </template>
          </a-alert>

          <a-empty v-if="!qdRecords.length" description="账本还没有记录（本功能上线前的请求无法追溯）" />
          <a-table
            v-else
            size="small"
            :data-source="qdRecords"
            :columns="qdRecordColumns"
            row-key="req_id"
            :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'ts'">
                <span class="text-xs">{{ dateTimeText(record.ts) }}</span>
              </template>
              <template v-else-if="column.key === 'model'">
                <span class="font-mono text-xs">{{ record.model || '—' }}</span>
              </template>
              <template v-else-if="column.key === 'cost'">
                <span v-if="record.cost != null" class="font-medium num">{{ fmtQw(record.cost) }}</span>
                <span v-else class="text-xs text-slate-400">— 上游未给</span>
              </template>
              <template v-else-if="column.key === 'ms'">
                <span v-if="record.ms != null" class="text-xs num">{{ fmtMs(record.ms) }}</span>
                <span v-else class="text-xs text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'account'">
                <span class="text-xs">{{ record.account || '—' }}</span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            每条的消耗是上游 <span class="font-mono">usage.credits</span> 直给的单请求值
            （倍率 × 用量），不是余额差——所以不受并发影响。实测值很小（1 万 token
            的请求约 0.02），因为它就是「credits」数，与额度卡的积分同单位。
            已消耗掉的积分来自哪一份（订阅 / 签到）上游不区分，这里无法拆分。
          </div>
        </a-card>
      </template>
    </template>

    <!-- ============ 百度搭子：原有页面 ============ -->
    <template v-else>
    <!-- 多账号总览：账号管理里添加的每份网页凭证都能独立查积分。
         点行即切换下方明细，避免「看汇总」和「看明细」要操作两次。 -->
    <a-card title="多账号总览" :bordered="false" class="mb-4">
      <template v-if="allPoints && allPoints.accounts.length">
        <a-row :gutter="[16, 16]" class="mb-3">
          <a-col :span="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                title="账号总余额"
                :value="allPoints.totals.left"
                :precision="2"
              />
              <div class="text-xs text-slate-500 mt-2">
                {{ allPoints.totals.ok_accounts }} / {{ allPoints.totals.accounts }} 个账号取到数据
              </div>
            </a-card>
          </a-col>
          <a-col :span="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic title="账号总量" :value="allPoints.totals.total" :precision="2" />
              <div class="text-xs text-slate-500 mt-2">由上游额度包累计</div>
            </a-card>
          </a-col>
          <a-col :span="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic title="账号已用" :value="allPoints.totals.used" :precision="2" />
              <div class="text-xs text-slate-500 mt-2">由上游额度包累计</div>
            </a-card>
          </a-col>
        </a-row>

        <a-table
          size="small"
          :pagination="false"
          :data-source="allPoints.accounts"
          :columns="acctColumns"
          row-key="id"
          :row-class-name="rowClass"
          :custom-row="customRow"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <div>{{ record.name }}</div>
              <div v-if="!record.ok" class="text-xs text-red-600">{{ record.error }}</div>
            </template>
            <template v-else-if="column.key === 'left'">
              <span v-if="record.ok" class="font-medium num">{{ fmt(record.left) }}</span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'total'">
              <span v-if="record.ok" class="num">{{ fmt(record.total) }}</span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'used'">
              <span v-if="record.ok" class="num">{{ fmt(record.used) }}</span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'state'">
              <a-tag v-if="!record.ok" color="red">失效</a-tag>
              <a-tag v-else-if="record.throttled" color="orange">限流</a-tag>
              <a-tag v-else color="green">正常</a-tag>
            </template>
          </template>
        </a-table>
      </template>
      <a-empty v-else description="还没有添加账号。到「账号管理」里添加后，这里会显示每个账号的积分。" />
    </a-card>

    <!-- 账号切换：下面所有区块都跟随这里选中的账号。
         原先只有一个小 radio 组，切了之后下方变化不明显，容易被读成「没切换成功」，
         所以改成大号分段控件 + 顶部大标题，并把选中行在总览表里同步高亮。 -->
    <a-card :bordered="false" class="mb-4">
      <template #title>
        <span class="text-base font-medium">查看账号</span>
      </template>
      <template #extra>
        <span v-if="detailCached" class="text-xs text-slate-400">本次为缓存数据</span>
      </template>

      <a-radio-group
        v-model:value="selectedId"
        button-style="solid"
        size="large"
        class="flex flex-wrap gap-2"
      >
        <a-radio-button
          v-for="o in accountOptions"
          :key="o.key"
          :value="o.key"
          :disabled="!o.ok"
          class="acct-btn text-center"
        >
          {{ o.label }}
          <span v-if="!o.ok" class="text-xs opacity-70">（不可用）</span>
        </a-radio-button>
      </a-radio-group>

      <div class="text-xs text-slate-500 mt-2">
        切换账号不会重新请求——每个账号的完整明细已随列表一次性取回。点「刷新」才重新打上游。
      </div>
    </a-card>

    <!-- 当前账号大标题：切换后最先看到的反馈 -->
    <div
      v-if="current"
      class="acct-banner mb-4 flex items-center justify-between flex-wrap gap-2"
    >
      <div class="flex items-center gap-3">
        <span class="text-xs text-slate-500">当前查看</span>
        <span class="text-xl font-semibold text-slate-800">{{ currentLabel }}</span>
        <a-tag v-if="selectedId === 'local'" color="blue">桌面凭证</a-tag>
        <a-tag v-else color="purple">网页凭证</a-tag>
      </div>
      <div class="text-sm text-slate-600">
        余额 <b class="text-base num">{{ fmt(current.left) }}</b>
        <span class="text-slate-400 ml-2 num">共 {{ fmt(current.total) }} · 已用 {{ fmt(current.used) }}</span>
      </div>
    </div>

    <div v-if="!accountOptions.length" class="text-xs text-slate-500 mb-2">
      还没有添加网页账号。到「账号管理」里添加后，可与本地后端账号一起切换查看。
    </div>

    <a-alert v-if="currentError" type="warning" show-icon class="mb-4" :message="`积分获取失败：${currentError}`" />

    <!-- 明细区按账号 key 化：切换时整块重新挂载并淡入，视觉上能确认「换了一份数据」 -->
    <div :key="selectedId" class="detail-block">

    <a-row :gutter="[16, 16]">
      <a-col :span="6">
        <a-card :bordered="false">
          <a-spin v-if="loading && !current" size="small" />
          <template v-else>
            <a-statistic title="可用余额" :value="current?.left ?? '—'" :precision="2" />
            <div class="text-xs text-slate-500 mt-2">
              共 {{ current ? fmt(current.total) : '—' }} · 已用 {{ current ? fmt(current.used) : '—' }}
            </div>
          </template>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-spin v-if="loading && !current" size="small" />
          <template v-else>
            <a-statistic title="额度包数量" :value="current ? (current.packages?.length ?? 0) : '—'" />
            <div class="text-xs text-slate-500 mt-2">订阅 + 增量包</div>
          </template>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-spin v-if="loading && !current" size="small" />
          <template v-else>
            <a-statistic title="即将过期" :value="current ? (current.expiring?.length ?? 0) : '—'" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="current?.expiring?.length">
                最近 {{ dateText(current?.expiring?.[0]?.expire_at ?? null) }}
              </template>
              <span v-else>没有未用完且临期的额度</span>
            </div>
          </template>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-spin v-if="loading && !current" size="small" />
          <template v-else>
            <a-statistic title="已过期未用完" :value="current ? (current.expired_unused?.length ?? 0) : '—'" />
            <div class="text-xs text-slate-500 mt-2">
              <template v-if="current?.expired_unused?.length">
                这部分额度已经用不上了
              </template>
              <span v-else>没有浪费的额度</span>
            </div>
          </template>
        </a-card>
      </a-col>
    </a-row>

    <a-card title="按来源统计" :bordered="false" class="mt-4">
      <a-alert
        type="info"
        show-icon
        class="mb-3"
        message="积分由服务端按天自动发放，没有签到或任务领取接口"
        description="登录奖励（login_bonus）为每日自动发放 500，成长计划奖励（growth_plan_*）由服务端按账号状态发放。客户端只提供查询接口，无手动领取能力。"
      />
      <a-spin v-if="loading && !current" size="small" />
      <a-table
        v-else
        size="small"
        :pagination="false"
        :data-source="current?.sources ?? []"
        :columns="sourceColumns"
        row-key="source"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'">
            <span class="font-mono text-xs">{{ record.source }}</span>
          </template>
          <template v-else-if="column.key === 'num'">
            <span class="num">{{ fmt(record.total) }}</span>
          </template>
          <template v-else-if="column.key === 'used'">
            <span class="num">{{ fmt(record.used) }}</span>
          </template>
          <template v-else-if="column.key === 'left'">
            <span class="font-medium num">{{ fmt(record.left) }}</span>
          </template>
          <template v-else-if="column.key === 'last'">
            <template v-if="record.last_at">
              {{ dateText(record.last_at) }}
              <a-tag :color="record.days_since_last === 0 ? 'green' : record.days_since_last > 3 ? 'orange' : 'default'" class="ml-1">
                {{ record.days_since_last === 0 ? '今天' : record.days_since_last + ' 天前' }}
              </a-tag>
            </template>
            <span v-else>—</span>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="每日发放与消耗" :bordered="false" class="mt-4">
      <a-spin v-if="loading && !current" size="small" />
      <a-empty v-else-if="!current || !current.daily_grant?.length" description="没有发放记录" />
      <!-- 发放与消耗同为「积分」量纲，所以能共图共用一张 Y 轴；
           先前手写的柱状图只画了发放，消耗藏在 title 里要悬停才看得到，
           而「发了多少、用了多少」恰恰是这张图要回答的。 -->
      <div v-else ref="grantChartEl" class="grant-chart" />
    </a-card>

    <a-card title="逐笔发放记录" :bordered="false" class="mt-4">
      <a-spin v-if="loading && !current" size="small" />
      <a-table
        v-else
        size="small"
        :data-source="pkgRows"
        :columns="pkgColumns"
        row-key="rowKey"
        :pagination="{ pageSize: 15, size: 'small', showSizeChanger: false }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'">
            <span class="font-mono text-xs">{{ record.source || record.package_type || '—' }}</span>
          </template>
          <template v-else-if="column.key === 'granted'">
            {{ dateTimeText(record.granted_at) }}
          </template>
          <template v-else-if="column.key === 'expire'">
            {{ dateTimeText(record.expire_at) }}
          </template>
          <template v-else-if="column.key === 'total'">
            <span class="num">{{ fmt(record.total) }}</span>
          </template>
          <template v-else-if="column.key === 'used'">
            <span class="num">{{ fmt(record.used) }}</span>
          </template>
          <template v-else-if="column.key === 'left'">
            <a-tag :color="record.left > 0 ? 'green' : 'default'"><span class="num">{{ fmt(record.left) }}</span></a-tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="pkgStateColor(record)">{{ pkgStateText(record) }}</a-tag>
          </template>
        </template>
      </a-table>
    </a-card>
    </div>

    <!-- ============ 操作流水（签到 / 任务 / 抽奖 / 自动发放）============
         原来这是独立的「任务记录」页。并入积分明细的理由：这些动作**全都是
         积分的来源**，而本页其余区块（额度包、按来源、每日发放、逐笔发放）
         回答的是同一个问题——「积分从哪来、怎么没的」。拆成两页会让
         「查一笔积分的来历」要在两页之间来回跳。
         账号管理页保留的是**操作台**（增删账号、跑任务、开轮询），
         记录是结果，不该堆在操作台上。 -->
    <a-card title="操作流水" :bordered="false" class="mt-4">
      <template #extra>
        <a-space>
          <a-select v-model:value="opType" size="small" style="width: 110px" :options="opTypeOptions" />
          <a-select v-model:value="opAccount" size="small" style="width: 140px" :options="opAccountOptions" />
          <a-select v-model:value="opDays" size="small" style="width: 100px" :options="opDayOptions" />
          <a-button size="small" class="ghost-btn" :loading="opLoading" @click="loadOps">刷新</a-button>
        </a-space>
      </template>

      <!-- 按天聚合：一眼看出哪天做了什么。只标类型不显示次数——
           「哪天做过什么」是这张表要回答的，次数在下面明细里能数。 -->
      <a-alert v-if="opError" type="error" show-icon :message="opError" class="mb-2" />
      <a-spin v-else-if="!ops" size="small" />
      <a-empty v-else-if="!ops.daily?.length" description="还没有操作记录" />
      <a-table
        v-else
        size="small"
        :pagination="false"
        :data-source="ops.daily"
        :columns="opDailyColumns"
        row-key="account_id"
        class="mb-4"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">{{ record.account }}</template>
          <template v-else-if="column.key === 'days'">
            <div v-for="(acts, day) in record.days" :key="day" class="text-xs leading-5">
              <span class="text-slate-400">{{ day }}</span>
              <a-tag v-for="(_, t) in acts" :key="t" :color="opTypeColor(String(t))" class="ml-1">
                {{ opTypeText(String(t)) }}
              </a-tag>
            </div>
          </template>
        </template>
      </a-table>

      <a-table
        size="small"
        :data-source="ops?.rows ?? []"
        :columns="opColumns"
        row-key="rowKey"
        :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <!-- 自动发放显示真实发放时刻（服务端 00:00 发的），不是「我们查到的时刻」
                 ——否则会看起来像点签到才发的 -->
            <span class="text-xs">
              {{ dateTimeText(record.type === 'grant' && record.granted_at ? record.granted_at : record.ts) }}
            </span>
          </template>
          <template v-else-if="column.key === 'type'">
            <a-tag :color="opTypeColor(record.type)">{{ opTypeText(record.type) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'account'">{{ record.account }}</template>
          <template v-else-if="column.key === 'detail'">
            <template v-if="record.type === 'checkin'">
              {{ opCheckinText(record.result) }}
              <a-tag v-if="!record.ok" color="red" class="ml-1">失败</a-tag>
              <span v-if="record.error" class="text-xs text-red-600 ml-1">{{ record.error }}</span>
            </template>
            <template v-else-if="record.type === 'task'">
              {{ record.title }}
              <a-tag v-if="record.already" color="default" class="ml-1">已发放</a-tag>
              <a-tag v-if="!record.ok" color="red" class="ml-1">失败</a-tag>
              <span v-if="record.error" class="text-xs text-red-600 ml-1">{{ record.error }}</span>
              <div class="text-xs text-slate-400 mt-1">
                <span v-if="record.via === 'query-then-complete'">发消息+上报</span>
                <span v-else-if="record.via === 'complete-only'">仅上报</span>
                <span v-else-if="record.via === 'noop'">无事可做</span>
                <template v-if="record.ms != null">
                  <span class="mx-1">·</span>耗时 {{ fmtMs(record.ms) }}
                </template>
                <template v-if="record.expected_points">
                  <span class="mx-1">·</span>声明奖励 {{ record.expected_points }} 积分
                </template>
              </div>
            </template>
            <template v-else-if="record.type === 'draw'">
              <template v-if="record.prize">抽到 <span class="font-medium">{{ record.prize }}</span></template>
              <template v-else>抽了 {{ record.count || 1 }} 次</template>
            </template>
            <template v-else-if="record.type === 'grant'">
              登录奖励 <span class="font-medium num">+{{ record.points_delta }}</span>
              <a-tag color="blue" class="ml-1">自动</a-tag>
              <span class="text-xs text-slate-400 ml-1">{{ record.note }}</span>
            </template>
          </template>
          <template v-else-if="column.key === 'points'">
            <template v-if="record.points_delta !== null && record.points_delta !== undefined">
              <span class="num" :class="record.points_delta > 0 ? 'text-green-700' : 'text-slate-400'">
                余额 {{ record.points_delta > 0 ? '+' + record.points_delta : record.points_delta }}
                <span v-if="record.points_before !== null && record.points_after !== null" class="text-xs text-slate-400 num">
                  ({{ fmt(record.points_before) }} → {{ fmt(record.points_after) }})
                </span>
              </span>
            </template>
            <!-- 没有 delta 与「delta 为 0」是两回事：前者是没打发放接口（今日已签），
                 后者才是真发了但没增加。如实显示 —，不折成 0。 -->
            <span v-else class="text-slate-400">— <span class="text-xs">本次未发放</span></span>
          </template>
        </template>
      </a-table>
    </a-card>
    </template>

    <!-- 签到详情：按月份/年份查看。千问办公没有签到体系，不渲染。 -->
    <CheckinDetailCard v-if="!isQw" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import PageHeader from '@/components/PageHeader.vue'
import CheckinDetailCard from '@/components/CheckinDetailCard.vue'
import client from '@/api/client'
import { channelStore, isTraework, isQwenwork, isQoder } from '@/stores/channel'
import { regionParam, isIntlRegion } from '@/stores/region'
import { traeworkApi } from '@/api/traework'
import type { TraeworkCreditRow, TraeworkStatus, TraeworkCreditRecord } from '@/api/traework'
import { qwenworkApi } from '@/api/qwenwork'
import type { QwCredits, QwCreditRecord } from '@/api/qwenwork'
import { qoderApi } from '@/api/qoder'
import type { QoderCreditRow, QoderCreditRecord } from '@/api/qoder'
import type { PointsData, PointsPackage, AllPointsData, AccountPoints } from '@/api/points'
import type { RecordsData } from '@/api/records'
import { SERIES, INK, TOOLTIP_BASE, axisStyle, compactNum, exactNum, barSeries } from '@/utils/chartTheme'

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

// 当前展示的账号统一成一份「明细视图」：本地后端与网页账号字段对齐后，
// 下面的统计卡 / 按来源 / 每日发放 / 逐笔四块都只读它，切换账号时整套跟着变。
interface PointsView2 {
  left: number
  total: number
  used: number
  packages: PointsPackage[]
  expiring: PointsPackage[]
  expired_unused: PointsPackage[]
  sources: any[]
  daily_grant: any[]
}

const data = ref<PointsData | null>(null)
const allPoints = ref<AllPointsData | null>(null)
const loading = ref(false)
const error = ref('')
const selectedId = ref<string>('local')

// TRAE Work 的额度：单一 credits，按账号独立，靠签到领取。
// 与千问的「三个积分池」是两套账，不合并显示。
const isTw = computed(() => isTraework())
const twStatus = ref<TraeworkStatus | null>(null)
const twRows = ref<TraeworkCreditRow[]>([])

const twColumns = [
  { title: '账号', key: 'name', width: '18%' },
  { title: '剩余额度', key: 'remain', width: '13%' },
  { title: '额度上限', key: 'limit', width: '13%' },
  { title: '已消耗', key: 'consumed', width: '13%' },
  { title: '签到可得', key: 'checkinCredits', width: '13%' },
  { title: '今日签到', key: 'checkin', width: '12%' },
  { title: '上次签到', key: 'last', width: '16%' },
  { title: '错误', key: 'err' },
]

const twRecords = ref<TraeworkCreditRecord[]>([])
const twWindow = ref({ cost: 0, requests: 0, exact: 0 })

const twRecordColumns = [
  { title: '时间', key: 'ts', width: '20%' },
  { title: '模型', key: 'model', width: '16%' },
  { title: '消耗', key: 'cost', width: '15%' },
  { title: '耗时', key: 'ms', width: '11%' },
  { title: '请求后剩余', key: 'remain', width: '18%' },
  { title: '账号', key: 'account', width: '20%' },
]

// TRAE 的账与千问不同：单一 credits，数值是「次」不是积分小数
const fmtTw = (n: number | null) => (n == null ? '—' : Number(n).toFixed(2))

// 合计只对**取到值**的账号求和：把 null 当 0 会让「一个账号取不到」
// 表现成「总额度变少了」，而真相是没测到。区域视图下整页只有当前区域的账号
const twTotals = computed(() => {
  let remain = 0
  let limit = 0
  let checked = 0
  let anyRemain = false
  let anyLimit = false
  for (const r of twRows.value) {
    if (r.remain != null) { remain += r.remain; anyRemain = true }
    if (r.limit != null) { limit += r.limit; anyLimit = true }
    if (r.checkedIn) checked++
  }
  return {
    remain: anyRemain ? remain : null,
    limit: anyLimit ? limit : null,
    checked,
  }
})

async function loadTw() {
  loading.value = true
  try {
    const r = regionParam() as 'cn' | 'intl' | undefined
    const [s, c] = await Promise.all([
      traeworkApi.status(r).catch((e: any) => ({
        data: { ready: false, error: e?.message || '读取失败', accounts: 0, mode: 'multi', modeNote: '', rows: [] },
      })),
      traeworkApi.credits(r).catch(() => ({ data: { count: 0, rows: [] } })),
    ])
    twStatus.value = s.data as TraeworkStatus
    twRows.value = c.data.rows || []
    // 逐笔明细单独拉：额度表与明细是两个端点，一个失败不该拖垮另一个
    const rec = await traeworkApi.creditRecords(200, r)
      .catch(() => ({ data: { rows: [], window: { cost: 0, requests: 0, exact: 0 } } }))
    twRecords.value = rec.data.rows || []
    twWindow.value = rec.data.window || { cost: 0, requests: 0, exact: 0 }
  } finally {
    loading.value = false
  }
}

// ---- Qoder 积分（两份额度 + 逐笔消耗，与 TRAE / 千问都是各自的账）----
const isQd = computed(() => isQoder())
const qdRows = ref<QoderCreditRow[]>([])
const qdError = ref('')
const qdRecords = ref<QoderCreditRecord[]>([])
const qdWindow = ref({ cost: 0, requests: 0, exact: 0 })
/** 账本起点。本功能上线前的请求没有逐笔记录，必须标出来 */
const qdSince = ref<number | null>(null)
// 已消耗（上游累积真值）。两份额度**分开合计**——与剩余额同口径，不相加。
// 取不到（查询失败）的账号不计入，返回 null，不补 0。
const qdUsed = computed(() => {
  let addOn: number | null = null
  let user: number | null = null
  for (const r of qdRows.value) {
    if (r.addOnQuota) addOn = (addOn || 0) + r.addOnQuota.used
    if (r.userQuota) user = (user || 0) + r.userQuota.used
  }
  return { addOn, user }
})

/** 7 天内到期的批次（推算剩余口径，先领先扣；estimated=false = 领取额降级） */
const qdExpiring = ref<{ count: number; amount: number; estimated?: boolean }>({ count: 0, amount: 0 })

// 占用百分比：上游 percentage 是 0~1 的小数；拿不到时显示 —，不编 0
const pctWidth = (p: number | null) => {
  const v = p == null ? 0 : (p > 1 ? p : p * 100)
  return `${Math.max(0, Math.min(100, v))}%`
}
const pctText = (p: number | null) => (p == null ? '—' : `${((p > 1 ? p : p * 100)).toFixed(0)}%`)
const usedClass = (p: number | null) => {
  const v = p == null ? 0 : (p > 1 ? p : p * 100)
  if (v >= 80) return 'used-high'
  if (v >= 50) return 'used-mid'
  return 'used-low'
}

// 两份额度**分开合计**，不合并。取不到的账号不计入（与 TRAE 同口径）
const qdTotals = computed(() => {
  let addOn: number | null = null
  let user: number | null = null
  let left: number | null = null
  let checked = 0
  let pending = 0
  for (const r of qdRows.value) {
    if (r.addOnQuota) { addOn = (addOn || 0) + r.addOnQuota.remaining; left = (left || 0) + r.addOnQuota.remaining }
    if (r.userQuota) { user = (user || 0) + r.userQuota.remaining; left = (left || 0) + r.userQuota.remaining }
    // 只数明确 true 的——查不出的（null）不计入，否则「已签 2/2」会把
    // 查不出的也当成已签，比不显示更糟
    if (r.checkedIn === true) checked++
    if (r.checkinPending) pending++
  }
  return { addOn, user, left, checked, pending }
})

const qdColumns = [
  { title: '账号', key: 'name', width: '18%' },
  { title: '已消耗（上游真值）', key: 'used', width: '26%' },
  { title: '剩余（签到）', key: 'addOn', width: '12%' },
  { title: '剩余（订阅）', key: 'user', width: '12%' },
  { title: '今日签到', key: 'checkin', width: '12%' },
  { title: '状态', key: 'err' },
]

const qdRecordColumns = [
  { title: '时间', key: 'ts', width: '24%' },
  { title: '模型', key: 'model', width: '20%' },
  { title: '消耗', key: 'cost', width: '18%' },
  { title: '耗时', key: 'ms', width: '13%' },
  { title: '账号', key: 'account', width: '25%' },
]

async function loadQd() {
  loading.value = true
  try {
    const r = regionParam() as 'cn' | 'intl' | undefined
    const [c, rec] = await Promise.all([
      qoderApi.credits(r).catch(() => ({
        data: {
          count: 0,
          rows: [] as QoderCreditRow[],
          summary: { total: 0, valid: 0, unknown: 0, checkedIn: 0, addOnTotal: 0, userTotal: 0, exceeded: 0, expiringCount: 0, expiringAmount: 0, expiringEstimated: false, expiringGrantedAmount: 0 },
          note: '',
        },
      })),
      qoderApi.creditRecords(200, r).catch(() => ({
        data: { rows: [] as QoderCreditRecord[], window: { cost: 0, requests: 0, exact: 0 }, since: null, recorded: 0 },
      })),
    ])
    qdRows.value = c.data.rows || []
    qdExpiring.value = {
      count: c.data.summary?.expiringCount || 0,
      amount: c.data.summary?.expiringAmount || 0,
      estimated: c.data.summary?.expiringEstimated,
    }
    qdRecords.value = rec.data.rows || []
    qdWindow.value = rec.data.window || { cost: 0, requests: 0, exact: 0 }
    qdSince.value = rec.data.since ?? null
    qdError.value = ''
  } catch (e: any) {
    qdRows.value = []
    qdRecords.value = []
    qdError.value = e?.response?.data?.error || e?.message || '读取 Qoder 积分失败'
  } finally {
    loading.value = false
  }
}

// ---- 千问办公积分（与搭子、TRAE 都是两套账）----
const isQw = computed(() => isQwenwork())
const qwCredits = ref<QwCredits | null>(null)
const qwRecords = ref<QwCreditRecord[]>([])
const qwWindow = ref({ total: 0, requests: 0 })

// 千问逐笔消耗的列。不再有「扣费池 / 免费 / 付费」三列：上游已停发
// 每日免费额度，新记录恒为 free=0、pool=paid，那三列只会显示一排零。
const qwRecordColumns = [
  { title: '时间', key: 'ts', width: '20%' },
  { title: '模型', key: 'model', width: '16%' },
  { title: '消耗', key: 'total', width: '16%' },
  { title: '请求后余额', key: 'balance', width: '22%' },
  { title: '账号', key: 'account', width: '14%' },
]

// ---- 操作流水（签到 / 任务 / 抽奖 / 自动发放）----
// 原来是一个独立的「任务记录」页，并入本页的理由见模板里的注释。
// 数据是搭子网页端（dumate.baidu.com）的，与千问/TRAE 无关，所以只在搭子分支渲染。
const ops = ref<RecordsData | null>(null)
const opLoading = ref(false)
// 拉取失败与「确实没有记录」必须分开：前者是故障，后者是正常空态。
// 折成一个空态等于把一次失败断言成「确实没签到过」。
const opError = ref('')
const opType = ref('')
const opAccount = ref<number | null>(null)
const opDays = ref(30)

const opTypeOptions = [
  { label: '全部类型', value: '' },
  { label: '签到', value: 'checkin' },
  { label: '任务', value: 'task' },
  { label: '抽奖', value: 'draw' },
  { label: '自动发放', value: 'grant' },
]
const opDayOptions = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
]
const opAccountOptions = ref<Array<{ label: string; value: number | null }>>([
  { label: '全部账号', value: null },
])
const opDailyColumns = [
  { title: '账号', key: 'name', width: '20%' },
  { title: '按天', key: 'days' },
]
const opColumns = [
  { title: '时间', key: 'ts', width: '16%' },
  { title: '类型', key: 'type', width: '9%' },
  { title: '账号', key: 'account', width: '14%' },
  { title: '结果', key: 'detail' },
  { title: '积分', key: 'points', width: '19%' },
]

const opTypeText = (t: string) => ops.value?.types?.[t] || t
const opTypeColor = (t: string) =>
  t === 'checkin' ? 'green' : t === 'task' ? 'blue' : t === 'draw' ? 'orange'
    : t === 'grant' ? 'cyan' : 'default'
// 任务耗时：秒/毫秒自动切换
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)

// 「今日已签」不等于这次发了分：签到是幂等的，已签就不再打发放接口，
// 所以这行没有本次发放金额。当天额度通常已由服务端在 00:00 自动发过，
// 那份属于当天早些时候的发放，不记在这次调用头上。
function opCheckinText(r?: string) {
  return r === 'claimed' ? '签到成功'
    : r === 'already' ? '今日已签（本次未发放）'
    : r === 'failed' ? '签到失败' : '—'
}

async function loadOps() {
  opLoading.value = true
  opError.value = ''
  try {
    const params = new URLSearchParams()
    if (opType.value) params.set('type', opType.value)
    if (opAccount.value) params.set('account_id', String(opAccount.value))
    params.set('days', String(opDays.value))
    params.set('limit', '500')
    const { data } = await client.get(`/web-accounts/records?${params}`)
    // rowKey：ts 可能撞（同一毫秒多条），补上类型与序号
    ops.value = {
      ...data,
      rows: (data.rows || []).map((r: any, i: number) => ({ ...r, rowKey: `${r.ts}-${r.type}-${i}` })),
    }
  } catch (e: any) {
    // 取不到要如实说「拉取失败」，不能渲染成「还没有操作记录」——
    // 那是把一次失败断言成「确实没签到过」，用户会据此以为账号没问题
    opError.value = e?.response?.data?.error || e?.message || '操作流水加载失败'
    ops.value = null
  } finally {
    opLoading.value = false
  }
}

/**
 * 账号筛选选项**独立拉取**，不从记录里反推。
 *
 * 原来是从 /records 的 daily 里补全，且只在 `length===1 && daily?.length`
 * 时填一次。两个后果：首次响应没有记录（默认 30 天窗口内无活动）就永远
 * 停在「全部账号」；窗口外有记录的账号也选不到。账号列表本来就有一个
 * 现成接口，直接用它更准也更简单。
 */
async function loadOpAccounts() {
  try {
    const { data } = await client.get('/web-accounts')
    opAccountOptions.value = [
      { label: '全部账号', value: null },
      ...(data.accounts || []).map((a: any) => ({ label: a.name, value: a.id })),
    ]
  } catch (e) { /* 取不到就保持「全部账号」，不影响主列表 */ }
}

async function loadQw() {
  loading.value = true
  try {
    const [credits, records] = await Promise.all([
      qwenworkApi.credits().catch((e: any) => ({ data: { ok: false, error: e?.message || '取不到千问积分' } })),
      qwenworkApi.creditRecords(200).catch(() => ({ data: { rows: [], window: { total: 0, requests: 0 } } })),
    ])
    qwCredits.value = credits.data as QwCredits
    qwRecords.value = records.data.rows || []
    qwWindow.value = records.data.window || { total: 0, requests: 0 }
  } finally {
    loading.value = false
  }
}

// 可切换的账号：本地后端 + 每个网页账号。取不到数据的也列出来（禁用），
// 否则用户不知道自己有这个账号、只是这次查询失败了。
const accountOptions = computed(() => {
  const opts: Array<{ key: string; label: string; ok: boolean }> = []
  for (const a of allPoints.value?.accounts ?? []) {
    opts.push({ key: String(a.id), label: a.name, ok: !!a.ok })
  }
  opts.push({ key: 'local', label: data.value?.account_name || '本地后端', ok: !!data.value })
  return opts
})

// 选中的账号明细。网页账号的 id 是数字，本地后端固定 'local'。
const current = computed<PointsView2 | null>(() => {
  if (selectedId.value === 'local') {
    const d = data.value
    if (!d) return null
    return {
      left: d.left, total: d.total, used: d.used,
      packages: d.packages, expiring: d.expiring,
      expired_unused: d.expired_unused, sources: d.sources, daily_grant: d.daily_grant,
    }
  }
  const a = (allPoints.value?.accounts ?? []).find((x) => String(x.id) === selectedId.value)
  if (!a || !a.ok) return null
  return {
    left: a.left ?? 0, total: a.total ?? 0, used: a.used ?? 0,
    packages: a.packages ?? [], expiring: a.expiring ?? [],
    expired_unused: a.expired_unused ?? [], sources: a.sources ?? [], daily_grant: a.daily_grant ?? [],
  }
})

// 当前选中的账号查询失败时，把原因显示在当前位置而不是顶部——顶部那一条
// 是留给整体加载失败的，两个来源的错误不该混在一起
const currentError = computed(() => {
  if (selectedId.value === 'local') return error.value
  const a = (allPoints.value?.accounts ?? []).find((x) => String(x.id) === selectedId.value)
  return a && !a.ok ? (a.error || '查询失败') : ''
})

const detailCached = computed(() => {
  if (selectedId.value === 'local') return !!data.value?.cached
  const a = (allPoints.value?.accounts ?? []).find((x) => String(x.id) === selectedId.value)
  return !!a?.cached
})

const currentLabel = computed(() =>
  accountOptions.value.find((o) => o.key === selectedId.value)?.label ?? '—')

// 总览表点行切换下方明细：汇总与明细是同一批账号的两种视图，
// 让用户来回找切换器没有意义
function customRow(record: AccountPoints) {
  return {
    onClick: () => {
      if (record.ok) selectedId.value = String(record.id)
    },
  }
}
function rowClass(record: AccountPoints) {
  return String(record.id) === selectedId.value ? 'row-selected' : ''
}

// 多账号表的列
const acctColumns = [
  { title: '账号', key: 'name' },
  { title: '余额', key: 'left', width: '18%' },
  { title: '总量', key: 'total', width: '16%' },
  { title: '已用', key: 'used', width: '16%' },
  { title: '状态', key: 'state', width: '12%' },
]

const sourceColumns = [
  { title: '来源', key: 'source', width: '26%' },
  { title: '笔数', key: 'count', width: '10%' },
  { title: '发放总额', key: 'num', width: '16%' },
  { title: '已用', key: 'used', width: '16%' },
  { title: '剩余', key: 'left', width: '16%' },
  { title: '最近发放', key: 'last', width: '16%' },
]
const pkgColumns = [
  { title: '来源', key: 'source', width: '22%' },
  { title: '发放时间', key: 'granted', width: '18%' },
  { title: '到期时间', key: 'expire', width: '18%' },
  { title: '总额', key: 'total', width: '12%' },
  { title: '已用', key: 'used', width: '12%' },
  { title: '剩余', key: 'left', width: '10%' },
  { title: '状态', key: 'status', width: '10%' },
]

// 逐笔记录要按发放时间倒序，且补一个稳定的 key（包 ID 可能重复）
const recentDaily = computed(() => (current.value?.daily_grant ?? []).slice(-14))

const pkgRows = computed(() =>
  (current.value?.packages ?? [])
    .slice()
    .sort((a, b) => (b.granted_at || 0) - (a.granted_at || 0))
    .map((p, i) => ({ ...p, rowKey: `${p.source}-${p.granted_at}-${i}` })))

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
// 千问积分保留 4 位：实测单次消耗 0.0025，按 2 位显示会变成 0
const fmtQw = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
/** 额度刷新时刻（上游 active_wallet 的 valid_to）。空值显示 —，不编日期 */
const fmtReset = (iso?: string | null) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—'
}
const dateText = (ts: number | null) =>
  ts ? new Date(ts).toLocaleDateString('zh-CN') : '—'
// 发放/到期时间精确到秒：同一天会发多笔（实测一天 61 笔），只到日期的话
// 逐笔记录里几十行显示完全一样，分不出先后顺序
const dateTimeText = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'

// 每日发放与消耗。两个序列同量纲（积分），共用一个 Y 轴与图例。
function renderGrantChart() {
  if (!grantChartEl.value) return
  if (!grantChart) grantChart = echarts.init(grantChartEl.value)
  const rows = recentDaily.value
  if (!rows.length) return

  grantChart.setOption({
    grid: { left: 60, right: 12, top: 34, bottom: 26 },
    legend: {
      data: ['发放', '消耗'],
      right: 0,
      top: 0,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: INK.secondary, fontSize: 12 },
    },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any[]) => {
        const r = rows[params[0].dataIndex]
        return `<div style="color:${INK.muted};font-size:11px">${r.day}</div>`
          + `<div style="margin-top:2px">发放 <b>${exactNum(r.granted)}</b></div>`
          + `<div>消耗 <b>${exactNum(r.used)}</b></div>`
          + `<div style="color:${INK.muted}">${r.count} 笔</div>`
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.day.slice(5)),
      ...axisStyle({ showGrid: false }),
    },
    yAxis: { type: 'value', ...axisStyle({ formatter: (v: number) => compactNum(v) }) },
    series: [
      barSeries({ name: '发放', data: rows.map((r) => r.granted), color: SERIES[0] }),
      barSeries({ name: '消耗', data: rows.map((r) => r.used), color: SERIES[1] }),
    ],
  })
}

function pkgStateText(p: PointsPackage) {
  if (p.expire_at && p.expire_at < Date.now()) return p.left > 0 ? '已过期(有剩余)' : '已过期'
  if (p.left <= 0) return '已用尽'
  return '可用'
}
function pkgStateColor(p: PointsPackage) {
  if (p.expire_at && p.expire_at < Date.now()) return 'red'
  if (p.left <= 0) return 'default'
  return 'green'
}

async function load(force = false) {
  loading.value = true
  error.value = ''
  try {
    // 多账号（网页凭证）与单账号（本地后端）分别拉：一个失败不影响另一个显示
    try {
      const { data: ap } = await client.get('/web-accounts/points-all' + (force ? '?refresh=1' : ''))
      allPoints.value = ap
    } catch (e) { /* 账号管理没配也不影响下面的明细 */ }

    try {
      const { data: d } = await client.get('/points/points' + (force ? '?refresh=1' : ''))
      data.value = d
    } catch (e: any) {
      // 本地后端起不来时不能把整页判死：网页账号的明细照样要看得到
      error.value = e?.response?.data?.error || e?.message || '未知错误'
    }

    // 首次加载默认选中第一个可用账号（网页账号优先）。之后刷新保留用户选择，
    // 否则每次点刷新都会跳回去，正在对比的账号被切走。
    const valid = accountOptions.value.filter((o) => o.ok).map((o) => o.key)
    if (!valid.includes(selectedId.value)) {
      selectedId.value = valid[0] ?? 'local'
    }
  } finally {
    loading.value = false
  }
}

// 图表实例：切换账号或刷新后要重画，组件卸载要销毁（否则 resize 监听会持有已卸载的实例）
const grantChartEl = ref<HTMLElement | null>(null)
let grantChart: echarts.ECharts | null = null

// 数据或所选账号变化时重画。用 watch 而不是在 load() 里直接调用：
// 切换账号不重新请求，但图必须跟着换。
watch([current, recentDaily], async () => {
  await nextTick()
  renderGrantChart()
}, { deep: false })

function onResize() { grantChart?.resize() }

// 操作流水只在搭子通道有意义（签到/抽奖/任务是网页端独有），
// 千问与 TRAE 各自的账在各自的区块里，切过去时不请求、也不渲染。
watch([opType, opAccount, opDays], () => { if (!isTw.value && !isQw.value && !isQd.value) loadOps() })

onMounted(() => {
  // 按当前通道初始化：顶栏已切到 TRAE/千问/Qoder 时进这个页面，
  // 该拉的是对应通道的账，而不是搭子的额度包
  if (isTw.value) loadTw()
  else if (isQw.value) loadQw()
  else if (isQd.value) loadQd()
  else {
    load()
    loadOps()
    loadOpAccounts()
  }
  window.addEventListener('resize', onResize)
})

// 切通道重拉：三条通道的数据源与结构都不同
watch(() => channelStore.current, () => {
  if (isTw.value) loadTw()
  else if (isQw.value) loadQw()
  else if (isQd.value) loadQd()
  else {
    load()
    loadOps()
    loadOpAccounts()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  grantChart?.dispose()
  grantChart = null
})
</script>

<style scoped>
/* 高度含 X 轴标签带，避免卡片里出现内嵌滚动条 */
.grant-chart {
  height: 240px;
  width: 100%;
}

/* 选中行给左侧色条 + 底色，让「下方明细属于哪一行」一眼可见 */
:deep(.row-selected) > td {
  background: var(--lab-primary-dim) !important;
}
:deep(.row-selected) > td:first-child {
  box-shadow: inset 3px 0 0 var(--lab-primary);
}

/* 已消耗占比条：只有数字看不出「还剩多少」，条给出一眼的量感 */
.used-bar-wrap {
  height: 6px;
  border-radius: 3px;
  background: var(--lab-surface-3);
  overflow: hidden;
  margin-top: 2px;
}
.used-bar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.used-bar.used-high { background: var(--lab-danger); }
.used-bar.used-mid { background: var(--lab-warn); }
.used-bar.used-low { background: var(--lab-ok); }

/* 切换按钮加大：默认 solid 按钮太小，点完看不出选中态变化。
   账号多时按钮换行，所以行高用倍数而不是固定像素，否则两行的按钮会撑歪 */
:deep(.acct-btn) {
  min-height: 40px;
  min-width: 96px;
  line-height: 1.2;
  padding: 6px 16px;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* 当前账号大标题：青色信号条 + 极淡渐变，与侧栏选中态同一套语言 */
.acct-banner {
  background: linear-gradient(90deg, var(--lab-primary-dim) 0%, transparent 100%);
  border: 1px solid var(--lab-border-strong);
  border-left: 3px solid var(--lab-primary);
  border-radius: 10px;
  padding: 14px 18px;
}

/* 切换账号时整块淡入：数据换了要有个视觉确认 */
.detail-block {
  animation: fade-in 0.22s ease-out;
}
@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
</style>
