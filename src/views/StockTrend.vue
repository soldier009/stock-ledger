<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtShares, fmtPct, pnlClass, marketLabel, rateOf } from '../utils/format'
import { buildPnlRows } from '../utils/pnl'

const route = useRoute()
const router = useRouter()
const portfolio = usePortfolioStore()

const market = String(route.params.market || '')
const code = String(route.params.code || '')

const stock = computed(() => portfolio.stocks.find((s) => s.market === market && s.code === code))
const name = computed(
  () => stock.value?.name || portfolio.trades.find((t) => t.market === market && t.code === code)?.name || code
)

const stockTrades = computed(() =>
  portfolio.trades
    .filter((t) => t.market === market && t.code === code)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.id || 0) - (b.id || 0))
)

// 盈亏行：与「成本与盈亏 › 标的明细」同源（含已实现盈亏与今日盈亏）
const row = computed(() => {
  const rows = buildPnlRows(portfolio.positions, portfolio.realizedEvents, portfolio.closedRounds)
  return rows.find((r) => r.market === market && r.code === code) || null
})

const pos = computed(() => portfolio.positions.find((p) => p.market === market && p.code === code) || null)
const rate = computed(() => rateOf(market, portfolio.rates))

// 现金分红累计（人民币）
const divTotal = computed(() =>
  stockTrades.value.filter((t) => t.type === 'div').reduce((a, t) => a + (Number(t.amount) || 0) * rate.value, 0)
)

function signed(v) {
  const n = Number(v) || 0
  const s = fmtMoney(n, 0)
  return n > 0 ? '+' + s : s
}
function todayText(r) {
  return r && r.hasToday ? signed(r.today) : '—'
}

// ===== 走势曲线 =====
const RANGES = [
  { key: '3m', label: '近三月' },
  { key: '1y', label: '近一年' },
  { key: 'all', label: '全部' }
]
const range = ref('1y')
const chartRef = ref(null)
let chart = null

const points = computed(() => {
  const all = portfolio.stockSeries(market, code) || []
  const from =
    range.value === '3m' ? dayjs().subtract(3, 'month') : range.value === '1y' ? dayjs().subtract(1, 'year') : null
  return all.filter((p) => !from || !dayjs(p.date).isBefore(from, 'day'))
})

// 交易点：按「不早于交易日的第一个曲线点」对齐，同日同类型合并成一个标记
const MARKS = {
  buy: { color: '#dc2626', label: '买' },
  sell: { color: '#16a34a', label: '卖' },
  div: { color: '#f59e0b', label: '息' },
  rights: { color: '#0ea5e9', label: '配' },
  gift: { color: '#64748b', label: '送' }
}
const markData = computed(() => {
  const pts = points.value
  if (!pts.length) return []
  const dates = pts.map((p) => p.date)
  const agg = new Map()
  for (const t of stockTrades.value) {
    if (!MARKS[t.type]) continue
    let i = dates.findIndex((d) => d >= t.date)
    if (i < 0) i = dates.length - 1
    const key = i + '|' + t.type
    const cur = agg.get(key) || { idx: i, type: t.type, shares: 0, amount: 0, count: 0 }
    cur.shares += Number(t.shares) || 0
    cur.amount += Number(t.amount) || 0
    cur.count += 1
    agg.set(key, cur)
  }
  return [...agg.values()].map((m) => ({
    coord: [m.idx, Math.round((pts[m.idx].value || 0) * 100) / 100],
    itemStyle: { color: MARKS[m.type].color },
    value: MARKS[m.type].label,
    _tip:
      m.type === 'div'
        ? `分红 ¥${fmtNum(m.amount, 2)}`
        : m.type === 'sell' || m.type === 'buy'
          ? `${MARKS[m.type].label} ${fmtShares(m.shares, market)} 股`
          : `${MARKS[m.type].label} ${fmtShares(m.shares, market)} 股`
  }))
})

function draw() {
  if (!chartRef.value) return
  if (!chart) chart = echarts.init(chartRef.value)
  const pts = points.value
  if (!pts.length) {
    chart.clear()
    return
  }
  chart.setOption(
    {
      grid: { left: 58, right: 16, top: 34, bottom: 26 },
      legend: {
        data: ['市值', '成本'],
        top: 0,
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 12,
        textStyle: { fontSize: 10, color: '#64748b' }
      },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const arr = Array.isArray(params) ? params : [params]
          if (!arr.length) return ''
          const i = arr[0].dataIndex
          const p = pts[i] || {}
          const lines = [
            arr[0].axisValueLabel,
            ...arr.map((x) => `${x.marker}${x.seriesName}　¥${fmtNum(x.value, 0)}`),
            `持股　${fmtShares(p.shares || 0, market)} 股`
          ]
          const m = markData.value.filter((d) => d.coord[0] === i)
          for (const d of m) lines.push(d._tip)
          return lines.join('<br/>')
        }
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: pts.map((p) => p.date.slice(5)),
        axisLabel: { color: '#94a3b8', fontSize: 10 },
        axisLine: { lineStyle: { color: '#e2e8f0' } }
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          color: '#94a3b8',
          fontSize: 10,
          formatter: (v) => (Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '万' : String(Math.round(v)))
        },
        splitLine: { lineStyle: { color: '#f1f5f9' } }
      },
      series: [
        {
          name: '市值',
          type: 'line',
          data: pts.map((p) => Math.round((p.value || 0) * 100) / 100),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#dc2626', width: 2 },
          itemStyle: { color: '#dc2626' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(220,38,38,0.20)' },
                { offset: 1, color: 'rgba(220,38,38,0.02)' }
              ]
            }
          },
          markPoint: {
            symbolSize: 18,
            label: { fontSize: 9, color: '#fff' },
            data: markData.value
          }
        },
        {
          name: '成本',
          type: 'line',
          data: pts.map((p) => Math.round((p.cost || 0) * 100) / 100),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#94a3b8', width: 1.4, type: 'dashed' },
          itemStyle: { color: '#94a3b8' }
        }
      ]
    },
    true
  )
}

watch([range, points], () => nextTick(() => { draw(); if (chart) chart.resize() }), { immediate: true, deep: false })

onBeforeUnmount(() => {
  if (chart) {
    chart.dispose()
    chart = null
  }
})
</script>

<template>
  <div>
    <div class="page-header">
      <div class="row gap8">
        <el-icon class="back-icon" @click="router.back()"><ArrowLeft /></el-icon>
        <div class="page-title">标的走势</div>
      </div>
    </div>

    <div class="card">
      <div class="row between">
        <div class="row gap8">
          <span class="trend-name">{{ name }}</span>
          <span class="muted">{{ marketLabel(market) }} {{ code }}</span>
        </div>
        <span v-if="row && row.closed" class="closed-tag">已清仓</span>
      </div>

      <div v-if="row" class="stat-grid">
        <div><span>持仓数量</span><b>{{ pos ? fmtShares(pos.shares, market) + ' 股' : '—' }}</b></div>
        <div><span>成本</span><b>{{ fmtMoney(row.cost, 0) }}</b></div>
        <div><span>市值</span><b>{{ row.closed ? '—' : fmtMoney(row.mv, 0) }}</b></div>
        <div>
          <span>浮动盈亏</span>
          <b :class="pnlClass(row.floating)">{{ row.closed ? '—' : signed(row.floating) }}</b>
        </div>
        <div>
          <span>今日盈亏</span>
          <b :class="row.hasToday ? pnlClass(row.today) : ''">{{ todayText(row) }}</b>
        </div>
        <div>
          <span>已实现盈亏</span>
          <b :class="pnlClass(row.realized)">{{ signed(row.realized) }}</b>
        </div>
        <div><span>现金分红</span><b>{{ fmtMoney(divTotal, 2) }}</b></div>
        <div>
          <span>收益率</span>
          <b :class="pnlClass(row.returnPct)">{{ row.closed ? '—' : fmtPct(row.returnPct) }}</b>
        </div>
        <div>
          <span>合计盈亏</span>
          <b :class="pnlClass(row.totalPnl)">{{ signed(row.totalPnl) }}</b>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="row between">
        <span class="section-title" style="margin: 0">市值 / 成本走势</span>
        <div class="trend-tabs">
          <span
            v-for="r in RANGES"
            :key="r.key"
            :class="{ active: range === r.key }"
            @click="range = r.key"
          >
            {{ r.label }}
          </span>
        </div>
      </div>
      <div v-show="points.length" ref="chartRef" class="trend-chart"></div>
      <div v-if="!points.length" class="muted" style="text-align: center; padding: 20px 0">
        暂无走势数据（日K补全后自动生成）
      </div>
      <div class="muted mark-legend">
        <span v-for="(m, k) in MARKS" :key="k" class="mark-item">
          <i :style="{ background: m.color }"></i>{{ m.label }}
        </span>
      </div>
    </div>

    <div class="card" @click="router.push(`/stock/${market}/${code}`)">
      <div class="row between">
        <span>股票详情（持仓、交易记录、分红）</span>
        <el-icon :size="14" style="color: #94a3b8"><ArrowRight /></el-icon>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trend-name {
  font-size: 16px;
  font-weight: 700;
}
.closed-tag {
  font-size: 10px;
  color: #94a3b8;
  background: #f1f5f9;
  border-radius: 10px;
  padding: 2px 7px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 12px 8px;
  margin-top: 12px;
}
.stat-grid > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  font-size: 11px;
  color: var(--text-2, #64748b);
}
.stat-grid b {
  display: block;
  margin-top: 3px;
  font-size: 13px;
  color: #334155;
}
.trend-chart {
  width: 100%;
  height: 240px;
  margin-top: 6px;
}
.trend-tabs {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: var(--text-2, #64748b);
}
.trend-tabs .active {
  color: var(--primary);
  font-weight: 600;
}
.mark-legend {
  display: flex;
  gap: 12px;
  font-size: 11px;
  margin-top: 6px;
}
.mark-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.mark-item i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
</style>
