<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtPct, pnlClass, fmtTime, parseTags } from '../utils/format'
import PullRefresh from '../components/PullRefresh.vue'
import PositionCard from '../components/PositionCard.vue'
import TradeForm from '../components/TradeForm.vue'
import CashForm from '../components/CashForm.vue'

const router = useRouter()

const portfolio = usePortfolioStore()
const tradeVisible = ref(false)
const cashVisible = ref(false)
const cashBroker = ref('')
const collapsed = ref({})

function openCash(broker = '') {
  cashBroker.value = broker || ''
  cashVisible.value = true
}

const totals = computed(() => portfolio.totals)
const totalCost = computed(() => portfolio.positions.reduce((a, p) => a + p.avgCost * p.shares * p.rate, 0))

// 资金账户：累计入金 / 出金
const inflow = computed(() =>
  portfolio.cashFlows.filter((c) => c.type === 'deposit').reduce((a, c) => a + Number(c.amount || 0), 0)
)
const outflow = computed(() =>
  portfolio.cashFlows.filter((c) => c.type === 'withdraw').reduce((a, c) => a + Number(c.amount || 0), 0)
)

// 持仓明细按标签分组（同一标签放一起），无标签归入「未分类」
const groups = computed(() => {
  const map = new Map()
  const uncat = []
  for (const p of portfolio.positions) {
    const tags = parseTags(p.tag)
    if (!tags.length) {
      uncat.push(p)
      continue
    }
    for (const t of tags) {
      if (!map.has(t)) map.set(t, [])
      map.get(t).push(p)
    }
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
  collapsed.value[tag || ''] = !collapsed.value[tag || '']
}
function isCollapsed(tag) {
  const key = tag || ''
  // 默认折叠，点击后按显式状态切换
  return key in collapsed.value ? collapsed.value[key] : true
}

async function onRefresh() {
  await portfolio.refreshQuotes(false)
  if (portfolio.quoteError) {
    ElMessage.warning('部分行情获取失败，请检查网络')
  }
}
</script>

<template>
  <PullRefresh :loading="portfolio.refreshing" @refresh="onRefresh">
    <div class="page-header">
      <div class="page-title">资产</div>
      <div class="row gap8">
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

    <!-- 资金账户（按券商分账） -->
    <div class="cash-card card">
      <div class="row between">
        <div class="section-title" style="margin-bottom: 0">资金账户</div>
        <div class="muted" style="font-size: 11px">总可用 {{ fmtMoney(totals.cash, 2) }}</div>
      </div>
      <div class="broker-row" v-for="b in portfolio.brokers" :key="b">
        <div class="flex1">
          <div class="broker-name">{{ b }}</div>
          <div class="broker-cash num">{{ fmtMoney(totals.brokerCash[b] || 0, 2) }}</div>
        </div>
        <el-button size="small" @click="openCash(b)">出入金</el-button>
      </div>
      <div class="divider" style="margin: 12px 0"></div>
      <div class="row between">
        <div class="muted">累计入金 <span class="num up">+{{ fmtNum(inflow, 2) }}</span></div>
        <div class="muted">累计出金 <span class="num down">-{{ fmtNum(outflow, 2) }}</span></div>
      </div>
    </div>

    <!-- 持仓明细（按标签分组） -->
    <div v-if="portfolio.positions.length">
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
          <PositionCard v-for="p in g.items" :key="p.market + ':' + p.code" :p="p" />
        </template>
      </div>
    </div>
    <div v-else class="empty-tip">
      <div class="icon"><el-icon :size="40"><Box /></el-icon></div>
      <div>暂无持仓</div>
      <div class="muted">点击右下角按钮，记录第一笔交易</div>
    </div>
  </PullRefresh>

  <div class="fab">
    <el-button type="primary" circle size="large" @click="tradeVisible = true" title="记一笔">
      <el-icon :size="22"><Plus /></el-icon>
    </el-button>
  </div>

  <TradeForm v-model="tradeVisible" />
  <CashForm v-model="cashVisible" :preset-broker="cashBroker" />
</template>

<style scoped>
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
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 12px;
}
/* 资产页文字整体调小一号 */
.page-title {
  font-size: 19px;
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
.cash-card {
  margin-bottom: 12px;
  padding: 14px;
}
.broker-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 0 6px;
}
.broker-row + .broker-row {
  border-top: 1px solid var(--border, #f1f5f9);
}
.broker-name {
  font-size: 13px;
  font-weight: 600;
}
.broker-cash {
  font-size: 19px;
  font-weight: 700;
  margin-top: 2px;
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
