<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { Calendar, ArrowRight } from '@element-plus/icons-vue'
import { drawdown, drawdownEvents, cumulativeRealized, NO_TAG } from '../services/calc'
import { fmtMoney, fmtNum, fmtPct, fmtShares, pnlClass } from '../utils/format'
import { RANGE_OPTIONS, rangeBounds } from '../utils/dateRange'
import { buildPnlRows, sumRows, hasForeignRealized } from '../utils/pnl'
import { INDEX_LIST } from '../services/indexes'
import { getKv, setKv } from '../db'
import { createCharts, alpha } from '../utils/echarts'
import DonutChart from '../components/DonutChart.vue'

const portfolio = usePortfolioStore()
const router = useRouter()
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

// 资产曲线：大类（全部 / 按标签 / 按股票）× 小类 × 时间范围
// 口径固定为「逐日持仓市值（不含现金）」，估值用当日收盘价（缺行情时回退成本价）
const ASSET_DIMS = [
  { key: 'all', label: '全部' },
  { key: 'tag', label: '按标签' },
  { key: 'stock', label: '按股票' }
]
const ASSET_RANGES = [
  { key: 'all', label: '全部' },
  { key: '1y', label: '近一年' }
]
const MARKET_SERIES = [
  { key: 'A', label: 'A股', color: '#dc2626' },
  { key: 'HK', label: '港股', color: '#f59e0b' },
  { key: 'US', label: '美股', color: '#3b82f6' }
]
const TAG_COLORS = ['#dc2626', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#06b6d4']
const OTHER_TAG = '__other__'
// 标签过多时只画市值前 N 个，其余合并为「其他」，避免图形过碎
const MAX_TAG_SERIES = 6
const assetDim = ref('all')
const assetSub = ref('all')
const assetRange = ref('all')

const curveRef = ref(null)
const assetRef = ref(null)
const drawdownRef = ref(null)
const monthlyRef = ref(null)
const yearlyRef = ref(null)

// 多张图各自一个 key；容器被 v-if 销毁时用 charts.release(key) 释放
const charts = createCharts()
// 容器随 v-if 销毁后，旧图表实例需一并释放
const initChart = (elRef, key) => charts.get(key, elRef.value)
const resetChart = (key) => charts.release(key)

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

// ===== 资产曲线 =====

const assetStart = computed(() => (assetRange.value === '1y' ? dayjs().subtract(1, 'year') : null))

const assetRows = computed(() => {
  const start = assetStart.value
  return (portfolio.assetSeries || []).filter((p) => !start || !dayjs(p.date).isBefore(start, 'day'))
})

/** 收集时间范围内出现过的分组键 */
function collectGroupKeys(rows, dim) {
  const keys = new Set()
  for (const p of rows) {
    const g = (dim === 'tag' ? p.byTag : p.byMarket) || {}
    for (const [k, v] of Object.entries(g)) if ((v || 0) > 0.005) keys.add(k)
  }
  return keys
}

// 分组键：市场按 A / 港股 / 美股 固定顺序；标签按最新一天市值降序
const assetGroupKeys = computed(() => {
  const rows = assetRows.value
  if (assetDim.value === 'all' || !rows.length) return []
  if (assetDim.value === 'stock') {
    const keys = collectGroupKeys(rows, 'stock')
    return MARKET_SERIES.filter((m) => keys.has(m.key)).map((m) => m.key)
  }
  const last = rows[rows.length - 1].byTag || {}
  return [...collectGroupKeys(rows, 'tag')].sort((a, b) => (last[b] || 0) - (last[a] || 0))
})

const assetTagKeys = computed(() => {
  const keys = assetGroupKeys.value
  if (assetDim.value !== 'tag') return { top: keys, rest: [] }
  return { top: keys.slice(0, MAX_TAG_SERIES), rest: keys.slice(MAX_TAG_SERIES) }
})

// 小类选项：随大类变化，第一项恒为「全部」
const assetSubOptions = computed(() => {
  const opts = [{ key: 'all', label: '全部' }]
  if (assetDim.value === 'stock') {
    for (const k of assetGroupKeys.value) {
      const m = MARKET_SERIES.find((x) => x.key === k)
      opts.push({ key: k, label: m ? m.label : k })
    }
  } else if (assetDim.value === 'tag') {
    const { top, rest } = assetTagKeys.value
    for (const k of top) opts.push({ key: k, label: k === NO_TAG ? '未分类' : k })
    if (rest.length) opts.push({ key: OTHER_TAG, label: '其他' })
  }
  return opts
})

function r2(v) {
  return Math.round((Number(v) || 0) * 100) / 100
}

// 当前选择下的曲线数据：小类选「全部」时多组堆叠，选具体项时只画该组
const assetChart = computed(() => {
  const rows = assetRows.value
  const dates = rows.map((p) => p.date)
  if (!rows.length) return { dates: [], series: [] }
  const dim = assetDim.value
  const sub = assetSub.value
  if (dim === 'all') {
    return { dates, series: [{ name: '持仓市值', color: '#dc2626', data: rows.map((p) => r2(p.marketValue)) }] }
  }
  if (dim === 'stock') {
    const keys = assetGroupKeys.value.filter((k) => sub === 'all' || k === sub)
    return {
      dates,
      series: keys.map((k) => {
        const m = MARKET_SERIES.find((x) => x.key === k) || { label: k, color: '#64748b' }
        return { name: m.label, color: m.color, data: rows.map((p) => r2((p.byMarket || {})[k] || 0)) }
      })
    }
  }
  const { top, rest } = assetTagKeys.value
  const keys = sub === 'all' ? top : [sub]
  return {
    dates,
    series: keys.map((k) => {
      const isOther = k === OTHER_TAG
      const idx = Math.max(0, top.indexOf(k))
      return {
        name: isOther ? '其他' : k === NO_TAG ? '未分类' : k,
        color: isOther ? '#94a3b8' : TAG_COLORS[idx % TAG_COLORS.length],
        data: rows.map((p) => {
          const g = p.byTag || {}
          if (isOther) return r2(rest.reduce((a, kk) => a + (g[kk] || 0), 0))
          return r2(g[k] || 0)
        })
      }
    })
  }
})

const assetHasData = computed(() => assetChart.value.series.some((s) => s.data.some((v) => Math.abs(v) > 0.005)))

// 纵轴贴着曲线画才能看清波动：上下都按振幅的 8% 留一点空隙
//（曲线很平时按量级的 1%），既不留大片空白，也不会让极值贴在轴上。
function bounds(vals) {
  let mn = Infinity
  let mx = -Infinity
  for (const v of vals) {
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    if (n < mn) mn = n
    if (n > mx) mx = n
  }
  if (mn === Infinity) return null
  const range = mx - mn
  return { mn, mx, pad: range > 0 ? range * 0.08 : Math.max(Math.abs(mx) * 0.01, 1) }
}
function axisMin(vals, dec = 0) {
  const b = bounds(vals)
  if (!b) return null
  const p = Math.pow(10, dec)
  return Math.floor((b.mn - b.pad) * p) / p
}
function axisMax(vals, dec = 0) {
  const b = bounds(vals)
  if (!b) return null
  const p = Math.pow(10, dec)
  return Math.ceil((b.mx + b.pad) * p) / p
}

// 各组是独立曲线（不堆叠），上下限取所有曲线的极值
const assetYVals = computed(() => {
  const vals = []
  for (const s of assetChart.value.series) for (const v of s.data || []) if (Number(v) > 0.005) vals.push(Number(v))
  return vals
})
const assetYMin = computed(() => axisMin(assetYVals.value) ?? 0)
const assetYMax = computed(() => axisMax(assetYVals.value))

// ===== 资产曲线的收益对比（大盘指数）=====
// 组合是金额、指数是点位，量纲不同：统一把区间起点归一化为 100，比较的是收益率
const CMP_KEY = 'stock-ledger-cmp-v1'
const compareOn = ref([])
getKv(CMP_KEY)
  .then((v) => {
    if (v && Array.isArray(v.keys)) compareOn.value = v.keys.filter((k) => INDEX_LIST.some((i) => i.key === k))
  })
  .catch(() => {})
function toggleCompare(key) {
  const i = compareOn.value.indexOf(key)
  if (i >= 0) compareOn.value.splice(i, 1)
  else compareOn.value.push(key)
  setKv(CMP_KEY, { keys: compareOn.value.slice() }).catch((e) => console.warn('[分析] 对比选择保存失败', e))
}

// 组合逐日市值（多组独立曲线时取当日合计）
const portfolioValues = computed(() => {
  const { series } = assetChart.value
  if (!series.length) return []
  const n = (series[0].data || []).length
  const out = []
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (const s of series) sum += Number(s.data[i]) || 0
    out.push(sum)
  }
  return out
})

// 归一化序列：组合 + 选中的指数，均以区间第一个有效值为 100
const compareSeries = computed(() => {
  const { dates } = assetChart.value
  if (!dates.length || !compareOn.value.length) return []
  const out = []
  const vals = portfolioValues.value
  const pIdx = vals.findIndex((v) => v > 0.005)
  if (pIdx >= 0) {
    const base = vals[pIdx]
    out.push({
      name: '我的持仓',
      color: '#dc2626',
      width: 2.5,
      data: vals.map((v) => (base ? Math.round((v / base) * 10000) / 100 : null))
    })
  }
  const cache = (portfolio.indexCache && portfolio.indexCache.byKey) || {}
  for (const key of compareOn.value) {
    const meta = INDEX_LIST.find((i) => i.key === key)
    const days = (cache[key] && cache[key].days) || []
    if (!meta || !days.length) continue
    // 三地交易日历不同：缺失日沿用上一交易日收盘
    let ptr = -1
    const filled = dates.map((d) => {
      while (ptr + 1 < days.length && days[ptr + 1][0] <= d) ptr++
      return ptr >= 0 ? days[ptr][1] : null
    })
    const first = filled.findIndex((v) => v !== null && v > 0)
    if (first < 0) continue
    const base = filled[first]
    out.push({
      name: meta.name,
      color: meta.color,
      width: 1.6,
      data: filled.map((v) => (v == null ? null : Math.round((v / base) * 10000) / 100))
    })
  }
  return out
})

const compareMode = computed(() => compareOn.value.length > 0 && compareSeries.value.length > 1)

// 对比曲线上下限：取所有归一化序列的极值，与资产曲线口径一致
const compareYVals = computed(() => {
  const vals = []
  for (const s of compareSeries.value) {
    for (const v of s.data || []) {
      if (v !== null && v !== undefined && !Number.isNaN(v)) vals.push(Number(v))
    }
  }
  return vals
})
const compareYMin = computed(() => axisMin(compareYVals.value, 2))
const compareYMax = computed(() => axisMax(compareYVals.value, 2))

// 该指数是否已取到日K（未取到时在开关上标注「无数据」）
function hasIndex(key) {
  const cache = (portfolio.indexCache && portfolio.indexCache.byKey) || {}
  return !!((cache[key] && cache[key].days) || []).length
}

/**
 * 底部图例会随条目多少自动换行，行数不定；写死 bottom 会让图例压到日期刻度上。
 * 按「名称总宽 ÷ 容器宽」估算行数，再据此加大 grid.bottom。
 */
function legendLines(names, el) {
  const w = (el && el.clientWidth) || 340
  let used = 0
  for (const n of names) used += String(n).length * 11 + 30
  return Math.max(1, Math.ceil(used / Math.max(140, w - 20)))
}

function drawCompareCurve() {
  const chart = initChart(assetRef, 'asset')
  if (!chart) return
  const { dates } = assetChart.value
  const series = compareSeries.value
  if (!dates.length || !series.length) {
    chart.clear()
    return
  }
  const pct = (v) => (v === null || v === undefined ? '' : (v - 100 >= 0 ? '+' : '') + (v - 100).toFixed(1) + '%')
  chart.setOption(
    {
      ...commonOption(),
      grid: { left: 52, right: 16, top: 24, bottom: 22 + legendLines(series.map((s) => s.name), assetRef.value) * 20 },
      legend: {
        data: series.map((s) => s.name),
        bottom: 4,
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 10,
        textStyle: { fontSize: 10, color: '#64748b' }
      },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const arr = Array.isArray(params) ? params : [params]
          if (!arr.length) return ''
          return [arr[0].axisValueLabel, ...arr.map((p) => `${p.marker}${p.seriesName}　${pct(p.value)}`)].join(
            '<br/>'
          )
        }
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: dates.map((d) => d.slice(5)),
        axisLabel: { color: '#94a3b8', fontSize: 10 },
        axisLine: { lineStyle: { color: '#e2e8f0' } }
      },
      yAxis: {
        type: 'value',
        min: compareYMin.value === null ? undefined : compareYMin.value,
        max: compareYMax.value === null ? undefined : compareYMax.value,
        axisLabel: { color: '#94a3b8', fontSize: 10, formatter: (v) => (v - 100 >= 0 ? '+' : '') + (v - 100).toFixed(0) + '%' },
        splitLine: { lineStyle: { color: '#f1f5f9' } }
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'line',
        data: s.data,
        connectNulls: true,
        smooth: true,
        symbol: 'none',
        lineStyle: { color: s.color, width: s.width },
        itemStyle: { color: s.color }
      }))
    },
    true
  )
}

function drawAssetCurve() {
  if (compareMode.value) {
    drawCompareCurve()
    return
  }
  const chart = initChart(assetRef, 'asset')
  if (!chart) return
  const { dates, series } = assetChart.value
  if (!dates.length || !assetHasData.value) { chart.clear(); return }
  const multi = series.length > 1
  // 单条（全部 / 选中某一组）：保留渐变面积填充到轴下限，即「瀑布」效果。
  // 多条（按标签 / 按股票 + 全部）：各画独立曲线，不堆叠、不做面积，
  // 这样每条都在自己的量级上，纵轴贴底也不会把下面几层裁掉。
  const mkSeries = (s) => ({
    name: s.name,
    type: 'line',
    data: s.data,
    smooth: true,
    symbol: 'none',
    lineStyle: { color: s.color, width: multi ? 1.6 : 2.5 },
    itemStyle: { color: s.color },
    ...(multi
      ? {}
      : {
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: alpha(s.color, 0.22) },
                { offset: 1, color: alpha(s.color, 0.02) }
              ]
            }
          }
        })
  })
  chart.setOption({
    ...commonOption(),
    grid: {
      left: 64,
      right: 20,
      top: multi ? 24 : 20,
      // 图例换行几行就留几行的高度，避免压住横轴日期
      bottom: multi ? 22 + legendLines(series.map((s) => s.name), assetRef.value) * 20 : 34
    },
    ...(multi
      ? {
          legend: {
            data: series.map((s) => s.name),
            bottom: 4,
            itemWidth: 10,
            itemHeight: 10,
            itemGap: 10,
            textStyle: { fontSize: 10, color: '#64748b' }
          }
        }
      : {}),
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const arr = Array.isArray(params) ? params : [params]
        if (!arr.length) return ''
        if (multi) {
          const i = arr[0].dataIndex
          let total = 0
          const lines = series.map((s) => {
            const v = Number(s.data[i]) || 0
            total += v
            const dot = `<span style="display:inline-block;margin-right:4px;width:8px;height:8px;border-radius:8px;background:${s.color}"></span>`
            return `${dot}${s.name}　¥${fmtNum(v, 0)}`
          })
          lines.push(`合计　¥${fmtNum(total, 0)}`)
          return [arr[0].axisValueLabel || '', ...lines].join('<br/>')
        }
        return `${arr[0].axisValueLabel || ''}<br/>${arr[0].marker}${arr[0].seriesName}　¥${fmtNum(Number(arr[0].value) || 0, 0)}`
      }
    },
    xAxis: { type: 'category', boundaryGap: false, data: dates.map((d) => d.slice(5)), axisLabel: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
    yAxis: {
      type: 'value',
      min: assetYMin.value,
      max: assetYMax.value === null ? undefined : assetYMax.value,
      axisLabel: {
        color: '#94a3b8',
        fontSize: 10,
        formatter: (v) => (Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '万' : String(Math.round(v)))
      },
      splitLine: { lineStyle: { color: '#f1f5f9' } }
    },
    series: series.map(mkSeries)
  }, true)
}

// 回撤分析：范围页签（自定义档用起止日期）
// 与交易页筛选共用 src/utils/dateRange.js 的口径
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
  if (!data.length) { chart.clear(); return }
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
    xAxis: { type: 'category', boundaryGap: false, data: data.map((d) => d.date.slice(5)), axisLabel: { color: '#94a3b8', fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10, formatter: (v) => v + '%' }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [{
      name: '回撤', type: 'line', data: values,
      smooth: false, symbol: 'none', lineStyle: { color: '#dc2626', width: 2 },
      itemStyle: { color: '#dc2626' },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(220,38,38,0.22)' }, { offset: 1, color: 'rgba(220,38,38,0.02)' }] } },
      markPoint: {
        symbol: 'circle',
        symbolSize: 18,
        itemStyle: { color: '#dc2626', borderColor: '#fff', borderWidth: 1 },
        label: { show: true, position: 'inside', color: '#fff', fontSize: 11, fontWeight: 600, formatter: (p) => String(p.data.value) },
        data: marks
      }
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

// 资产曲线：换大类时小类回到「全部」，随后重绘
watch(assetDim, async () => { assetSub.value = 'all'; await nextTick(); drawAssetCurve() })
watch([assetSub, assetRange], async () => { await nextTick(); drawAssetCurve() })
// 指数开关切换 / 指数数据到位后重绘（归一化模式与金额模式互斥）
watch([compareOn, () => portfolio.indexCache], async () => { await nextTick(); drawAssetCurve() }, { deep: true })

// 日历卡片切到柱形图档（或档内切月/年）时容器会重建，需重建图表实例
watch([calView, chartMode], async () => {
  await nextTick()
  if (calView.value !== 'chart') return
  if (chartMode.value === 'month') { resetChart('monthly'); drawMonthly() }
  else { resetChart('yearly'); drawYearly() }
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

function drawVisible() {
  drawCurve()
  drawAssetCurve()
  if (calView.value === 'chart') {
    if (chartMode.value === 'month') drawMonthly()
    else drawYearly()
  }
}

watch(
  () => [portfolio.monthly.length, portfolio.yearly.length, portfolio.netValue.length, portfolio.assetSeries.length, portfolio.realizedEvents.length],
  () => { drawVisible(); drawDrawdown() }
)

function onResize() { charts.resizeAll() }

onMounted(async () => {
  await nextTick()
  drawVisible()
  drawDrawdown()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); charts.disposeAll() })

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
function signedPct2(v) {
  const n = Number(v) || 0
  return `${n > 0 ? '+' : ''}${fmtPct(n, 2)}`
}

// ===== 成本与盈亏：入口卡片，点进 /pnl 三级详情页 =====
// 口径：成本 = 持仓成本（含已清仓标的的历史买入额），收益率 = 浮动盈亏 ÷ 成本
const pnlRows = computed(() =>
  buildPnlRows(portfolio.positions, portfolio.realizedEvents, portfolio.closedRounds)
)
const pnlSum = computed(() => sumRows(pnlRows.value))
const pnlCostFilled = computed(() => portfolio.positions.filter((p) => Number(p.avgCost) > 0).length)
// 港美股已实现盈亏是交易原币，未折人民币，界面上说明一下
const pnlForeign = computed(() => hasForeignRealized(pnlRows.value))
const pnlSlices = computed(() => {
  const s = pnlSum.value
  const items = [{ name: '成本', value: s.cost, color: '#cbd5e1' }]
  if (s.floating !== 0) {
    items.push({
      name: s.floating > 0 ? '浮动盈利' : '浮动亏损',
      value: Math.abs(s.floating),
      color: s.floating > 0 ? '#dc2626' : '#10b981'
    })
  }
  return items
})
</script>

<template>
  <div>
    <div class="page-header">
      <div class="page-title">分析</div>
    </div>

    <!-- 资产曲线：大类（全部 / 按标签 / 按股票）× 小类 × 时间范围 -->
    <div class="card">
      <div class="section-title">资产曲线</div>
      <div class="curve-tabs">
        <span
          v-for="d in ASSET_DIMS"
          :key="d.key"
          class="curve-chip"
          :class="{ active: assetDim === d.key }"
          @click="assetDim = d.key"
        >{{ d.label }}</span>
      </div>
      <div v-if="assetDim !== 'all'" class="curve-tabs" style="margin-top: 8px">
        <span
          v-for="o in assetSubOptions"
          :key="o.key"
          class="dd-chip"
          :class="{ active: assetSub === o.key }"
          @click="assetSub = o.key"
        >{{ o.label }}</span>
      </div>
      <div class="curve-tabs" style="margin-top: 6px">
        <span
          v-for="r in ASSET_RANGES"
          :key="r.key"
          class="dd-chip"
          :class="{ active: assetRange === r.key }"
          @click="assetRange = r.key"
        >{{ r.label }}</span>
      </div>
      <!-- 大盘指数对比：选中后曲线切换为「起点 = 100」的收益率对比 -->
      <div class="cmp-row">
        <span class="muted cmp-label">对比</span>
        <span
          v-for="idx in INDEX_LIST"
          :key="idx.key"
          class="dd-chip cmp-chip"
          :class="{ active: compareOn.includes(idx.key), disabled: !hasIndex(idx.key) }"
          :style="compareOn.includes(idx.key) ? { borderColor: idx.color, color: idx.color } : null"
          @click="toggleCompare(idx.key)"
        >
          {{ idx.name }}{{ hasIndex(idx.key) ? '' : '（无数据）' }}
        </span>
      </div>
      <div ref="assetRef" class="chart"></div>
      <div v-if="!assetHasData" class="muted" style="text-align: center; padding: 4px 0 8px">暂无数据</div>
      <div class="muted" style="font-size: 11px; margin-top: 2px">
        {{ compareMode ? '口径：全部归一化到区间起点（收益对比，买入/入金会造成台阶）' : '口径：持仓市值（不含现金），按当日收盘价估值' }}
      </div>
    </div>

    <!-- 成本与盈亏：环形图为中心收益率，右侧四项指标，整卡点进 /pnl -->
    <div class="card" @click="router.push('/pnl')">
      <div class="row between" style="margin-bottom: 6px">
        <div class="section-title">成本与盈亏</div>
        <el-icon class="pnl-arrow"><ArrowRight /></el-icon>
      </div>
      <div class="muted pnl-sub">
        {{ pnlCostFilled }}/{{ portfolio.positions.length }} 项资产已填写成本价
      </div>
      <div class="pnl-body">
        <DonutChart
          :items="pnlSlices"
          center-label="收益率"
          :center-value="signedPct2(pnlSum.returnPct)"
          :center-font-size="15"
          :radius="['54%', '78%']"
          height="140px"
        />
        <div class="pnl-list">
          <div class="pnl-line">
            <span class="pnl-line-label">成本</span>
            <span class="pnl-line-value">{{ fmtMoney(pnlSum.cost, 0) }}</span>
          </div>
          <div class="pnl-line">
            <span class="pnl-line-label">市值</span>
            <span class="pnl-line-value">{{ fmtMoney(pnlSum.mv, 0) }}</span>
          </div>
          <div class="pnl-line">
            <span class="pnl-line-label">浮动盈亏</span>
            <span class="pnl-line-value" :class="pnlClass(pnlSum.floating)">{{ signedMoney(pnlSum.floating) }}</span>
          </div>
          <div class="pnl-line">
            <span class="pnl-line-label">已实现盈亏</span>
            <span class="pnl-line-value" :class="pnlClass(pnlSum.realized)">{{ signedMoney(pnlSum.realized) }}</span>
          </div>
          <div class="pnl-line total">
            <span class="pnl-line-label">合计盈亏</span>
            <span class="pnl-line-value" :class="pnlClass(pnlSum.totalPnl)">{{ signedMoney(pnlSum.totalPnl) }}</span>
          </div>
        </div>
      </div>
      <div v-if="pnlForeign" class="muted pnl-sub" style="margin-top: 6px">
        港美股已实现盈亏按交易原币计，未折人民币
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
      class="sd-drawer"
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
/* 成本与盈亏入口卡 */
.pnl-arrow {
  color: #cbd5e1;
  font-size: 16px;
}
.pnl-sub {
  font-size: 11px;
  margin-bottom: 6px;
}
.pnl-body {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pnl-body :deep(.donut) {
  flex: 0 0 46%;
}
.pnl-list {
  flex: 1;
  min-width: 0;
}
.pnl-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 5px 0;
}
.pnl-line-label {
  font-size: 12px;
  color: var(--text-2, #64748b);
}
.pnl-line-value {
  font-size: 13px;
  font-weight: 600;
}
.pnl-line.total {
  border-top: 1px solid #f1f5f9;
  margin-top: 2px;
}
.pnl-line.total .pnl-line-value {
  font-size: 15px;
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
.dd-chip .el-icon {
  margin-right: 2px;
  vertical-align: -1px;
}
/* 指数对比开关：指数多了自动换行，避免横向滚动看不全 */
.cmp-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.cmp-label {
  flex: none;
  font-size: 11px;
}
.cmp-chip {
  border: 1px solid transparent;
}
.cmp-chip.active {
  background: #fff;
  border-color: #dc2626;
}
.cmp-chip.disabled {
  opacity: 0.55;
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
.calendar-card .year-cell .cell-pct {
  font-size: 7px;
}
</style>

<!--
  抽屉容器样式必须是全局的：el-drawer 会 teleport 到 body，
  它渲染的 .el-drawer 元素不继承父组件的 data-v，scoped 选择器命中不到。
-->
<style>
.sd-drawer {
  left: 0 !important;
  right: 0 !important;
  width: min(420px, 100%) !important;
  max-width: 100% !important;
  margin: 0 auto !important;
  border-radius: 14px 14px 0 0 !important;
  overflow: hidden !important;
}
</style>

