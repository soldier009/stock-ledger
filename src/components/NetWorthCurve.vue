<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import dayjs from 'dayjs'
import { ArrowLeft, TrendCharts, Wallet } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtPct, pnlClass } from '../utils/format'
import { useOverlayHistory } from '../utils/useOverlayHistory'

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue'])

const portfolio = usePortfolioStore()
const chartRef = ref(null)
let chart = null
let ro = null

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const mode = ref('day') // day | month | year
const dayRange = ref('1m')

const dayRanges = [
  { label: '近一周', key: '1w' },
  { label: '近一月', key: '1m' },
  { label: '近三月', key: '3m' },
  { label: '年初至今', key: 'ytd' },
  { label: '近一年', key: '1y' }
]

const modes = [
  { label: '日', key: 'day' },
  { label: '月', key: 'month' },
  { label: '年', key: 'year' }
]

const currentRangeLabel = computed(() => (dayRanges.find((r) => r.key === dayRange.value) || dayRanges[1]).label)

function startOfRange(key) {
  const today = dayjs()
  switch (key) {
    case '1w': return today.subtract(7, 'day')
    case '1m': return today.subtract(1, 'month')
    case '3m': return today.subtract(3, 'month')
    case 'ytd': return today.startOf('year')
    case '1y': return today.subtract(1, 'year')
    default: return today.subtract(1, 'month')
  }
}

const dayData = computed(() => {
  const start = startOfRange(dayRange.value)
  return portfolio.netValue.filter((p) =>
    dayjs(p.date).isAfter(start) || dayjs(p.date).isSame(start, 'day')
  )
})

const latest = computed(() => {
  const s = portfolio.netValue
  return s.length ? s[s.length - 1] : { netValue: portfolio.totals.totalAssets }
})

// 净资产曲线口径说明：用于确认“补录历史持仓（初始建仓）并入起点”是否生效
const initialInfo = computed(() => {
  const buys = portfolio.trades.filter((t) => t.origin === 'initial' && (t.type === 'buy' || t.type === 'rights'))
  const deps = portfolio.cashFlows.filter((c) => c.origin === 'initial' && c.type === 'deposit')
  const depSum = deps.reduce((a, c) => a + (Number(c.amount) || 0), 0)
  const series = portfolio.netValue
  const start = series.length ? series[0].date : ''
  const initDates = [...buys.map((t) => t.date), ...deps.map((c) => c.date)].sort()
  const earliestInit = initDates.length ? initDates[0] : ''
  if (!buys.length || !depSum || !start || !earliestInit) {
    return { has: false }
  }
  return {
    has: true,
    merged: earliestInit > start, // 补录日晚于曲线起点 → 已真正并入更早的起点
    count: buys.length,
    depSum,
    start,
    initDate: earliestInit
  }
})

// 区间起点基准：区间开始日之前最近的一条净资产（= 区间开始前的账户状态）
// 这样区间内每一天（含第一天）的出入金都落在「变化」里，与下面的资金进出统计口径一致；
// 账户数据全部落在区间内时没有更早的点，此时基准为 0（账户自此处起才有净资产）
const dayBase = computed(() => {
  const start = startOfRange(dayRange.value).format('YYYY-MM-DD')
  let prev = null
  for (const p of portfolio.netValue) if (p.date < start) prev = p
  return { value: prev ? prev.netValue : 0, date: prev ? prev.date : '' }
})

// 日视图：所选时间区间内净资产的变化金额（区间起点前的状态 → 最新一条）
const periodChange = computed(() => {
  const data = dayData.value
  if (!data.length) return { value: 0, pct: 0, base: 0 }
  const base = dayBase.value.value
  const last = data[data.length - 1].netValue
  const v = last - base
  return { value: v, pct: base ? (v / base) * 100 : 0, base }
})

function baseOption() {
  return {
    grid: { left: 56, right: 16, top: 12, bottom: 24 },
    tooltip: {
      trigger: 'axis',
      // confine + 自定义 position：弹窗固定在触点上方居中，靠左/右边缘时自动收进容器，
      // 顶部放不下时改到触点下方，避免入金 pin 弹出的提示被屏幕边缘裁掉
      confine: true,
      extraCssText: 'max-width: 92%; white-space: normal; border-radius: 8px;',
      position(point, params, dom, rect, size) {
        const [viewW, viewH] = size.viewSize
        const [w, h] = size.contentSize
        // 横向：以触点为中心，靠边时收进容器内
        let x = point[0] - w / 2
        x = Math.max(4, Math.min(x, Math.max(4, viewW - w - 4)))
        // 纵向：优先放触点上方，上方放不下改下方，两边都放不下（内容高）就贴容器顶部，
        // 并始终把整块弹窗夹在容器内，避免入金标记多、弹窗变高时顶部被裁
        let y = point[1] - h - 14
        if (y < 4) y = point[1] + 14
        if (y + h > viewH - 4) y = Math.max(4, viewH - h - 4)
        return [x, y]
      },
      valueFormatter: (v) => '¥' + fmtNum(v, 0)
    },
    xAxis: {
      type: 'category',
      axisLabel: { color: '#94a3b8', fontSize: 11 },
      axisLine: { lineStyle: { color: '#e2e8f0' } }
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: '#94a3b8',
        fontSize: 11,
        formatter: (v) => (Math.abs(v) >= 10000 ? (v / 10000).toFixed(0) + '万' : v)
      },
      splitLine: { lineStyle: { color: '#f1f5f9' } }
    }
  }
}

// 纵轴范围：让曲线/柱子的最高点落在绘图区约 3/4 高度处，上方留出空间，
// 避免折线顶到上方的提示文字、以及入金标记（pin）被裁掉
// fromZero=true 用于柱状图（0 在底部，最高点 = 3/4）
// bottomRatio 用于日曲线：纵轴底部取「区间内总资产最小值 × bottomRatio」，
// 使曲线起伏与其占总资产的真实比例接近，不至于把很小的日波动画成剧烈震荡
function axisRange(values, fromZero, bottomRatio) {
  const nums = (values || []).filter((v) => typeof v === 'number' && isFinite(v))
  if (!nums.length) return {}
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  if (bottomRatio && lo > 0) {
    const min = lo * bottomRatio
    // 最高点仍落在绘图区 3/4 高度处
    const max = min + ((hi - min) * 4) / 3
    return { min, max: max > min ? max : min + 1 }
  }
  if (fromZero) {
    const top = Math.max(hi, 0)
    if (top <= 0) return { min: 0, max: 1 }
    return { min: Math.min(0, lo), max: (top * 4) / 3 }
  }
  if (hi === lo) {
    const pad = Math.abs(hi) || 1
    return { min: lo - pad * 0.5, max: hi + pad * 1.5 }
  }
  const span = hi - lo
  const bottom = 0.12
  const top = (1 + bottom) / 3 // 使数据最高点落在绘图区 75% 高度处
  return { min: lo - span * bottom, max: hi + span * top }
}

// 金额简写（1.2万 等），用于折线上的资金事件标签
function moneyShort(v) {
  const n = Number(v) || 0
  if (Math.abs(n) >= 10000) {
    const w = n / 10000
    return (Math.abs(w) >= 100 ? w.toFixed(0) : w.toFixed(1)) + '万'
  }
  return String(Math.round(n))
}

function dayRows(list) {
  return (list || []).map((d) => {
    const notes = d.notes || []
    return {
      date: d.date,
      v: Math.round(d.netValue * 100) / 100,
      cash: Math.round(d.cash * 100) / 100,
      mv: Math.round(d.marketValue * 100) / 100,
      flows: notes.filter((n) => n.kind === 'flow'),
      initials: notes.filter((n) => n.kind === 'initial' || n.kind === 'initialTrade')
    }
  })
}

// 当天普通出入金的净变动额
function netFlow(flows) {
  return (flows || []).reduce((a, f) => a + (f.type === 'deposit' ? f.amount : -f.amount), 0)
}

// 「投资收益」与「资金进出」按两个独立口径统计（累计值，不随上方区间切换变化）：
//   投资收益 = 买卖盈亏的全部金额总和 = 已实现盈亏（卖出） + 现金分红 + 当前持仓浮动盈亏
//   资金进出 = 本金 = 入金合计 − 出金合计（与资产页「累计入金」、总盈亏率同源）
// 注1：totalRealized 已包含现金分红（calc.js 中分红到账即计入），这里把分红单列出来展示，
//      「已实现」一行显示的是纯买卖盈亏
// 注2：本金按「资金来源」拆成互不重叠的两块：补录建仓（虚拟入金）+ 手动入金 − 出金。
//     App 内买入花的钱来自手动入金的现金，只是「现金 → 持仓」的形态转换、净资产不变，
//     不能再单列一次，否则本金被算两遍（此前「建仓成本 + 入金 − 出金」就是这么虚高的，
//     也导致「占本金」收益率被稀释）
// 注3：补录历史持仓（初始建仓）会自动生成等额入金，属于本金的一部分，单列为「补录建仓」
const capitalBreakdown = computed(() => {
  const realized = Number(portfolio.totals?.totalRealized) || 0
  const floating = Number(portfolio.totals?.floating) || 0
  let dividend = 0
  for (const e of portfolio.realizedEvents) {
    if (e.type === 'div') dividend += Number(e.amount) || 0
  }
  const tradeRealized = realized - dividend // 纯买卖带来的已实现盈亏
  // 本金的两块来源互不重叠，保证「补录建仓 + 入金 − 出金 = 本金」恒成立：
  //   补录建仓 = 补录历史持仓时自动生成的入金（虚拟入金，不占用手动入金的现金）
  //   入金     = 资金账户里手动记录的入金；App 内买入花的钱出自这里，故不再单列买入成本
  let initialCost = 0
  let deposit = 0
  let withdraw = 0
  for (const c of portfolio.cashFlows) {
    const amt = Number(c.amount) || 0
    if (c.type === 'deposit') {
      if (c.origin === 'initial') initialCost += amt
      else deposit += amt
    } else if (c.type === 'withdraw') withdraw += amt
  }
  const invest = realized + floating
  // 本金 = 入金 − 出金：与 store 的 totals.principal、资产页「累计入金」同源
  const flow = Number(portfolio.totals?.principal) || deposit - withdraw
  return {
    invest,
    realized: tradeRealized,
    dividend,
    floating,
    flow,
    initialCost,
    deposit,
    withdraw,
    roi: flow ? (invest / flow) * 100 : 0
  }
})

// 批量把资金事件并入 month/year 的统计
function aggFlows(target, p) {
  for (const n of p.notes || []) {
    if (n.kind !== 'flow') continue
    if (n.type === 'deposit') target.deposit += n.amount
    else target.withdraw += n.amount
  }
}

function drawDay() {
  const data = dayData.value
  if (!data.length) {
    chart.clear()
    return
  }
  const rows = dayRows(data)
  const xs = data.map((d) => d.date.slice(5))
  // 普通出入金发生日在折线上加标记（补录的历史持仓已并入起点，不在此标记）
  const marks = []
  rows.forEach((r, i) => {
    const net = netFlow(r.flows)
    if (Math.abs(net) > 0.005) marks.push({ coord: [xs[i], r.v], net })
  })
  chart.setOption({
    ...baseOption(),
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const p = params && params[0]
        const r = p ? rows[p.dataIndex] : null
        if (!r) return ''
        // 现金与持仓市值拆成两行：单行太长会让弹窗过宽，在屏幕中间也会被裁掉半截
        const lines = [
          `净资产：¥${fmtNum(r.v, 0)}`,
          `现金：¥${fmtNum(r.cash, 0)}`,
          `持仓市值：¥${fmtNum(r.mv, 0)}`
        ]
        // 当天出入金笔数多时只列前 3 笔、其余汇总：笔数一多弹窗会高到顶出图表
        const flows = r.flows || []
        for (const f of flows.slice(0, 3)) {
          lines.push((f.type === 'deposit' ? '入金 +' : '出金 -') + fmtMoney(f.amount, 0))
        }
        if (flows.length > 3) {
          const rest = flows.slice(3).reduce((a, f) => a + (f.type === 'deposit' ? Number(f.amount) : -Number(f.amount)), 0)
          lines.push(`其余 ${flows.length - 3} 笔合计 ${rest >= 0 ? '+' : '-'}${fmtMoney(Math.abs(rest), 0)}`)
        }
        // 补录的历史持仓可能一次补很多只，同样只列前 2 条、其余汇总，避免弹窗过高
        const initials = r.initials || []
        for (const n of initials.slice(0, 2)) {
          lines.push('初始建仓并入起点' + (n.kind === 'initial' ? '：' + fmtMoney(n.amount, 0) : '：' + n.label))
        }
        if (initials.length > 2) lines.push(`其余 ${initials.length - 2} 笔初始建仓已并入起点`)
        return `<b>${r.date}</b>` + lines.map((s) => `<div>${s}</div>`).join('')
      }
    },
    xAxis: {
      ...baseOption().xAxis,
      boundaryGap: false,
      data: xs
    },
    yAxis: { ...baseOption().yAxis, ...axisRange(rows.map((r) => r.v), false, 0.25) },
    series: [{
      name: '净资产',
      type: 'line',
      data: rows.map((r) => r.v),
      smooth: true,
      symbol: 'none',
      lineStyle: { color: '#dc2626', width: 2 },
      itemStyle: { color: '#dc2626' },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(220,38,38,0.18)' },
            { offset: 1, color: 'rgba(220,38,38,0.01)' }
          ]
        }
      },
      markPoint: {
        symbol: 'pin',
        symbolSize: 36,
        itemStyle: { color: '#d97706' },
        label: {
          show: true,
          color: '#fff',
          fontSize: 10,
          formatter: (p) => (p.data.net >= 0 ? '入+' + moneyShort(p.data.net) : '出-' + moneyShort(-p.data.net))
        },
        data: marks
      }
    }]
  })
}

function monthData() {
  const map = new Map()
  for (const p of portfolio.netValue) {
    const key = p.date.slice(0, 7)
    let m = map.get(key)
    if (!m) {
      m = { month: key, deposit: 0, withdraw: 0, netValue: p.netValue }
      map.set(key, m)
    } else {
      m.netValue = p.netValue
    }
    aggFlows(m, p)
  }
  return [...map.values()]
    .map((m) => ({ ...m, netValue: Math.round(m.netValue * 100) / 100 }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

function yearData() {
  const map = new Map()
  for (const p of portfolio.netValue) {
    const key = p.date.slice(0, 4)
    let m = map.get(key)
    if (!m) {
      m = { year: key, deposit: 0, withdraw: 0, netValue: p.netValue }
      map.set(key, m)
    } else {
      m.netValue = p.netValue
    }
    aggFlows(m, p)
  }
  return [...map.values()]
    .map((m) => ({ ...m, netValue: Math.round(m.netValue * 100) / 100 }))
    .sort((a, b) => a.year.localeCompare(b.year))
}

function drawMonth() {
  const data = monthData()
  if (!data.length) {
    chart.clear()
    return
  }
  chart.setOption({
    ...baseOption(),
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const p = params && params[0]
        const r = p ? data[p.dataIndex] : null
        if (!r) return ''
        const lines = [`期末净资产：¥${fmtNum(r.netValue, 0)}`]
        if (r.deposit) lines.push('当月入金 +' + fmtMoney(r.deposit, 0))
        if (r.withdraw) lines.push('当月出金 -' + fmtMoney(r.withdraw, 0))
        return `<b>${r.month}</b>` + lines.map((s) => `<div>${s}</div>`).join('')
      }
    },
    xAxis: {
      ...baseOption().xAxis,
      data: data.map((d) => d.month)
    },
    yAxis: { ...baseOption().yAxis, ...axisRange(data.map((d) => d.netValue), true) },
    series: [{
      name: '净资产',
      type: 'bar',
      data: data.map((d) => d.netValue),
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: (p) => p.value >= 0 ? '#dc2626' : '#10b981'
      }
    }]
  })
}

function drawYear() {
  const data = yearData()
  if (!data.length) {
    chart.clear()
    return
  }
  chart.setOption({
    ...baseOption(),
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const p = params && params[0]
        const r = p ? data[p.dataIndex] : null
        if (!r) return ''
        const lines = [`年末净资产：¥${fmtNum(r.netValue, 0)}`]
        if (r.deposit) lines.push('全年入金 +' + fmtMoney(r.deposit, 0))
        if (r.withdraw) lines.push('全年出金 -' + fmtMoney(r.withdraw, 0))
        return `<b>${r.year}年</b>` + lines.map((s) => `<div>${s}</div>`).join('')
      }
    },
    xAxis: {
      ...baseOption().xAxis,
      data: data.map((d) => d.year + '年')
    },
    yAxis: { ...baseOption().yAxis, ...axisRange(data.map((d) => d.netValue), true) },
    series: [{
      name: '净资产',
      type: 'bar',
      data: data.map((d) => d.netValue),
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: (p) => p.value >= 0 ? '#dc2626' : '#10b981'
      }
    }]
  })
}

function draw() {
  const el = chartRef.value
  if (!el || !el.offsetWidth || !el.offsetHeight) return // 容器布局未完成，等 ResizeObserver 触发后再画
  // 关闭时图表 DOM 已被 v-if 移除：若实例仍指向旧画布则重建，否则重开后会空白
  if (chart && (!chart.getDom || !chart.getDom().isConnected)) {
    try { chart.dispose() } catch (e) { /* ignore */ }
    chart = null
  }
  if (!chart) chart = echarts.init(el)
  chart.clear()
  if (mode.value === 'day') drawDay()
  else if (mode.value === 'month') drawMonth()
  else drawYear()
}

function destroyChart() {
  if (ro) {
    ro.disconnect()
    ro = null
  }
  if (chart) {
    try { chart.dispose() } catch (e) { /* ignore */ }
    chart = null
  }
}

function watchChartSize(on) {
  const el = chartRef.value
  if (!el || typeof ResizeObserver === 'undefined') return
  if (on && !ro) {
    ro = new ResizeObserver(() => {
      if (!chartRef.value) return
      if (chart) {
        chart.resize()
      } else if (chartRef.value.offsetWidth && chartRef.value.offsetHeight) {
        draw()
      }
    })
    ro.observe(el)
  } else if (!on && ro) {
    ro.disconnect()
    ro = null
  }
}

function close() {
  visible.value = false
}
// 接管系统返回手势（iOS 左边缘右滑 / 安卓返回 / 浏览器后退），与左上角箭头表现一致：关闭浮层回到总览
useOverlayHistory(visible, close)

// 右滑关闭：移动端没有物理返回键，向右拖动面板超过阈值即返回总览
const dragX = ref(0)
const dragging = ref(false)
let startX = 0
let startY = 0

const panelStyle = computed(() => (dragX.value ? { transform: `translateX(${dragX.value}px)` } : {}))

function onTouchStart(e) {
  const t = e.touches && e.touches[0]
  if (!t) return
  startX = t.clientX
  startY = t.clientY
  dragging.value = false
}

function onTouchMove(e) {
  const t = e.touches && e.touches[0]
  if (!t) return
  const dx = t.clientX - startX
  const dy = t.clientY - startY
  if (!dragging.value) {
    // 只接管明显向右的横向滑动，纵向滚动不受影响
    if (dx > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) dragging.value = true
    else return
  }
  dragX.value = Math.max(0, Math.min(dx, 260))
  if (e.cancelable) e.preventDefault()
}

function onTouchEnd() {
  const passed = dragX.value > 72
  dragging.value = false
  dragX.value = 0
  if (passed) close()
}

watch([() => mode.value, () => dayRange.value, () => portfolio.netValue.length], async () => {
  await nextTick()
  draw()
})

watch(visible, async (v) => {
  if (v) {
    mode.value = 'day'
    dayRange.value = '1m'
    await nextTick()
    // 打开即挂载了新画布容器：用 ResizeObserver 兜底“布局未完成/尺寸为 0”，并随容器自适应
    watchChartSize(true)
    draw()
  } else {
    // 关闭：图表 DOM 即将被 v-if 移除，销毁实例，避免下次打开复用失效实例导致空白
    await nextTick()
    destroyChart()
  }
})

function onResize() {
  if (chart) chart.resize()
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  if (visible.value) {
    nextTick(() => {
      watchChartSize(true)
      draw()
    })
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  destroyChart()
})
</script>

<template>
  <teleport to="body">
    <div v-if="visible" class="nw-overlay" @click.self="close">
      <div
        class="nw-panel"
        :class="{ dragging }"
        :style="panelStyle"
        @touchstart.passive="onTouchStart"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
      >
        <div class="nw-header">
          <div class="nw-back" @click="close">
            <el-icon :size="22"><ArrowLeft /></el-icon>
          </div>
          <div class="nw-title">净资产走势</div>
          <div class="nw-back" style="visibility: hidden">
            <el-icon :size="22"><ArrowLeft /></el-icon>
          </div>
        </div>

        <div class="nw-top">
          <div class="nw-summary">
            <div class="nw-label">
              {{ mode === 'day' ? '所选区间变化（' + currentRangeLabel + '）' : '净资产' }}
            </div>
            <div v-if="mode === 'day'" class="nw-value nw-range-value" :class="['num', pnlClass(periodChange.value)]">
              {{ periodChange.value > 0 ? '+' : '' }}{{ fmtMoney(periodChange.value, 0) }}
              <span v-if="periodChange.base" class="nw-pct">({{ periodChange.value > 0 ? '+' : '' }}{{ fmtPct(periodChange.pct) }})</span>
            </div>
            <div v-else class="nw-value num">{{ fmtMoney(latest.netValue, 0) }}</div>
          </div>

          <div class="mode-bar">
            <span
              v-for="m in modes"
              :key="m.key"
              class="mode-chip"
              :class="{ active: mode === m.key }"
              @click="mode = m.key"
            >{{ m.label }}</span>
          </div>
        </div>

        <div v-if="mode === 'day'" class="range-bar">
          <span
            v-for="r in dayRanges"
            :key="r.key"
            class="range-chip"
            :class="{ active: dayRange === r.key }"
            @click="dayRange = r.key"
          >{{ r.label }}</span>
        </div>

        <div v-if="initialInfo.has" class="nw-note">
          <template v-if="initialInfo.merged">
            已将 {{ initialInfo.count }} 笔补录历史持仓（本金 ¥{{ fmtNum(initialInfo.depSum, 0) }}）
            并入曲线起点 {{ initialInfo.start }}，中途无跳变
          </template>
          <template v-else>
            {{ initialInfo.count }} 笔补录历史持仓发生于 {{ initialInfo.start }}（曲线起点），已按起点计入
          </template>
        </div>

        <div ref="chartRef" class="nw-chart"></div>

        <div v-if="mode === 'day'" class="nw-breakdown">
          <div class="nw-bd-row">
            <div class="nw-bd-icon" :class="pnlClass(capitalBreakdown.invest)">
              <el-icon :size="18"><TrendCharts /></el-icon>
            </div>
            <div class="nw-bd-label">
              投资收益
              <div class="nw-bd-sub">
                已实现 {{ fmtMoney(capitalBreakdown.realized, 0) }} · 分红 {{ fmtMoney(capitalBreakdown.dividend, 0) }} · 浮动 {{ fmtMoney(capitalBreakdown.floating, 0) }}
              </div>
            </div>
            <div class="nw-bd-right">
              <div class="nw-bd-num" :class="pnlClass(capitalBreakdown.invest)">{{ (capitalBreakdown.invest > 0 ? '+' : '') + fmtMoney(capitalBreakdown.invest, 0) }}</div>
              <div class="nw-bd-pct">占本金 {{ fmtPct(capitalBreakdown.roi) }}</div>
            </div>
          </div>
          <div class="nw-bd-row nw-capital">
            <div class="nw-bd-icon">
              <el-icon :size="18"><Wallet /></el-icon>
            </div>
            <div class="nw-bd-label">
              资金进出（本金）
              <div class="nw-bd-sub">
                补录建仓 {{ fmtMoney(capitalBreakdown.initialCost, 0) }} · 入金 {{ fmtMoney(capitalBreakdown.deposit, 0) }}
              </div>
            </div>
            <div class="nw-bd-right">
              <div class="nw-bd-num">{{ fmtMoney(capitalBreakdown.flow, 0) }}</div>
              <div class="nw-bd-pct">出金 {{ fmtMoney(capitalBreakdown.withdraw, 0) }}</div>
            </div>
          </div>
          <div class="nw-bd-note">投资收益 = 买卖已实现盈亏 + 现金分红 + 持仓浮动盈亏；资金进出（本金）= 补录建仓 + 入金 − 出金，App 内买入花的钱来自手动入金的现金，已含在入金中、不重复计入</div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.nw-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(15, 23, 42, 0.4);
  display: flex;
  justify-content: center;
  align-items: stretch;
  padding: 16px;
}
.nw-panel {
  background: #fff;
  width: 100%;
  max-width: 480px;
  border-radius: 16px;
  box-shadow: 0 12px 48px rgba(15, 23, 42, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: transform 0.22s ease;
}
/* 跟手拖动时不要过渡，否则会有延迟感 */
.nw-panel.dragging {
  transition: none;
}
.nw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 4px;
  flex-shrink: 0;
}
.nw-back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  cursor: pointer;
  color: var(--text-1, #1f2937);
}
.nw-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1, #1f2937);
}
.nw-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 16px 0;
  gap: 10px;
}
.nw-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.nw-label {
  font-size: 12px;
  color: var(--text-2, #64748b);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nw-value {
  font-size: 26px;
  font-weight: 800;
  margin-top: 2px;
  color: var(--text-1, #1f2937);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nw-value.nw-range-value {
  font-size: 22px;
}
.nw-pct {
  font-size: 13px;
  font-weight: 700;
  margin-left: 4px;
}
.mode-bar {
  display: flex;
  flex-shrink: 0;
  background: #f1f5f9;
  border-radius: 18px;
  padding: 3px;
}
.mode-chip {
  font-size: 13px;
  padding: 5px 14px;
  border-radius: 15px;
  color: var(--text-2, #64748b);
  cursor: pointer;
  white-space: nowrap;
}
.mode-chip.active {
  background: #fff;
  color: #dc2626;
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}
.nw-breakdown {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 16px 14px;
  border-top: 1px solid #f1f5f9;
  flex-shrink: 0;
}
.nw-bd-row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #f8fafc;
  border-radius: 10px;
  padding: 10px 12px;
}
.nw-bd-icon {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: #e2e8f0;
  color: #64748b;
}
.nw-bd-icon.up {
  background: #fee2e2;
  color: #dc2626;
}
.nw-bd-icon.down {
  background: #d1fae5;
  color: #10b981;
}
.nw-capital .nw-bd-icon {
  background: #fef3c7;
  color: #d97706;
}
.nw-bd-label {
  flex: 1;
  font-size: 14px;
  color: #334155;
}
.nw-bd-sub {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nw-bd-right {
  text-align: right;
}
.nw-bd-num {
  font-size: 16px;
  font-weight: 700;
}
.nw-bd-num.up {
  color: #dc2626;
}
.nw-bd-num.down {
  color: #10b981;
}
.nw-bd-pct {
  font-size: 11px;
  color: #94a3b8;
}
.nw-bd-note {
  font-size: 11px;
  line-height: 1.5;
  color: #94a3b8;
  padding: 0 2px;
}
.range-bar {
  display: flex;
  gap: 6px;
  padding: 12px 16px 0;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.range-chip {
  flex-shrink: 0;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 15px;
  background: #f1f5f9;
  color: var(--text-2, #64748b);
  cursor: pointer;
}
.range-chip.active {
  background: #fdecec;
  color: #dc2626;
  font-weight: 600;
}
.nw-note {
  flex-shrink: 0;
  margin: 10px 16px 0;
  font-size: 11px;
  line-height: 1.5;
  color: #d97706;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 6px 10px;
}
.nw-chart {
  flex: 1;
  min-height: 0;
  width: 100%;
  margin-top: 8px;
}

@media (max-width: 540px) {
  .nw-overlay {
    padding: 0;
  }
  .nw-panel {
    max-width: none;
    border-radius: 0;
  }
  .nw-value {
    font-size: 24px;
  }
}
</style>
