<script setup>
/**
 * 分析 › 收益：收益曲线 + 买卖盈亏日历 + 回撤分析 / 回撤事件
 * 由 Analysis.vue（Tab 壳）按页签挂载，卸载即销毁图表实例
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import dayjs from 'dayjs'
import { Calendar, ArrowLeft, ArrowRight } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../../stores/portfolio'
import { drawdown, drawdownEvents, cumulativeRealized } from '../../services/calc'
import { fmtMoney, fmtNum, fmtPct, fmtShares, pnlClass } from '../../utils/format'
import { RANGE_OPTIONS, rangeBounds } from '../../utils/dateRange'
import { createCharts, alpha } from '../../utils/echarts'

const portfolio = usePortfolioStore()

const curveRef = ref(null)
const drawdownRef = ref(null)
const monthlyRef = ref(null)
const yearlyRef = ref(null)

// 本面板自己的图实例池：切换页签卸载时整体销毁
const charts = createCharts()
const initChart = (elRef, key) => charts.get(key, elRef.value)
const resetChart = (key) => charts.release(key)

// ===== 收益曲线 =====
// 口径固定为「累计已实现盈亏」，只按资产类别（股票/基金/可转债）拆分，不含现金与持仓市值
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
  const points = cumulativeRealized(events)
  // 范围起点补一个 0 值点：曲线从 0 起步，否则第一笔直接悬空起跳看着突兀
  if (start && points.length) {
    const from = start.format('YYYY-MM-DD')
    if (points[0].date > from) points.unshift({ date: from, value: 0, dayAmount: 0, count: 0 })
  }
  return points
})

const curveHasData = computed(() => curveData.value.some((p) => Math.abs(p.value) > 0.005))

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
  if (!data.length || !curveHasData.value) {
    chart.clear()
    return
  }
  const meta = curveKindMeta.value
  const c = meta.color
  // 时间轴：横向距离按真实天数，不再是等距类目。
  // 必须带 T00:00:00，否则按 UTC 解析，东八区整体偏一天
  const pts = data.map((d) => [dayjs(d.date + 'T00:00:00').valueOf(), Math.round(d.value * 100) / 100])
  chart.setOption(
    {
      ...commonOption(),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        formatter: (arr) => {
          const p = arr && arr[0]
          if (!p) return ''
          const d = data[p.dataIndex]
          const dayRow =
            d && d.count
              ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px">当日 ${d.count} 笔 合计 ${d.dayAmount >= 0 ? '+' : '-'}¥${fmtNum(Math.abs(d.dayAmount), 0)}</div>`
              : ''
          return (
            `<div style="font-size:11px;color:#94a3b8">${dayjs(p.value[0]).format('YYYY-MM-DD')}</div>` +
            `<div style="font-size:12px">${meta.short} <b>¥${fmtNum(p.value[1], 0)}</b></div>${dayRow}`
          )
        }
      },
      xAxis: {
        type: 'time',
        // 点数多时只显示年-月，避免标签糊成一片
        axisLabel: {
          color: '#94a3b8',
          fontSize: 10,
          hideOverlap: true,
          formatter: (v) => dayjs(v).format(data.length > 90 ? 'YY-MM' : 'MM-DD')
        },
        axisLine: { lineStyle: { color: '#e2e8f0' } }
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#94a3b8', fontSize: 10 },
        splitLine: { lineStyle: { color: '#f1f5f9' } }
      },
      series: [
        {
          name: meta.short,
          type: 'line',
          data: pts,
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { color: c, width: 2.5 },
          itemStyle: { color: c },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: alpha(c, 0.22) },
                { offset: 1, color: alpha(c, 0.02) }
              ]
            }
          }
        }
      ]
    },
    true
  )
}

// ===== 买卖盈亏日历 =====
const calendarDate = ref(dayjs())
// 「日历 / 柱形图」两档；柱形图档内再分月、年
const calView = ref('calendar')
const calMode = ref('month')
const chartMode = ref('month')

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
  return days.reduce((a, d) => a + d.amount, 0)
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

// ===== 点击日历日期：查看当日卖出（已实现盈亏）明细 =====
const showSellDrawer = ref(false)
const selSellDay = ref('')

function openSellDay(dateStr) {
  if (!dailyMap.value[dateStr]) return
  selSellDay.value = dateStr
  showSellDrawer.value = true
}

// 当日明细：与日历格同口径（同一批 realizedEvents），按盈亏金额降序
const sellRows = computed(() => {
  const day = dailyMap.value[selSellDay.value]
  if (!day) return []
  const tradeMap = new Map(portfolio.trades.map((t) => [t.id, t]))
  return day.events
    .map((e) => {
      const t = tradeMap.get(e.id) || {}
      const qty = Number(t.shares) || 0
      const price = Number(t.price) || 0
      const isSell = e.type === 'sell'
      // 由「已实现盈亏 =（卖出价 − 成本价）× 股数 − 费用 − 税费」反推成本价
      const cost = isSell && qty > 0 ? price - (e.amount + (Number(t.fee) || 0) + (Number(t.tax) || 0)) / qty : null
      const pct = cost && cost > 0 && qty > 0 ? (e.amount / (cost * qty)) * 100 : null
      return {
        id: e.id,
        name: e.name || e.code,
        code: e.code,
        market: e.market,
        type: e.type,
        amount: e.amount,
        qty,
        price,
        pct,
        broker: t.broker || ''
      }
    })
    .sort((a, b) => b.amount - a.amount)
})

const sellDayTotal = computed(() => (dailyMap.value[selSellDay.value] || {}).amount || 0)
const sellCount = computed(() => sellRows.value.filter((r) => r.type === 'sell').length)
const divCount = computed(() => sellRows.value.length - sellCount.value)
const sellDayTitle = computed(() => (selSellDay.value ? dayjs(selSellDay.value).format('YYYY年M月D日') : ''))
const sellDrawerTitle = computed(() => {
  if (sellCount.value && divCount.value) return '当日卖出 / 分红明细'
  return sellCount.value ? '当日卖出明细' : '当日分红明细'
})

function signedMoney(v) {
  if (!v) return fmtMoney(0, 0)
  return `${v > 0 ? '+' : ''}${fmtMoney(v, 0)}`
}

// ===== 买卖盈亏日历的柱形图档 =====
function drawMonthly() {
  const chart = initChart(monthlyRef, 'monthly')
  if (!chart) return
  const data = portfolio.monthly
  if (!data.length) {
    chart.clear()
    return
  }
  chart.setOption({
    ...commonOption(),
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + fmtNum(v, 0) },
    xAxis: {
      type: 'category',
      data: data.map((d) => d.month),
      axisLabel: { color: '#94a3b8', fontSize: 10 },
      axisLine: { lineStyle: { color: '#e2e8f0' } }
    },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [
      {
        name: '已实现盈亏',
        type: 'bar',
        data: data.map((d) => Math.round(d.realized * 100) / 100),
        itemStyle: { borderRadius: [4, 4, 0, 0], color: (p) => (p.value >= 0 ? '#dc2626' : '#10b981') },
        label: { show: true, position: 'top', color: '#94a3b8', fontSize: 10 }
      }
    ]
  })
}

function drawYearly() {
  const chart = initChart(yearlyRef, 'yearly')
  if (!chart) return
  const data = portfolio.yearly
  if (!data.length) {
    chart.clear()
    return
  }
  chart.setOption({
    ...commonOption(),
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + fmtNum(v, 0) },
    xAxis: {
      type: 'category',
      data: data.map((d) => d.year + '年'),
      axisLabel: { color: '#94a3b8', fontSize: 10 },
      axisLine: { lineStyle: { color: '#e2e8f0' } }
    },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [
      {
        name: '已实现盈亏',
        type: 'bar',
        data: data.map((d) => Math.round(d.realized * 100) / 100),
        itemStyle: { borderRadius: [4, 4, 0, 0], color: (p) => (p.value >= 0 ? '#dc2626' : '#10b981') },
        label: { show: true, position: 'top', color: '#94a3b8', fontSize: 10 }
      }
    ]
  })
}

// ===== 回撤分析 =====
// 范围页签（自定义档用起止日期），与交易页筛选共用 src/utils/dateRange.js 的口径
const ddRanges = RANGE_OPTIONS
const ddRange = ref('1m')
const ddCustomStart = ref('')
const ddCustomEnd = ref('')

const ddScope = computed(() => rangeBounds(ddRange.value, ddCustomStart.value, ddCustomEnd.value))

/**
 * 区间内的真实数据点。
 * 净值曲线不是日历每天都打点（见 buildDailyAssets：事件日 + 持仓交易日 + 今天），
 * 所以节假日那几天根本没有点。若起始日当天没有点，要补上起始日之前最近的一个点做基准，
 * 否则「十一」这类长假跨期的下跌会被整个漏掉。
 */
const ddPoints = computed(() => {
  const { start, end } = ddScope.value
  const startKey = start.format('YYYY-MM-DD')
  const pts = portfolio.netValue
  let seed = null
  for (const p of pts) {
    if (p.date <= startKey) seed = p
    else break
  }
  const inRange = pts.filter((p) => {
    const d = dayjs(p.date)
    return !d.isBefore(start, 'day') && !d.isAfter(end, 'day')
  })
  return seed && inRange.length && inRange[0] !== seed ? [seed, ...inRange] : inRange
})

/** 回撤曲线按「日历日」画：非交易日沿用上一日净值，保证「本月」严格从当月 1 号开始 */
const ddFiltered = computed(() => {
  const { start, end } = ddScope.value
  const pts = ddPoints.value
  if (!pts.length) return []
  const from = dayjs(pts[0].date).isAfter(start, 'day') ? dayjs(pts[0].date) : start
  const map = new Map(pts.map((p) => [p.date, p]))
  const out = []
  let last = null
  let d = from
  while (!d.isAfter(end, 'day')) {
    const key = d.format('YYYY-MM-DD')
    const hit = map.get(key)
    if (hit) last = hit
    if (last) out.push(hit || { ...last, date: key })
    d = d.add(1, 'day')
  }
  return out
})

const ddStats = computed(() => drawdown(ddFiltered.value))

// 多次回撤事件：忽略小于该值（绝对值百分比）的波动，避免把四舍五入级别的抖动也列出来
// 事件只落在真实数据点上，避免把节假日标成峰/谷
const DD_MIN_PCT = 0.1
const DD_MARK_MAX = 5 // 曲线上最多标几个序号
const ddEvents = computed(() => drawdownEvents(ddPoints.value, { minPct: DD_MIN_PCT }))
const ddMarks = computed(() => ddEvents.value.slice(0, DD_MARK_MAX))

function drawDrawdown() {
  const chart = initChart(drawdownRef, 'drawdown')
  if (!chart) return
  const data = ddFiltered.value
  if (!data.length) {
    chart.clear()
    return
  }
  let peak = data[0].netValue
  const ddSeries = data.map((d) => {
    if (d.netValue > peak) peak = d.netValue
    return peak > 0 ? ((d.netValue - peak) / peak) * 100 : 0
  })
  const values = ddSeries.map((v) => Math.round(v * 100) / 100)
  // 事件谷底处标序号圆点：用数据下标定位，避免跨年时 MM-DD 重名
  const marks = ddMarks.value
    .map((e, i) => {
      const idx = data.findIndex((d) => d.date === e.troughDate)
      if (idx < 0) return null
      return { coord: [idx, values[idx]], value: i + 1 }
    })
    .filter(Boolean)
  chart.setOption({
    ...commonOption(),
    tooltip: { trigger: 'axis', valueFormatter: (v) => fmtNum(v, 2) + '%' },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: data.map((d) => d.date.slice(5)),
      axisLabel: { color: '#94a3b8', fontSize: 10 }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#94a3b8', fontSize: 10, formatter: (v) => v + '%' },
      splitLine: { lineStyle: { color: '#f1f5f9' } }
    },
    series: [
      {
        name: '回撤',
        type: 'line',
        data: values,
        smooth: false,
        symbol: 'none',
        lineStyle: { color: '#dc2626', width: 2 },
        itemStyle: { color: '#dc2626' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(220,38,38,0.22)' },
              { offset: 1, color: 'rgba(220,38,38,0.02)' }
            ]
          }
        },
        markPoint: {
          symbol: 'circle',
          symbolSize: 18,
          itemStyle: { color: '#dc2626', borderColor: '#fff', borderWidth: 1 },
          label: { show: true, position: 'inside', color: '#fff', fontSize: 11, fontWeight: 600, formatter: (p) => String(p.data.value) },
          data: marks
        }
      }
    ]
  })
}

// 收益曲线：切换类别 / 市场 / 时间范围后重绘
watch([curveKind, curveMarket, curveRange], async () => {
  await nextTick()
  drawCurve()
})

// 日历卡片切到柱形图档（或档内切月/年）时容器会重建，需重建图表实例
watch([calView, chartMode], async () => {
  await nextTick()
  if (calView.value !== 'chart') return
  if (chartMode.value === 'month') {
    resetChart('monthly')
    drawMonthly()
  } else {
    resetChart('yearly')
    drawYearly()
  }
})

watch(ddRange, drawDrawdown)
// 自定义起止日期变化后重算（开始晚于结束时自动对调，保证区间有效）
watch([ddCustomStart, ddCustomEnd], ([s, e]) => {
  if (s && e && dayjs(s).isAfter(dayjs(e))) {
    ddCustomStart.value = e
    ddCustomEnd.value = s
  }
  drawDrawdown()
})

// 数据到位后重绘（本面板挂载期间）
watch(
  () => [portfolio.monthly.length, portfolio.yearly.length, portfolio.netValue.length, portfolio.realizedEvents.length],
  () => {
    drawVisible()
    drawDrawdown()
  }
)

function drawVisible() {
  drawCurve()
  if (calView.value === 'chart') {
    if (chartMode.value === 'month') drawMonthly()
    else drawYearly()
  }
}

function onResize() {
  charts.resizeAll()
}

onMounted(async () => {
  await nextTick()
  drawVisible()
  drawDrawdown()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  charts.disposeAll()
})
</script>

<template>
  <div>
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
            <span v-for="w in ['日', '一', '二', '三', '四', '五', '六']" :key="w">{{ w }}</span>
          </div>
          <div class="calendar-grid">
            <div
              v-for="d in calendarGrid"
              :key="d.format('YYYY-MM-DD')"
              class="calendar-cell"
              :class="{
                muted: !d.isSame(calendarDate, 'month'),
                today: d.isSame(dayjs(), 'day'),
                clickable: !!dailyMap[d.format('YYYY-MM-DD')]
              }"
              @click="openSellDay(d.format('YYYY-MM-DD'))"
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
        >
          <el-icon v-if="r.icon" :size="12"><Calendar /></el-icon>
          {{ r.label }}
        </span>
      </div>
      <!-- 自定义区间：起止日期 -->
      <div v-if="ddRange === 'custom'" class="dd-custom">
        <el-date-picker
          v-model="ddCustomStart"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="开始日期"
          size="small"
          class="dd-date"
        />
        <span class="muted">→</span>
        <el-date-picker
          v-model="ddCustomEnd"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="结束日期"
          size="small"
          class="dd-date"
        />
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

    <!-- 回撤事件：随所选区间变化，按跌幅从大到小排序 -->
    <div class="card">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">回撤事件</div>
        <span class="muted">跌幅 ≥ {{ DD_MIN_PCT }}% · {{ ddEvents.length }} 次</span>
      </div>
      <div v-if="ddEvents.length" class="dd-events">
        <div v-for="(e, i) in ddEvents" :key="e.peakDate + e.troughDate" class="dd-event">
          <div class="dd-badge">{{ i + 1 }}</div>
          <div class="dd-event-main">
            <div class="row between">
              <span class="num down dd-pct">{{ fmtPct(e.dropPct) }}</span>
              <span class="dd-range-text">{{ e.peakDate }} → {{ e.troughDate }}</span>
            </div>
            <div class="muted dd-sub">
              下跌 {{ e.dropDays }} 天 ·
              {{ e.recovered ? `已于 ${e.recoveryDate} 修复（${e.recoveryDays} 天）` : '尚未修复' }}
            </div>
          </div>
        </div>
      </div>
      <div v-else class="muted" style="text-align: center; padding: 12px">
        <template v-if="ddStats.maxDrawdownPct !== 0">
          该区间最大回撤 {{ fmtPct(ddStats.maxDrawdownPct) }}，未达 {{ DD_MIN_PCT }}% 阈值，不单列事件
        </template>
        <template v-else>该区间暂无回撤数据</template>
      </div>
    </div>

    <!-- 点击日历日期：当日卖出明细 -->
    <el-drawer
      v-model="showSellDrawer"
      direction="btt"
      :size="`min(560px, 72vh)`"
      :with-header="false"
    >
      <div class="sd-head">
        <span class="sd-date">{{ sellDayTitle }}</span>
        <span class="sd-title">{{ sellDrawerTitle }}</span>
      </div>
      <div class="sd-summary">
        <span class="muted">当日已实现盈亏</span>
        <span class="num sd-total" :class="pnlClass(sellDayTotal)">{{ signedMoney(sellDayTotal) }}</span>
        <span class="sd-sub">
          <template v-if="sellCount">{{ sellCount }} 笔卖出</template>
          <template v-if="sellCount && divCount"> · </template>
          <template v-if="divCount">{{ divCount }} 笔分红</template>
        </span>
      </div>
      <div class="sd-list">
        <div v-for="(it, i) in sellRows" :key="i" class="sd-item">
          <div class="sd-item-main">
            <span class="sd-name">{{ it.name }}</span>
            <span class="sd-sub">
              {{ it.code }}<template v-if="it.broker"> · {{ it.broker }}</template>
            </span>
            <span v-if="it.type === 'sell'" class="sd-sub">卖出 {{ fmtShares(it.qty, it.market) }} 股 @ {{ fmtNum(it.price, 3) }}</span>
            <span v-else class="sd-sub">分红</span>
          </div>
          <div class="sd-item-side">
            <span class="sd-amt num" :class="pnlClass(it.amount)">{{ signedMoney(it.amount) }}</span>
            <span v-if="it.pct !== null" class="sd-sub num">{{ it.pct > 0 ? '+' : '' }}{{ fmtPct(it.pct) }}</span>
          </div>
        </div>
        <div v-if="!sellRows.length" class="sd-empty">当日无明细</div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 12px;
}
.chart {
  height: 300px;
  margin: 4px 0 0;
}
/* 页签放不下时换行显示，不再横向滚动（手机上更容易点全） */
.curve-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
.dd-chip .el-icon {
  margin-right: 2px;
  vertical-align: -1px;
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
/* 有盈亏的日期可点击，展开当日卖出明细 */
.calendar-cell.clickable {
  cursor: pointer;
}
.calendar-cell.clickable:active {
  background: #eef2f7;
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
.dd-tabs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}
/* 自定义区间：起止日期 */
.dd-custom {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.dd-custom .dd-date {
  flex: 1;
  min-width: 0;
}
/* 回撤事件列表 */
.dd-events {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dd-event {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid #f1f5f9;
}
.dd-event:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.dd-badge {
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #dc2626;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dd-event-main {
  flex: 1;
  min-width: 0;
}
.dd-event-main .dd-pct {
  font-size: 14px;
  font-weight: 700;
}
.dd-range-text {
  font-size: 12px;
  color: var(--text-2);
}
.dd-sub {
  margin-top: 2px;
  font-size: 11px;
}
.value {
  font-size: 15px;
  font-weight: 700;
  margin-top: 4px;
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

/* 当日明细抽屉 */
.sd-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}
.sd-date {
  font-size: 15px;
  font-weight: 700;
}
.sd-title {
  font-size: 12px;
  color: var(--text-2);
}
.sd-summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.sd-total {
  font-size: 15px;
  font-weight: 700;
}
.sd-list {
  max-height: 52vh;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.sd-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 0;
  border-bottom: 1px solid #f1f5f9;
}
.sd-item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sd-name {
  font-size: 13px;
  font-weight: 600;
}
.sd-sub {
  font-size: 11px;
  color: var(--text-2);
}
.sd-item-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}
.sd-amt {
  font-size: 13px;
  font-weight: 700;
}
.sd-empty {
  text-align: center;
  color: var(--text-2);
  font-size: 12px;
  padding: 20px 0;
}
</style>
