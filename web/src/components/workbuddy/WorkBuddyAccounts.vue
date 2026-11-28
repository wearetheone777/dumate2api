<template>
  <div class="page">
    <PageHeader title="账号管理" :sub="subText">
      <template #actions>
        <!-- 分组筛选（M2.4）：选中组后一键签到只作用于该组，卡片列表同步收窄 -->
        <a-select
          v-if="groupOptions.length"
          v-model:value="groupFilter"
          size="small"
          style="width: 132px"
          :options="groupOptions"
          placeholder="全部分组"
          allow-clear
        />
        <!-- 排序作用于**全量**再切页（P2-9）：先切页再排序会让每页各自成序，
             翻页时账号顺序乱跳。选项里的升/降序也按「全量口径」命名 -->
        <a-select
          v-model:value="sortMode"
          size="small"
          style="width: 128px"
          :options="sortOptions"
        />
        <a-button size="small" class="ghost-btn" :loading="loading" :disabled="!enabledCount" @click="checkinAll">
          {{ groupFilter ? `签到「${groupFilter}」组` : '一键签到' }}
        </a-button>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
        <AccountTransferCard @imported="load" />
        <a-button type="primary" size="small" :loading="oauthLoading" :disabled="oauthPolling" @click="startOauthLogin">
          浏览器登录
        </a-button>
        <a-button size="small" @click="importOpen = true">导入账号</a-button>
      </template>
    </PageHeader>

    <!-- 结构说明。文案按当前区域视图出 -->
    <a-alert type="info" show-icon>
      <template #message>WorkBuddy {{ isIntl ? '国际版' : '国内版' }}的凭证由本项目自己持有</template>
      <template #description>
        <div>
          凭证存于 <code>data/workbuddy-accounts.json</code>。账号来源：
          <b>浏览器 OAuth 登录</b>（推荐，多账号就是每个账号各登录一次）、
          官方客户端认证文件导入、或手动粘贴 token。
        </div>
        <div class="mt-1 text-xs">
          <template v-if="isIntl">
            当前是<b>国际版（workbuddy.ai）</b>视图。国际版没有签到接口（上游不提供）；
            额度是套餐包积分。要加国内账号请切回「国内版」。
          </template>
          <template v-else>
            当前是<b>国内版（copilot.tencent.com）</b>视图，有签到体系。
            与国际版（workbuddy.ai）是两套独立账号，要加国际账号请切到「国际版」。
          </template>
        </div>
      </template>
    </a-alert>

    <a-alert
      v-if="status && !status.ready"
      type="warning"
      show-icon
      :message="status.error || '通道不可用'"
    />

    <!-- OAuth 登录进行中：说明轮询状态与多账号做法 -->
    <a-alert v-if="oauthPolling" type="info" show-icon>
      <template #message>等待浏览器完成登录…（最长 10 分钟，每 2 秒检查一次）</template>
      <template #description>
        在弹出的官方登录页里完成登录即会自动导入。
        要加<b>多个账号</b>：完成一个后，换另一个账号（或开无痕窗口）再点一次「浏览器登录」。
      </template>
    </a-alert>

    <a-card :bordered="false">
      <div class="flex items-center justify-between mb-3">
        <div>
          <span class="section-title">账号列表</span>
          <span class="hint-text ml-2">
            共 {{ filteredRows.length }} 个<template v-if="groupFilter">（组内）</template> · 启用 {{ enabledCount }} 个
            <template v-if="pageRows.length !== filteredRows.length">
              · 本页 {{ pageRows.length }} 个
            </template>
          </span>
        </div>
        <!-- 额度新鲜度（P2-9 二次修正的配套）：轮询刻意不刷额度（每号 4 次上游），
             所以「剩余积分 / 今日签到」只在上次手动刷新那一刻有效。不标出来就是
             「看起来实时、其实是几分钟前的数字」——本项目最忌讳的那种假象。
             超过 5 分钟才变橙色：正常操作节奏（进页面就刷一次）不会触发。 -->
        <span v-if="creditsAt" class="text-xs" :class="creditsStale ? 'text-orange-700' : 'text-slate-400'">
          额度更新于 {{ relTime(creditsAt, nowTick) }}<template v-if="creditsStale">（已过期，点刷新重取）</template>
        </span>
        <span v-else class="text-xs text-slate-400">额度尚未读取</span>
      </div>

      <a-empty v-if="!filteredRows.length && !loading" :description="groupFilter ? `分组「${groupFilter}」下没有账号` : `还没有${isIntl ? '国际' : '国内'}版账号`">
        <a-button type="primary" :loading="oauthLoading" @click="startOauthLogin">浏览器登录添加账号</a-button>
        <a-button class="ml-2" @click="importOpen = true">其他方式导入</a-button>
      </a-empty>

      <a-skeleton v-if="loading && !filteredRows.length" active :paragraph="{ rows: 4 }" />

      <a-row v-else :gutter="[16, 16]">
        <a-col v-for="a in pageRows" :key="a.id" :span="8" :xs="24" :md="8">
          <a-card size="small" :bordered="true" class="h-full">
            <div class="flex items-start justify-between">
              <div class="min-w-0">
                <div class="font-medium truncate">
                  {{ a.nickname || a.uid || '未命名' }}
                  <a-tag v-if="!a.enabled" color="default" class="ml-1">已停用</a-tag>
                  <!-- 分组（M2.4）：点击标签直接改组 -->
                  <a-tag
                    v-if="a.group"
                    color="geekblue"
                    class="ml-1 cursor-pointer"
                    @click="openGroup(a)"
                  >{{ a.group }}</a-tag>
                  <!-- 改名：后端 PATCH 支持 nickname，此前一直没有入口 -->
                  <a-button type="text" size="small" class="ml-1" style="padding: 0 4px" @click="openRename(a)">
                    <EditOutlined />
                  </a-button>
                </div>
                <div class="text-xs text-slate-400 font-mono mt-1 truncate">
                  UID {{ a.uid || '—' }}
                </div>
                <div v-if="a.enterpriseName" class="text-xs text-slate-400 mt-1 truncate">
                  {{ a.enterpriseName }}
                </div>
              </div>
              <a-switch
                size="small"
                :checked="a.enabled"
                @change="(v: boolean) => toggle(a, v)"
              />
            </div>

            <a-alert
              v-if="a.lastError"
              :type="errFresh(a) ? 'error' : 'warning'"
              :message="errorWhen(errAt(a)) + a.lastError"
              show-icon
              class="mt-2"
              style="padding: 4px 8px"
            />

            <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div class="text-xs text-slate-400">剩余积分</div>
                <div class="num">{{ creditOf(a.id)?.total ?? '—' }}</div>
                <!-- 临期包：不用点开详情就该看见的风险（已用完的包不算） -->
                <div v-if="soonPackText(a)" class="text-xs text-orange-700">{{ soonPackText(a) }}</div>
              </div>
              <div>
                <div class="text-xs text-slate-400">今日签到</div>
                <div>
                  <a-tag v-if="isIntl" color="default">不支持</a-tag>
                  <a-tag v-else :color="checkinColor(a)">
                    {{ checkinText(a) }}
                  </a-tag>
                </div>
              </div>
              <div>
                <div class="text-xs text-slate-400">上次签到</div>
                <div class="text-xs">{{ a.lastCheckin ? dateText(a.lastCheckin) : '从未' }}</div>
              </div>
              <div>
                <div class="text-xs text-slate-400">token 到期</div>
                <div class="text-xs" :class="tokenExpired(a) ? 'text-red-600' : ''">
                  {{ a.expiresAt ? dateText(a.expiresAt) : '—' }}
                </div>
              </div>
            </div>

            <div class="mt-3 flex flex-wrap gap-1">
              <a-button v-if="!isIntl" size="small" :loading="busy[a.id]" @click="checkin(a)">签到</a-button>
              <a-button size="small" @click="openDetail(a)">详情</a-button>
              <a-popconfirm title="删除并移入回收站（30 天内可恢复）？" @confirm="remove(a)">
                <a-button size="small" danger>删除</a-button>
              </a-popconfirm>
            </div>

            <div class="mt-2 text-xs text-slate-400">
              来源 {{ sourceText(a.source) }}
              · refresh …{{ a.refreshTail || '—' }}
            </div>
            <!-- 出站代理（M2.1）：脱敏展示。配置了代理的账号，聊天/签到/刷新
                 全部走它（login IP = 调用 IP，降低风控面）；未配 = 直连。
                 原始 URL 含凭证不出进程，这里显示的是 redact 后的形态 -->
            <div class="mt-1 text-xs flex items-center gap-1">
              <span class="text-slate-400">出站</span>
              <a-tag v-if="a.proxy" color="purple" class="mr-0">
                <span class="font-mono">{{ a.proxy }}</span>
              </a-tag>
              <span v-else class="text-slate-400">直连</span>
              <a-button type="text" size="small" style="padding: 0 4px" @click="openProxy(a)">
                <EditOutlined />
              </a-button>
            </div>
            <!-- 分组（M2.4）：未分组也给出入口——批量操作的前提是先圈组 -->
            <div class="mt-1 text-xs flex items-center gap-1">
              <span class="text-slate-400">分组</span>
              <span v-if="a.group" class="text-slate-500">{{ a.group }}</span>
              <span v-else class="text-slate-400">未分组</span>
              <a-button type="text" size="small" style="padding: 0 4px" @click="openGroup(a)">
                <EditOutlined />
              </a-button>
            </div>
          </a-card>
        </a-col>
      </a-row>

      <!-- 客户端分页（P2-9）：只在真的分页时才出分页条——账号少的时候
           一条恒显示「1 / 1」的分页器纯属噪音 -->
      <!-- 客户端分页（P2-9）：只在真的需要时出分页条——账号少的时候一条恒显示
           「1 / 1」的分页器纯属噪音。但**改过页大小就继续显示**：把页大小调到
           100 让总页数变成 1 之后若整条消失，用户就再也调不回来了 -->
      <div v-if="totalPages > 1 || pageSize !== DEFAULT_PAGE_SIZE" class="mt-3 flex items-center justify-between">
        <span class="text-xs text-slate-400">
          第 {{ safePage }} / {{ totalPages }} 页，每页 {{ pageSize }} 个 — 排序与筛选作用于全量后切页
        </span>
        <a-pagination
          size="small"
          :current="safePage"
          :page-size="pageSize"
          :total="filteredRows.length"
          :show-size-changer="true"
          :page-size-options="PAGE_SIZE_TEXT"
          @change="onPageChange"
        />
      </div>
    </a-card>

    <!-- 导入账号：两条路——客户端认证文件导入 / 手动粘贴 token（登录流程后置） -->
    <a-modal v-model:open="importOpen" title="导入 WorkBuddy 账号" :footer="null" width="560">
      <a-alert type="info" show-icon class="mb-3">
        <template #message>当前导入到{{ isIntl ? '国际版' : '国内版' }}</template>
        <template #description>
          两套账号不通用。推荐用页面右上角的<b>「浏览器登录」</b>（OAuth 设备授权，
          多账号就是每个账号各登录一次）；这里的两种方式是没有浏览器登录条件时的替代——
          客户端导入读的是本机客户端的登录态文件，必须先在客户端里登录对应区域的账号。
        </template>
      </a-alert>
      <a-button type="primary" block :loading="importLoading" @click="doImportClient">
        从客户端认证文件导入
      </a-button>
      <a-divider plain class="text-xs text-slate-400">或手动粘贴 token</a-divider>
      <a-form layout="vertical">
        <a-form-item label="accessToken">
          <a-textarea v-model:value="tokenForm.accessToken" :rows="2" placeholder="粘贴 access token" />
        </a-form-item>
        <a-form-item label="refreshToken">
          <a-textarea v-model:value="tokenForm.refreshToken" :rows="2" placeholder="粘贴 refresh token" />
        </a-form-item>
        <div class="grid grid-cols-2 gap-2">
          <a-form-item label="uid（可选，缺失用 token 尾做占位）">
            <a-input v-model:value="tokenForm.uid" placeholder="uid" />
          </a-form-item>
          <a-form-item label="昵称（可选）">
            <a-input v-model:value="tokenForm.nickname" placeholder="nickname" />
          </a-form-item>
        </div>
        <a-button block :loading="tokenLoading" @click="doImportToken">导入</a-button>
      </a-form>
      <a-alert v-if="importError" type="error" show-icon class="mt-3" :message="importError" />
    </a-modal>

    <!-- 详情：完整字段 + 逐包明细（含到期）。credits 里的 packages 从来没在
         账号页展示过——「哪个包快过期」要进详情才看得见 -->
    <a-modal v-model:open="detailOpen" :title="`账号详情 · ${detailRow?.nickname || detailRow?.uid || ''}`" :footer="null" width="560">
      <template v-if="detailRow">
        <a-descriptions :column="1" size="small" bordered class="mb-3">
          <a-descriptions-item label="UID"><span class="font-mono text-xs">{{ detailRow.uid || '—' }}</span></a-descriptions-item>
          <a-descriptions-item label="区域">{{ detailRow.region === 'global' ? '国际（workbuddy.ai）' : '国内（copilot.tencent.com）' }}</a-descriptions-item>
          <a-descriptions-item label="凭证域"><span class="font-mono text-xs">{{ detailRow.domain || '—' }}</span></a-descriptions-item>
          <a-descriptions-item label="来源">{{ sourceText(detailRow.source) }}</a-descriptions-item>
          <a-descriptions-item label="创建时间">{{ detailRow.createdAt ? dateText(detailRow.createdAt) : '—' }}</a-descriptions-item>
          <a-descriptions-item label="access token">{{ detailRow.expiresAt ? dateText(detailRow.expiresAt) : '—' }}</a-descriptions-item>
          <a-descriptions-item label="refresh token">
            {{ detailRow.refreshExpiresAt ? dateText(detailRow.refreshExpiresAt) : '—' }}
            <a-tag v-if="detailRow.refreshExpiresAt && Date.now() >= detailRow.refreshExpiresAt" color="red" class="ml-1">已过期</a-tag>
          </a-descriptions-item>
          <a-descriptions-item label="refresh 尾"><span class="font-mono text-xs">…{{ detailRow.refreshTail || '—' }}</span></a-descriptions-item>
          <a-descriptions-item label="最近错误">
            <span v-if="detailRow.lastError" :class="errFresh(detailRow) ? 'text-red-600' : 'text-slate-500'">
              {{ errorWhen(errAt(detailRow)) }}{{ detailRow.lastError }}
            </span>
            <span v-else class="text-slate-400">无</span>
          </a-descriptions-item>
        </a-descriptions>
        <div class="section-title mb-2">套餐包明细</div>
        <template v-if="creditOf(detailRow.id)?.packages?.length">
          <div v-for="(p, i) in creditOf(detailRow.id)!.packages" :key="i"
            class="flex items-center justify-between text-xs py-1"
            :class="packSoon(p) ? 'text-orange-700' : ''">
            <span>
              {{ p.name }}
              <a-tag v-if="packSoon(p)" color="orange" class="ml-1" size="small">还剩 {{ packDaysLeft(p) }} 天</a-tag>
            </span>
            <span class="num">
              {{ p.remainPrecise != null ? p.remainPrecise : p.remain }}
              <span class="text-slate-400">/ {{ p.size || '—' }}</span>
              <span class="text-slate-400 ml-2">{{ p.expireAt ? `到期 ${new Date(p.expireAt).toLocaleDateString('zh-CN')}` : '到期未知' }}</span>
            </span>
          </div>
        </template>
        <div v-else class="text-xs text-slate-400">
          {{ detailRow.region === 'global' ? '国际版是订阅制，无套餐包明细' : '该账号没有套餐包明细（额度接口失败或确实为空）' }}
        </div>
      </template>
    </a-modal>

    <!-- 改名：PATCH /accounts/:id 的 nickname 字段此前没有入口 -->
    <a-modal v-model:open="renameOpen" title="修改昵称" @ok="doRename" :confirm-loading="renameLoading" ok-text="保存" cancel-text="取消">
      <a-input v-model:value="renameValue" placeholder="昵称（留空恢复为 UID 显示）" @press-enter="doRename" />
    </a-modal>

    <!-- 出站代理：http://[user:pass@]host[:port]。保存时后端 normalize 校验，
         非法地址当场 400（配了代理就绝不静默回退直连）。空串 = 清除回直连 -->
    <a-modal
      v-model:open="proxyOpen"
      :title="`出站代理 · ${proxyRow?.nickname || proxyRow?.uid || ''}`"
      :confirm-loading="proxyLoading"
      ok-text="保存"
      cancel-text="取消"
      @ok="doSaveProxy"
    >
      <a-alert type="info" show-icon class="mb-3">
        <template #message>账号级出口隔离</template>
        <template #description>
          <div class="text-xs">
            配置后该账号的<b>聊天 / 签到 / token 刷新 / OAuth 登录</b>全部走此代理
            （登录 IP 与调用 IP 一致）。支持 <code>http://host:port</code> 与
            <code>http://user:pass@host:port</code>。清空 = 回直连。
          </div>
        </template>
      </a-alert>
      <a-input
        v-model:value="proxyValue"
        placeholder="http://user:pass@host:port（留空保存 = 清除）"
        @press-enter="doSaveProxy"
      />
      <div v-if="proxyRow?.proxy" class="mt-2 text-xs text-slate-400">
        当前：{{ proxyRow.proxy }}
      </div>
    </a-modal>

    <!-- 分组（M2.4）：自由命名；下拉给已有组名便于归组，也可手输新组名 -->
    <a-modal
      v-model:open="groupOpen"
      :title="`设置分组 · ${groupRow?.nickname || groupRow?.uid || ''}`"
      :confirm-loading="groupLoading"
      ok-text="保存"
      cancel-text="取消"
      @ok="doSaveGroup"
    >
      <a-auto-complete
        v-model:value="groupValue"
        :options="groupOptions"
        placeholder="组名（留空保存 = 移出分组）"
        @press-enter="doSaveGroup"
      />
      <div class="mt-2 text-xs text-slate-400">
        组是自由标签：同组账号可用「签到『组名』组」一键批量签到。
      </div>
    </a-modal>

    <!-- 自动化与护栏（P0-1 自动签到 / P1-6 额度护栏 / P2-11 连坐参数）
         三块都是**运行期配置**：保存即生效，网关下一次判定/选号就按新值走。
         纪律：开关一律配外部文字标签（小尺寸 a-switch 不渲染 checked-children，
         两个外观相同的开关并排会看起来只有一个——CLAUDE.md 已记） -->
    <a-card title="自动化与护栏" :bordered="false" class="mt-4">
      <template #extra>
        <span class="text-xs text-slate-400">保存即生效，无需重启</span>
      </template>
      <a-row :gutter="[24, 16]">
        <!-- 自动签到 -->
        <a-col :xs="24" :lg="12">
          <div class="flex items-center justify-between">
            <div class="min-w-0">
              <div class="font-medium">每日自动签到</div>
              <div class="text-xs text-slate-400">
                国内版两条腿：<b>签到</b>（领当天积分，先查状态：已签跳过、未知状态不签）
                与<b>活跃上报</b>（点亮 growth 连登，各自幂等互不影响）；
                国际版没有签到接口，走<b>网页打卡</b>（ACP 建会话跑一轮）。三者分开计数。
              </div>
            </div>
            <label class="flex items-center gap-2 shrink-0">
              <span class="text-xs" :class="autock.enabled ? 'text-green-700' : 'text-slate-400'">
                {{ autock.enabled ? '已开启' : '已关闭' }}
              </span>
              <a-switch size="small" :checked="autock.enabled" :loading="autockSaving"
                @change="(v: boolean) => saveAutock({ enabled: v })" />
            </label>
          </div>
          <div class="mt-2 flex items-center gap-2 flex-wrap text-xs">
            <span class="text-slate-500">每日</span>
            <a-input-number size="small" :min="0" :max="23" :value="autock.hour" style="width: 68px"
              :disabled="autockSaving" @change="(v: any) => v != null && saveAutock({ hour: Number(v) })" />
            <span class="text-slate-500">:</span>
            <a-input-number size="small" :min="0" :max="59" :value="autock.minute" style="width: 68px"
              :disabled="autockSaving" @change="(v: any) => v != null && saveAutock({ minute: Number(v) })" />
            <span class="text-slate-500">+ 随机后延</span>
            <a-input-number size="small" :min="0" :max="120" :value="autock.jitter_minutes" style="width: 72px"
              :disabled="autockSaving" @change="(v: any) => v != null && saveAutock({ jitter_minutes: Number(v) })" />
            <span class="text-slate-500">分钟</span>
            <a-button size="small" :loading="autockRunning" @click="runAutock">立即跑一轮</a-button>
          </div>
          <div class="mt-2 text-xs text-slate-500">
            <template v-if="autock.next_run_at">下次触发 {{ dateText(autock.next_run_at) }}</template>
            <template v-else-if="!autock.enabled">未排程（开关关闭）</template>
            <template v-if="autock.last_result">
              · 上次（{{ autock.last_result.trigger }}）
              国内签成 {{ autock.last_result.claimed }} / 已签 {{ autock.last_result.already }}
              <template v-if="autock.last_result.activity != null">
                · 活跃 {{ autock.last_result.activity }}
                <span v-if="autock.last_result.activityUnverified" class="text-orange-700">
                  （未验证 {{ autock.last_result.activityUnverified }}）
                </span>
              </template>
              <template v-if="autock.last_result.webDaily != null">
                · 国际网页打卡 {{ autock.last_result.webDaily }}
              </template>
              / 未知 {{ autock.last_result.unknown }} / 失败 {{ autock.last_result.failed }}
            </template>
          </div>
          <div v-if="autock.last_result?.results?.length" class="mt-1 text-xs">
            <!-- key 必须带 action：同一账号现在会出现两行（签到 + 活跃上报），
                 只用 id 会让 Vue 把两行复用到同一个节点上（渲染错乱） -->
            <div v-for="r in autock.last_result.results.slice(0, 8)" :key="`${r.id}-${r.action}`" class="flex justify-between">
              <span class="truncate">{{ r.name }}</span>
              <span :class="r.ok ? 'text-green-700' : 'text-red-600'">
                {{ autockActionText(r) }}{{ r.error ? `：${r.error.slice(0, 40)}` : '' }}
              </span>
            </div>
          </div>
        </a-col>

        <!-- 额度护栏 -->
        <a-col :xs="24" :lg="12">
          <div class="flex items-center justify-between">
            <div class="min-w-0">
              <div class="font-medium">额度护栏</div>
              <div class="text-xs text-slate-400">
                剩余低于阈值的账号不进选号候选——省掉一次注定 402 的上游请求。快照陈旧时自动失效。
              </div>
            </div>
            <label class="flex items-center gap-2 shrink-0">
              <span class="text-xs" :class="guard.enabled ? 'text-green-700' : 'text-slate-400'">
                {{ guard.enabled ? '已开启' : '已关闭' }}
              </span>
              <a-switch size="small" :checked="guard.enabled" :loading="guardSaving"
                @change="(v: boolean) => saveGuard({ enabled: v })" />
            </label>
          </div>
          <div class="mt-2 flex items-center gap-2 text-xs">
            <span class="text-slate-500">阈值</span>
            <a-input-number size="small" :min="0.01" :step="0.5" :value="guard.threshold" style="width: 96px"
              :disabled="guardSaving" @change="(v: any) => v != null && saveGuard({ threshold: Number(v) })" />
            <span class="text-slate-500">积分（低于它即跳过）</span>
          </div>
          <!-- 保留积分下限：与上面的 threshold 不是一回事。
               threshold 是「低于就不选这个号」的选号过滤；
               creditFloor 是 pool 层保底线，写进池的余额低于它就整个跳过。
               而且它**重启才生效**（pool 配置在 createPool 时定死）——这条必须写在界面上，
               否则「改了没反应」会被当成 bug。 -->
          <div class="mt-2 flex items-center gap-2 text-xs">
            <span class="text-slate-500">保底线</span>
            <a-input-number size="small" :min="0" :step="10" :value="guard.creditFloor ?? 0" style="width: 96px"
              :disabled="guardSaving" @change="(v: any) => v != null && saveGuard({ creditFloor: Number(v) })" />
            <span class="text-slate-500">积分（0 = 关闭）</span>
            <span
              v-if="guardPoolFloor != null && (guard.creditFloor ?? 0) !== guardPoolFloor"
              class="text-orange-700"
            >需重启网关才生效（当前生效 {{ guardPoolFloor }}）</span>
          </div>
          <div class="mt-2 text-xs text-slate-500">
            快照：<template v-if="guardSnap.at">
              {{ dateText(guardSnap.at) }} · {{ guardSnap.accounts }} 个账号
              <span v-if="!guardSnap.fresh" class="text-orange-700">· 已过期（护栏不生效）</span>
            </template>
            <template v-else>尚无数据（打开本页刷新额度后生成）</template>
          </div>
        </a-col>

        <!-- 连坐参数（P2-11） -->
        <a-col :xs="24" :lg="12">
          <div class="font-medium">风控连坐参数</div>
          <div class="text-xs text-slate-400">
            窗口内有 N 个不同账号被限制就整区域暂停。改短时长会<b>立即截断</b>现有倒计时。
          </div>
          <div class="mt-2 grid grid-cols-2 gap-2 text-xs">
            <label class="flex items-center gap-1">
              <span class="text-slate-500 w-20">触发账号数</span>
              <a-input-number size="small" :min="1" :max="50" :value="restr.waveMin"
                :disabled="restrSaving" @change="(v: any) => v != null && saveRestr({ waveMin: Number(v) })" />
            </label>
            <label class="flex items-center gap-1">
              <span class="text-slate-500 w-20">判定窗口</span>
              <a-input-number size="small" :min="0" :max="86400" :value="restr.waveWindowSec"
                :disabled="restrSaving" @change="(v: any) => v != null && saveRestr({ waveWindowSec: Number(v) })" />
              <span class="text-slate-400">秒</span>
            </label>
            <label class="flex items-center gap-1">
              <span class="text-slate-500 w-20">暂停时长</span>
              <a-input-number size="small" :min="0" :max="86400" :value="restr.holdSeconds"
                :disabled="restrSaving" @change="(v: any) => v != null && saveRestr({ holdSeconds: Number(v) })" />
              <span class="text-slate-400">秒</span>
            </label>
            <label class="flex items-center gap-1">
              <span class="text-slate-500 w-20">受限换号数</span>
              <a-input-number size="small" :min="0" :max="20" :value="restr.restrictedRotateMax"
                :disabled="restrSaving" @change="(v: any) => v != null && saveRestr({ restrictedRotateMax: Number(v) })" />
            </label>
          </div>
          <div class="mt-2 text-xs text-slate-500">
            暂停时长设 <b>0</b> = 彻底关闭连坐暂停（仍记录「哪些号被限制」）。换号数默认 0：11140 是设备/出口级风控，换号会让更多号连坐。
          </div>
        </a-col>

        <!-- 余额巡检（2026-11-08 补）：FEFO 与护栏快照的 TTL 都是 6 小时，
             不刷新就静默失效——真机实测 workbuddy 段曾停了 101 小时、
             护栏快照文件从未被创建。每日 keepalive 只覆盖 6 小时，所以真正
             让快照常新的是这个 10 分钟级的低频巡检。
             它同时管搭子网页池，所以文案里点明「也管别的通道」 -->
        <a-col :xs="24" :lg="12">
          <div class="flex items-center justify-between">
            <div class="min-w-0">
              <div class="font-medium">余额巡检（FEFO / 护栏保鲜）</div>
              <div class="text-xs text-slate-400">
                FEFO 与护栏快照的 TTL 都是 <b>6 小时</b>，过期后临期优先与护栏<b>静默失效</b>。
                每日 keepalive 只覆盖 6 小时，所以要让它们长期有效只能靠这里的低频巡检。
                <b>同时管搭子网页池</b>（同一份配置）。
              </div>
            </div>
            <label class="flex items-center gap-2 shrink-0">
              <span class="text-xs" :class="bref.enabled ? 'text-green-700' : 'text-slate-400'">
                {{ bref.enabled ? '已开启' : '已关闭' }}
              </span>
              <a-switch size="small" :checked="bref.enabled" :loading="brefSaving"
                @change="(v: boolean) => saveBref({ enabled: v })" />
            </label>
          </div>
          <div class="mt-2 flex items-center gap-2 flex-wrap text-xs">
            <span class="text-slate-500">每</span>
            <a-input-number size="small" :min="0" :max="1440" :value="bref.minutes" style="width: 84px"
              :disabled="brefSaving" @change="(v: any) => v != null && saveBref({ minutes: Number(v) })" />
            <span class="text-slate-500">分钟</span>
            <a-button size="small" :loading="brefRunning" @click="runBref">立即巡检一轮</a-button>
          </div>
          <div class="mt-2 text-xs text-slate-500">
            <template v-if="!bref.enabled">未启用（间隔设 0 也等于关闭）</template>
            <template v-else-if="bref.last_run_at">上次 {{ dateText(bref.last_run_at) }}</template>
            <template v-else>已排程，尚未跑过</template>
            <template v-if="bref.last_result">
              · 搭子 {{ bref.last_result.ok_count ?? '?' }}/{{ bref.last_result.accounts ?? '?' }}
              <!-- WorkBuddy 段必须区分「查到了但没有临期」与「一个都没查到」：
                   全失败时 entries=0 并不代表没有临期，写成「临期 0 个号」就是
                   把「无知」说成「确认没有」——本项目最忌讳的假象 -->
              <template v-if="bref.last_result.workbuddy">
                · WorkBuddy {{ bref.last_result.workbuddy.ok_count ?? '?' }}/{{ bref.last_result.workbuddy.accounts ?? '?' }}
                <span v-if="bref.last_result.workbuddy.error" class="text-red-600">
                  （巡检异常：{{ bref.last_result.workbuddy.error }}）
                </span>
                <span v-else-if="!bref.last_result.workbuddy.ok_count" class="text-orange-700">
                  （全部查询失败，快照未更新）
                </span>
                <span v-else-if="bref.last_result.workbuddy.entries != null">
                  （其中临期 {{ bref.last_result.workbuddy.entries }} 个号）
                </span>
              </template>
            </template>
          </div>
        </a-col>

        <!-- 模型繁忙度（2026-11-08 融合批）：上游 /v2/chat/busy 是唯一
             「免费、不扣额度、不动账号状态」的接口。**必须如实标出「只提示不拦」**
             ——让人以为已避开繁忙模型而实际仍会打过去，比不显示更糟。
             国际版没有这个接口（404），那不是故障，是「查不到」。 -->
        <a-col :xs="24" :lg="12">
          <!-- 布局口径：按钮**跟标题同一行**，说明文字独占下面的整行。
               原来的写法是「左侧文字块（含多行说明）+ 右侧按钮垂直居中」，
               说明文字有 3 行时按钮会落在第 2 行的水平位置上，视觉上像
               「夹在文字中间」——实测几何没重叠（按钮 x=833、左块宽 556），
               但看起来就是错位。把 buttons 提到标题行、说明文字 100% 宽，
               两种屏幕宽度下都不会再错位。 -->
          <div class="flex items-center justify-between">
            <div class="font-medium">模型繁忙度</div>
            <a-button size="small" :loading="busyLoading" class="shrink-0 ml-2" @click="loadBusy(true)">探测</a-button>
          </div>
          <div class="text-xs text-slate-400 mt-1">
            上游实时的排队状况（idle / normal / busy / congested / unavailable）。
            <b>免费只读</b>：不扣额度、不改账号状态。
            <span v-if="busyInfo && !busyInfo.guardEnabled" class="text-orange-700">
              当前<b>仅提示、不参与选号</b>——繁忙模型仍会被打到
            </span>
            <span v-else-if="busyInfo && busyInfo.guardEnabled" class="text-green-700">
              已启用拦截（DUMATE_WORKBUDDY_BUSY_GUARD=1）
            </span>
          </div>
          <div class="mt-2 text-xs">
            <template v-if="!busyInfo">尚未探测</template>
            <template v-else-if="busyInfo.unsupported">
              <span class="text-slate-400">国际版没有该接口（上游 404）——查不到，不是通道故障</span>
            </template>
            <template v-else-if="!busyInfo.ok">
              <span class="text-red-600">探测失败：{{ busyInfo.error }}</span>
            </template>
            <template v-else-if="!busyInfo.models.length">
              <span class="text-slate-400">没有模型可查（模型目录为空）</span>
            </template>
            <template v-else>
              <div class="flex flex-wrap gap-1">
                <a-tag
                  v-for="m in busyShown" :key="m.id" :color="busyColor(m.level)"
                  class="mr-1"
                >{{ m.id }} · {{ m.level }}</a-tag>
                <span v-if="busyInfo.crowded.length" class="text-orange-700 ml-1">
                  {{ busyInfo.crowded.length }} 个模型明显拥挤，建议换模型
                </span>
                <span v-else class="text-green-700 ml-1">没有明显拥挤的模型</span>
              </div>
              <div class="mt-1 text-slate-400">
                探测于 {{ dateText(busyInfo.at) }} · 共 {{ busyInfo.models.length }} 个模型
                <template v-if="busyInfo.models.length > busyShown.length">（只列拥挤与偏忙的，其余正常）</template>
              </div>
            </template>
          </div>
        </a-col>

        <!-- 成长中心（2026-11-08 融合批）：**只读**。
             不接取任务、不领奖、不开盲盒——调研实证伪造成长事件会被上游识别为
             异常，且接取/领奖的 body 形状尚未在 unlocked 态验证过。
             所以这里只回答「这个号连登几天、今天点亮没有、还有多少任务能做」。 -->
        <a-col :xs="24" :lg="12">
          <!-- 与「模型繁忙度」同口径：按钮跟标题同一行，说明文字独占整行 -->
          <div class="flex items-center justify-between">
            <div class="font-medium">成长中心（只读）</div>
            <a-button size="small" :loading="growthLoading" class="shrink-0 ml-2" @click="loadGrowth">查询</a-button>
          </div>
          <div class="text-xs text-slate-400 mt-1">
            连登档位 / 今日点亮 / 任务进度 / 成长能量 / 盲盒额度。
            <b>只看不动</b>：不接取任务、不领奖、不开盲盒。
          </div>
          <div class="mt-2 text-xs">
            <template v-if="!growth">尚未查询</template>
            <template v-else-if="!growth.ok">
              <span class="text-red-600">
                查询失败：{{ growth.error || Object.values(growth.errors)[0] || '未知原因' }}
              </span>
            </template>
            <template v-else>
              <div class="grid grid-cols-2 gap-x-3 gap-y-1">
                <div>
                  <span class="text-slate-400">连登</span>
                  <!-- null（查不到）与 0（查到了没连）必须分开显示 -->
                  <span class="num ml-1">
                    {{ growth.streak?.days != null ? `${growth.streak.days} 天` : '查不到' }}
                  </span>
                  <span v-if="growth.streak?.nextTierRemaining != null" class="text-slate-400 ml-1">
                    （再 {{ growth.streak.nextTierRemaining }} 天到 {{ growth.streak.nextTier }}）
                  </span>
                </div>
                <div>
                  <span class="text-slate-400">今日点亮</span>
                  <span class="ml-1" :class="growth.heatmap?.todayScore ? 'text-green-700' : 'text-orange-700'">
                    <template v-if="growth.heatmap?.todayScore == null">查不到</template>
                    <template v-else-if="growth.heatmap.todayScore > 0">已点亮</template>
                    <template v-else>未点亮</template>
                  </span>
                </div>
                <div>
                  <span class="text-slate-400">任务</span>
                  <span class="num ml-1">
                    <template v-if="growth.tasks">
                      已领 {{ growth.tasks.claimed }}/{{ growth.tasks.total }}，可做 {{ growth.tasks.claimable }}
                    </template>
                    <template v-else>查不到</template>
                  </span>
                </div>
                <div>
                  <span class="text-slate-400">能量</span>
                  <span class="num ml-1">{{ growth.energy?.balance ?? '查不到' }}</span>
                </div>
              </div>
              <!-- 可领取但未领的档位：调研说「必须手动领，不领会过期」，
                   这是最该提醒的一条 -->
              <div v-if="growth.streak?.redeemable?.length" class="mt-1 text-orange-700">
                连登档位 {{ growth.streak.redeemable.join(' / ') }} 天已解锁但未领取（不领会过期，需到官方客户端手动领）
              </div>
              <!-- 待做任务：只列前 3 个，按奖励从大到小 -->
              <div v-if="growth.tasks?.pending?.length" class="mt-1 text-slate-500">
                可做任务：
                <span v-for="t in growth.tasks.pending.slice(0, 3)" :key="t.code" class="mr-2">
                  {{ t.title }}（{{ t.credit }} 积分）{{ t.auto ? '·自动' : '' }}
                </span>
                <span v-if="growth.tasks.pending.length > 3">…还有 {{ growth.tasks.pending.length - 3 }} 个</span>
              </div>
              <!-- 逐项失败原因：不能只报一个总错，运维要能看出哪个端点坏了 -->
              <div v-if="Object.keys(growth.errors).length" class="mt-1 text-orange-700">
                部分端点失败：{{ Object.entries(growth.errors).map(([k, v]) => `${k}: ${v}`).join('；') }}
              </div>
              <div class="mt-1 text-slate-400">查询于 {{ dateText(growth.at) }}</div>
            </template>
          </div>
        </a-col>
      </a-row>
    </a-card>

    <!-- 签到结果 -->
    <a-alert v-if="checkinMsg" :type="checkinMsgType" show-icon class="mt-4" message="签到结果">
      <template #description>
        <ul class="pl-4 mb-0 text-xs">
          <li v-for="(l, i) in checkinDetail" :key="i">{{ l }}</li>
        </ul>
      </template>
    </a-alert>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { App } from 'ant-design-vue'
import { EditOutlined } from '@ant-design/icons-vue'
import PageHeader from '@/components/PageHeader.vue'
import AccountTransferCard from '@/components/AccountTransferCard.vue'
import { channelStore, isWorkBuddy } from '@/stores/channel'
import { regionStore, regionParam } from '@/stores/region'
import { workbuddyApi } from '@/api/workbuddy'
import type {
  WorkBuddyAccount, WorkBuddyCreditRow, WorkBuddyStatus, WorkBuddyRestrictionConfig, WorkBuddyAutoCheckin,
  WorkBuddyBusy, WorkBuddyGrowth,
} from '@/api/workbuddy'
import { lastErrorFresh, errorWhen, relTime, isStale } from '@/utils/lastError'
import {
  DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, clampPage, pageCount, pageSlice, sameSig, sortRows,
} from '@/utils/paging'
import type { RowSort } from '@/utils/paging'

const { message } = App.useApp()

const status = ref<WorkBuddyStatus | null>(null)
const credits = ref<{ count: number; rows: WorkBuddyCreditRow[] } | null>(null)
const loading = ref(false)
const rows = computed(() => status.value?.rows ?? [])
// 分组筛选（M2.4）：空 = 全部。列表、计数、一键签到范围都跟着收窄
const groupFilter = ref<string>('')
const filteredRows = computed(() =>
  groupFilter.value ? rows.value.filter((a) => (a.group || '') === groupFilter.value) : rows.value)
const groupOptions = computed(() => {
  const groups = [...new Set(rows.value.map((a) => (a.group || '').trim()).filter(Boolean))]
  return groups.sort().map((g) => ({ label: g, value: g }))
})
const isIntl = computed(() => regionStore.current === 'intl')

// ---- 客户端分页 / 排序（P2-9）----
// 口径：筛选 → 排序 → 切页（顺序不能换）。先切页再排序会让每页各自成序，
// 翻页时同一个账号跳来跳去，用户会以为数据在乱跳。
const sortMode = ref<RowSort>('default')
const sortOptions: Array<{ label: string; value: RowSort }> = [
  { label: '默认顺序', value: 'default' },
  { label: '积分从少到多', value: 'credits-asc' },
  { label: '积分从多到少', value: 'credits-desc' },
  { label: '最快到期', value: 'expiring' },
]
const pageSize = ref<number>(DEFAULT_PAGE_SIZE)
const currentPage = ref(1)

/** 积分未知（null）按「排最后」处理，不当 0——未知不是「用完了」 */
function creditTotalOf(id: number): number | null {
  const c = credits.value?.rows.find((r) => r.id === id)
  if (!c) return null
  if (c.totalPrecise != null && Number.isFinite(c.totalPrecise)) return c.totalPrecise
  return c.total != null && Number.isFinite(c.total) ? c.total : null
}

const sortedRows = computed(() => sortRows(filteredRows.value, sortMode.value, creditTotalOf))
const totalPages = computed(() => pageCount(sortedRows.value.length, pageSize.value))
const safePage = computed(() => clampPage(currentPage.value, sortedRows.value.length, pageSize.value))
const pageRows = computed(() => pageSlice(sortedRows.value, safePage.value, pageSize.value))
// ant-design-vue 的 pageSizeOptions 必须是**纯数字字符串**：它内部按
// Number(value) 解析并回传给 showSizeChange，写成「50 / 页」会变成 NaN，
// 于是切到 100 条后页大小仍是原值（看起来像「页大小选择器没反应」）。
// 单位放到分页器旁边的说明文字里。
const PAGE_SIZE_TEXT = PAGE_SIZE_OPTIONS.map((n) => String(n))

function onPageChange(p: number, size?: number) {
  // 页码在这里就夹紧一次：分页器回传的值来自上一次渲染的 total，
  // 与当前数据可能已经不一致（轮询刚好加点/删点账号）。
  // 页大小也在这个统一入口里收——ant-design-vue 改页大小时 change 与
  // showSizeChange 会**都**触发，分开写会出现「先按旧页大小夹页码、
  // 再改页大小」的顺序陷阱
  if (size != null) {
    const s = Math.max(1, Math.floor(Number(size)) || DEFAULT_PAGE_SIZE)
    if (s !== pageSize.value) { pageSize.value = s; currentPage.value = 1; return }
  }
  currentPage.value = clampPage(p, sortedRows.value.length, pageSize.value)
}
// 换筛选/换排序/换区域都回第一页：留在第 5 页去看一个只有 2 页的新集合
// 会渲染成空白，且分页条本身也会显示一个不存在的页码
watch([groupFilter, sortMode, () => regionStore.current], () => { currentPage.value = 1 })

const busy = reactive<Record<number, boolean>>({})
const importOpen = ref(false)
const importLoading = ref(false)
const tokenLoading = ref(false)
const importError = ref('')
const tokenForm = reactive({ accessToken: '', refreshToken: '', uid: '', nickname: '' })

const checkinMsg = ref('')
const checkinMsgType = ref<'success' | 'warning' | 'error'>('success')
const checkinDetail = ref<string[]>([])

const subText = computed(() => {
  const r = isIntl.value ? '国际版' : '国内版'
  if (!status.value) return `WorkBuddy ${r}账号（多账号，可增删）`
  if (!status.value.ready) return `WorkBuddy ${r}账号 · 通道不可用`
  return `WorkBuddy ${r}账号 · 可用 ${status.value.accounts} 个`
})

const enabledCount = computed(() => filteredRows.value.filter((a) => a.enabled).length)

function creditOf(id: number): WorkBuddyCreditRow | undefined {
  return credits.value?.rows.find((r) => r.id === id)
}

function checkinColor(a: WorkBuddyAccount) {
  const c = creditOf(a.id)
  if (!c || c.checkedIn == null) return 'default'
  return c.checkedIn ? 'green' : 'orange'
}
function checkinText(a: WorkBuddyAccount) {
  const c = creditOf(a.id)
  if (!c) return '刷新中'
  if (c.error) return '查询失败'
  if (c.unsupportedCheckin) return '不支持'
  if (c.checkedIn == null) return '—'
  return c.checkedIn ? '今日已签' : '未签到'
}

function tokenExpired(a: WorkBuddyAccount) {
  return !!a.expiresAt && Date.now() >= a.expiresAt
}

// ---- 套餐包临期（与积分明细页同口径：7 天窗口，已用完的包不算）----
const packSoon = (p: NonNullable<WorkBuddyCreditRow['packages']>[number]) => {
  const now = Date.now()
  return !!(p.expireAt && p.expireAt > now && p.expireAt <= now + 7 * 86400000 && p.remain > 0)
}
const packDaysLeft = (p: NonNullable<WorkBuddyCreditRow['packages']>[number]) =>
  p.expireAt ? Math.max(0, Math.ceil((p.expireAt - Date.now()) / 86400000)) : 0

function soonPackText(a: WorkBuddyAccount): string {
  const c = creditOf(a.id)
  if (!c?.packages) return ''
  const soon = c.packages.filter(packSoon)
  if (!soon.length) return ''
  const sum = soon.reduce((s, p) => s + (p.remainPrecise != null ? p.remainPrecise : p.remain), 0)
  // 精确余额是浮点（上游 "1569.42"），直接插值会渲染成 1569.4200000000001——
  // 截图里就是这么露出来的。留两位小数并按千分位分组。
  const text = sum.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  return `${soon.length} 个包 7 天内到期（${text}）`
}

// ---- 详情弹窗 ----
const detailOpen = ref(false)
const detailRow = ref<WorkBuddyAccount | null>(null)
function openDetail(a: WorkBuddyAccount) {
  detailRow.value = a
  detailOpen.value = true
}

// ---- 改名 ----
const renameOpen = ref(false)
const renameLoading = ref(false)
const renameValue = ref('')
let renameId: number | null = null
function openRename(a: WorkBuddyAccount) {
  renameId = a.id
  renameValue.value = a.nickname || ''
  renameOpen.value = true
}
async function doRename() {
  if (renameId == null) return
  renameLoading.value = true
  try {
    await workbuddyApi.patchAccount(renameId, { nickname: renameValue.value.trim() })
    message.success('昵称已更新')
    renameOpen.value = false
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '改名失败')
  } finally {
    renameLoading.value = false
  }
}

// ---- 出站代理（M2.1）----
const proxyOpen = ref(false)
const proxyLoading = ref(false)
const proxyValue = ref('')
const proxyRow = ref<WorkBuddyAccount | null>(null)
function openProxy(a: WorkBuddyAccount) {
  proxyRow.value = a
  proxyValue.value = '' // 安全：不回填原始 URL（前端根本没有它，只有脱敏形态）
  proxyOpen.value = true
}
async function doSaveProxy() {
  if (proxyRow.value == null) return
  proxyLoading.value = true
  try {
    const { data } = await workbuddyApi.patchAccount(proxyRow.value.id, { proxy: proxyValue.value.trim() })
    message.success(proxyValue.value.trim() ? `代理已设置：${data.proxy || ''}` : '代理已清除（回直连）')
    proxyOpen.value = false
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '代理保存失败')
  } finally {
    proxyLoading.value = false
  }
}

// ---- 分组（M2.4）----
const groupOpen = ref(false)
const groupLoading = ref(false)
const groupValue = ref('')
const groupRow = ref<WorkBuddyAccount | null>(null)
function openGroup(a: WorkBuddyAccount) {
  groupRow.value = a
  groupValue.value = a.group || ''
  groupOpen.value = true
}
async function doSaveGroup() {
  if (groupRow.value == null) return
  groupLoading.value = true
  try {
    await workbuddyApi.patchAccount(groupRow.value.id, { group: groupValue.value.trim() })
    message.success(groupValue.value.trim() ? `已移入分组「${groupValue.value.trim()}」` : '已移出分组')
    groupOpen.value = false
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '分组保存失败')
  } finally {
    groupLoading.value = false
  }
}

const dateText = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

// ---- 自动化与护栏（P0-1 / P1-6 / P2-11）：三块运行期配置 ----
const autock = reactive<WorkBuddyAutoCheckin>({
  enabled: false, hour: 0, minute: 0, jitter_minutes: 10, per_account_delay_ms: 2000,
  last_run_at: null, last_result: null, next_run_at: null, running: false,
})
const autockSaving = ref(false)
const autockRunning = ref(false)
const guard = reactive({ enabled: false, threshold: 1, creditFloor: 0 })
// pool 当前实际生效的保底线（启动时读 env，运行期改不了）。
// 与 guard.creditFloor 不一致时界面要提示「需重启」——否则改了没反应会被当成 bug。
const guardPoolFloor = ref<number | null>(null)
const guardSnap = reactive({ at: null as number | null, fresh: false, accounts: 0, ttlMs: 0 })
const guardSaving = ref(false)
const restr = reactive<WorkBuddyRestrictionConfig>({
  waveMin: 2, waveWindowSec: 900, holdSeconds: 1800, restrictedRotateMax: 0,
})
const restrSaving = ref(false)
// 余额巡检（FEFO / 护栏保鲜）：走 /api/admin/auto-checkin/balance-refresh，
// 与搭子网页池共用同一份配置——这里只暴露「开关 + 间隔 + 跑一轮」三件事，
// 不重复解释搭子那边已有的语义
const bref = reactive({
  enabled: false,
  minutes: 10,
  last_run_at: null as number | null,
  last_result: null as null | {
    ok_count?: number; accounts?: number;
    workbuddy?: { ok_count?: number; accounts?: number; entries?: number; error?: string } | null;
  },
})
const brefSaving = ref(false)
const brefRunning = ref(false)

// 模型繁忙度（融合批）：只读探针。默认不自动拉——它要打一次上游，
// 而且繁忙度是秒级瞬时的，页面开着时的旧读数没意义（与额度同理）。
const busyInfo = ref<WorkBuddyBusy | null>(null)
const busyLoading = ref(false)
// 界面只列「值得看」的模型：拥挤 + 偏忙；其余（idle/normal）压成一句话。
// 模型目录有几十个，全铺出来会把这块压成一面墙，反而看不出哪个该避开。
const busyShown = computed(() => {
  const b = busyInfo.value
  if (!b) return []
  // Record<string, number> 而不是字面量对象：level 来自上游是任意字符串，
  // 用字面量索引会让 TS 报「不能用 string 索引」——这里要的就是「不认识的排最后」
  const order: Record<string, number> = { congested: 0, unavailable: 1, busy: 2, normal: 3, idle: 4 }
  const rank = (lv: string) => (order[lv] != null ? order[lv] : 9)
  return (b.models || [])
    .map((id) => ({ id, level: b.levels[id] || 'normal' }))
    .filter((x) => x.level !== 'idle' && x.level !== 'normal')
    .sort((a, z) => rank(a.level) - rank(z.level))
    .slice(0, 24)
})
function busyColor(level: string) {
  if (level === 'congested') return 'red'
  if (level === 'unavailable') return 'red'
  if (level === 'busy') return 'orange'
  return 'default'
}

// 成长中心（只读）：一次打 5 个只读上游端点，**只按需触发**，不进轮询
const growth = ref<WorkBuddyGrowth | null>(null)
const growthLoading = ref(false)
async function loadGrowth() {
  growthLoading.value = true
  try {
    const r = regionParam() as 'cn' | 'intl' | undefined
    const { data } = await workbuddyApi.growth({ region: r })
    growth.value = data
  } catch (e: any) {
    growth.value = {
      ok: false, region: 'cn', streak: null, heatmap: null, tasks: null,
      energy: null, buddyQuota: null, errors: {},
      error: e?.response?.data?.error || e?.message || '查询失败',
      note: '', at: Date.now(),
    }
  } finally {
    growthLoading.value = false
  }
}
async function loadBusy(explicit = false) {
  if (!explicit && busyInfo.value) return
  busyLoading.value = true
  try {
    const r = regionParam() as 'cn' | 'intl' | undefined
    const { data } = await workbuddyApi.busy({ region: r })
    busyInfo.value = data
  } catch (e: any) {
    // 失败也留一条可解释的状态：静默不动会让人以为「没拥挤」
    busyInfo.value = {
      ok: false, region: 'cn', models: [], levels: {}, crowded: [],
      unsupported: false, guardEnabled: false,
      error: e?.response?.data?.error || e?.message || '探测失败', note: '', at: Date.now(),
    }
  } finally {
    busyLoading.value = false
  }
}

function autockActionText(r: NonNullable<WorkBuddyAutoCheckin['last_result']>['results'][number]) {
  if (r.action === 'web-daily') return r.already ? '今日已打卡' : (r.ok ? '网页打卡' : '打卡失败')
  if (r.action === 'activity') {
    if (r.already) return '今日已上报'
    if (!r.ok) return '上报失败'
    // 送达 ≠ 计入：/v2/report 对假 token 也回 code=0（真机实测），
    // 只有回读到连登天数才算真的生效。不区分会让界面报喜不报忧。
    return r.verified ? `活跃已上报（连登 ${r.streakDays} 天）` : '活跃已送达·未验证'
  }
  if (r.action === 'claim') return r.already ? '已签跳过' : (r.ok ? '签成' : '失败')
  if (r.action === 'already') return '今日已签'
  if (r.action === 'unsupported') return '不支持'
  return '状态未知（未签）'
}

async function loadAutomation() {
  const [a, g, rc, br] = await Promise.all([
    workbuddyApi.autocheckin().catch(() => null),
    workbuddyApi.guard().catch(() => null),
    workbuddyApi.restrictionConfig().catch(() => null),
    workbuddyApi.balanceRefresh().catch(() => null),
  ])
  if (a) Object.assign(autock, a.data)
  if (g) {
    Object.assign(guard, g.data.config)
    Object.assign(guardSnap, g.data.snapshot)
    guardPoolFloor.value = g.data.poolFloor ?? null
  }
  if (rc) Object.assign(restr, rc.data.config)
  if (br) {
    bref.enabled = !!br.data.enabled
    bref.minutes = br.data.minutes
    bref.last_run_at = br.data.last_run_at
    bref.last_result = br.data.last_result
  }
}

async function saveAutock(patch: { enabled?: boolean; hour?: number; minute?: number; jitter_minutes?: number }) {
  autockSaving.value = true
  try {
    const { data } = await workbuddyApi.saveAutocheckin(patch)
    if (data && data.ok === false) { message.error(data.error || '保存失败'); return }
    Object.assign(autock, data)
    message.success(patch.enabled === true ? '已开启自动签到（立即跑了一轮）'
      : patch.enabled === false ? '已关闭自动签到（取消排程）' : '已保存')
    await loadAutomation()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    autockSaving.value = false
  }
}

async function runAutock() {
  autockRunning.value = true
  try {
    await workbuddyApi.runAutocheckin()
    // 触发式：结果靠轮询（一轮可能几秒到几十秒）
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      await loadAutomation()
      if (!autock.running) break
    }
  } catch (e: any) {
    message.error(e?.response?.data?.error || '触发失败')
  } finally {
    autockRunning.value = false
  }
}

async function saveGuard(patch: { enabled?: boolean; threshold?: number; creditFloor?: number }) {
  guardSaving.value = true
  try {
    const { data } = await workbuddyApi.saveGuard(patch)
    if (data && data.ok === false) { message.error(data.error || '保存失败'); return }
    if (data.config) Object.assign(guard, data.config)
    // 保底线的生效路径与其它配置不同：它落在 pool 的启动配置里，
    // 保存后必须明说「要重启」——否则运维会以为已经生效
    message.success(patch.creditFloor !== undefined
      ? '保底线已保存（需重启网关才生效）' : '已保存')
    await loadAutomation()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    guardSaving.value = false
  }
}

async function saveRestr(patch: Partial<WorkBuddyRestrictionConfig>) {
  restrSaving.value = true
  try {
    const { data } = await workbuddyApi.saveRestrictionConfig(patch)
    if (data && data.ok === false) { message.error(data.error || '保存失败'); return }
    if (data.config) Object.assign(restr, data.config)
    message.success(patch.holdSeconds !== undefined
      ? '已保存（改短立即截断现有倒计时）' : '已保存')
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    restrSaving.value = false
  }
}

// ---- 余额巡检（FEFO / 护栏保鲜）----
// 接口在 /auto-checkin 前缀下（与搭子网页池共用），前端放在这里只是因为它
// 从 WorkBuddy 账号页操作。**开关/间隔/跑一轮**三件事，与后端 snapshot() 一一对应。
async function saveBref(patch: { enabled?: boolean; minutes?: number }) {
  brefSaving.value = true
  try {
    const { data } = await workbuddyApi.saveBalanceRefresh(patch)
    if (data && data.ok === false) { message.error(data.error || '保存失败'); return }
    message.success(patch.enabled === true ? '已开启余额巡检'
      : patch.enabled === false ? '已关闭余额巡检' : '已保存')
    await loadAutomation()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '保存失败')
  } finally {
    brefSaving.value = false
  }
}

async function runBref() {
  brefRunning.value = true
  try {
    const { data } = await workbuddyApi.runBalanceRefresh()
    // 后端 run-now 是**同步**跑完才返回（一轮串行限速，账号多时要几十秒），
    // 所以这里直接用返回值刷新展示，不再轮询
    if (data && (data as any).skipped === 'already_running') {
      message.info('上一轮还在跑，等它结束')
    } else {
      message.success('巡检完成')
    }
    await loadAutomation()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '巡检失败')
  } finally {
    brefRunning.value = false
  }
}

const errAt = (a: WorkBuddyAccount) => a.lastErrorAt ?? null
const errFresh = (a: WorkBuddyAccount) => lastErrorFresh(a)

// ---- 轮询去重（P2-9）----
// `load()` 的返回值分三种用途：手动刷新（要 loading 骨架）、操作后回落
// （同上）、定时轮询（**必须静默**）。轮询走骨架会把整页闪一下，
// 而绝大多数轮次数据根本没变。
//
// 去重两层：
//   1. **同签名不赋值**。签名是响应体的稳定 JSON；不变就不写 ref，
//      Vue 的依赖链整个不触发，DOM 一个节点都不动。
//   2. **在途不叠加**。上一轮还没回来就发下一轮，会堆请求，且回来的顺序不定。
//
// **轮询只刷 /status，绝不刷 /credits**（2026-11-08 二次修正）：
// `/status` 读本地账号文件，成本接近零；`/credits` 是**每账号打三个上游端点**
// （签到状态 + 额度 + 按 TTL 的档位）。50 个号 × 每 15 秒 = 每分钟 200 次上游
// 请求，这正是 `docs/CHANNEL-WORKBUDDY.md` 里「节奏宁少勿多」要避免的事。
// 额度是分钟级变化的数据，只在进页面/手动刷新/操作后回落时取。
//
// 更根本的一点：**轮询本身没有产品价值**——没人盯着看「今日签到」在 15 秒内
// 变化。它真正的用途是「这个页面开着的时候，后台刚跑完的那轮自动签到/被别人
// 改了配置能自己反映出来」，而那两者都在 `/status` 里（restriction 与 rows）。
const lastStatusSnap = ref<unknown>(undefined)
const lastCreditsSnap = ref<unknown>(undefined)
// 额度数据的取得时刻（**只在真的取了额度时**推进）。轮询不取额度，
// 所以它不动——界面据此如实标「额度更新于 N 分钟前」。
const creditsAt = ref<number | null>(null)
// 超过这个时长就把「额度更新于…」标橙：分钟级的数据放到 5 分钟已经该重取
const CREDITS_STALE_MS = 5 * 60 * 1000
// 每 15 秒的轮询会推进 status，但 creditsAt 不会变；用同一个 tick 驱动的
// 「现在」来算颜色，避免时间文案停在第一次渲染时的相对时间上。
const nowTick = ref(Date.now())
// 判据在 `@/utils/lastError` 的 isStale（纯函数、有单测）——「看着是新的、
// 其实是旧的」这类假象必须靠断言锁，不能靠肉眼等 5 分钟
const creditsStale = computed(() => isStale(creditsAt.value, CREDITS_STALE_MS, nowTick.value))
let inFlight = false
// 请求序号：异步回落可能乱序（读得慢的那次比快的那次晚回来），后到的旧数据
// 会把刚删掉的账号又画回来。只认**最新一次**发出的请求的结果。
let loadSeq = 0

/**
 * 拉账号列表与状态。
 * @param opts.silent  静默（不出骨架）
 * @param opts.credits 是否顺带取额度（**默认 true**；轮询显式传 false）
 */
async function load(opts: { silent?: boolean; credits?: boolean } = {}) {
  const withCredits = opts.credits !== false
  // 只有**轮询**允许被在途请求挡掉：操作后的回落必须真的重新读，
  // 否则删了账号界面还挂着它（用户会以为删除失败）
  if (inFlight && opts.silent) return
  const seq = ++loadSeq
  inFlight = true
  if (!opts.silent) loading.value = true
  try {
    const r = regionParam() as 'cn' | 'intl' | undefined
    const [s, c] = await Promise.all([
      workbuddyApi.status(r).catch((e: any) => ({
        data: { ready: false, error: e?.message || '读取失败', accounts: 0, mode: 'multi' as const, modeNote: '', rows: [] },
      })),
      // 不取额度时给一个「占位」而不是让 c 为 undefined：后面的签名比较要能
      // 区分「没取」与「取到了空」——用 undefined 会让 lastCreditsSnap 被写成
      // undefined，下一次真取到时即使内容相同也会重画一次（无害但不准确）
      withCredits ? workbuddyApi.credits(r).catch(() => ({ data: { count: 0, rows: [] } })) : null,
    ])
    if (seq !== loadSeq) return // 已有更新的请求发出，这次结果作废
    // 签名没变就不赋值：Vue 的依赖链整个不触发，DOM 一个节点都不动
    if (!sameSig(s.data, lastStatusSnap.value)) {
      lastStatusSnap.value = s.data
      status.value = s.data as WorkBuddyStatus
    }
    if (c && !sameSig(c.data, lastCreditsSnap.value)) {
      lastCreditsSnap.value = c.data
      credits.value = c.data
      // 只有真的取了额度才推进时刻。签名相同也算「刚确认过」——上游给的
      // 就是同一个值，说它「更新于刚刚」是诚实的。
      creditsAt.value = Date.now()
    } else if (c) {
      creditsAt.value = Date.now()
    }
  } finally {
    if (seq === loadSeq) {
      inFlight = false
      loading.value = false
    }
  }
}

async function toggle(a: WorkBuddyAccount, v: boolean) {
  await workbuddyApi.patchAccount(a.id, { enabled: v })
  await load()
}

async function remove(a: WorkBuddyAccount) {
  await workbuddyApi.removeAccount(a.id)
  message.success('已移入回收站（30 天内可恢复）')
  await load()
}

async function checkin(a: WorkBuddyAccount) {
  busy[a.id] = true
  try {
    const { data } = await workbuddyApi.checkin(a.id)
    reportCheckin([data])
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '签到失败')
  } finally {
    busy[a.id] = false
  }
}

async function checkinAll() {
  loading.value = true
  try {
    // 选中分组时只签该组（M2.4）；不选中 = 全部可用账号
    const { data } = await workbuddyApi.checkin(undefined, groupFilter.value || undefined)
    reportCheckin(data?.results || [])
    if (data && data.ok === false && data.error) message.warning(data.error)
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '签到失败')
  } finally {
    loading.value = false
  }
}

function reportCheckin(list: any[]) {
  checkinDetail.value = list.map((r: any) => {
    const name = r.nickname || r.id
    if (r.unsupported) return `${name}：该版本暂不支持自动签到`
    if (!r.ok) return `${name}：失败 — ${r.error || '未知错误'}`
    if (r.already) return `${name}：今日已签到过（跳过）`
    return `${name}：签到成功`
  })
  const failed = list.filter((r: any) => !r.ok && !r.unsupported).length
  checkinMsgType.value = failed ? (failed === list.length ? 'error' : 'warning') : 'success'
  checkinMsg.value = failed ? `${failed} 个失败` : '全部完成'
}

async function doImportClient() {
  importLoading.value = true
  importError.value = ''
  try {
    const { data } = await workbuddyApi.importClient(regionStore.current)
    if (!data.ok) {
      importError.value = data.error || '导入失败'
      return
    }
    message.success(`已导入账号：${data.account?.nickname || data.account?.uid || ''}`)
    importOpen.value = false
    await load()
  } catch (e: any) {
    importError.value = e?.response?.data?.error || '导入失败'
  } finally {
    importLoading.value = false
  }
}

async function doImportToken() {
  if (!tokenForm.accessToken.trim() || !tokenForm.refreshToken.trim()) {
    importError.value = '请粘贴完整的 accessToken 与 refreshToken'
    return
  }
  tokenLoading.value = true
  importError.value = ''
  try {
    const { data } = await workbuddyApi.importToken({
      region: regionStore.current,
      accessToken: tokenForm.accessToken.trim(),
      refreshToken: tokenForm.refreshToken.trim(),
      uid: tokenForm.uid.trim() || undefined,
      nickname: tokenForm.nickname.trim() || undefined,
    })
    if (!data.ok) {
      importError.value = data.error || '导入失败'
      return
    }
    message.success(`已导入账号：${data.account?.nickname || data.account?.uid || ''}`)
    importOpen.value = false
    tokenForm.accessToken = ''
    tokenForm.refreshToken = ''
    tokenForm.uid = ''
    tokenForm.nickname = ''
    await load()
  } catch (e: any) {
    importError.value = e?.response?.data?.error || '导入失败'
  } finally {
    tokenLoading.value = false
  }
}

// 来源标记的人话
const sourceText = (s: string) =>
  s === 'oauth' ? '浏览器登录'
    : s === 'client-import' ? '客户端导入'
      : s === 'manual' ? '手动粘贴' : (s || '—')

// OAuth 设备授权登录（浏览器登录）：生成授权链接 → 打开浏览器 → 每 2 秒轮询，
// 完成即自动导入。多账号 = 换账号后再点一次（浏览器已登录当前账号时用无痕窗口）。
const oauthLoading = ref(false)
const oauthPolling = ref(false)
let oauthTimer: ReturnType<typeof setInterval> | null = null
let oauthState = ''
let oauthRegion: 'cn' | 'intl' = 'cn'

function stopOauth(err = '') {
  if (oauthTimer) { clearInterval(oauthTimer); oauthTimer = null }
  oauthPolling.value = false
  if (err) message.error(err)
}

async function startOauthLogin() {
  if (oauthPolling.value) return
  oauthLoading.value = true
  const region = regionStore.current
  try {
    const { data } = await workbuddyApi.loginUrl(region)
    if (!data.ok || !data.authUrl || !data.state) {
      message.error(data.error || '生成授权链接失败')
      return
    }
    window.open(data.authUrl, '_blank', 'noopener')
    oauthState = data.state
    oauthRegion = region
    oauthPolling.value = true
    message.info('已打开浏览器授权页；完成登录后会自动导入账号')
    const deadline = Date.now() + 10 * 60 * 1000
    oauthTimer = setInterval(async () => {
      if (Date.now() > deadline) { stopOauth('登录窗口已超时，请重新发起'); return }
      try {
        const { data: r } = await workbuddyApi.loginPoll(oauthRegion, oauthState)
        if (r.status === 'ok') {
          stopOauth()
          message.success(`已导入账号：${r.account?.nickname || r.account?.uid || ''}`)
          await load()
        } else if (r.status === 'error' || r.status === 'expired') {
          stopOauth(r.error || r.message || '登录失败')
        }
      } catch (e) { /* 网络抖动忽略，下一轮继续 */ }
    }, 2000)
  } catch (e: any) {
    message.error(e?.response?.data?.error || '生成授权链接失败')
  } finally {
    oauthLoading.value = false
  }
}

// ---- 定时轮询（P2-9）----
// 15 秒静默拉一次 **/status**（不是 /credits，理由见 load() 上方注释）。
// 四条约束：
//   1. **只在 WorkBuddy 页签跑**。这是组件级的定时器，组件随 v-if 销毁即自动
//      停——比在全局 watch 里开关定时器少一处状态。
//   2. **页面不可见时跳过**。后台标签页里的轮询只是给管理端加请求，
//      而账号状态这类数据的时效性以分钟计。
//   3. **切回来立即拉一次**。否则从别的窗口切回来会先看到最多 15 秒的旧数据
//      （连坐倒计时/账号增删恰恰是切回来最想看的）。
//   4. **有弹窗时不轮询**：整表重画会把正在输入的框刷掉内容。
const POLL_MS = 15000
let pollTimer: ReturnType<typeof setInterval> | null = null

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

/** 轮询专用：只读本地状态的 /status，带 credits:false 明确不打上游 */
function pollTick() {
  // 相对时间文案（relTime）与「已过期」判据都要有个会走的「现在」，
  // 否则「额度更新于 3 分钟前」会停在首次渲染那一刻不动
  nowTick.value = Date.now()
  if (typeof document !== 'undefined' && document.hidden) return
  if (importOpen.value || renameOpen.value || proxyOpen.value || groupOpen.value) return
  load({ silent: true, credits: false })
}

function startPoll() {
  stopPoll()
  pollTimer = setInterval(pollTick, POLL_MS)
}

function onVisibility() {
  if (typeof document === 'undefined' || document.hidden) return
  pollTick()
}

// 本页只在 WorkBuddy 通道下有意义；区域切换也重新拉
onMounted(() => {
  if (!isWorkBuddy()) return
  load(); loadAutomation()
  // 繁忙度只在进页面时探一次：它是秒级瞬时的只读探针，轮询它既没意义
  // 又多打上游（与「轮询不刷额度」同一条纪律）。之后由用户点「探测」刷新。
  loadBusy()
  startPoll()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
})
watch(() => channelStore.current, () => {
  if (isWorkBuddy()) { load(); loadAutomation(); loadBusy(); startPoll() } else { stopPoll() }
})
// 切区域要重探：国内有该接口、国际版 404，读数是区域专属的事实
watch(() => regionStore.current, () => {
  if (isWorkBuddy()) { load(); loadAutomation(); loadBusy(true) }
})
onBeforeUnmount(() => {
  stopOauth()
  stopPoll()
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
})
</script>
