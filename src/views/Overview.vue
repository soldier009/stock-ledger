<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ArrowLeft, ArrowRight, View, Hide, Loading } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtShares, fmtPct, pnlClass, marketLabel, fmtTime, assetClass, assetClassLabel } from '../utils/format'
import { holdingDayDetail } from '../services/calc'
import { groupBy, PALETTE, CASH_COLOR } from '../utils/composition'
import NetWorthCurve from '../components/NetWorthCurve.vue'
import ClosedRounds from '../components/ClosedRounds.vue'
import DonutChart from '../components/DonutChart.vue'

const portfolio = usePortfolioStore()
const router = useRouter()
const showCurve = ref(false)
const showClosed = ref(false)
const showMoney = ref(true)

const latest = computed(() => portfolio.lastNetPoint)

const todayChange = computed(() => {
  const s = portfolio.netValue
  if (s.length < 2) return { value: 0, pct: 0 }
  const last = s[s.length - 1]
  const prev = s[s.length - 2]
  const v = last.netValue - prev.netValue
  return { value: v, pct: prev.netValue ? (v / prev.netValue) * 100 : 0 }
})

const allocation = computed(() => {
  const groups = {}
  for (const p of portfolio.positions) {
    groups[p.market] = (groups[p.market] || 0) + p.mvCny
  }
  return Object.entries(groups)
    .map(([market, value]) => ({ market, label: marketLabel(market), value }))
    .sort((a, b) => b.value - a.value)
})

const totalAllocation = computed(() => allocation.value.reduce((a, b) => a + b.value, 0))

// 当前持仓成本（与资产页口径一致）
const totalCost = computed(() => portfolio.positions.reduce((a, p) => a + p.avgCost * p.shares * p.rate, 0))

// ===== 资产分布：第一级「市场」，第二级「资产类型」 =====
const assetMode = ref('total') // 'total' 或市场代码 A / HK / US
const MARKET_COLORS = { A: '#dc2626', HK: '#f59e0b', US: '#3b82f6', CASH: '#8b5cf6' }
const CLASS_COLORS = { stock: '#dc2626', fund: '#3b82f6', bond: '#f59e0b', other: '#64748b' }

// 各市场内部的资产类型构成：{ A: { stock: 123, fund: 456 }, ... }
const classByMarket = computed(() => {
  const map = {}
  for (const p of portfolio.positions) {
    const cls = assetClass(p.market, p.code, p.assetType)
    const m = map[p.market] || (map[p.market] = {})
    m[cls] = (m[cls] || 0) + (Number(p.mvCny) || 0)
  }
  return map
})

function toClassRows(classes) {
  return Object.entries(classes || {})
    .filter(([, v]) => v > 0)
    .map(([cls, v]) => ({
      key: cls,
      name: assetClassLabel(cls),
      value: v,
      color: CLASS_COLORS[cls] || CLASS_COLORS.other
    }))
    .sort((a, b) => b.value - a.value)
}

// 有持仓的市场（无持仓的市场不展示）
const marketList = computed(() =>
  ['A', 'HK', 'US']
    .map((m) => {
      const classes = classByMarket.value[m] || {}
      const value = Object.values(classes).reduce((a, b) => a + b, 0)
      return { market: m, label: marketLabel(m), value, classes }
    })
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
)

// 第一级 tab：只列出有持仓的市场
const marketTabs = computed(() => marketList.value.map((m) => ({ key: m.market, label: m.label })))

// 持仓变化导致当前市场消失（如清仓）时，回到总资产视图
watch(marketTabs, (tabs) => {
  if (assetMode.value !== 'total' && !tabs.some((t) => t.key === assetMode.value)) assetMode.value = 'total'
})

// 分布数据：rows 为第一级项，children 为第二级资产类型
const distribution = computed(() => {
  if (assetMode.value === 'total') {
    const rows = marketList.value.map((m) => ({
      key: m.market,
      name: m.label,
      value: m.value,
      color: MARKET_COLORS[m.market] || CLASS_COLORS.other,
      children: toClassRows(m.classes)
    }))
    const cash = Number(portfolio.totals.cash) || 0
    if (cash > 0) rows.push({ key: 'CASH', name: '现金', value: cash, color: MARKET_COLORS.CASH, children: [] })
    return { rows, total: rows.reduce((a, b) => a + b.value, 0) }
  }
  const m = marketList.value.find((x) => x.market === assetMode.value)
  const rows = toClassRows(m ? m.classes : {})
  return { rows, total: m ? m.value : 0 }
})

// 占比：分母为当前视图合计（总资产视图含现金），一级与二级共用，不会出现 NaN
function distPct(value, total) {
  if (!(total > 0)) return '0.0'
  return (((Number(value) || 0) / total) * 100).toFixed(1)
}

// ===== 当日持仓盈亏日历 =====
const hMode = ref('month')
const hDate = ref(dayjs())

const hGrid = computed(() => {
  const start = hDate.value.startOf('month')
  const end = hDate.value.endOf('month')
  const days = []
  let cursor = start.startOf('week')
  while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
    days.push(cursor)
    cursor = cursor.add(1, 'day')
  }
  return days
})

const hMap = computed(() => {
  const map = {}
  for (const d of portfolio.dailyHolding) map[d.date] = d
  return map
})

// 汇总某区间（前缀匹配）浮盈亏金额 + 基准（区间内最早一个交易日的盘前市值）
function sumRange(prefix) {
  let amount = 0
  let firstBase = null
  for (const d of portfolio.dailyHolding) {
    if (!d.date.startsWith(prefix)) continue
    amount += d.amount
    if (firstBase === null && d.base > 0) firstBase = d.base
  }
  return { amount, base: firstBase, pct: firstBase ? (amount / firstBase) * 100 : null }
}

const hMonth = computed(() => sumRange(hDate.value.format('YYYY-MM')))
const hYear = computed(() => sumRange(hDate.value.format('YYYY')))

function hDayPct(dateStr) {
  const d = hMap.value[dateStr]
  if (!d || !d.base) return null
  return (d.amount / d.base) * 100
}

// 年模式：当年 1-12 月数据（金额 + 当月涨跌幅）
const hYearMonths = computed(() => {
  const year = hDate.value.format('YYYY')
  const map = {}
  for (const d of portfolio.dailyHolding) {
    if (!d.date.startsWith(year)) continue
    const k = d.date.slice(5, 7)
    if (!map[k]) map[k] = { amount: 0, base: null }
    map[k].amount += d.amount
    if (map[k].base === null && d.base > 0) map[k].base = d.base
  }
  return Array.from({ length: 12 }, (_, i) => {
    const k = String(i + 1).padStart(2, '0')
    const m = map[k] || { amount: 0, base: null }
    return { key: k, label: `${i + 1}月`, amount: m.amount, pct: m.base ? (m.amount / m.base) * 100 : null }
  })
})

const hasHolding = computed(() => portfolio.dailyHolding.length > 0)

// 日历显示状态。少数标的缺历史价格不再让整块日历不可用：
// 数据层已经只累加能取到行情的标的（缺的自然不计入），所以缺失时照常显示，
// 只在卡片底部说明哪些没算进去；只有缓存里一只数据都没有（首次/换设备/清缓存）
// 时才用进度提示顶替，避免把大片残缺数字当成完整结果。
const kCal = computed(() => {
  const p = portfolio
  if (!p.trades.length) return { kind: 'no-data' }
  if ((p.klineState === 'syncing' || p.klineState === 'idle') && p.klineBlocking) {
    return { kind: 'loading', total: p.klineTotal, done: p.klineFetched }
  }
  if (p.klineState === 'idle') return { kind: 'loading', total: 0, done: 0 }
  // 可重试的缺失 + 数据源本身没有的（后者重试也没用）
  return { kind: 'ok', missing: p.klineMissing, partial: p.klinePartial }
})

function hPrevMonth() { hDate.value = hDate.value.subtract(1, 'month') }
function hNextMonth() { hDate.value = hDate.value.add(1, 'month') }
function hPrevYear() { hDate.value = hDate.value.subtract(1, 'year') }
function hNextYear() { hDate.value = hDate.value.add(1, 'year') }
// 年模式点某月 -> 跳到该月的月历视图
function goMonth(key) {
  hDate.value = dayjs(`${hDate.value.format('YYYY')}-${key}-01`)
  hMode.value = 'month'
}

// ===== 点击日期查看当日持仓盈亏明细 =====
const showDayDrawer = ref(false)
const selDay = ref('')
const ddTab = ref('gain') // 'gain' | 'loss'

function openDay(dateStr) {
  const row = hMap.value[dateStr]
  if (!row || row.amount === 0) return
  selDay.value = dateStr
  // 默认优先显示金额绝对值更大的一边
  ddTab.value = Math.abs(lossTotal.value) > Math.abs(gainTotal.value) ? 'loss' : 'gain'
  showDayDrawer.value = true
}

// 某日明细行。历史日期：与日历同口径（盘前持股 × 收盘涨跌 × 汇率）；
// 今天：与日历“今日”格同口径，用当前持仓的实时行情 (现价 − 昨收) × 持股。
const dayRows = computed(() => {
  const date = selDay.value
  if (!date) return []
  const by = (portfolio.klineCache && portfolio.klineCache.bySymbol) || {}
  const todayStr = dayjs().format('YYYY-MM-DD')
  if (date !== todayStr) return holdingDayDetail(portfolio.trades, by, portfolio.rates, date)
  const rows = []
  for (const p of portfolio.positions) {
    const q = p.quote || null
    const prev = q && q.prevClose
    if (!prev || prev <= 0 || p.dayCny === null) continue
    rows.push({
      market: p.market,
      code: p.code,
      name: p.name || p.code,
      shares: p.shares,
      prevClose: prev,
      close: p.price,
      changePct: (p.price / prev - 1) * 100,
      amount: p.dayCny
    })
  }
  return rows
})
const gainRows = computed(() => dayRows.value.filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount))
const lossRows = computed(() => dayRows.value.filter((x) => x.amount < 0).sort((a, b) => a.amount - b.amount))
const gainTotal = computed(() => gainRows.value.reduce((a, b) => a + b.amount, 0))
const lossTotal = computed(() => lossRows.value.reduce((a, b) => a + b.amount, 0))
const dayTitle = computed(() => (selDay.value ? dayjs(selDay.value).format('YYYY年M月D日') : ''))
// 带符号金额/涨跌幅文本（亏损列传入负数）
function moneyCol(v) {
  if (!v) return '¥0'
  return `${v > 0 ? '+' : '-'}${fmtMoney(Math.abs(v), 0)}`
}
function pctCol(v) {
  if (v === null || v === undefined) return '—'
  return `${v > 0 ? '+' : ''}${fmtPct(v)}`
}

// ===== 资产构成：按资产类别（标签）分组，含现金，点进详情页 =====
const compGroups = computed(() => groupBy(portfolio.positions, 'tag'))
const compCash = computed(() => Number(portfolio.totals?.cash) || 0)
const compTotal = computed(() => Number(portfolio.totals?.totalAssets) || 0)

// 扇区：取占比前 5 个标签，其余合并为「其他 N 个标签」，现金单独一块
const compSlices = computed(() => {
  const g = compGroups.value
  const items = g.slice(0, 5).map((x, i) => ({ name: x.name, value: x.value, color: PALETTE[i % PALETTE.length] }))
  const rest = g.slice(5)
  if (rest.length) {
    items.push({
      name: `其他 ${rest.length} 个标签`,
      value: rest.reduce((a, b) => a + b.value, 0),
      color: '#94a3b8'
    })
  }
  if (compCash.value > 0) items.push({ name: '现金', value: compCash.value, color: CASH_COLOR })
  return items
})

// 列表：展示前 3 个标签，其余折叠为「其他 N 个标签」
const compRows = computed(() => {
  const g = compGroups.value
  const top = g.slice(0, 3)
  const rest = g.slice(3)
  const rows = top.map((x, i) => ({ name: x.name, value: x.value, color: PALETTE[i % PALETTE.length] }))
  if (rest.length) {
    rows.push({ name: `其他 ${rest.length} 个标签`, value: rest.reduce((a, b) => a + b.value, 0), color: '#94a3b8' })
  }
  return rows
})

function compPct(v) {
  if (!(compTotal.value > 0)) return '0.0'
  return (((Number(v) || 0) / compTotal.value) * 100).toFixed(1)
}

onMounted(() => {
  // 进入总览时确保持仓行情日历数据最新（幂等，每日最多拉取一次）
  portfolio.syncKlines()
})
</script>

<template>
  <div>
    <div class="page-header">
      <div class="page-title">总览</div>
    </div>

    <!-- 净资产卡片：简洁第一层 -->
    <div class="card net-worth-card" @click="showCurve = true">
      <div class="row between" style="margin-bottom: 8px; align-items: center">
        <div class="row gap8" @click.stop>
          <span class="section-title">净资产</span>
          <el-button type="primary" size="small" round @click="router.push('/add-asset')">＋ 新增资产</el-button>
        </div>
        <div class="row gap8" style="align-items: center; color: var(--text-2)">
          <el-icon
            :size="18"
            style="cursor: pointer"
            @click.stop="showMoney = !showMoney"
          >
            <View v-if="showMoney" />
            <Hide v-else />
          </el-icon>
          <span class="muted num" style="font-size: 11px">
            {{ portfolio.lastQuoteAt ? '更新于 ' + fmtTime(portfolio.lastQuoteAt) : '' }}
          </span>
          <el-icon :size="18" style="color: #94a3b8"><ArrowRight /></el-icon>
        </div>
      </div>

      <div class="row between" style="align-items: flex-end; margin-bottom: 12px">
        <div class="big-value num">{{ showMoney ? fmtMoney(latest.netValue, 0) : '¥****' }}</div>
        <div style="text-align: right">
          <div class="muted" style="font-size: 12px">今日变化</div>
          <div class="num" :class="pnlClass(todayChange.value)">
            {{ todayChange.value > 0 ? '+' : '' }}{{ fmtMoney(todayChange.value, 0) }}
            ({{ todayChange.value > 0 ? '+' : '' }}{{ fmtPct(todayChange.pct) }})
          </div>
        </div>
      </div>

      <div class="asset-liability">
        <div>
          <div class="muted" style="font-size: 12px">持仓市值</div>
          <div class="num" style="font-size: 16px; font-weight: 700; margin-top: 2px">
            {{ showMoney ? fmtMoney(portfolio.totals.mvTotal, 2) : '¥****' }}
          </div>
        </div>
        <div class="al-divider"></div>
        <!-- 现金可点：进资金账户页看各券商余额与流水 -->
        <div class="cash-cell" @click.stop="router.push('/cash')">
          <div class="muted" style="font-size: 12px">现金</div>
          <div class="row gap8" style="margin-top: 2px">
            <span class="num" style="font-size: 16px; font-weight: 700">
              {{ showMoney ? fmtMoney(portfolio.totals.cash, 2) : '¥****' }}
            </span>
            <el-icon :size="14" style="color: #94a3b8"><ArrowRight /></el-icon>
          </div>
        </div>
      </div>

      <div class="closed-entry" @click.stop="showClosed = true">
        <div class="closed-entry-left">
          <span class="closed-entry-title">已清仓</span>
          <span class="muted" style="font-size: 12px">
            {{ portfolio.closedStat.count }} 笔 · {{ portfolio.closedStat.stockCount }} 只
          </span>
        </div>
        <div class="closed-entry-right">
          <span
            v-if="portfolio.closedStat.count"
            class="num"
            :class="pnlClass(portfolio.closedStat.realized)"
          >{{ portfolio.closedStat.realized > 0 ? '+' : '' }}{{ fmtMoney(portfolio.closedStat.realized, 0) }}</span>
          <el-icon :size="18" style="color: #94a3b8"><ArrowRight /></el-icon>
        </div>
      </div>
    </div>

    <NetWorthCurve v-model="showCurve" />
    <ClosedRounds v-model="showClosed" />

    <!-- 关键指标 -->
    <div class="metrics card">
      <div class="metric-grid">
        <div>
          <div class="muted">成本</div>
          <div class="num value">{{ fmtMoney(totalCost, 0) }}</div>
        </div>
        <div>
          <div class="muted">持仓市值</div>
          <div class="num value">{{ fmtMoney(portfolio.totals.mvTotal, 0) }}</div>
        </div>
        <div>
          <div class="muted">浮动盈亏</div>
          <div class="num value" :class="pnlClass(portfolio.totals.floating)">
            {{ portfolio.totals.floating > 0 ? '+' : '' }}{{ fmtMoney(portfolio.totals.floating, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">已实现盈亏</div>
          <div class="num value" :class="pnlClass(portfolio.totals.totalRealized)">
            {{ portfolio.totals.totalRealized > 0 ? '+' : '' }}{{ fmtMoney(portfolio.totals.totalRealized, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">今日盈亏</div>
          <div class="num value" :class="pnlClass(portfolio.totals.dayPnl)">
            {{ portfolio.totals.dayPnl > 0 ? '+' : '' }}{{ fmtMoney(portfolio.totals.dayPnl, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">收益率</div>
          <div class="num value" :class="pnlClass(portfolio.totals.totalPnl)">
            {{ portfolio.totals.totalPnlPct === null ? '—' : (portfolio.totals.totalPnlPct > 0 ? '+' : '') + fmtPct(portfolio.totals.totalPnlPct) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 资产分布 -->
    <div class="card">
      <div class="section-title" style="margin-bottom: 12px">资产分布</div>
      
      <div class="distribution-tabs">
        <span :class="{ active: assetMode === 'total' }" @click="assetMode = 'total'">总资产</span>
        <span
          v-for="t in marketTabs"
          :key="t.key"
          :class="{ active: assetMode === t.key }"
          @click="assetMode = t.key"
        >{{ t.label }}</span>
      </div>

      <template v-if="distribution.rows.length">
        <div class="distribution-bar">
          <div class="bar-segment"
               v-for="row in distribution.rows"
               :key="row.key"
               :style="{ backgroundColor: row.color, width: distPct(row.value, distribution.total) + '%' }">
          </div>
        </div>

        <div class="distribution-list">
          <template v-for="row in distribution.rows" :key="row.key">
            <div class="distribution-item">
              <div class="item-dot" :style="{ backgroundColor: row.color }"></div>
              <div class="item-name">{{ row.name }}</div>
              <div class="item-percentage">{{ distPct(row.value, distribution.total) }}%</div>
              <div class="item-amount">{{ fmtMoney(row.value, 0) }}</div>
            </div>
            <div v-for="child in row.children" :key="row.key + '-' + child.key" class="distribution-item sub-item">
              <div class="item-dot small" :style="{ backgroundColor: child.color }"></div>
              <div class="item-name sub-name">{{ child.name }}</div>
              <div class="item-percentage">{{ distPct(child.value, distribution.total) }}%</div>
              <div class="item-amount">{{ fmtMoney(child.value, 0) }}</div>
            </div>
          </template>
        </div>
      </template>
      <div v-else class="muted" style="text-align: center; padding: 20px">暂无持仓数据</div>
    </div>

    <!-- 资产构成 -->
    <div class="card" @click="router.push('/composition')">
      <div class="row between" style="margin-bottom: 10px">
        <div class="section-title">资产构成 <span class="comp-dim">· 资产类别</span></div>
        <el-icon class="comp-arrow"><ArrowRight /></el-icon>
      </div>
      <div class="comp-body">
        <DonutChart
          :items="compSlices"
          center-label="总资产"
          :center-value="fmtMoney(compTotal, 0)"
          :center-font-size="13"
          :radius="['58%', '80%']"
          height="110px"
        />
        <div class="comp-list">
          <div v-for="r in compRows" :key="r.name" class="distribution-item">
            <div class="item-dot" :style="{ backgroundColor: r.color }"></div>
            <div class="item-name">{{ r.name }}</div>
            <div class="item-percentage">{{ compPct(r.value) }}%</div>
          </div>
          <div v-if="!compRows.length" class="muted">暂无持仓数据</div>
        </div>
      </div>
    </div>

    <!-- 当日持仓盈亏日历 -->
    <div class="card h-calendar">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">当日持仓盈亏</div>
        <div class="pie-switch">
          <span :class="{ active: hMode === 'month' }" @click="hMode = 'month'">月</span>
          <span :class="{ active: hMode === 'year' }" @click="hMode = 'year'">年</span>
        </div>
      </div>

      <!-- ===== 数据齐全：显示月/年日历 ===== -->
      <template v-if="kCal.kind === 'ok'">
      <!-- 月模式 -->
      <template v-if="hMode === 'month'">
        <div class="calendar-nav">
          <div class="nav-item">
            <el-icon @click="hPrevYear"><ArrowLeft /></el-icon>
            <span class="nav-year">{{ hDate.format('YYYY年') }}</span>
            <el-icon @click="hNextYear"><ArrowRight /></el-icon>
          </div>
          <div class="nav-item">
            <el-icon @click="hPrevMonth"><ArrowLeft /></el-icon>
            <span class="nav-month">{{ hDate.format('M月') }}</span>
            <el-icon @click="hNextMonth"><ArrowRight /></el-icon>
          </div>
        </div>
        <!-- 只留本月变动：同一行再摆「本年变动」会让金额和百分比互相挤压；
             年变动本来就在「年模式」里有，月模式下重复展示没有意义 -->
        <div class="row" style="justify-content: flex-end; margin-bottom: 12px">
          <div>
            <span class="muted">本月变动</span>
            <span class="num h-num" style="margin-left: 6px" :class="pnlClass(hMonth.amount)">
              {{ hMonth.amount > 0 ? '+' : '' }}{{ fmtNum(hMonth.amount, 0) }}
            </span>
            <span v-if="hMonth.pct !== null" class="num h-num" style="margin-left: 6px" :class="pnlClass(hMonth.pct)">
              {{ hMonth.pct > 0 ? '+' : '' }}{{ fmtPct(hMonth.pct) }}
            </span>
          </div>
        </div>
        <div class="calendar-header">
          <span v-for="w in ['日','一','二','三','四','五','六']" :key="w">{{ w }}</span>
        </div>
        <div class="calendar-grid">
          <div
            v-for="d in hGrid"
            :key="d.format('YYYY-MM-DD')"
            class="calendar-cell"
            :class="{
              muted: !d.isSame(hDate, 'month'),
              today: d.isSame(dayjs(), 'day'),
              clickable: !!hMap[d.format('YYYY-MM-DD')]
            }"
            @click="openDay(d.format('YYYY-MM-DD'))"
          >
            <div class="cell-date">{{ d.date() }}</div>
            <template v-if="hMap[d.format('YYYY-MM-DD')] && hMap[d.format('YYYY-MM-DD')].amount !== 0">
              <div class="cell-pnl num" :class="pnlClass(hMap[d.format('YYYY-MM-DD')].amount)">
                {{ hMap[d.format('YYYY-MM-DD')].amount > 0 ? '+' : '' }}{{ fmtNum(hMap[d.format('YYYY-MM-DD')].amount, 0) }}
              </div>
              <div v-if="hDayPct(d.format('YYYY-MM-DD')) !== null" class="cell-pct num" :class="pnlClass(hDayPct(d.format('YYYY-MM-DD')))">
                {{ hDayPct(d.format('YYYY-MM-DD')) > 0 ? '+' : '' }}{{ fmtPct(hDayPct(d.format('YYYY-MM-DD'))) }}
              </div>
            </template>
          </div>
        </div>
      </template>

      <!-- 年模式 -->
      <template v-else>
        <div class="calendar-nav">
          <div class="nav-item">
            <el-icon @click="hPrevYear"><ArrowLeft /></el-icon>
            <span class="nav-year">{{ hDate.format('YYYY年') }}</span>
            <el-icon @click="hNextYear"><ArrowRight /></el-icon>
          </div>
        </div>
        <div class="row" style="justify-content: flex-end; margin-bottom: 12px">
          <div>
            <span class="muted">本年变动</span>
            <span class="num h-num" style="margin-left: 6px" :class="pnlClass(hYear.amount)">
              {{ hYear.amount > 0 ? '+' : '' }}{{ fmtNum(hYear.amount, 0) }}
            </span>
            <span v-if="hYear.pct !== null" class="num h-num" style="margin-left: 6px" :class="pnlClass(hYear.pct)">
              {{ hYear.pct > 0 ? '+' : '' }}{{ fmtPct(hYear.pct) }}
            </span>
          </div>
        </div>
        <div class="year-grid">
          <div
            v-for="m in hYearMonths"
            :key="m.key"
            class="year-cell clickable"
            :class="{ today: m.key === dayjs().format('MM') && hDate.isSame(dayjs(), 'year') }"
            @click="goMonth(m.key)"
          >
            <div class="cell-date">{{ m.label }}</div>
            <template v-if="m.amount !== 0">
              <div class="cell-pnl num" :class="pnlClass(m.amount)">
                {{ m.amount > 0 ? '+' : '' }}{{ fmtNum(m.amount, 0) }}
              </div>
              <div v-if="m.pct !== null" class="cell-pct num" :class="pnlClass(m.pct)">
                {{ m.pct > 0 ? '+' : '' }}{{ fmtPct(m.pct) }}
              </div>
            </template>
            <div v-else class="cell-empty">—</div>
          </div>
        </div>
      </template>

        <!-- 有标的缺历史价格：日历数字只含能取到行情的部分 -->
        <div v-if="kCal.missing.length" class="h-status h-status-inline">
          <div class="h-status-title">以下股票的历史价格还没获取到：</div>
          <div class="h-missing-list">{{ kCal.missing.map((x) => x.name || x.code).join('、') }}</div>
          <div class="muted" style="margin-top: 4px; line-height: 1.6">
            这些股票的盈亏暂未计入日历（上方数字为其余股票的合计），不影响其它数据。
          </div>
          <el-button
            size="small"
            type="primary"
            :loading="portfolio.klineSyncing"
            style="margin-top: 10px"
            @click="portfolio.retryKlines()"
          >补全</el-button>
        </div>

        <!-- 数据源本身没有：重试也不会有，只说明，不给按钮 -->
        <div v-if="kCal.partial.length" class="h-note">
          <div v-for="x in kCal.partial" :key="x.key" class="h-note-item">
            <b>{{ x.name || x.code }}</b>
            <template v-if="x.since">数据源仅有 {{ x.since }} 起的价格</template>
            <template v-else>数据源暂无价格数据</template>
            ，此前盈亏未计入日历
          </div>
        </div>

        <div v-if="hasHolding" class="muted h-tip">按当日收盘价估算；分红/送股等除权日可能有偏差</div>
        <div v-else class="muted h-tip">暂无逐日数据（记录买入后，次日起会显示每天的持仓盈亏）</div>
      </template>

      <!-- ===== 缓存里一只数据都没有：补全中 / 暂无记录 ===== -->
      <template v-else>
        <!-- 首次补全历史价格（换设备/清缓存后） -->
        <div v-if="kCal.kind === 'loading'" class="h-status">
          <el-icon class="is-loading" :size="18"><Loading /></el-icon>
          <span v-if="kCal.total" style="font-weight: 600">正在获取历史行情 {{ kCal.done }}/{{ kCal.total }}…</span>
          <span v-else style="font-weight: 600">正在获取历史行情…</span>
          <div class="muted" style="margin-top: 4px; line-height: 1.6">
            换设备/清缓存后的首次打开，需要把每只股票从最早一笔交易到今天的历史价格补全，<br />请稍候，完成后会自动显示，无需手动操作。
          </div>
        </div>
        <!-- 完全没有任何交易记录 -->
        <div v-else class="muted h-tip">暂无持仓数据，记录买入后这里会显示每天的持仓盈亏</div>
      </template>
    </div>

    <!-- 点击日期查看当日持仓盈亏明细 -->
    <el-drawer
      v-model="showDayDrawer"
      direction="btt"
      :size="`min(640px, 76vh)`"
      :with-header="false"
      class="dd-drawer"
    >
      <div class="dd-head">
        <span class="dd-date">{{ dayTitle }}</span>
        <span class="dd-title">当日持仓盈亏明细</span>
      </div>
      <div class="dd-tabs">
        <div class="dd-tab up" :class="{ active: ddTab === 'gain' }" @click="ddTab = 'gain'">
          <div class="dd-tab-label">盈利金额</div>
          <div class="dd-tab-num up">{{ moneyCol(gainTotal) }}</div>
          <div class="dd-tab-count">{{ gainRows.length }} 只</div>
        </div>
        <div class="dd-tab down" :class="{ active: ddTab === 'loss' }" @click="ddTab = 'loss'">
          <div class="dd-tab-label">亏损金额</div>
          <div class="dd-tab-num down">{{ moneyCol(lossTotal) }}</div>
          <div class="dd-tab-count">{{ lossRows.length }} 只</div>
        </div>
      </div>

      <div class="dd-list-head">
        <span>名称代码</span>
        <span>{{ ddTab === 'gain' ? '盈利额' : '亏损额' }} / 收益率</span>
      </div>

      <div class="dd-list">
        <template v-if="ddTab === 'gain'">
          <div v-for="(it, i) in gainRows" :key="'g' + i" class="dd-item">
            <div class="dd-item-main">
              <span class="dd-name">{{ it.name }}</span>
              <span class="dd-sub">{{ fmtShares(it.shares, it.market) }}股</span>
            </div>
            <div class="dd-item-side">
              <span class="dd-amt up">{{ moneyCol(it.amount) }}</span>
              <span class="dd-sub">{{ pctCol(it.changePct) }}</span>
            </div>
          </div>
          <div v-if="!gainRows.length" class="dd-empty">当日无盈利股票</div>
        </template>
        <template v-else>
          <div v-for="(it, i) in lossRows" :key="'l' + i" class="dd-item">
            <div class="dd-item-main">
              <span class="dd-name">{{ it.name }}</span>
              <span class="dd-sub">{{ fmtShares(it.shares, it.market) }}股</span>
            </div>
            <div class="dd-item-side">
              <span class="dd-amt down">{{ moneyCol(it.amount) }}</span>
              <span class="dd-sub">{{ pctCol(it.changePct) }}</span>
            </div>
          </div>
          <div v-if="!lossRows.length" class="dd-empty">当日无亏损股票</div>
        </template>
      </div>
    </el-drawer>

  </div>
</template>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
}
.big-value {
  font-size: 32px;
  font-weight: 800;
}
.net-worth-card {
  cursor: pointer;
}
.asset-liability {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
}
.asset-liability > div:first-child,
.asset-liability > div:last-child {
  flex: 1;
}
.al-divider {
  width: 1px;
  height: 32px;
  background: #e2e8f0;
}
/* 现金可点：进资金账户页，点卡片其他区域仍是净资产走势 */
.cash-cell {
  cursor: pointer;
}
/* 已清仓记录入口：放在净资产卡片底部，点卡片其他区域仍是净资产走势 */
.closed-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #f1f5f9;
  cursor: pointer;
}
.closed-entry-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.closed-entry-title {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
}
.closed-entry-right {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 700;
}
.closed-entry-right .up {
  color: #dc2626;
}
.closed-entry-right .down {
  color: #10b981;
}
.metrics {
  padding-top: 16px;
  padding-bottom: 16px;
}
.metric-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px 12px;
}
.metric-grid .value {
  font-size: 17px;
  font-weight: 700;
  margin-top: 4px;
}
.alloc-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.alloc-item {
  font-size: 13px;
}
.pie-switch {
  display: flex;
  gap: 4px;
  background: var(--bg, #f1f5f9);
  border-radius: 16px;
  padding: 3px;
}
.pie-switch span {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 14px;
  color: var(--text-2);
  cursor: pointer;
}
.pie-switch span.active {
  background: #fff;
  color: #dc2626;
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

/* ===== 当日持仓盈亏日历 ===== */
.h-calendar .calendar-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.h-calendar .nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}
.h-calendar .nav-item .el-icon {
  color: var(--text-2);
}
.h-calendar .nav-year {
  font-size: 15px;
  font-weight: 700;
}
.h-calendar .nav-month {
  font-size: 14px;
  font-weight: 700;
  color: var(--primary);
}
.h-calendar .calendar-header {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  color: var(--text-2);
  font-size: 11px;
  margin-bottom: 6px;
}
.h-calendar .calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.h-calendar .calendar-cell {
  aspect-ratio: 1 / 0.92;
  border-radius: 8px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  padding: 1px;
  overflow: hidden;
}
.h-calendar .calendar-cell.muted {
  opacity: 0.35;
}
.h-calendar .calendar-cell.today {
  border: 1.5px solid var(--primary);
}
.h-calendar .cell-date {
  font-size: 11px;
  line-height: 1.1;
}
.h-calendar .cell-pnl {
  font-size: 9px;
  font-weight: 700;
  margin-top: 1px;
  line-height: 1.1;
  white-space: nowrap;
}
.h-calendar .cell-pct {
  font-size: 7px;
  font-weight: 600;
  margin-top: 1px;
  line-height: 1.1;
  white-space: nowrap;
}
.h-calendar .cell-empty {
  color: #cbd5e1;
  font-size: 10px;
  margin-top: 4px;
}
.h-calendar .muted {
  font-size: 11px;
}
.h-calendar .h-num {
  font-size: 13px;
}
.h-calendar .year-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.h-calendar .year-cell {
  aspect-ratio: 1.1;
  border-radius: 8px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  padding: 3px 1px;
  overflow: hidden;
}
.h-calendar .year-cell.today {
  border: 1.5px solid var(--primary);
}
.h-calendar .year-cell .cell-pnl {
  font-size: 9px;
}
.h-calendar .year-cell .cell-pct {
  font-size: 7px;
}
.h-calendar .calendar-cell.clickable,
.h-calendar .year-cell.clickable {
  cursor: pointer;
}
.h-calendar .calendar-cell.clickable:hover,
.h-calendar .year-cell.clickable:hover {
  background: #eef2f7;
}
.h-calendar .h-tip {
  margin-top: 10px;
  text-align: center;
}
.h-calendar .h-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 10px;
  color: var(--text-2);
  font-size: 12px;
  text-align: center;
}
.h-calendar .h-status-title {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
}
.h-calendar .h-missing-list {
  color: #dc2626;
  font-size: 13px;
  font-weight: 600;
  word-break: break-all;
  line-height: 1.6;
}
/* 日历照常显示时的缺失提示：不再是整块占位，只占一小条 */
.h-calendar .h-status-inline {
  align-items: flex-start;
  gap: 6px;
  padding: 12px 12px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 10px;
  margin-top: 12px;
}
/* 数据源本身没有的标的：淡灰说明，不提供按钮（重试也不会有） */
.h-calendar .h-note {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.7;
}
.h-calendar .h-note-item {
  word-break: break-all;
}
.h-calendar .h-note-item b {
  color: #475569;
  font-weight: 600;
}
</style>

<style>
/* 底部抽屉：当日持仓盈亏明细（drawer 挂载到 body，需全局样式） */
/* 整体 UI 是 max-width:520px 的手机列；抽屉也要收在同一列宽内居中，避免宽屏下铺满整个浏览器 */
.el-drawer.dd-drawer {
  width: min(100%, 520px) !important;
  left: 0 !important;
  right: 0 !important;
  margin: 0 auto;
}
.dd-drawer .el-drawer__body {
  padding: 16px 18px 22px;
  overflow: hidden;
}
.dd-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
}
.dd-date {
  font-size: 17px;
  font-weight: 800;
  color: #1f2937;
}
.dd-title {
  font-size: 12px;
  color: var(--text-2);
}
.dd-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 12px;
}
.dd-tab {
  position: relative;
  background: #fff;
  border: 1px solid #f1f5f9;
  border-radius: 12px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  overflow: hidden;
}
.dd-tab::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  opacity: 0;
}
.dd-tab.up.active::before {
  background: #dc2626;
  opacity: 1;
}
.dd-tab.down.active::before {
  background: #16a34a;
  opacity: 1;
}
.dd-tab.up.active {
  background: #fff7f8;
  border-color: #fecdd3;
}
.dd-tab.down.active {
  background: #f0fdf4;
  border-color: #bbf7d0;
}
.dd-tab-label {
  font-size: 12px;
  color: var(--text-2);
}
.dd-tab-num {
  font-size: 20px;
  font-weight: 800;
}
.dd-tab-count {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 4px;
  align-self: flex-end;
}
.dd-list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: #94a3b8;
  padding: 0 10px 6px;
}
.dd-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 2px;
  max-height: 46vh;
}
.dd-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-radius: 8px;
  padding: 8px 10px;
}
.dd-item-main,
.dd-item-side {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dd-item-side {
  align-items: flex-end;
}
.dd-name {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
}
.dd-amt {
  font-size: 13px;
  font-weight: 700;
}
.dd-sub {
  font-size: 11px;
  color: #94a3b8;
}
.dd-empty {
  color: #94a3b8;
  font-size: 12px;
  padding: 24px 0;
  text-align: center;
}

/* ===== 资产分布 ===== */
.distribution-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.distribution-tabs span {
  padding: 6px 12px;
  border-radius: 16px;
  font-size: 13px;
  cursor: pointer;
  background: #f1f5f9;
  color: #64748b;
}
.distribution-tabs span.active {
  background: #dc2626;
  color: #fff;
}

.distribution-bar {
  height: 10px;
  border-radius: 5px;
  background: #f1f5f9;
  margin-bottom: 16px;
  overflow: hidden;
}
.bar-segment {
  height: 100%;
  float: left;
}

.distribution-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.distribution-item {
  display: flex;
  align-items: center;
  gap: 12px;
}
.distribution-item.sub-item {
  padding-left: 20px;
}
.item-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}
.item-dot.small {
  width: 8px;
  height: 8px;
}
.item-name {
  flex: 1;
  font-size: 13px;
}
.item-name.sub-name {
  font-size: 12px;
  color: var(--text-2, #64748b);
}
.item-percentage {
  width: 60px;
  text-align: right;
  font-size: 13px;
  font-weight: 600;
}
.item-amount {
  width: 80px;
  text-align: right;
  font-size: 13px;
  font-weight: 600;
}

/* ===== 资产构成入口 ===== */
.comp-body {
  display: flex;
  align-items: center;
  gap: 8px;
}
.comp-body > :first-child {
  width: 110px;
  flex: 0 0 110px;
}
.comp-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.comp-dim {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2, #64748b);
}
.comp-arrow {
  color: #cbd5e1;
  font-size: 14px;
}
</style>
