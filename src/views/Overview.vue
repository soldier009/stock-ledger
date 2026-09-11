<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import dayjs from 'dayjs'
import { ArrowLeft, ArrowRight, View, Hide, Loading } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtPct, pnlClass, marketLabel, fmtTime, parseTags } from '../utils/format'
import { holdingDayDetail } from '../services/calc'
import InitPositionForm from '../components/InitPositionForm.vue'
import NetWorthCurve from '../components/NetWorthCurve.vue'

const portfolio = usePortfolioStore()
const showInit = ref(false)
const showCurve = ref(false)
const showMoney = ref(true)
const pieRef = ref(null)
let pieChart = null
const PALETTE = ['#dc2626', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#14b8a6', '#f97316', '#64748b']

const latest = computed(() => {
  const s = portfolio.netValue
  return s.length ? s[s.length - 1] : { netValue: portfolio.totals.totalAssets }
})

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

// 持仓分布：按标签 / 按个股
const pieMode = ref('tag')
const assetMode = ref('total')
const pieData = computed(() => {
  if (pieMode.value === 'tag') {
    const groups = {}
    for (const p of portfolio.positions) {
      const tags = parseTags(p.tag)
      const key = tags.length ? tags[0] : '未分类'
      groups[key] = (groups[key] || 0) + p.mvCny
    }
    return Object.entries(groups)
      .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.value - a.value)
  }
  return portfolio.positions.map((p) => ({ name: p.name || p.code, value: Math.round(p.mvCny * 100) / 100 }))
})

// 资产分布数据
const distributionSegments = computed(() => {
  const total = portfolio.totals.mvTotal
  if (total === 0) return []
  
  let segments = []
  
  if (assetMode.value === 'total') {
    // 总资产分布
    segments = [
      { name: '股票', value: portfolio.totals.stockValue, color: '#dc2626' },
      { name: '基金', value: portfolio.totals.fundValue, color: '#3b82f6' },
      { name: '现金/资产', value: portfolio.totals.cash, color: '#8b5cf6' }
    ]
  } else if (assetMode.value === 'stock') {
    // 股票分布
    const stockPositions = portfolio.positions.filter(p => p.market === 'A' || p.market === 'US')
    const totalStock = stockPositions.reduce((sum, p) => sum + p.mvCny, 0)
    if (totalStock === 0) return []
    
    segments = [
      { name: 'A股', value: stockPositions.filter(p => p.market === 'A').reduce((sum, p) => sum + p.mvCny, 0), color: '#dc2626' },
      { name: '美股', value: stockPositions.filter(p => p.market === 'US').reduce((sum, p) => sum + p.mvCny, 0), color: '#f59e0b' }
    ]
  } else if (assetMode.value === 'fund') {
    // 基金分布
    const fundPositions = portfolio.positions.filter(p => p.market === 'FUND')
    const totalFund = fundPositions.reduce((sum, p) => sum + p.mvCny, 0)
    if (totalFund === 0) return []
    
    segments = [
      { name: '公募基金', value: totalFund, color: '#3b82f6' }
    ]
  } else if (assetMode.value === 'cash') {
    // 现金/资产分布
    segments = [
      { name: '现金', value: portfolio.totals.cash, color: '#8b5cf6' }
    ]
  }
  
  return segments.map(segment => ({
    ...segment,
    width: total > 0 ? Math.round((segment.value / total) * 100) : 0
  }))
})

const distributionItems = computed(() => {
  return distributionSegments.value.map(segment => ({
    ...segment,
    percentage: total > 0 ? Math.round((segment.value / total) * 100) : 0
  }))
}))

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

// 日历数据是否“完整可显示”：
// - 缺整段历史（首次/换设备/失败）时，用状态提示代替数字，避免把残缺数据当成完整结果
// - 仅增量补当天（每日常规刷新）时不阻断，正常显示已有数据
const kCal = computed(() => {
  const p = portfolio
  if (!p.trades.length) return { kind: 'no-data' }
  if (p.klineState === 'missing') return { kind: 'missing', list: p.klineMissing }
  if ((p.klineState === 'syncing' || p.klineState === 'idle') && p.klineBlocking) {
    return { kind: 'loading', total: p.klineTotal, done: p.klineFetched }
  }
  if (p.klineState === 'idle') return { kind: 'loading', total: 0, done: 0 }
  return { kind: 'ok' }
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

// 持仓分布（按标签 / 按个股）
function drawPie() {
  if (!pieRef.value) return
  if (!pieChart) pieChart = echarts.init(pieRef.value)
  const data = pieData.value
  const total = data.reduce((a, b) => a + b.value, 0)
  if (!data.length) { pieChart.clear(); return }
  pieChart.setOption({
    tooltip: { trigger: 'item', formatter: (p) => `${p.name}<br/>¥${fmtNum(p.value, 0)}（${p.percent}%）` },
    graphic: [
      { type: 'text', left: 'center', top: '42%', style: { text: '持仓市值', textAlign: 'center', fill: '#94a3b8', fontSize: 12 } },
      { type: 'text', left: 'center', top: '48%', style: { text: '¥' + fmtNum(total, 0), textAlign: 'center', fill: '#1f2937', fontSize: 18, fontWeight: 700 } }
    ],
    series: [{
      type: 'pie', radius: ['42%', '68%'], center: ['50%', '50%'],
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      label: { color: '#334155', fontSize: 11, formatter: '{b}\n{d}%' },
      color: PALETTE, data
    }]
  })
}

watch(
  [() => portfolio.positions.map((p) => Math.round(p.mvCny)).join(','), pieMode],
  async () => { await nextTick(); drawPie() }
)

function onResize() { pieChart && pieChart.resize() }

onMounted(() => {
  nextTick().then(() => { drawPie() })
  window.addEventListener('resize', onResize)
  // 进入总览时确保持仓行情日历数据最新（幂等，每日最多拉取一次）
  portfolio.syncKlines()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  pieChart && pieChart.dispose()
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
          <el-button type="primary" size="small" round @click="showInit = true">＋ 新建仓</el-button>
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
        <div>
          <div class="muted" style="font-size: 12px">现金</div>
          <div class="num" style="font-size: 16px; font-weight: 700; margin-top: 2px">
            {{ showMoney ? fmtMoney(portfolio.totals.cash, 2) : '¥****' }}
          </div>
        </div>
      </div>
    </div>

    <NetWorthCurve v-model="showCurve" />

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
        <span :class="{ active: assetMode === 'stock' }" @click="assetMode = 'stock'">股票</span>
        <span :class="{ active: assetMode === 'fund' }" @click="assetMode = 'fund'">基金</span>
        <span :class="{ active: assetMode === 'cash' }" @click="assetMode = 'cash'">现金/资产</span>
      </div>
      
      <div class="distribution-bar">
        <div class="bar-segment" 
             v-for="(segment, index) in distributionSegments" 
             :key="index"
             :style="{ backgroundColor: segment.color, width: segment.width + '%' }">
        </div>
      </div>

      <div class="distribution-list">
        <div v-for="(item, index) in distributionItems" :key="index" class="distribution-item">
          <div class="item-dot" :style="{ backgroundColor: item.color }"></div>
          <div class="item-name">{{ item.name }}</div>
          <div class="item-percentage">{{ item.percentage }}%</div>
          <div class="item-amount">¥{{ fmtMoney(item.amount, 0) }}</div>
        </div>
      </div>
    </div>

    <!-- 持仓分布 -->
    <div class="card">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">持仓分布</div>
        <div class="pie-switch">
          <span :class="{ active: pieMode === 'tag' }" @click="pieMode = 'tag'">按标签</span>
          <span :class="{ active: pieMode === 'stock' }" @click="pieMode = 'stock'">按个股</span>
        </div>
      </div>
      <div ref="pieRef" class="pie-chart"></div>
      <div v-if="!portfolio.positions.length" class="muted" style="text-align: center; padding: 20px">暂无持仓数据</div>
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
        <div class="row between" style="margin-bottom: 12px">
          <div>
            <span class="muted">本月变动</span>
            <span class="num h-num" style="margin-left: 6px" :class="pnlClass(hMonth.amount)">
              {{ hMonth.amount > 0 ? '+' : '' }}{{ fmtNum(hMonth.amount, 0) }}
            </span>
            <span v-if="hMonth.pct !== null" class="num h-num" style="margin-left: 6px" :class="pnlClass(hMonth.pct)">
              {{ hMonth.pct > 0 ? '+' : '' }}{{ fmtPct(hMonth.pct) }}
            </span>
          </div>
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

        <div v-if="hasHolding" class="muted h-tip">按当日收盘价估算；分红/送股等除权日可能有偏差</div>
        <div v-else class="muted h-tip">暂无逐日数据（记录买入后，次日起会显示每天的持仓盈亏）</div>
      </template>

      <!-- ===== 数据不齐：补全中 / 缺失可重试 / 暂无数据 ===== -->
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
        <!-- 有股票一直没拉到，明确告知并支持重试 -->
        <div v-else-if="kCal.kind === 'missing'" class="h-status">
          <div class="h-status-title">以下股票的历史价格还没获取到：</div>
          <div class="h-missing-list">{{ kCal.list.map((x) => x.name || x.code).join('、') }}</div>
          <div class="muted" style="margin-top: 4px; line-height: 1.6">
            为避免把不完整的数据当成完整结果，日历暂不显示数字。请检查网络后重试。
          </div>
          <el-button
            size="small"
            type="primary"
            :loading="portfolio.klineSyncing"
            style="margin-top: 12px"
            @click="portfolio.retryKlines()"
          >重试补全</el-button>
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
              <span class="dd-sub">{{ it.shares }}股</span>
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
              <span class="dd-sub">{{ it.shares }}股</span>
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

    <InitPositionForm v-model="showInit" />
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
.pie-chart {
  height: 260px;
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
  height: 24px;
  border-radius: 12px;
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
.item-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}
.item-name {
  flex: 1;
  font-size: 14px;
}
.item-percentage {
  width: 60px;
  text-align: right;
  font-size: 14px;
  font-weight: 600;
}
.item-amount {
  width: 80px;
  text-align: right;
  font-size: 14px;
  font-weight: 600;
}
</style>
