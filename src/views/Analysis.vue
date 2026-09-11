<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { drawdown, cumulativeRealized } from '../services/calc'
import { fmtMoney, fmtNum, fmtPct, pnlClass } from '../utils/format'

const portfolio = usePortfolioStore()
const calendarDate = ref(dayjs())
// 日历卡片：「日历 / 柱形图」两档；柱形图档内再分月、年
const calView = ref('calendar')
const calMode = ref('month')
const chartMode = ref('month')

// 收益曲线：口径固定为「累计已实现盈亏」，只按资产类别（股票/基金/可转债）拆分，不含现金与持仓市值
const CURVE_KINDS = [
  { key: 'all', label: '累计已实现盈亏', short: '累计已实现盈亏', color: '#dc2626' },
  { key: 'stock', label: '股票', short: '股票累计已实现盈亏', color: '#dc2626' },
  { key: 'fund', label: '基金', short: '基金累计已实现盈亏', color: '#3b82f6' },
  { key: 'bond', label: '可转债', short: '可转债累计已实现盈亏', color: '#f59e0b' }
]
const CURVE_MARKETS = [
  { key: 'all', label: '全部' },
  { key: 'A', label: 'A股' },
  { key: 'HK', label: '港股' },
  { key: 'US', label: '美股' }
]
const CURVE_RANGES = [
  { key: 'ytd', label: '年初至今' },
  { key: '1y', label: '最近一年' },
  { key: 'all', label: '全部' }
]
const curveKind = ref('all')
const curveMarket = ref('all')
const curveRange = ref('all')

const curveRef = ref(null)
const drawdownRef = ref(null)
const monthlyRef = ref(null)
const yearlyRef = ref(null)

const charts = {}

const totalCost = computed(() => portfolio.positions.reduce((a, p) => a + p.avgCost * p.shares * p.rate, 0))

/** 曲线配色：hex -> rgba */
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

const curveKindMeta = computed(() => CURVE_KINDS.find((k) => k.key === curveKind.value) || CURVE_KINDS[0])

// 时间范围起点（null 表示全部）
const curveStart = computed(() => {
  if (curveRange.value === 'ytd') return dayjs().startOf('year')
  if (curveRange.value === '1y') return dayjs().subtract(1, 'year')
  return null
})

// 当前「类别 × 市场 × 时间范围」下的曲线数据
// 口径恒定：累计已实现盈亏（只取产生已实现盈亏的买卖/分红事件），按资产类别与市场筛选
const curveData = computed(() => {
  const kind = curveKind.value
  const mkt = curveMarket.value
  const start = curveStart.value
  const events = portfolio.realizedEvents.filter(
    (e) =>
      (mkt === 'all' || e.market === mkt) &&
      (kind === 'all' || e.asset === kind) &&
      (!start || !dayjs(e.date).isBefore(start, 'day'))
  )
  return cumulativeRealized(events).map((p) => ({ date: p.date, value: p.value }))
})

const curveHasData = computed(() => curveData.value.some((p) => Math.abs(p.value) > 0.005))

function initChart(ref, key) {
  if (!ref.value) return null
  if (!charts[key]) charts[key] = echarts.init(ref.value)
  return charts[key]
}

// 容器随 v-if 销毁后，旧图表实例需一并释放
function resetChart(key) {
  if (charts[key]) {
    charts[key].dispose()
    delete charts[key]
  }
}

function commonOption() {
  return {
    grid: { left: 64, right: 20, top: 28, bottom: 34 },
    xAxis: { type: 'category', axisLabel: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: '#f1f5f9' } } }
  }
}

function drawCurve() {
  const chart = initChart(curveRef, 'curve')
  if (!chart) return
  const data = curveData.value
  if (!data.length || !curveHasData.value) { chart.clear(); return }
  const meta = curveKindMeta.value
  const c = meta.color
  chart.setOption({
    ...commonOption(),
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + fmtNum(v, 0) },
    xAxis: { type: 'category', boundaryGap: false, data: data.map((d) => d.date.slice(5)), axisLabel: { color: '#94a3b8', fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [{
      name: meta.short, type: 'line', data: data.map((d) => Math.round(d.value * 100) / 100),
      smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { color: c, width: 2.5 },
      itemStyle: { color: c },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: alpha(c, 0.22) }, { offset: 1, color: alpha(c, 0.02) }] } }
    }]
  }, true)
}

// 回撤分析：范围页签
const ddRanges = [
  { label: '近一月', key: '1m' },
  { label: '近半年', key: '6m' },
  { label: '年初至今', key: 'ytd' },
  { label: '近三年', key: '3y' },
  { label: '近五年', key: '5y' }
]
const ddRange = ref('1m')

function ddStartOfRange(key) {
  const today = dayjs()
  switch (key) {
    case '1m': return today.subtract(1, 'month')
    case '6m': return today.subtract(6, 'month')
    case 'ytd': return today.startOf('year')
    case '1y': return today.subtract(1, 'year')
    case '3y': return today.subtract(3, 'year')
    case '5y': return today.subtract(5, 'year')
    default: return today.subtract(1, 'month')
  }
}

const ddFiltered = computed(() => {
  const start = ddStartOfRange(ddRange.value)
  return portfolio.netValue.filter((p) => dayjs(p.date).isAfter(start) || dayjs(p.date).isSame(start, 'day'))
})

const ddStats = computed(() => drawdown(ddFiltered.value))

function drawDrawdown() {
  const chart = initChart(drawdownRef, 'drawdown')
  if (!chart) return
  const data = ddFiltered.value
  if (!data.length) { chart.clear(); return }
  let peak = data[0].netValue
  const ddSeries = data.map((d) => {
    if (d.netValue > peak) peak = d.netValue
    return peak > 0 ? ((d.netValue - peak) / peak) * 100 : 0
  })
  chart.setOption({
    ...commonOption(),
    tooltip: { trigger: 'axis', valueFormatter: (v) => fmtNum(v, 2) + '%' },
    xAxis: { type: 'category', boundaryGap: false, data: data.map((d) => d.date.slice(5)), axisLabel: { color: '#94a3b8', fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10, formatter: (v) => v + '%' }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [{
      name: '回撤', type: 'line', data: ddSeries.map((v) => Math.round(v * 100) / 100),
      smooth: false, symbol: 'none', lineStyle: { color: '#dc2626', width: 2 },
      itemStyle: { color: '#dc2626' },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(220,38,38,0.22)' }, { offset: 1, color: 'rgba(220,38,38,0.02)' }] } }
    }]
  })
}

function drawMonthly() {
  const chart = initChart(monthlyRef, 'monthly')
  if (!chart) return
  const data = portfolio.monthly
  if (!data.length) { chart.clear(); return }
  chart.setOption({
    ...commonOption(),
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + fmtNum(v, 0) },
    xAxis: { type: 'category', data: data.map((d) => d.month), axisLabel: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [{
      name: '已实现盈亏', type: 'bar', data: data.map((d) => Math.round(d.realized * 100) / 100),
      itemStyle: { borderRadius: [4, 4, 0, 0], color: (p) => (p.value >= 0 ? '#dc2626' : '#10b981') },
      label: { show: true, position: 'top', color: '#94a3b8', fontSize: 10 }
    }]
  })
}

function drawYearly() {
  const chart = initChart(yearlyRef, 'yearly')
  if (!chart) return
  const data = portfolio.yearly
  if (!data.length) { chart.clear(); return }
  chart.setOption({
    ...commonOption(),
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + fmtNum(v, 0) },
    xAxis: { type: 'category', data: data.map((d) => d.year + '年'), axisLabel: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [{
      name: '已实现盈亏', type: 'bar', data: data.map((d) => Math.round(d.realized * 100) / 100),
      itemStyle: { borderRadius: [4, 4, 0, 0], color: (p) => (p.value >= 0 ? '#dc2626' : '#10b981') },
      label: { show: true, position: 'top', color: '#94a3b8', fontSize: 10 }
    }]
  })
}

// 收益曲线：切换类别 / 市场 / 时间范围后重绘
watch([curveKind, curveMarket, curveRange], async () => { await nextTick(); drawCurve() })

// 日历卡片切到柱形图档（或档内切月/年）时容器会重建，需重建图表实例
watch([calView, chartMode], async () => {
  await nextTick()
  if (calView.value !== 'chart') return
  if (chartMode.value === 'month') { resetChart('monthly'); drawMonthly() }
  else { resetChart('yearly'); drawYearly() }
})

watch(ddRange, drawDrawdown)

function drawVisible() {
  drawCurve()
  if (calView.value === 'chart') {
    if (chartMode.value === 'month') drawMonthly()
    else drawYearly()
  }
}

watch(
  () => [portfolio.monthly.length, portfolio.yearly.length, portfolio.netValue.length, portfolio.realizedEvents.length],
  () => { drawVisible(); drawDrawdown() }
)

function onResize() { Object.values(charts).forEach((c) => c && c.resize()) }

onMounted(async () => {
  await nextTick()
  drawVisible()
  drawDrawdown()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); Object.values(charts).forEach((c) => c && c.dispose()) })

// 日历
const calendarGrid = computed(() => {
  const start = calendarDate.value.startOf('month')
  const end = calendarDate.value.endOf('month')
  const days = []
  let cursor = start.startOf('week')
  while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
    days.push(cursor)
    cursor = cursor.add(1, 'day')
  }
  return days
})

const dailyMap = computed(() => {
  const map = {}
  for (const d of portfolio.dailyPnl) map[d.date] = d
  return map
})

const monthChange = computed(() => {
  const days = portfolio.dailyPnl.filter((d) => d.date.startsWith(calendarDate.value.format('YYYY-MM')))
  const sum = days.reduce((a, d) => a + d.amount, 0)
  return sum
})

// 本年累计已实现盈亏
const yearChange = computed(() => {
  const days = portfolio.dailyPnl.filter((d) => d.date.startsWith(calendarDate.value.format('YYYY')))
  return days.reduce((a, d) => a + d.amount, 0)
})

// 某日期之前最近一条净资产（作为变动百分比基准）
function baseNetBefore(dateStr) {
  let base = null
  for (const n of portfolio.netValue) {
    if (n.date < dateStr) base = n.netValue
    else break
  }
  return base
}

// 本月变动百分比（基准：月初前一交易日净资产）
const monthChangePct = computed(() => {
  const first = calendarDate.value.startOf('month').format('YYYY-MM-DD')
  const base = baseNetBefore(first)
  if (!base) return null
  return (monthChange.value / base) * 100
})

// 本年变动百分比（基准：年初前一交易日净资产）
const yearChangePct = computed(() => {
  const first = calendarDate.value.startOf('year').format('YYYY-MM-DD')
  const base = baseNetBefore(first)
  if (!base) return null
  return (yearChange.value / base) * 100
})

// 年模式：当年 1-12 月数据（金额 + 当月百分比）
const yearMonths = computed(() => {
  const year = calendarDate.value.format('YYYY')
  const map = {}
  for (const d of portfolio.dailyPnl) {
    if (d.date.startsWith(year)) {
      const k = d.date.slice(5, 7)
      map[k] = (map[k] || 0) + d.amount
    }
  }
  return Array.from({ length: 12 }, (_, i) => {
    const k = String(i + 1).padStart(2, '0')
    const amount = map[k] || 0
    const first = `${year}-${k}-01`
    const base = baseNetBefore(first)
    return { key: k, label: `${i + 1}月`, amount, pct: base ? (amount / base) * 100 : null }
  })
})

// 某天盈亏百分比（基准：该日前最近净资产）
function dayPct(dateStr) {
  const d = dailyMap.value[dateStr]
  if (!d) return null
  const base = baseNetBefore(dateStr)
  if (!base) return null
  return (d.amount / base) * 100
}

function prevMonth() { calendarDate.value = calendarDate.value.subtract(1, 'month') }
function nextMonth() { calendarDate.value = calendarDate.value.add(1, 'month') }
function prevYear() { calendarDate.value = calendarDate.value.subtract(1, 'year') }
function nextYear() { calendarDate.value = calendarDate.value.add(1, 'year') }
</script>

<template>
  <div>
    <div class="page-header">
      <div class="page-title">分析</div>
    </div>

    <!-- 成本与盈亏 -->
    <div class="card">
      <div class="section-title">成本与盈亏</div>
      <div class="metric-grid">
        <div>
          <div class="muted">成本</div>
          <div class="num value">{{ fmtMoney(totalCost, 0) }}</div>
        </div>
        <div>
          <div class="muted">资产总金额</div>
          <div class="num value">{{ fmtMoney(portfolio.totals.totalAssets, 0) }}</div>
        </div>
        <div>
          <div class="muted">已实现盈亏</div>
          <div class="num value" :class="pnlClass(portfolio.totals.totalRealized)">
            {{ portfolio.totals.totalRealized > 0 ? '+' : '' }}{{ fmtMoney(portfolio.totals.totalRealized, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">浮动盈亏</div>
          <div class="num value" :class="pnlClass(portfolio.totals.floating)">
            {{ portfolio.totals.floating > 0 ? '+' : '' }}{{ fmtMoney(portfolio.totals.floating, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">盈亏</div>
          <div class="num value" :class="pnlClass(portfolio.totals.totalPnl)">
            {{ portfolio.totals.totalPnl > 0 ? '+' : '' }}{{ fmtMoney(portfolio.totals.totalPnl, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">浮动盈亏率</div>
          <div class="num value" :class="pnlClass(portfolio.totals.totalPnl)">
            {{ portfolio.totals.totalPnlPct === null ? '—' : (portfolio.totals.totalPnlPct > 0 ? '+' : '') + fmtPct(portfolio.totals.totalPnlPct) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 收益曲线：类别 × 市场 × 时间范围 -->
    <div class="card">
      <div class="section-title">收益曲线</div>
      <div class="curve-tabs">
        <span
          v-for="k in CURVE_KINDS"
          :key="k.key"
          class="curve-chip"
          :class="{ active: curveKind === k.key }"
          @click="curveKind = k.key"
        >{{ k.label }}</span>
      </div>
      <div class="curve-tabs" style="margin-top: 8px">
        <span
          v-for="m in CURVE_MARKETS"
          :key="m.key"
          class="dd-chip"
          :class="{ active: curveMarket === m.key }"
          @click="curveMarket = m.key"
        >{{ m.label }}</span>
      </div>
      <div class="curve-tabs" style="margin-top: 6px">
        <span
          v-for="r in CURVE_RANGES"
          :key="r.key"
          class="dd-chip"
          :class="{ active: curveRange === r.key }"
          @click="curveRange = r.key"
        >{{ r.label }}</span>
      </div>
      <div ref="curveRef" class="chart"></div>
      <div v-if="!curveHasData" class="muted" style="text-align: center; padding: 4px 0 8px">暂无数据</div>
    </div>

    <!-- 买卖盈亏日历：日历 / 柱形图 两档 -->
    <div class="card calendar-card">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">买卖盈亏日历</div>
        <div class="pie-switch">
          <span :class="{ active: calView === 'calendar' }" @click="calView = 'calendar'">日历</span>
          <span :class="{ active: calView === 'chart' }" @click="calView = 'chart'">柱形图</span>
        </div>
      </div>

      <template v-if="calView === 'calendar'">
        <!-- 月模式：选择月份 + 本月变动 + 日历 -->
        <template v-if="calMode === 'month'">
          <div class="calendar-nav">
            <div class="nav-side">
              <div class="nav-item">
                <el-icon @click="prevYear"><ArrowLeft /></el-icon>
                <span class="nav-year">{{ calendarDate.format('YYYY年') }}</span>
                <el-icon @click="nextYear"><ArrowRight /></el-icon>
              </div>
            </div>
            <div class="pie-switch">
              <span :class="{ active: calMode === 'month' }" @click="calMode = 'month'">月</span>
              <span :class="{ active: calMode === 'year' }" @click="calMode = 'year'">年</span>
            </div>
            <div class="nav-side right">
              <div class="nav-item">
                <el-icon @click="prevMonth"><ArrowLeft /></el-icon>
                <span class="nav-month">{{ calendarDate.format('M月') }}</span>
                <el-icon @click="nextMonth"><ArrowRight /></el-icon>
              </div>
            </div>
          </div>
          <div class="row between" style="margin-bottom: 12px">
            <div>
              <span class="muted">本月变动</span>
              <span class="num" style="margin-left: 8px" :class="pnlClass(monthChange)">
                {{ monthChange > 0 ? '+' : '' }}{{ fmtMoney(monthChange, 0) }}
              </span>
              <span v-if="monthChangePct !== null" class="num" style="margin-left: 6px" :class="pnlClass(monthChangePct)">
                {{ monthChangePct > 0 ? '+' : '' }}{{ fmtPct(monthChangePct) }}
              </span>
            </div>
            <div>
              <span class="muted">本年变动</span>
              <span class="num" style="margin-left: 8px" :class="pnlClass(yearChange)">
                {{ yearChange > 0 ? '+' : '' }}{{ fmtMoney(yearChange, 0) }}
              </span>
              <span v-if="yearChangePct !== null" class="num" style="margin-left: 6px" :class="pnlClass(yearChangePct)">
                {{ yearChangePct > 0 ? '+' : '' }}{{ fmtPct(yearChangePct) }}
              </span>
            </div>
          </div>
          <div class="calendar-header">
            <span v-for="w in ['日','一','二','三','四','五','六']" :key="w">{{ w }}</span>
          </div>
          <div class="calendar-grid">
            <div
              v-for="d in calendarGrid"
              :key="d.format('YYYY-MM-DD')"
              class="calendar-cell"
              :class="{ muted: !d.isSame(calendarDate, 'month'), today: d.isSame(dayjs(), 'day') }"
            >
              <div class="cell-date">{{ d.date() }}</div>
              <template v-if="dailyMap[d.format('YYYY-MM-DD')]">
                <div class="cell-pnl num" :class="pnlClass(dailyMap[d.format('YYYY-MM-DD')].amount)">
                  {{ dailyMap[d.format('YYYY-MM-DD')].amount > 0 ? '+' : '' }}{{ fmtNum(dailyMap[d.format('YYYY-MM-DD')].amount, 0) }}
                </div>
                <div v-if="dayPct(d.format('YYYY-MM-DD')) !== null" class="cell-pct num" :class="pnlClass(dayPct(d.format('YYYY-MM-DD')))">
                  {{ dayPct(d.format('YYYY-MM-DD')) > 0 ? '+' : '' }}{{ fmtPct(dayPct(d.format('YYYY-MM-DD'))) }}
                </div>
              </template>
            </div>
          </div>
        </template>

        <!-- 年模式：选择年份 + 本年变动 + 全年每月数据 -->
        <template v-else>
          <div class="calendar-nav">
            <div class="nav-side">
              <div class="nav-item">
                <el-icon @click="prevYear"><ArrowLeft /></el-icon>
                <span class="nav-year">{{ calendarDate.format('YYYY年') }}</span>
                <el-icon @click="nextYear"><ArrowRight /></el-icon>
              </div>
            </div>
            <div class="pie-switch">
              <span :class="{ active: calMode === 'month' }" @click="calMode = 'month'">月</span>
              <span :class="{ active: calMode === 'year' }" @click="calMode = 'year'">年</span>
            </div>
            <div class="nav-side right"></div>
          </div>
          <div class="row" style="justify-content: flex-end; margin-bottom: 12px">
            <div>
              <span class="muted">本年变动</span>
              <span class="num" style="margin-left: 8px" :class="pnlClass(yearChange)">
                {{ yearChange > 0 ? '+' : '' }}{{ fmtMoney(yearChange, 0) }}
              </span>
              <span v-if="yearChangePct !== null" class="num" style="margin-left: 6px" :class="pnlClass(yearChangePct)">
                {{ yearChangePct > 0 ? '+' : '' }}{{ fmtPct(yearChangePct) }}
              </span>
            </div>
          </div>
          <div class="year-grid">
            <div
              v-for="m in yearMonths"
              :key="m.key"
              class="year-cell"
              :class="{ today: m.key === dayjs().format('MM') && calendarDate.isSame(dayjs(), 'year') }"
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
      </template>

      <!-- 柱形图档：月 / 年 -->
      <template v-else>
        <div class="pie-switch seg">
          <span :class="{ active: chartMode === 'month' }" @click="chartMode = 'month'">月</span>
          <span :class="{ active: chartMode === 'year' }" @click="chartMode = 'year'">年</span>
        </div>
        <template v-if="chartMode === 'month'">
          <div ref="monthlyRef" class="chart"></div>
          <div v-if="portfolio.monthly.length">
            <el-table :data="portfolio.monthly" size="small">
              <el-table-column prop="month" label="月份" width="100" />
              <el-table-column label="已实现盈亏">
                <template #default="{ row }">
                  <span :class="pnlClass(row.realized)" class="num">¥{{ fmtNum(row.realized, 0) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="其中分红"><template #default="{ row }"><span class="num">¥{{ fmtNum(row.div, 0) }}</span></template></el-table-column>
              <el-table-column label="笔数" prop="count" width="70" />
            </el-table>
          </div>
        </template>
        <template v-else>
          <div ref="yearlyRef" class="chart"></div>
          <div v-if="portfolio.yearly.length">
            <el-table :data="portfolio.yearly" size="small">
              <el-table-column prop="year" label="年份" width="90" />
              <el-table-column label="已实现盈亏">
                <template #default="{ row }">
                  <span :class="pnlClass(row.realized)" class="num">¥{{ fmtNum(row.realized, 0) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="其中分红"><template #default="{ row }"><span class="num">¥{{ fmtNum(row.div, 0) }}</span></template></el-table-column>
              <el-table-column label="笔数" prop="count" width="70" />
            </el-table>
          </div>
        </template>
      </template>
    </div>

    <!-- 回撤分析 -->
    <div class="card">
      <div class="section-title" style="margin-bottom: 12px">回撤分析</div>
      <div class="dd-tabs">
        <span
          v-for="r in ddRanges"
          :key="r.key"
          class="dd-chip"
          :class="{ active: ddRange === r.key }"
          @click="ddRange = r.key"
        >{{ r.label }}</span>
      </div>
      <div class="row between" style="margin: 10px 0 6px">
        <div>
          <div class="muted">最大回撤</div>
          <div class="num value" :class="ddStats.maxDrawdownPct !== 0 ? 'down' : 'flat'">
            {{ ddStats.maxDrawdownPct !== 0 ? fmtPct(ddStats.maxDrawdownPct) : '—' }}
          </div>
        </div>
        <div style="text-align: right">
          <div class="muted">当前回撤</div>
          <div class="num value" :class="Math.abs(ddStats.currentDrawdownPct) < 0.005 ? 'flat' : 'down'">
            {{ ddFiltered.length >= 2 ? (Math.abs(ddStats.currentDrawdownPct) < 0.005 ? '已修复' : fmtPct(ddStats.currentDrawdownPct)) : '—' }}
          </div>
        </div>
      </div>
      <div ref="drawdownRef" class="chart"></div>
    </div>

    <!-- 最大回撤事件 -->
    <div class="card">
      <div class="section-title" style="margin-bottom: 12px">最大回撤事件</div>
      <div v-if="ddFiltered.length >= 2 && ddStats.maxDrawdownPct !== 0" class="event-grid">
        <div>
          <div class="muted">百分比</div>
          <div class="num down">{{ fmtPct(ddStats.maxDrawdownPct) }}</div>
        </div>
        <div>
          <div class="muted">峰值日期</div>
          <div class="num">{{ ddStats.peakDate || '—' }}</div>
        </div>
        <div>
          <div class="muted">谷底日期</div>
          <div class="num">{{ ddStats.troughDate || '—' }}</div>
        </div>
        <div>
          <div class="muted">下跌历时</div>
          <div class="num">{{ ddStats.days }} 天</div>
        </div>
        <div>
          <div class="muted">修复日期</div>
          <div class="num">{{ ddStats.recovered ? ddStats.recoveryDate : '未修复' }}</div>
        </div>
        <div>
          <div class="muted">修复历时</div>
          <div class="num">{{ ddStats.recovered ? ddStats.recoveryDays + ' 天' : '—' }}</div>
        </div>
      </div>
      <div v-else class="muted" style="text-align: center; padding: 12px">暂无回撤数据</div>
    </div>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 12px;
}
.metric-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 14px 8px;
}
.metric-grid .value {
  font-size: 15px;
  font-weight: 700;
  margin-top: 4px;
}
.curve-tabs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.curve-chip {
  flex-shrink: 0;
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 12px;
  background: #f1f5f9;
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
}
.curve-chip.active {
  background: #fdecec;
  color: #dc2626;
  font-weight: 600;
}
.chart {
  height: 300px;
  margin: 4px 0 0;
}
.calendar-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.nav-side {
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 0;
}
.nav-side.right {
  justify-content: flex-end;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}
.nav-item .el-icon {
  color: var(--text-2);
}
.nav-year {
  font-size: 16px;
  font-weight: 700;
}
.nav-month {
  font-size: 15px;
  font-weight: 700;
  color: var(--primary);
}
.calendar-header {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  color: var(--text-2);
  font-size: 12px;
  margin-bottom: 6px;
}
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.calendar-cell {
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
.calendar-cell.muted {
  opacity: 0.35;
}
.calendar-cell.today {
  border: 1.5px solid var(--primary);
}
.cell-date {
  font-size: 11px;
  line-height: 1.1;
}
.cell-pnl {
  font-size: 10px;
  font-weight: 700;
  margin-top: 1px;
  line-height: 1.1;
  white-space: nowrap;
}
.cell-pct {
  font-size: 8px;
  font-weight: 600;
  margin-top: 1px;
  line-height: 1.1;
  white-space: nowrap;
}
.cell-empty {
  color: #cbd5e1;
  font-size: 11px;
  margin-top: 4px;
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
.year-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.year-cell {
  aspect-ratio: 1.1;
  border-radius: 8px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  padding: 3px 1px;
  overflow: hidden;
}
.year-cell.today {
  border: 1.5px solid var(--primary);
}
.year-cell .cell-pnl {
  font-size: 10px;
}
.year-cell .cell-pct {
  font-size: 8px;
}
.dd-tabs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.dd-chip {
  flex-shrink: 0;
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 12px;
  background: #f1f5f9;
  color: var(--text-2);
  cursor: pointer;
}
.dd-chip.active {
  background: #fdecec;
  color: #dc2626;
  font-weight: 600;
}
.event-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px 8px;
}
.event-grid .num {
  font-size: 13px;
  font-weight: 600;
  margin-top: 2px;
}

/* 盈亏日历：标题「盈亏日历」、日期、星期几保持原字号，其余调小一号 */
.calendar-card .muted {
  font-size: 11px;
}
.calendar-card .num {
  font-size: 13px;
}
.calendar-card .nav-year {
  font-size: 15px;
}
.calendar-card .nav-month {
  font-size: 14px;
}
.calendar-card .pie-switch span {
  font-size: 11px;
}
/* 柱形图档的「月 / 年」：水平居中，档位比右上角「日历 / 柱形图」更宽一点 */
.calendar-card .pie-switch.seg {
  width: fit-content;
  margin: 0 auto 12px;
}
.calendar-card .pie-switch.seg span {
  padding: 4px 22px;
  font-size: 12px;
}
.calendar-card .cell-pnl {
  font-size: 9px;
}
.calendar-card .cell-pct {
  font-size: 7px;
}
.calendar-card .cell-empty {
  font-size: 10px;
}
.calendar-card .year-cell {
  font-size: 10px;
}
.calendar-card .year-cell .cell-pnl {
  font-size: 9px;
}
.calendar-card .year-cell .cell-pct {
  font-size: 7px;
}
</style>
