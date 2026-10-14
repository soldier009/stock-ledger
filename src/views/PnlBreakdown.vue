<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue'
import * as echarts from 'echarts'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtPct, marketLabel, pnlClass } from '../utils/format'
import {
  DIM_TAG,
  DIM_PURPOSE,
  PALETTE,
  dimLabel,
  matchDim
} from '../utils/composition'
import { buildPnlRows, sumRows, groupRows, untaggedRows, hasForeignRealized } from '../utils/pnl'
import DonutChart from '../components/DonutChart.vue'

const route = useRoute()
const router = useRouter()
const portfolio = usePortfolioStore()

// 两级结构：
//   一级 /pnl                        按「资产类别 / 用途」分组
//   二级 /pnl?dim=tag&key=网格        该分类下直接列出标的盈亏明细（不再按另一维度分组）
const level = computed(() => {
  const dim = route.query.dim === DIM_PURPOSE ? DIM_PURPOSE : DIM_TAG
  const key = route.query.key ? String(route.query.key) : ''
  return { dim, key, stage: key ? 2 : 1 }
})

const dimTab = ref(level.value.dim)
watch(
  () => route.query.dim,
  (v) => {
    dimTab.value = v === DIM_PURPOSE ? DIM_PURPOSE : DIM_TAG
  }
)

const includeUntagged = ref(false)

// 全量标的：当前持仓 + 已清仓标的
const allRows = computed(() =>
  buildPnlRows(portfolio.positions, portfolio.realizedEvents, portfolio.closedRounds)
)

// 当前作用域下的标的（二级按一级维度过滤）
const scoped = computed(() => {
  const { dim, key, stage } = level.value
  let list = allRows.value
  if (stage === 2) list = list.filter((r) => matchDim(r, dim, key))
  return list
})

const scopeSum = computed(() => sumRows(scoped.value))
// 一级分母为全部标的成本合计，二级为该分类合计
const costTotal = computed(() => (level.value.stage === 1 ? sumRows(allRows.value).cost : scopeSum.value.cost))

const groupDim = computed(() => dimTab.value)
const groups = computed(() => groupRows(scoped.value, groupDim.value, { includeUntagged: includeUntagged.value }))
const missing = computed(() => untaggedRows(scoped.value, groupDim.value))
// 港美股已实现盈亏是交易原币，未折人民币
const foreign = computed(() => hasForeignRealized(scoped.value))

function signed(v, digits = 2) {
  const n = Number(v) || 0
  const s = fmtMoney(n, digits)
  return n > 0 ? '+' + s : s
}
function signedPct(v, digits = 2) {
  const n = Number(v) || 0
  return (n > 0 ? '+' : '') + fmtPct(n, digits)
}
// 今日盈亏：无行情 / 已清仓时显示「—」，与总览口径一致
function todayText(sum) {
  return sum && sum.hasToday ? signed(sum.today, 0) : '—'
}
function pctOfCost(v) {
  const t = costTotal.value
  if (!(t > 0)) return '0.0'
  return (((Number(v) || 0) / t) * 100).toFixed(1)
}

const centerValue = computed(() => signed(scopeSum.value.totalPnl, 0))
const centerSub = computed(() => {
  const s = scopeSum.value
  if (level.value.stage === 1) {
    return `${groups.value.length} 个${dimLabel(groupDim.value)} · ${s.count} 项`
  }
  return `${s.count} 项 · 成本 ${fmtMoney(s.cost, 0)}`
})

const donutItems = computed(() =>
  groups.value.map((g, i) => ({
    name: g.name,
    value: g.cost,
    color: PALETTE[i % PALETTE.length]
  }))
)

function onRowClick(group) {
  if (level.value.stage === 1) {
    router.push({ path: '/pnl', query: { dim: dimTab.value, key: group.name } })
  }
}

// 标的走势页：显示该股票的收益信息与走势曲线（清仓标的同样可看历史曲线）
function goStock(r) {
  router.push(`/stock/${r.market}/${r.code}/trend`)
}

// ===== 二级页顶部的「该分类合计走势」=====
// 数据直接取资产序列按标签 / 用途拆出的当日市值合计，与分组口径一致
const GROUP_RANGES = [
  { key: '3m', label: '近三月' },
  { key: '1y', label: '近一年' },
  { key: 'all', label: '全部' }
]
const groupRange = ref('1y')
const groupRef = ref(null)
let groupChart = null

const groupPoints = computed(() => {
  if (level.value.stage !== 2) return []
  const key = level.value.key
  const dim = level.value.dim
  const from =
    groupRange.value === '3m'
      ? dayjs().subtract(3, 'month')
      : groupRange.value === '1y'
        ? dayjs().subtract(1, 'year')
        : null
  return (portfolio.assetSeries || [])
    .filter((p) => !from || !dayjs(p.date).isBefore(from, 'day'))
    .map((p) => ({
      date: p.date,
      value: Math.round(((dim === DIM_PURPOSE ? p.byPurpose : p.byTag) || {})[key] || 0)
    }))
    .filter((p) => Math.abs(p.value) > 0.005)
})

function drawGroupCurve() {
  if (level.value.stage !== 2) return
  if (!groupRef.value) return
  if (!groupChart) groupChart = echarts.init(groupRef.value)
  const pts = groupPoints.value
  if (!pts.length) {
    groupChart.clear()
    return
  }
  groupChart.setOption(
    {
      grid: { left: 58, right: 16, top: 16, bottom: 26 },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const arr = Array.isArray(params) ? params : [params]
          if (!arr.length) return ''
          return `${arr[0].axisValueLabel}<br/>市值　¥${fmtNum(arr[0].value, 0)}`
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
          data: pts.map((p) => p.value),
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
          }
        }
      ]
    },
    true
  )
}

watch(
  [() => level.value.stage, () => level.value.key, groupRange, () => portfolio.assetSeries],
  () => {
    nextTick(() => {
      if (level.value.stage === 2) {
        drawGroupCurve()
        if (groupChart) groupChart.resize()
      }
    })
  },
  { immediate: true, deep: false }
)

onBeforeUnmount(() => {
  if (groupChart) {
    groupChart.dispose()
    groupChart = null
  }
})
</script>

<template>
  <div>
    <div class="page-header">
      <div class="row gap8">
        <el-icon class="back-icon" @click="router.back()"><ArrowLeft /></el-icon>
        <div class="page-title">成本与盈亏</div>
      </div>
    </div>

    <!-- 二级面包屑：一级维度 → 具体分类 -->
    <div v-if="level.stage === 2" class="card crumb-card">
      <div class="crumb-row">
        <span class="crumb-chip">{{ dimLabel(level.dim) }} · {{ level.key }}</span>
        <el-icon class="crumb-arrow"><ArrowRight /></el-icon>
        <span class="crumb-chip active">标的明细</span>
      </div>
    </div>

    <!-- 一级：环形图（占总投资）+ 分组列表 -->
    <div class="card" v-if="level.stage === 1">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">成本与盈亏</div>
        <span class="muted">成本 {{ fmtMoney(scopeSum.cost, 0) }}</span>
      </div>

      <div class="dim-tabs">
        <span :class="{ active: dimTab === DIM_TAG }" @click="dimTab = DIM_TAG">资产类别</span>
        <span :class="{ active: dimTab === DIM_PURPOSE }" @click="dimTab = DIM_PURPOSE">用途</span>
      </div>

      <DonutChart
        :items="donutItems"
        center-label="合计盈亏"
        :center-value="centerValue"
        :center-sub="centerSub"
        :center-font-size="20"
        :radius="['68%', '84%']"
        height="300px"
      />

      <div class="pnl-sum">
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">成本</div>
          <div class="pnl-sum-value">{{ fmtMoney(scopeSum.cost, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">市值</div>
          <div class="pnl-sum-value">{{ fmtMoney(scopeSum.mv, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">浮动盈亏</div>
          <div class="pnl-sum-value" :class="pnlClass(scopeSum.floating)">{{ signed(scopeSum.floating, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">今日盈亏</div>
          <div class="pnl-sum-value" :class="scopeSum.hasToday ? pnlClass(scopeSum.today) : ''">
            {{ todayText(scopeSum) }}
          </div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">已实现盈亏</div>
          <div class="pnl-sum-value" :class="pnlClass(scopeSum.realized)">{{ signed(scopeSum.realized, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">合计盈亏</div>
          <div class="pnl-sum-value" :class="pnlClass(scopeSum.totalPnl)">{{ signed(scopeSum.totalPnl, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">收益率</div>
          <div class="pnl-sum-value" :class="pnlClass(scopeSum.returnPct)">{{ signedPct(scopeSum.returnPct) }}</div>
        </div>
      </div>

      <div v-if="foreign" class="muted pnl-note">港美股已实现盈亏按交易原币计，未折人民币</div>

      <div class="comp-switch">
        <span class="muted">包含无标签项</span>
        <el-switch v-model="includeUntagged" size="small" />
      </div>

      <div v-if="groups.length" class="comp-list">
        <div
          v-for="(g, i) in groups"
          :key="g.name"
          class="comp-row clickable"
          @click="onRowClick(g)"
        >
          <div class="comp-row-top">
            <div class="item-dot" :style="{ backgroundColor: PALETTE[i % PALETTE.length] }"></div>
            <div class="item-name">
              {{ g.name }}
              <span class="item-count">{{ g.count }} 项</span>
            </div>
            <div class="item-amount" :class="pnlClass(g.totalPnl)">{{ signed(g.totalPnl, 0) }}</div>
            <el-icon class="item-arrow"><ArrowRight /></el-icon>
          </div>
          <div class="pnl-row-meta">
            <span>成本 {{ fmtMoney(g.cost, 0) }}</span>
            <span>浮动 <b :class="pnlClass(g.floating)">{{ signed(g.floating, 0) }}</b></span>
            <span>今日 <b :class="g.hasToday ? pnlClass(g.today) : ''">{{ todayText(g) }}</b></span>
            <span>已实现 <b :class="pnlClass(g.realized)">{{ signed(g.realized, 0) }}</b></span>
            <span>收益率 <b :class="pnlClass(g.returnPct)">{{ signedPct(g.returnPct) }}</b></span>
          </div>
          <div class="comp-row-bar">
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: pctOfCost(g.cost) + '%', backgroundColor: PALETTE[i % PALETTE.length] }"></div>
            </div>
            <span class="bar-pct">{{ pctOfCost(g.cost) }}%</span>
          </div>
        </div>
      </div>
      <div v-else class="muted" style="text-align: center; padding: 20px">暂无数据</div>

      <div v-if="!includeUntagged && missing.count" class="comp-missing">
        未计入：未设置{{ dimLabel(groupDim) }}的 {{ missing.count }} 项，成本合计 {{ fmtMoney(missing.cost, 0) }}
      </div>
    </div>

    <!-- 二级：该分类下的标的盈亏明细 -->
    <div class="card" v-else>
      <div class="row between" style="margin-bottom: 8px">
        <div class="section-title">{{ level.key }}</div>
        <span class="muted">{{ scoped.length }} 项</span>
      </div>

      <div class="pnl-sum">
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">成本</div>
          <div class="pnl-sum-value">{{ fmtMoney(scopeSum.cost, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">市值</div>
          <div class="pnl-sum-value">{{ fmtMoney(scopeSum.mv, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">浮动盈亏</div>
          <div class="pnl-sum-value" :class="pnlClass(scopeSum.floating)">{{ signed(scopeSum.floating, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">今日盈亏</div>
          <div class="pnl-sum-value" :class="scopeSum.hasToday ? pnlClass(scopeSum.today) : ''">
            {{ todayText(scopeSum) }}
          </div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">已实现盈亏</div>
          <div class="pnl-sum-value" :class="pnlClass(scopeSum.realized)">{{ signed(scopeSum.realized, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">合计盈亏</div>
          <div class="pnl-sum-value" :class="pnlClass(scopeSum.totalPnl)">{{ signed(scopeSum.totalPnl, 0) }}</div>
        </div>
        <div class="pnl-sum-item">
          <div class="pnl-sum-label">收益率</div>
          <div class="pnl-sum-value" :class="pnlClass(scopeSum.returnPct)">{{ signedPct(scopeSum.returnPct) }}</div>
        </div>
      </div>

      <div v-if="foreign" class="muted pnl-note">港美股已实现盈亏按交易原币计，未折人民币</div>

      <!-- 该分类下股票合计的市值走势 -->
      <div class="trend-block">
        <div class="row between">
          <span class="section-title" style="margin: 0">合计市值走势</span>
          <div class="trend-tabs">
            <span
              v-for="r in GROUP_RANGES"
              :key="r.key"
              :class="{ active: groupRange === r.key }"
              @click="groupRange = r.key"
            >
              {{ r.label }}
            </span>
          </div>
        </div>
        <div v-show="groupPoints.length" ref="groupRef" class="trend-chart"></div>
        <div v-if="!groupPoints.length" class="muted" style="text-align: center; padding: 16px 0">
          暂无走势数据
        </div>
      </div>

      <div v-if="scoped.length" class="comp-list">
        <div
          v-for="(r, i) in scoped"
          :key="r.key"
          class="pnl-detail clickable"
          @click="goStock(r)"
        >
          <div class="pnl-detail-top">
            <div class="item-dot" :style="{ backgroundColor: PALETTE[i % PALETTE.length] }"></div>
            <div class="item-name">
              {{ r.name }}
              <span class="item-count">{{ marketLabel(r.market) }} {{ r.code }}</span>
              <span v-if="r.closed" class="closed-tag">已清仓</span>
            </div>
            <div class="item-amount" :class="pnlClass(r.totalPnl)">{{ signed(r.totalPnl, 0) }}</div>
            <el-icon v-if="!r.closed" class="item-arrow"><ArrowRight /></el-icon>
          </div>
          <div class="pnl-grid">
            <div><span>成本</span><b>{{ fmtMoney(r.cost, 0) }}</b></div>
            <div><span>市值</span><b>{{ r.closed ? '—' : fmtMoney(r.mv, 0) }}</b></div>
            <div><span>浮动盈亏</span><b :class="pnlClass(r.floating)">{{ r.closed ? '—' : signed(r.floating, 0) }}</b></div>
            <div><span>今日盈亏</span><b :class="r.hasToday ? pnlClass(r.today) : ''">{{ todayText(r) }}</b></div>
            <div><span>已实现盈亏</span><b :class="pnlClass(r.realized)">{{ signed(r.realized, 0) }}</b></div>
            <div><span>收益率</span><b :class="pnlClass(r.returnPct)">{{ r.closed ? '—' : signedPct(r.returnPct) }}</b></div>
            <div><span>{{ level.stage === 2 ? '占该分类' : '占总投资' }}</span><b>{{ pctOfCost(r.cost) }}%</b></div>
          </div>
        </div>
      </div>
      <div v-else class="muted" style="text-align: center; padding: 20px">暂无数据</div>
    </div>
  </div>
</template>

<style scoped>
.crumb-card {
  padding: 10px 14px;
}
.crumb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.crumb-chip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 14px;
  background: #f1f5f9;
  color: var(--text-2, #64748b);
  cursor: default;
}
.crumb-chip.active {
  background: #dc2626;
  color: #fff;
  font-weight: 600;
}
.crumb-arrow {
  color: #94a3b8;
  font-size: 12px;
}
.dim-tabs {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.dim-tabs span {
  padding: 7px 16px;
  border-radius: 18px;
  font-size: 13px;
  background: #f1f5f9;
  color: #64748b;
  cursor: pointer;
}
.dim-tabs span.active {
  background: #0d9488;
  color: #fff;
  font-weight: 600;
}
.comp-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 12px 0;
  padding: 10px 0;
  border-top: 1px solid #f1f5f9;
  border-bottom: 1px solid #f1f5f9;
}
.comp-list {
  display: flex;
  flex-direction: column;
}
.comp-row {
  padding: 8px 0;
}
.comp-row.clickable,
.pnl-detail.clickable {
  cursor: pointer;
}
.comp-row-top,
.pnl-detail-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.item-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: 0 0 12px;
}
.item-name {
  flex: 1;
  font-size: 13px;
  min-width: 0;
}
.item-count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-2, #64748b);
}
.closed-tag {
  margin-left: 6px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #f1f5f9;
  color: #94a3b8;
}
.item-amount {
  font-size: 13px;
  font-weight: 600;
  flex: 0 0 auto;
}
.item-arrow {
  color: #cbd5e1;
  font-size: 14px;
  flex: 0 0 14px;
}
.pnl-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
  padding-left: 22px;
  font-size: 11px;
  color: var(--text-2, #64748b);
}
.pnl-row-meta b {
  font-weight: 600;
}
.comp-row-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding-left: 22px;
}
.bar-track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #f1f5f9;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 3px;
}
.bar-pct {
  width: 56px;
  text-align: right;
  font-size: 12px;
  color: var(--text-2, #64748b);
}
.comp-missing {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-2, #64748b);
}
.pnl-note {
  font-size: 11px;
  margin-bottom: 4px;
}
/* 合计条：六个指标两行铺开 */
.pnl-sum {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 6px 0 12px;
}
.pnl-sum-item {
  background: #f8fafc;
  border-radius: 8px;
  padding: 8px 10px;
}
.pnl-sum-label {
  font-size: 11px;
  color: var(--text-2, #64748b);
}
.pnl-sum-value {
  font-size: 14px;
  font-weight: 600;
  margin-top: 2px;
}
.pnl-detail {
  padding: 10px 0;
  border-bottom: 1px solid #f8fafc;
}
/* 二级页顶部的分类合计走势 */
.trend-block {
  margin: 10px 0 4px;
}
.trend-chart {
  width: 100%;
  height: 190px;
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
/* 自适应列数：宽屏排 4 列，窄屏自动降到 3 列，单格不小于 72px 保证金额放得下 */
.pnl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
  gap: 10px 6px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-2, #64748b);
}
.pnl-grid > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.pnl-grid b {
  display: block;
  margin-top: 2px;
  font-weight: 600;
  font-size: 12px;
  line-height: 1.3;
  color: #334155;
}
</style>
