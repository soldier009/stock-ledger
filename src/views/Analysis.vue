<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtPct, pnlClass } from '../utils/format'

const portfolio = usePortfolioStore()
const activeTab = ref('netValue')
const calendarDate = ref(dayjs())

const curveRef = ref(null)
const netValueRef = ref(null)
const drawdownRef = ref(null)
const monthlyRef = ref(null)
const yearlyRef = ref(null)

const charts = {}

const totalCost = computed(() => portfolio.positions.reduce((a, p) => a + p.avgCost * p.shares * p.rate, 0))

function initChart(ref, key) {
  if (!ref.value) return null
  if (!charts[key]) charts[key] = echarts.init(ref.value)
  return charts[key]
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
  const data = portfolio.cumulative
  if (!data.length) { chart.clear(); return }
  chart.setOption({
    ...commonOption(),
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + fmtNum(v, 0) },
    xAxis: { type: 'category', boundaryGap: false, data: data.map((d) => d.date.slice(5)), axisLabel: { color: '#94a3b8', fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10 }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [{
      name: '累计已实现盈亏', type: 'line', data: data.map((d) => Math.round(d.value * 100) / 100),
      smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { color: '#dc2626', width: 2.5 },
      itemStyle: { color: '#dc2626' },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(220,38,38,0.22)' }, { offset: 1, color: 'rgba(220,38,38,0.02)' }] } }
    }]
  })
}

function drawNetValue() {
  const chart = initChart(netValueRef, 'netValue')
  if (!chart) return
  const data = portfolio.netValue
  if (!data.length) { chart.clear(); return }
  chart.setOption({
    ...commonOption(),
    tooltip: { trigger: 'axis', valueFormatter: (v) => '¥' + fmtNum(v, 0) },
    xAxis: { type: 'category', boundaryGap: false, data: data.map((d) => d.date.slice(5)), axisLabel: { color: '#94a3b8', fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 10, formatter: (v) => (v >= 10000 ? (v / 10000).toFixed(0) + '万' : v) }, splitLine: { lineStyle: { color: '#f1f5f9' } } },
    series: [{
      name: '净资产', type: 'line', data: data.map((d) => Math.round(d.netValue * 100) / 100),
      smooth: true, symbol: 'none', lineStyle: { color: '#dc2626', width: 2 },
      itemStyle: { color: '#dc2626' },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(220,38,38,0.18)' }, { offset: 1, color: 'rgba(220,38,38,0.01)' }] } }
    }]
  })
}

function drawDrawdown() {
  const chart = initChart(drawdownRef, 'drawdown')
  if (!chart) return
  const data = portfolio.netValue
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

const drawMap = { curve: drawCurve, netValue: drawNetValue, monthly: drawMonthly, yearly: drawYearly }

function redraw() { drawMap[activeTab.value]?.() }

watch(activeTab, async () => { await nextTick(); redraw() })
watch(
  () => [portfolio.monthly.length, portfolio.yearly.length, portfolio.cumulative.length, portfolio.netValue.length],
  () => { redraw(); drawDrawdown() }
)

function onResize() { Object.values(charts).forEach((c) => c && c.resize()) }

onMounted(async () => { await nextTick(); redraw(); drawDrawdown(); window.addEventListener('resize', onResize) })
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

function prevMonth() { calendarDate.value = calendarDate.value.subtract(1, 'month') }
function nextMonth() { calendarDate.value = calendarDate.value.add(1, 'month') }
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

    <!-- 回撤分析 -->
    <div class="card">
      <div class="section-title" style="margin-bottom: 12px">回撤分析</div>
      <template v-if="portfolio.drawdownStats && portfolio.drawdownStats.maxDrawdownPct !== 0">
        <div class="row between">
          <div>
            <div class="muted">最大回撤</div>
            <div class="num value down">{{ fmtPct(portfolio.drawdownStats.maxDrawdownPct / 100) }}</div>
          </div>
          <div>
            <div class="muted">当前回撤</div>
            <div class="num value down">{{ portfolio.drawdownStats.recovered ? '已修复' : fmtPct(portfolio.drawdownStats.maxDrawdownPct / 100) }}</div>
          </div>
        </div>
        <div class="row between" style="margin-top: 12px">
          <div>
            <div class="muted">峰值日期</div>
            <div class="num">{{ portfolio.drawdownStats.peakDate || '—' }}</div>
          </div>
          <div>
            <div class="muted">谷底日期</div>
            <div class="num">{{ portfolio.drawdownStats.troughDate || '—' }}</div>
          </div>
          <div>
            <div class="muted">下跌历时</div>
            <div class="num">{{ portfolio.drawdownStats.days }} 天</div>
          </div>
        </div>
      </template>
      <div ref="drawdownRef" class="chart"></div>
    </div>

    <!-- 盈亏日历 -->
    <div class="card">
      <div class="section-title" style="margin-bottom: 12px">盈亏日历</div>
      <div class="row between" style="margin-bottom: 12px">
        <el-icon @click="prevMonth"><ArrowLeft /></el-icon>
        <span class="section-title">{{ calendarDate.format('YYYY年M月') }}</span>
        <el-icon @click="nextMonth"><ArrowRight /></el-icon>
      </div>
      <div class="row between" style="margin-bottom: 12px">
        <div>
          <span class="muted">本月变动</span>
          <span class="num" style="margin-left: 8px" :class="pnlClass(monthChange)">
            {{ monthChange > 0 ? '+' : '' }}{{ fmtMoney(monthChange, 0) }}
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
          <div v-if="dailyMap[d.format('YYYY-MM-DD')]" class="cell-pnl num" :class="pnlClass(dailyMap[d.format('YYYY-MM-DD')].amount)">
            {{ dailyMap[d.format('YYYY-MM-DD')].amount > 0 ? '+' : '' }}{{ fmtNum(dailyMap[d.format('YYYY-MM-DD')].amount, 0) }}
          </div>
        </div>
      </div>
    </div>

    <el-tabs v-model="activeTab" class="analysis-tabs">
      <el-tab-pane label="净值曲线" name="netValue">
        <div ref="netValueRef" class="chart"></div>
      </el-tab-pane>
      <el-tab-pane label="收益曲线" name="curve">
        <div ref="curveRef" class="chart"></div>
      </el-tab-pane>

      <el-tab-pane label="月度" name="monthly">
        <div ref="monthlyRef" class="chart"></div>
        <div v-if="portfolio.monthly.length" class="card">
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
      </el-tab-pane>
      <el-tab-pane label="年度" name="yearly">
        <div ref="yearlyRef" class="chart"></div>
        <div v-if="portfolio.yearly.length" class="card">
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
      </el-tab-pane>
    </el-tabs>
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
.analysis-tabs {
  padding: 0 8px;
}
.chart {
  height: 300px;
  margin: 8px 8px 0;
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
  aspect-ratio: 1;
  border-radius: 8px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  padding: 2px;
}
.calendar-cell.muted {
  opacity: 0.35;
}
.calendar-cell.today {
  border: 1.5px solid var(--primary);
}
.cell-date {
  font-size: 12px;
}
.cell-pnl {
  font-size: 11px;
  font-weight: 700;
  margin-top: 1px;
}
</style>
