<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, marketLabel } from '../utils/format'
import {
  DIM_TAG,
  DIM_PURPOSE,
  DIM_STOCK,
  CASH_COLOR,
  PALETTE,
  dimLabel,
  otherDim,
  matchDim,
  groupBy,
  untaggedOf
} from '../utils/composition'
import DonutChart from '../components/DonutChart.vue'

const route = useRoute()
const router = useRouter()
const portfolio = usePortfolioStore()

// 三级结构：
//   一级 /composition                                  按「资产类别 / 用途」分组
//   二级 /composition?dim=tag&key=海外指数基金          该分类内按另一维度分组
//   三级 /composition?dim=tag&key=海外指数基金&skey=长期投资   具体持仓明细
const level = computed(() => {
  const dim = route.query.dim === DIM_PURPOSE ? DIM_PURPOSE : DIM_TAG
  const key = route.query.key ? String(route.query.key) : ''
  const skey = route.query.skey ? String(route.query.skey) : ''
  const stage = !key ? 1 : !skey ? 2 : 3
  return { dim, key, skey, subDim: otherDim(dim), stage }
})

// 一级的分组维度（资产类别 / 用途）
const dimTab = ref(level.value.dim)
watch(
  () => route.query.dim,
  (v) => {
    dimTab.value = v === DIM_PURPOSE ? DIM_PURPOSE : DIM_TAG
  }
)

const includeUntagged = ref(false)

const cash = computed(() => Number(portfolio.totals?.cash) || 0)
const totalAssets = computed(() => Number(portfolio.totals?.totalAssets) || 0)

// 当前作用域内的持仓（二级按一级维度过滤，三级再按二级维度过滤）
const scoped = computed(() => {
  const { dim, key, subDim, skey, stage } = level.value
  let list = portfolio.positions
  if (stage >= 2) list = list.filter((p) => matchDim(p, dim, key))
  if (stage === 3) list = list.filter((p) => matchDim(p, subDim, skey))
  return list
})

const scopeTotal = computed(() => scoped.value.reduce((a, p) => a + (Number(p.mvCny) || 0), 0))
// 一级分母为总资产（含现金），二/三级为该分类合计
const total = computed(() => (level.value.stage === 1 ? totalAssets.value : scopeTotal.value))

// 按个股模式：不做分组，每只持仓单独一块（与总览「持仓分布-按个股」同口径）
const stockMode = ref(false)
// 切换层级时回到分类视图
watch(() => route.fullPath, () => {
  stockMode.value = false
})

// 一级用当前 tab 的维度，二级用另一维度；按个股时直接铺开持仓
const groupDim = computed(() => {
  if (stockMode.value) return DIM_STOCK
  return level.value.stage === 1 ? dimTab.value : level.value.subDim
})
const groups = computed(() =>
  stockMode.value ? [] : groupBy(scoped.value, groupDim.value, { includeUntagged: includeUntagged.value })
)
const missing = computed(() =>
  stockMode.value ? { value: 0, count: 0 } : untaggedOf(scoped.value, groupDim.value)
)

const rows = computed(() => {
  const list = stockMode.value
    ? scoped.value
        .slice()
        .sort((a, b) => (Number(b.mvCny) || 0) - (Number(a.mvCny) || 0))
        .map((p, i) => ({
          key: p.market + ':' + p.code,
          name: p.name || p.code,
          value: Number(p.mvCny) || 0,
          count: 1,
          color: PALETTE[i % PALETTE.length],
          cash: false,
          stock: true,
          pos: p
        }))
    : groups.value.map((g, i) => ({
        key: g.key,
        name: g.name,
        value: g.value,
        count: g.count,
        color: PALETTE[i % PALETTE.length],
        cash: false,
        stock: false
      }))
  if (level.value.stage === 1 && cash.value > 0) {
    list.push({ key: '__cash__', name: '现金', value: cash.value, count: 0, color: CASH_COLOR, cash: true, stock: false })
  }
  return list
})

const groupCount = computed(() => (stockMode.value ? scoped.value.length : groups.value.length))
const itemCount = computed(() =>
  stockMode.value ? scoped.value.length : groups.value.reduce((a, g) => a + g.count, 0)
)

function pct(v) {
  const t = total.value
  if (!(t > 0)) return '0.0'
  return (((Number(v) || 0) / t) * 100).toFixed(1)
}

const centerLabel = computed(() => (level.value.stage === 1 ? '总资产' : '合计'))
const centerValue = computed(() => fmtMoney(total.value, 2))
const centerSub = computed(() =>
  stockMode.value
    ? `${scoped.value.length} 只标的`
    : `${groupCount.value} 个${dimLabel(groupDim.value)} · ${itemCount.value} 项`
)

function onRowClick(row) {
  if (row.cash) return
  // 按个股模式：直接进个股详情
  if (row.stock) {
    goStock(row.pos)
    return
  }
  const { stage, dim, key } = level.value
  if (stage === 1) {
    router.push({ path: '/composition', query: { dim: dimTab.value, key: row.key } })
  } else if (stage === 2) {
    router.push({ path: '/composition', query: { dim, key, skey: row.key } })
  }
}

function goStock(p) {
  router.push(`/stock/${p.market}/${p.code}`)
}
</script>

<template>
  <div>
    <div class="page-header">
      <div class="row gap8">
        <el-icon class="back-icon" @click="router.back()"><ArrowLeft /></el-icon>
        <div class="page-title">资产构成</div>
      </div>
    </div>

    <!-- 二/三级面包屑：一级维度 → 二级维度 -->
    <div v-if="level.stage >= 2" class="card crumb-card">
      <div class="crumb-row">
        <span class="crumb-chip">{{ dimLabel(level.dim) }} · {{ level.key }}</span>
        <el-icon class="crumb-arrow"><ArrowRight /></el-icon>
        <span class="crumb-chip active">
          {{ dimLabel(level.subDim) }}{{ level.stage === 3 ? ' · ' + level.skey : '' }}
        </span>
      </div>
    </div>

    <!-- 一级 / 二级：环形图 + 分类列表 -->
    <div class="card" v-if="level.stage <= 2">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">{{ level.stage === 1 ? '资产构成' : level.key }}</div>
      </div>

      <!-- 维度切换：一级「资产类别 / 用途 / 按个股」，二级「另一维度 / 按个股」 -->
      <div v-if="level.stage <= 2" class="dim-tabs">
        <template v-if="level.stage === 1">
          <span
            :class="{ active: !stockMode && dimTab === DIM_TAG }"
            @click="dimTab = DIM_TAG; stockMode = false"
          >资产类别</span>
          <span
            :class="{ active: !stockMode && dimTab === DIM_PURPOSE }"
            @click="dimTab = DIM_PURPOSE; stockMode = false"
          >用途</span>
        </template>
        <template v-else>
          <span :class="{ active: !stockMode }" @click="stockMode = false">{{ dimLabel(level.subDim) }}</span>
        </template>
        <span :class="{ active: stockMode }" @click="stockMode = true">按个股</span>
      </div>

      <DonutChart
        :items="rows"
        :center-label="centerLabel"
        :center-value="centerValue"
        :center-sub="centerSub"
        :center-font-size="20"
        :radius="['68%', '84%']"
        height="300px"
      />

      <div v-if="!stockMode" class="comp-switch">
        <span class="muted">包含无标签项</span>
        <el-switch v-model="includeUntagged" size="small" />
      </div>

      <div v-if="rows.length" class="comp-list">
        <div
          v-for="row in rows"
          :key="row.key"
          class="comp-row"
          :class="{ clickable: !row.cash }"
          @click="onRowClick(row)"
        >
          <div class="comp-row-top">
            <div class="item-dot" :style="{ backgroundColor: row.color }"></div>
            <div class="item-name">
              {{ row.name }}
              <span v-if="row.stock" class="item-count">{{ marketLabel(row.pos.market) }} {{ row.pos.code }}</span>
              <span v-else-if="row.count" class="item-count">{{ row.count }} 项</span>
            </div>
            <div class="item-amount">{{ fmtMoney(row.value, 0) }}</div>
            <el-icon v-if="!row.cash" class="item-arrow"><ArrowRight /></el-icon>
          </div>
          <div class="comp-row-bar">
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: pct(row.value) + '%', backgroundColor: row.color }"></div>
            </div>
            <span class="bar-pct">{{ pct(row.value) }}%</span>
          </div>
        </div>
      </div>
      <div v-else class="muted" style="text-align: center; padding: 20px">暂无持仓数据</div>

      <div v-if="!includeUntagged && missing.count" class="comp-missing">
        未计入：未设置{{ dimLabel(groupDim) }}的 {{ missing.count }} 项，合计 {{ fmtMoney(missing.value, 0) }}
      </div>
    </div>

    <!-- 三级：具体持仓明细 -->
    <div class="card" v-else>
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">{{ level.skey }}</div>
        <span class="muted">{{ scoped.length }} 项 · {{ fmtMoney(scopeTotal, 0) }}</span>
      </div>

      <div v-if="scoped.length" class="comp-list">
        <div
          v-for="(p, i) in scoped"
          :key="p.market + p.code"
          class="comp-row clickable"
          @click="goStock(p)"
        >
          <div class="comp-row-top">
            <div class="item-dot" :style="{ backgroundColor: PALETTE[i % PALETTE.length] }"></div>
            <div class="item-name">
              {{ p.name || p.code }}
              <span class="item-count">{{ marketLabel(p.market) }} {{ p.code }}</span>
            </div>
            <div class="item-amount">{{ fmtMoney(p.mvCny, 0) }}</div>
            <el-icon class="item-arrow"><ArrowRight /></el-icon>
          </div>
          <div class="comp-row-bar">
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: pct(p.mvCny) + '%', backgroundColor: PALETTE[i % PALETTE.length] }"></div>
            </div>
            <span class="bar-pct">{{ pct(p.mvCny) }}%</span>
          </div>
        </div>
      </div>
      <div v-else class="muted" style="text-align: center; padding: 20px">暂无持仓数据</div>
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
/* 面包屑只做路径展示，不参与导航：返回统一走左上角箭头 */
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
/* 维度切换：独立大胶囊，选中青绿色（与参考设计一致） */
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
.comp-row.clickable {
  cursor: pointer;
}
.comp-row-top {
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
</style>
