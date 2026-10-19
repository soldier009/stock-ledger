<script setup>
/**
 * 分析 › 配置：资产曲线 + 成本与盈亏入口
 * 由 Analysis.vue（Tab 壳）按页签挂载，卸载即销毁图表实例
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ArrowRight } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../../stores/portfolio'
import { NO_TAG } from '../../services/calc'
import { fmtMoney, fmtNum, fmtPct, pnlClass } from '../../utils/format'
import { buildPnlRows, sumRows, hasForeignRealized } from '../../utils/pnl'
import { INDEX_LIST } from '../../services/indexes'
import { getKv, setKv } from '../../db'
import { createCharts, alpha } from '../../utils/echarts'
import DonutChart from '../../components/DonutChart.vue'

const portfolio = usePortfolioStore()
const router = useRouter()

// ===== 成本与盈亏：入口卡片，点进 /pnl 三级详情页 =====
// 口径：成本 = 持仓成本（含已清仓标的的历史买入额），收益率 = 浮动盈亏 ÷ 成本
const pnlRows = computed(() => buildPnlRows(portfolio.positions, portfolio.realizedEvents, portfolio.closedRounds))
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
function signedMoney(v) {
  if (!v) return fmtMoney(0, 0)
  return `${v > 0 ? '+' : ''}${fmtMoney(v, 0)}`
}
function signedPct2(v) {
  const n = Number(v) || 0
  return `${n > 0 ? '+' : ''}${fmtPct(n, 2)}`
}

// ===== 资产曲线：大类（全部 / 按标签 / 按股票）× 小类 × 时间范围 =====
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
const assetRef = ref(null)

// 本面板自己的图实例池：切换页签卸载时整体销毁
const charts = createCharts()
const initChart = (elRef, key) => charts.get(key, elRef.value)
const resetChart = (key) => charts.release(key)

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

// 当前选择下的曲线数据：小类选「全部」时多组，选具体项时只画该组
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
          return [arr[0].axisValueLabel, ...arr.map((p) => `${p.marker}${p.seriesName}　${pct(p.value)}`)].join('<br/>')
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
        axisLabel: {
          color: '#94a3b8',
          fontSize: 10,
          formatter: (v) => (v - 100 >= 0 ? '+' : '') + (v - 100).toFixed(0) + '%'
        },
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
  if (!dates.length || !assetHasData.value) {
    chart.clear()
    return
  }
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
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: dates.map((d) => d.slice(5)),
      axisLabel: { color: '#94a3b8', fontSize: 10 },
      axisLine: { lineStyle: { color: '#e2e8f0' } }
    },
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

function commonOption() {
  return {
    grid: { left: 64, right: 20, top: 28, bottom: 34 },
    axisPointer: { label: { show: false } }
  }
}

// 资产曲线：换大类时小类回到「全部」，随后重绘
watch(assetDim, async () => {
  assetSub.value = 'all'
  await nextTick()
  drawAssetCurve()
})
watch([assetSub, assetRange], async () => {
  await nextTick()
  drawAssetCurve()
})
// 指数开关切换 / 指数数据到位后重绘（归一化模式与金额模式互斥）
watch([compareOn, () => portfolio.indexCache], async () => {
  await nextTick()
  drawAssetCurve()
}, { deep: true })

watch(() => portfolio.assetSeries.length, async () => {
  await nextTick()
  drawAssetCurve()
})

function onResize() {
  charts.resizeAll()
}

onMounted(async () => {
  await nextTick()
  drawAssetCurve()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  charts.disposeAll()
})
</script>

<template>
  <div>
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
</style>
