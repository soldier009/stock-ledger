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

function drawDay() {
  const data = dayData.value
  if (!data.length) {
    chart.clear()
    return
  }
  chart.setOption({
    ...baseOption(),
    xAxis: {
      ...baseOption().xAxis,
      boundaryGap: false,
      data: data.map((d) => d.date.slice(5))
    },
    yAxis: baseOption().yAxis,
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

function monthData() {
  const map = new Map()
  for (const p of portfolio.netValue) {
    const key = p.date.slice(0, 7)
    map.set(key, p.netValue)
  }
  return [...map.entries()]
    .map(([month, netValue]) => ({ month, netValue: Math.round(netValue * 100) / 100 }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

function yearData() {
  const map = new Map()
  for (const p of portfolio.netValue) {
    const key = p.date.slice(0, 4)
    map.set(key, p.netValue)
  }
  return [...map.entries()]
    .map(([year, netValue]) => ({ year, netValue: Math.round(netValue * 100) / 100 }))
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
  if (!chartRef.value) return
  if (!chart) chart = echarts.init(chartRef.value)
  chart.clear()
  if (mode.value === 'day') drawDay()
  else if (mode.value === 'month') drawMonth()
  else drawYear()
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
    draw()
  }
})

function onResize() {
  if (chart) chart.resize()
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  if (visible.value) draw()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  if (chart) {
    chart.dispose()
    chart = null
  }
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
