<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import dayjs from 'dayjs'
import { ArrowLeft } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtPct, pnlClass } from '../utils/format'

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

// 日视图：所选时间区间内净资产的变化金额（区间首条 → 最新一条）
const periodChange = computed(() => {
  const data = dayData.value
  if (!data.length) return { value: 0, pct: 0 }
  const first = data[0].netValue
  const last = data[data.length - 1].netValue
  const v = last - first
  return { value: v, pct: first ? (v / first) * 100 : 0 }
})

function baseOption() {
  return {
    grid: { left: 56, right: 16, top: 12, bottom: 24 },
    tooltip: {
      trigger: 'axis',
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
        const lines = [
          `净资产：¥${fmtNum(r.v, 0)}`,
          `　现金：¥${fmtNum(r.cash, 0)}　持仓市值：¥${fmtNum(r.mv, 0)}`
        ]
        for (const f of r.flows) {
          lines.push((f.type === 'deposit' ? '入金 +' : '出金 -') + fmtMoney(f.amount, 0))
        }
        for (const n of r.initials) {
          lines.push('初始建仓并入起点' + (n.kind === 'initial' ? '：' + fmtMoney(n.amount, 0) : '：' + n.label))
        }
        return `<b>${r.date}</b>` + lines.map((s) => `<div>${s}</div>`).join('')
      }
    },
    xAxis: {
      ...baseOption().xAxis,
      boundaryGap: false,
      data: xs
    },
    yAxis: baseOption().yAxis,
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
    yAxis: baseOption().yAxis,
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
    yAxis: baseOption().yAxis,
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
      <div class="nw-panel">
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
            <div v-if="mode === 'day'" class="nw-value" :class="['num', pnlClass(periodChange.value)]">
              {{ periodChange.value > 0 ? '+' : '' }}{{ fmtMoney(periodChange.value, 0) }}
              <span class="nw-pct">({{ periodChange.value > 0 ? '+' : '' }}{{ fmtPct(periodChange.pct) }})</span>
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
