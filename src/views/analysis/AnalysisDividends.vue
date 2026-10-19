<script setup>
/**
 * 分析 › 分红：汇总 + 分红日历（月 / 年切换）+ 明细 + 按标的汇总
 * 金额一律为折人民币（港美股按生效汇率折算），数据源 store.divEvents
 */
import { ref, computed } from 'vue'
import dayjs from 'dayjs'
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../../stores/portfolio'
import { fmtMoney, fmtNum, marketLabel } from '../../utils/format'

const portfolio = usePortfolioStore()

const divs = computed(() => portfolio.divEvents)

/** 有分红的年份，降序（最近在前） */
const years = computed(() => {
  const set = new Set(divs.value.map((d) => String(d.date).slice(0, 4)))
  return [...set].sort((a, b) => (a < b ? 1 : -1))
})

// 年份选择：默认最近的年份；翻到没有数据的年份时自动回到最近一年
const THIS_YEAR = dayjs().format('YYYY')
const pickedYear = ref(years.value[0] || THIS_YEAR)
const year = computed(() => (years.value.includes(pickedYear.value) ? pickedYear.value : years.value[0] || THIS_YEAR))
const view = ref('month') // month | year
// 月视图里点击某个月 -> 只显示该月明细；'' 表示整年
const month = ref('')

const total = computed(() => divs.value.reduce((a, d) => a + d.cny, 0))

const yearDivs = computed(() => divs.value.filter((d) => String(d.date).slice(0, 4) === year.value))
const yearTotal = computed(() => yearDivs.value.reduce((a, d) => a + d.cny, 0))
const yearCount = computed(() => yearDivs.value.length)

// 所选年份 1-12 月
const months = computed(() =>
  Array.from({ length: 12 }, (_, i) => {
    const key = String(i + 1).padStart(2, '0')
    const list = yearDivs.value.filter((d) => String(d.date).slice(5, 7) === key)
    return {
      key,
      label: `${i + 1}月`,
      amount: list.reduce((a, d) => a + d.cny, 0),
      count: list.length,
      // 未来月份置灰，避免误导
      future: Number(`${year.value}${key}`) > Number(dayjs().format('YYYYMM'))
    }
  })
)

// 逐年汇总（年视图）
const yearRows = computed(() =>
  years.value.map((y) => {
    const list = divs.value.filter((d) => String(d.date).slice(0, 4) === y)
    return {
      year: y,
      amount: list.reduce((a, d) => a + d.cny, 0),
      count: list.length
    }
  })
)

// 明细：受所选年份（及可选月份）约束，按日期倒序
const rows = computed(() => {
  const list = month.value ? yearDivs.value.filter((d) => String(d.date).slice(5, 7) === month.value) : yearDivs.value
  return list.map((d) => ({
    id: d.id,
    date: d.date,
    name: d.name || d.code,
    code: d.code,
    market: d.market,
    amount: Number(d.amount) || 0,
    cny: d.cny,
    broker: d.broker || '',
    note: d.note || '',
    // 原币与折算后差异明显时（港美股）额外标注原币金额
    foreign: d.market === 'HK' || d.market === 'US'
  }))
})

// 按标的汇总：累计分红、次数、最近一次到账日
const byStock = computed(() => {
  const map = new Map()
  for (const d of divs.value) {
    const key = `${d.market}:${d.code}`
    const cur = map.get(key) || { key, name: d.name || d.code, code: d.code, market: d.market, cny: 0, count: 0, last: '' }
    cur.cny += d.cny
    cur.count += 1
    if (!cur.last || String(d.date) > cur.last) cur.last = String(d.date)
    map.set(key, cur)
  }
  return [...map.values()].sort((a, b) => b.cny - a.cny)
})

function prevYear() {
  pickedYear.value = String(Number(year.value) - 1)
  month.value = ''
}
function nextYear() {
  pickedYear.value = String(Number(year.value) + 1)
  month.value = ''
}
function pickMonth(key) {
  if (months.value.find((m) => m.key === key).future) return
  month.value = month.value === key ? '' : key
}
function pickYear(y) {
  pickedYear.value = y
  view.value = 'month'
}
function clearMonth() {
  month.value = ''
}
const monthLabel = computed(() => (month.value ? `${Number(month.value)}月` : ''))
</script>

<template>
  <div>
    <!-- 汇总 -->
    <div class="card">
      <div class="section-title">分红汇总</div>
      <div class="div-sum">
        <div>
          <div class="muted">累计应得分红</div>
          <div class="num sum-value">¥{{ fmtNum(total, 0) }}</div>
        </div>
        <div>
          <div class="muted">{{ year }}年应得分红</div>
          <div class="num sum-value">¥{{ fmtNum(yearTotal, 0) }}</div>
        </div>
        <div>
          <div class="muted">{{ year }}年分红次数</div>
          <div class="num sum-value">{{ yearCount }}</div>
        </div>
      </div>
    </div>

    <!-- 分红日历 -->
    <div class="card">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">分红日历</div>
        <div class="pie-switch">
          <span :class="{ active: view === 'month' }" @click="view = 'month'">月</span>
          <span :class="{ active: view === 'year' }" @click="view = 'year'">年</span>
        </div>
      </div>

      <!-- 月视图：所选年份 12 个月 -->
      <template v-if="view === 'month'">
        <div class="div-nav">
          <div class="nav-item">
            <el-icon @click="prevYear"><ArrowLeft /></el-icon>
            <span class="nav-title">{{ year }}年</span>
            <el-icon @click="nextYear"><ArrowRight /></el-icon>
          </div>
        </div>
        <div class="div-grid">
          <div
            v-for="m in months"
            :key="m.key"
            class="div-cell"
            :class="{ clickable: m.count > 0, active: month === m.key, future: m.future }"
            @click="pickMonth(m.key)"
          >
            <div class="cell-label">{{ m.label }}</div>
            <template v-if="m.count">
              <div class="num cell-amt">¥{{ fmtNum(m.amount, 0) }}</div>
              <div class="cell-sub">{{ m.count }} 笔</div>
            </template>
            <div v-else class="cell-empty">—</div>
          </div>
        </div>
        <div v-if="month" class="row" style="margin-top: 10px">
          <span class="month-chip" @click="clearMonth">已选 {{ monthLabel }} ×</span>
        </div>
      </template>

      <!-- 年视图：逐年份合计，点某年进入该年的月视图 -->
      <template v-else>
        <div class="div-grid">
          <div v-for="y in yearRows" :key="y.year" class="div-cell clickable" @click="pickYear(y.year)">
            <div class="cell-label">{{ y.year }}</div>
            <div class="num cell-amt">¥{{ fmtNum(y.amount, 0) }}</div>
            <div class="cell-sub">{{ y.count }} 笔</div>
          </div>
          <div v-if="!yearRows.length" class="muted" style="grid-column: 1 / -1; text-align: center; padding: 12px">
            暂无分红记录
          </div>
        </div>
      </template>
      <div class="muted" style="font-size: 11px; margin-top: 8px">金额按当前汇率折算为人民币</div>
    </div>

    <!-- 分红明细 -->
    <div class="card">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">分红明细</div>
        <span class="muted">{{ rows.length }} 笔</span>
      </div>
      <div v-if="rows.length" class="div-list">
        <div v-for="r in rows" :key="r.id" class="div-item">
          <div class="div-item-main">
            <span class="div-name">{{ r.name }}</span>
            <span class="div-meta">
              {{ marketLabel(r.market) }} · {{ r.code }}<template v-if="r.broker"> · {{ r.broker }}</template>
            </span>
            <span v-if="r.note" class="div-meta">{{ r.note }}</span>
          </div>
          <div class="div-item-side">
            <span class="num div-amt">¥{{ fmtMoney(r.cny, 2) }}</span>
            <span v-if="r.foreign" class="div-meta">到账 {{ fmtNum(r.amount, 2) }} 原币</span>
            <span class="div-meta">{{ r.date }}</span>
          </div>
        </div>
      </div>
      <div v-else class="muted" style="text-align: center; padding: 12px">
        {{ year }}年{{ month ? `${monthLabel}` : '' }}暂无分红记录
      </div>
    </div>

    <!-- 按标的汇总 -->
    <div class="card">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">按标的汇总</div>
        <span class="muted">累计 {{ byStock.length }} 只</span>
      </div>
      <div v-if="byStock.length" class="div-stock-list">
        <div v-for="s in byStock" :key="s.key" class="div-stock">
          <div class="div-stock-main">
            <span class="div-name">{{ s.name }}</span>
            <span class="div-meta">{{ marketLabel(s.market) }} · {{ s.code }}</span>
          </div>
          <div class="div-stock-side">
            <span class="num div-amt">¥{{ fmtNum(s.cny, 2) }}</span>
            <span class="div-meta">{{ s.count }} 次 · 最近 {{ s.last }}</span>
          </div>
        </div>
      </div>
      <div v-else class="muted" style="text-align: center; padding: 12px">暂无分红记录</div>
    </div>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 12px;
}
.div-sum {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px 8px;
}
.sum-value {
  font-size: 15px;
  font-weight: 700;
  margin-top: 4px;
}
.div-nav {
  display: flex;
  justify-content: center;
  margin-bottom: 12px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 14px;
  cursor: pointer;
  user-select: none;
}
.nav-item .el-icon {
  color: var(--text-2);
}
.nav-title {
  font-size: 16px;
  font-weight: 700;
}
.div-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}
.div-cell {
  aspect-ratio: 1.05;
  border-radius: 8px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3px 1px;
  overflow: hidden;
}
.div-cell.clickable {
  cursor: pointer;
}
.div-cell.clickable:active {
  background: #eef2f7;
}
.div-cell.active {
  border: 1.5px solid var(--primary);
}
/* 未到月份：整格淡显，避免误以为「为零」 */
.div-cell.future {
  opacity: 0.4;
}
.cell-label {
  font-size: 11px;
  line-height: 1.1;
}
.cell-amt {
  font-size: 10px;
  font-weight: 700;
  margin-top: 1px;
  line-height: 1.1;
  white-space: nowrap;
  color: #dc2626;
}
.cell-sub {
  font-size: 8px;
  color: var(--text-2);
  line-height: 1.1;
}
.cell-empty {
  color: #cbd5e1;
  font-size: 11px;
  margin-top: 4px;
}
.month-chip {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 12px;
  background: #fdecec;
  color: #dc2626;
  cursor: pointer;
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
.div-item,
.div-stock {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 0;
  border-bottom: 1px solid #f1f5f9;
}
.div-item:last-child,
.div-stock:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.div-item-main,
.div-stock-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.div-name {
  font-size: 13px;
  font-weight: 600;
}
.div-meta {
  font-size: 11px;
  color: var(--text-2);
}
.div-item-side,
.div-stock-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}
.div-amt {
  font-size: 13px;
  font-weight: 700;
  color: #dc2626;
}
</style>
