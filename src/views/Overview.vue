<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtPct, pnlClass, marketLabel, fmtTime } from '../utils/format'

const portfolio = usePortfolioStore()
const chartRef = ref(null)
const pieRef = ref(null)
let chart = null
let pieChart = null
const PALETTE = ['#dc2626', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#14b8a6', '#f97316', '#64748b']

const ranges = [
  { label: '近一周', key: '1w' },
  { label: '本月至今', key: 'mtd' },
  { label: '近一月', key: '1m' },
  { label: '近三月', key: '3m' },
  { label: '年初至今', key: 'ytd' },
  { label: '近一年', key: '1y' }
]
const activeRange = ref('1m')

function startOfRange(key) {
  const today = dayjs()
  switch (key) {
    case '1w': return today.subtract(7, 'day')
    case 'mtd': return today.startOf('month')
    case '1m': return today.subtract(1, 'month')
    case '3m': return today.subtract(3, 'month')
    case 'ytd': return today.startOf('year')
    case '1y': return today.subtract(1, 'year')
    default: return today.subtract(1, 'month')
  }
}

const filteredSeries = computed(() => {
  const start = startOfRange(activeRange.value)
  return portfolio.netValue.filter((p) => dayjs(p.date).isAfter(start) || dayjs(p.date).isSame(start, 'day'))
})

const curveChange = computed(() => {
  const s = filteredSeries.value
  if (!s.length) return { value: 0, pct: 0 }
  const first = s[0].netValue
  const last = s[s.length - 1].netValue
  return { value: last - first, pct: first > 0 ? (last - first) / first : 0 }
})

const latest = computed(() => {
  const s = portfolio.netValue
  return s.length ? s[s.length - 1] : { netValue: portfolio.totals.totalAssets }
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

function draw() {
  if (!chartRef.value) return
  if (!chart) chart = echarts.init(chartRef.value)
  const data = filteredSeries.value
  if (!data.length) {
    chart.clear()
    return
  }
  chart.setOption({
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + fmtNum(v, 0) },
    grid: { left: 56, right: 16, top: 12, bottom: 24 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: data.map((d) => d.date.slice(5)),
      axisLabel: { color: '#94a3b8', fontSize: 10 },
      axisLine: { lineStyle: { color: '#e2e8f0' } }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#94a3b8', fontSize: 10, formatter: (v) => (v >= 10000 ? (v / 10000).toFixed(0) + '万' : v) },
      splitLine: { lineStyle: { color: '#f1f5f9' } }
    },
    series: [{
      name: '净资产',
      type: 'line',
      data: data.map((d) => Math.round(d.netValue * 100) / 100),
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
      }
    }]
  })
}

// 持仓分布（按个股）
function drawPie() {
  if (!pieRef.value) return
  if (!pieChart) pieChart = echarts.init(pieRef.value)
  const data = portfolio.positions.map((p) => ({ name: p.name || p.code, value: Math.round(p.mvCny * 100) / 100 }))
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

watch([() => filteredSeries.value.length, () => portfolio.netValue.length], async () => {
  await nextTick()
  draw()
})

watch(activeRange, draw)

watch(
  () => portfolio.positions.map((p) => Math.round(p.mvCny)).join(','),
  async () => { await nextTick(); drawPie() }
)

function onResize() { chart && chart.resize(); pieChart && pieChart.resize() }

onMounted(() => {
  nextTick().then(() => { draw(); drawPie() })
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  chart && chart.dispose()
  pieChart && pieChart.dispose()
})
</script>

<template>
  <div>
    <div class="page-header">
      <div class="page-title">总览</div>
    </div>

    <!-- 净值曲线卡片 -->
    <div class="card">
      <div class="row between" style="margin-bottom: 6px">
        <div class="row gap8">
          <span class="section-title">净资产</span>
        </div>
        <div class="muted num">
          {{ portfolio.lastQuoteAt ? '更新于 ' + fmtTime(portfolio.lastQuoteAt) : '' }}
        </div>
      </div>
      <div class="row between" style="align-items: flex-end; margin-bottom: 14px">
        <div>
          <div class="big-value num">{{ fmtMoney(latest.netValue, 0) }}</div>
        </div>
        <div style="text-align: right">
          <div class="muted">{{ ranges.find(r => r.key === activeRange)?.label }}变动</div>
          <div class="num" :class="pnlClass(curveChange.value)">
            {{ curveChange.value > 0 ? '+' : '' }}{{ fmtMoney(curveChange.value, 0) }}
            ({{ curveChange.value > 0 ? '+' : '' }}{{ fmtPct(curveChange.pct) }})
          </div>
        </div>
      </div>
      <div class="range-bar">
        <span
          v-for="r in ranges"
          :key="r.key"
          class="range-chip"
          :class="{ active: activeRange === r.key }"
          @click="activeRange = r.key"
        >{{ r.label }}</span>
      </div>
      <div ref="chartRef" class="overview-chart"></div>
    </div>

    <!-- 关键指标 -->
    <div class="metrics card">
      <div class="metric-grid">
        <div>
          <div class="muted">累计盈亏</div>
          <div class="num value" :class="pnlClass(portfolio.totals.totalPnl)">
            {{ portfolio.totals.totalPnl > 0 ? '+' : '' }}{{ fmtMoney(portfolio.totals.totalPnl, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">收益率</div>
          <div class="num value" :class="pnlClass(portfolio.totals.totalPnl)">
            {{ portfolio.totals.totalPnlPct === null ? '—' : (portfolio.totals.totalPnlPct > 0 ? '+' : '') + fmtPct(portfolio.totals.totalPnlPct) }}
          </div>
        </div>
        <div>
          <div class="muted">今日盈亏</div>
          <div class="num value" :class="pnlClass(portfolio.totals.dayPnl)">
            {{ portfolio.totals.dayPnl > 0 ? '+' : '' }}{{ fmtMoney(portfolio.totals.dayPnl, 0) }}
          </div>
        </div>
        <div>
          <div class="muted">持仓市值</div>
          <div class="num value">{{ fmtMoney(portfolio.totals.mvTotal, 0) }}</div>
        </div>
      </div>
    </div>

    <!-- 资产分布 -->
    <div class="card">
      <div class="section-title" style="margin-bottom: 12px">资产分布</div>
      <div v-if="allocation.length" class="alloc-list">
        <div v-for="item in allocation" :key="item.market" class="alloc-item">
          <div class="row between" style="margin-bottom: 4px">
            <span>{{ item.label }}</span>
            <span class="num">{{ fmtMoney(item.value, 0) }}</span>
          </div>
          <el-progress
            :percentage="totalAllocation > 0 ? Math.round(item.value / totalAllocation * 100) : 0"
            :stroke-width="8"
            :color="item.market === 'A' ? '#dc2626' : item.market === 'HK' ? '#3b82f6' : '#f59e0b'"
            :show-text="false"
          />
        </div>
      </div>
      <div v-else class="muted" style="text-align: center; padding: 20px">暂无持仓数据</div>
    </div>

    <!-- 持仓分布 -->
    <div class="card">
      <div class="section-title" style="margin-bottom: 12px">持仓分布</div>
      <div ref="pieRef" class="pie-chart"></div>
      <div v-if="!portfolio.positions.length" class="muted" style="text-align: center; padding: 20px">暂无持仓数据</div>
    </div>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 15px;
  font-weight: 600;
}
.big-value {
  font-size: 30px;
  font-weight: 800;
}
.range-bar {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 8px;
  margin-bottom: 8px;
}
.range-chip {
  flex-shrink: 0;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 16px;
  background: #f1f5f9;
  color: var(--text-2);
}
.range-chip.active {
  background: #fdecec;
  color: #dc2626;
  font-weight: 600;
}
.overview-chart {
  height: 220px;
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
</style>
