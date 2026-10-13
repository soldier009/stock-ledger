<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { usePortfolioStore } from '../stores/portfolio'
import { useSettingsStore } from '../stores/settings'
import { fmtMoney, fmtPct, pnlClass, fmtTime, parseTags } from '../utils/format'
import { matchPosition, normKeyword } from '../utils/search'
import PullRefresh from '../components/PullRefresh.vue'
import PositionCard from '../components/PositionCard.vue'
import BatchEditSheet from '../components/BatchEditSheet.vue'

const router = useRouter()

const portfolio = usePortfolioStore()

// 标签分组折叠状态：持久化到 localStorage，记住用户最后保持的展开/折叠
const TAG_FOLD_KEY = 'sl-assets-tagFold'
function loadCollapsed() {
  try {
    const raw = localStorage.getItem(TAG_FOLD_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}
function saveCollapsed() {
  try {
    localStorage.setItem(TAG_FOLD_KEY, JSON.stringify(collapsed.value))
  } catch {
    /* 忽略存储失败（如隐私模式） */
  }
}
const collapsed = ref(loadCollapsed())

const totals = computed(() => portfolio.totals)
const totalCost = computed(() => portfolio.positions.reduce((a, p) => a + p.avgCost * p.shares * p.rate, 0))

// 底部券商行：只显示各账户现金，流水与出入金都在资金账户页操作
const brokerRows = computed(() =>
  portfolio.brokers.map((b) => ({ name: b, balance: (totals.value.brokerCash || {})[b] || 0 }))
)
// 券商分组的折叠状态与标签分组同一套交互，单独持久化：记住用户最后的展开/收起
const BROKER_FOLD_KEY = 'sl-assets-brokerFold'
function loadBrokerFold() {
  try {
    return localStorage.getItem(BROKER_FOLD_KEY) === '1'
  } catch {
    return true
  }
}
const brokerCollapsed = ref(loadBrokerFold())
function toggleBroker() {
  brokerCollapsed.value = !brokerCollapsed.value
  try {
    localStorage.setItem(BROKER_FOLD_KEY, brokerCollapsed.value ? '1' : '0')
  } catch {
    /* 忽略存储失败（如隐私模式） */
  }
}

// 持仓查找：名称 / 代码 / 标签 / 用途 / 券商
const keyword = ref('')
const searching = computed(() => !!normKeyword(keyword.value))
const matched = computed(() =>
  portfolio.positions.filter((p) => matchPosition(keyword.value, p, parseTags))
)

// 持仓明细按标签分组（同一标签放一起），无标签归入「未分类」
const groups = computed(() => {
  const map = new Map()
  const uncat = []
  for (const p of matched.value) {
    // 资产类别标签是单选：只取第一个，避免同一持仓被计入多个分组、各分组市值之和大于总市值
    const t = parseTags(p.tag)[0] || ''
    if (!t) {
      uncat.push(p)
      continue
    }
    if (!map.has(t)) map.set(t, [])
    map.get(t).push(p)
  }
  const summarize = (items) => {
    const mv = items.reduce((a, p) => a + (p.mvCny || 0), 0)
    const cost = items.reduce((a, p) => a + p.avgCost * p.shares * p.rate, 0)
    const pnlPct = cost > 0 ? ((mv - cost) / cost) * 100 : null
    return { mv, pnlPct }
  }
  const arr = []
  for (const [tag, items] of map) arr.push({ tag, items, ...summarize(items) })
  arr.sort((a, b) => a.tag.localeCompare(b.tag))
  if (uncat.length) arr.push({ tag: '', items: uncat, ...summarize(uncat) })
  return arr
})

function toggleGroup(tag) {
  const key = tag || ''
  // 以 isCollapsed 取反：未点过的组默认折叠，第一次点击即可展开
  collapsed.value = { ...collapsed.value, [key]: !isCollapsed(key) }
  saveCollapsed()
}
function isCollapsed(tag) {
  // 正在查找时一律展开，否则命中的持仓藏在折叠组里等于没搜到
  if (searching.value) return false
  const key = tag || ''
  // 默认折叠；点过的标签保持其最后状态，刷新/重开页面后依然有效
  return key in collapsed.value ? collapsed.value[key] : true
}

async function onRefresh() {
  await portfolio.refreshQuotes(false)
  if (portfolio.quoteError) {
    ElMessage.warning('部分行情获取失败，请检查网络')
  }
}

// ===== 批量管理模式：多选 + 批量改标签 / 用途 / 券商 =====
const settings = useSettingsStore()
const batchMode = ref(false)
const batchVisible = ref(false)
// 选中集合：key = market:code
const selected = ref(new Set())
const selectedList = computed(() =>
  portfolio.positions.filter((p) => selected.value.has(`${p.market}:${p.code}`))
)
// 选中集合里涉及的交易条数，以及可连带迁移的「初始建仓」入金条数（ref_id 指向这些交易）
const impact = computed(() => {
  const keys = selected.value
  let trades = 0
  let flows = 0
  for (const t of portfolio.trades) {
    if (!keys.has(`${t.market}:${t.code}`)) continue
    trades += 1
  }
  const tradeIds = new Set(
    portfolio.trades.filter((t) => keys.has(`${t.market}:${t.code}`)).map((t) => t.id)
  )
  for (const c of portfolio.cashFlows) {
    if (c.ref_id && tradeIds.has(c.ref_id)) flows += 1
  }
  return { trades, flows }
})

function toggleSelect(p) {
  const key = `${p.market}:${p.code}`
  const next = new Set(selected.value)
  next.has(key) ? next.delete(key) : next.add(key)
  selected.value = next
}
// 全选作用于「当前筛选结果」：先搜再全选，不必逐行点
function selectVisible() {
  const next = new Set(selected.value)
  for (const p of matched.value) next.add(`${p.market}:${p.code}`)
  selected.value = next
}
function exitBatch() {
  batchMode.value = false
  selected.value = new Set()
}

// 批量写入前自动留一份备份：配了 GitHub 就上传，没配只能提示先导出
async function backupBeforeBatch() {
  if (!settings.isGithubReady) {
    ElMessage.warning('未配置 GitHub 同步，无法自动备份；批量修改不可撤销，建议先到设置页导出备份')
    return
  }
  const ok = await settings.backupNow(true)
  if (ok) ElMessage.success('已先备份当前数据到云端')
  else ElMessage.warning(`云端备份失败：${settings.backupError || '未知原因'}，本次修改仍会执行`)
}

const applying = ref(false)
async function applyBatch(patch) {
  const targets = selectedList.value.map((p) => ({ market: p.market, code: p.code }))
  if (!targets.length) return
  const changed = []
  if (patch.tag !== undefined) changed.push('标签')
  if (patch.purpose !== undefined) changed.push('用途')
  if (patch.broker) changed.push('所属券商')
  try {
    await ElMessageBox.confirm(
      `将修改 ${targets.length} 只标的的${changed.join('、')}。此操作不可撤销，执行前会尝试备份一份。`,
      '批量修改确认',
      { confirmButtonText: '确认修改', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  applying.value = true
  try {
    await backupBeforeBatch()
    const res = await portfolio.bulkUpdateStocks({
      targets,
      patch,
      syncTrades: !!patch.syncTrades,
      syncCash: !!patch.syncCash
    })
    const extra = res.trades || res.flows ? `（连带 ${res.trades} 笔交易、${res.flows} 笔入金）` : ''
    ElMessage.success(`已修改 ${res.stocks} 只标的${extra}`)
    batchVisible.value = false
    exitBatch()
  } catch (e) {
    ElMessage.error(`批量修改失败：${e?.message || e}`)
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <PullRefresh :loading="portfolio.refreshing" @refresh="onRefresh">
    <div class="page-header">
      <div class="page-title">资产</div>
      <div class="row gap8">
        <el-button v-if="batchMode" size="small" @click="exitBatch">退出</el-button>
        <el-button v-else size="small" @click="batchMode = true">批量</el-button>
        <el-button size="small" @click="router.push('/trades')">交易记录</el-button>
        <div class="muted num" v-if="portfolio.lastQuoteAt">
          更新于 {{ fmtTime(portfolio.lastQuoteAt) }}
          <el-icon v-if="portfolio.refreshing" class="spin"><Refresh /></el-icon>
        </div>
      </div>
    </div>

    <!-- 成本与盈亏 -->
    <div class="summary card">
      <div class="section-title">成本与盈亏</div>
      <div class="metric-grid">
        <div>
          <div class="muted">成本</div>
          <div class="num value">{{ fmtMoney(totalCost, 0) }}</div>
        </div>
        <div>
          <div class="muted">资产总金额</div>
          <div class="num value">{{ fmtMoney(totals.totalAssets, 0) }}</div>
        </div>
        <div>
          <div class="muted">已实现盈亏</div>
          <div class="num value" :class="pnlClass(totals.totalRealized)">
            {{ totals.totalRealized > 0 ? '+' : '' }}{{ fmtMoney(totals.totalRealized, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">浮动盈亏</div>
          <div class="num value" :class="pnlClass(totals.floating)">
            {{ totals.floating > 0 ? '+' : '' }}{{ fmtMoney(totals.floating, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">盈亏</div>
          <div class="num value" :class="pnlClass(totals.totalPnl)">
            {{ totals.totalPnl > 0 ? '+' : '' }}{{ fmtMoney(totals.totalPnl, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">浮动盈亏率</div>
          <div class="num value" :class="pnlClass(totals.totalPnl)">
            {{ totals.totalPnlPct === null ? '—' : (totals.totalPnlPct > 0 ? '+' : '') + fmtPct(totals.totalPnlPct) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 持仓明细（按标签分组） -->
    <div v-if="portfolio.positions.length" class="holdings-search">
      <el-input v-model="keyword" size="small" placeholder="搜持仓：名称 / 代码 / 标签 / 用途" clearable>
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <div v-if="searching" class="row between" style="margin-top: 6px">
        <span class="muted num">命中 {{ matched.length }} / {{ portfolio.positions.length }} 只</span>
        <span class="clear-link" @click="keyword = ''">清空</span>
      </div>
      <!-- 批量模式：全选作用于当前筛选结果，可先搜再全选 -->
      <div v-if="batchMode" class="row between batch-tools">
        <span class="muted">已选 {{ selectedList.length }} 只</span>
        <span class="row gap8">
          <span class="clear-link" @click="selectVisible">全选当前 {{ matched.length }} 只</span>
          <span class="clear-link" @click="selected = new Set()">清空选择</span>
        </span>
      </div>
    </div>
    <div v-if="groups.length">
      <div class="group-section" v-for="g in groups" :key="g.tag || '__uncat__'">
        <div class="group-header" @click="toggleGroup(g.tag)">
          <el-icon :class="{ flip: isCollapsed(g.tag) }"><ArrowDown /></el-icon>
          <span class="group-name">{{ g.tag || '未分类' }}</span>
          <span class="group-count">{{ g.items.length }} 只</span>
          <span class="group-stats">
            <span class="group-stat"><span class="muted">市值</span> <span class="num">{{ fmtMoney(g.mv, 0) }}</span></span>
            <span class="group-stat"><span class="muted">盈亏率</span> <span class="num" :class="pnlClass(g.pnlPct)">{{ g.pnlPct === null ? '—' : (g.pnlPct > 0 ? '+' : '') + fmtPct(g.pnlPct) }}</span></span>
          </span>
        </div>
        <template v-if="!isCollapsed(g.tag)">
          <PositionCard
            v-for="p in g.items"
            :key="p.market + ':' + p.code"
            :p="p"
            :selectable="batchMode"
            :selected="selected.has(p.market + ':' + p.code)"
            @toggle-select="toggleSelect(p)"
          />
        </template>
      </div>
    </div>
    <div v-else-if="searching" class="empty-tip">
      <div class="icon"><el-icon :size="40"><Search /></el-icon></div>
      <div>没有匹配「{{ keyword.trim() }}」的持仓</div>
      <div class="clear-link" style="margin-top: 8px" @click="keyword = ''">清空</div>
    </div>
    <div v-else class="empty-tip">
      <div class="icon"><el-icon :size="40"><Box /></el-icon></div>
      <div>暂无持仓</div>
      <div class="muted">点击右下角按钮，新增股票或券商账户</div>
    </div>

    <!-- 券商：与上方股票分组同款折叠，展开后显示各账户现金 -->
    <div v-if="!batchMode" class="card broker-bar">
      <div class="group-header" @click="toggleBroker">
        <el-icon :class="{ flip: brokerCollapsed }"><ArrowDown /></el-icon>
        <span class="group-name">券商</span>
        <span class="group-count">{{ brokerRows.length }} 个</span>
        <span class="group-stats">
          <span class="group-stat">
            <span class="muted">现金</span>
            <span class="num">{{ fmtMoney(totals.cash, 0) }}</span>
          </span>
        </span>
      </div>
      <template v-if="!brokerCollapsed">
        <div class="broker-list">
          <div
            v-for="b in brokerRows"
            :key="b.name"
            class="broker-line"
            @click.stop="router.push('/cash')"
          >
            <span class="chip-name">{{ b.name }}</span>
            <span class="chip-cash num" :class="{ down: b.balance < 0 }">{{ fmtMoney(b.balance, 2) }}</span>
          </div>
        </div>
        <div class="broker-more" @click.stop="router.push('/cash')">
          <span>资金流水与出入金</span>
          <el-icon :size="14"><ArrowRight /></el-icon>
        </div>
      </template>
    </div>
  </PullRefresh>

  <!-- 新增资产（股票建仓 / 券商账户）统一入口；普通记账在交易记录页与股票详情页 -->
  <div v-if="!batchMode" class="fab">
    <el-button type="primary" circle size="large" @click="router.push('/add-asset')" title="新增资产">
      <el-icon :size="22"><Plus /></el-icon>
    </el-button>
  </div>

  <!-- 批量操作条 -->
  <div v-if="batchMode" class="batch-bar">
    <span class="batch-count">已选 {{ selectedList.length }} 只</span>
    <el-button size="small" :disabled="!selectedList.length" @click="batchVisible = true">
      批量修改
    </el-button>
  </div>

  <BatchEditSheet
    v-model="batchVisible"
    :count="selectedList.length"
    :brokers="portfolio.brokers"
    :impact-trades="impact.trades"
    :impact-flows="impact.flows"
    @apply="applyBatch"
  />
</template>

<style scoped>
.holdings-search {
  padding: 0 16px 8px;
}
.batch-tools {
  margin-top: 8px;
}
.batch-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(60px + env(safe-area-inset-bottom));
  z-index: 95;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 auto;
  max-width: 520px;
  padding: 10px 16px;
  background: #fff;
  border-top: 1px solid var(--border);
  box-shadow: 0 -4px 14px rgba(15, 23, 42, 0.08);
}
.batch-count {
  font-size: 13px;
  font-weight: 600;
}
.clear-link {
  font-size: 12px;
  color: var(--primary);
  cursor: pointer;
}
.spin {
  animation: spin 1s linear infinite;
  margin-left: 4px;
  vertical-align: -2px;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.summary {
  padding-top: 16px;
  padding-bottom: 16px;
}
.section-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 12px;
}
.muted {
  font-size: 11px;
}
.empty-tip {
  font-size: 13px;
}
:deep(.el-button--small) {
  font-size: 11px;
}
/* 底部券商分组：与上方股票分组同款折叠，展开后显示各账户现金 */
.broker-bar {
  padding: 4px 0 6px;
}
/* 一个券商一行，避免横向挤压看不全 */
.broker-list {
  margin: 2px 0 6px;
}
.broker-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 14px;
  border-top: 1px solid var(--border, #f1f5f9);
  cursor: pointer;
}
.broker-line:active {
  background: var(--bg);
}
.broker-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--primary);
  cursor: pointer;
}
.chip-name {
  font-size: 13px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-cash {
  flex: none;
  font-weight: 700;
  font-size: 14px;
}
.group-section {
  margin-bottom: 12px;
}
.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  cursor: pointer;
  user-select: none;
}
.group-header .el-icon {
  color: var(--text-2);
  transition: transform 0.2s;
  font-size: 14px;
}
.group-header .flip {
  transform: rotate(-90deg);
}
.group-name {
  font-size: 14px;
  font-weight: 700;
}
.group-count {
  font-size: 10px;
  color: var(--text-2);
  background: var(--bg);
  border-radius: 10px;
  padding: 1px 7px;
}
.group-stats {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}
.group-stat {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
}
.group-stat .num {
  font-size: 11px;
  font-weight: 700;
}
.metric-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 14px 8px;
}
.metric-grid .value {
  font-size: 14px;
  font-weight: 700;
  margin-top: 4px;
}
.fab {
  position: fixed;
  right: max(16px, calc((100vw - 520px) / 2 + 16px));
  bottom: calc(76px + env(safe-area-inset-bottom));
  z-index: 90;
  box-shadow: 0 4px 16px rgba(15, 157, 120, 0.4);
  border-radius: 50%;
}
</style>
