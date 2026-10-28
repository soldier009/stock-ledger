<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtNum, fmtShares, typeLabel, marketLabel, pnlClass } from '../utils/format'
import { rangeBounds, inRange, rangeLabel } from '../utils/dateRange'
import { matchTrade, matchFlow, normKeyword } from '../utils/search'
import TradeForm from '../components/TradeForm.vue'
import CashForm from '../components/CashForm.vue'

const router = useRouter()

const portfolio = usePortfolioStore()
const tradeVisible = ref(false)
const cashVisible = ref(false)
const editingCash = ref(null)
const editingTrade = ref(null)
const showCash = ref(true)

// ===== 查找与筛选（参考主流记账 App：pill 下拉 + 底部弹层选项）=====
// 类型 / 时间 / 券商三个维度叠加生效；关键词通过右上角放大镜展开
const filter = ref('all') // all | bs | div | gift_rights | win
const keyword = ref('')
const searchOpen = ref(false)
const dateRange = ref('all') // all | 7d | 30d | 1y | custom
const customStart = ref('')
const customEnd = ref('')
const brokerFilter = ref('')

const typeOptions = [
  { label: '全部类型', value: 'all' },
  { label: '买入与卖出', value: 'bs' },
  { label: '分红', value: 'div' },
  { label: '送配', value: 'gift_rights' },
  { label: '中签', value: 'win' }
]
const timeOptions = [
  { label: '全部时间', value: 'all' },
  { label: '最近 7 天', value: '7d' },
  { label: '最近 30 天', value: '30d' },
  { label: '最近一年', value: '1y' },
  { label: '自定义', value: 'custom' }
]
const brokerOptions = computed(() => [
  { label: '全部券商', value: '' },
  ...portfolio.brokers.map((b) => ({ label: b, value: b }))
])

// 底部弹层（el-drawer 自底部滑出），一次只开一个维度
const sheet = ref(null) // 'type' | 'time' | 'broker'
const sheetVisible = ref(false)
const sheetTitle = computed(() => ({ type: '类型', time: '时间范围', broker: '券商' }[sheet.value] || ''))
const sheetOptions = computed(
  () => ({ type: typeOptions, time: timeOptions, broker: brokerOptions.value }[sheet.value] || [])
)
const sheetValue = computed(
  () => ({ type: filter.value, time: dateRange.value, broker: brokerFilter.value }[sheet.value])
)
const drawerSize = computed(() => `${Math.min(480, 96 + sheetOptions.value.length * 50)}px`)
function openSheet(k) {
  sheet.value = k
  sheetVisible.value = true
}
function pick(o) {
  if (sheet.value === 'type') filter.value = o.value
  else if (sheet.value === 'time') dateRange.value = o.value
  else brokerFilter.value = o.value
  sheetVisible.value = false
}
function resetSheet() {
  pick({ value: { type: 'all', time: 'all', broker: '' }[sheet.value] })
}

const typePillLabel = computed(() => typeOptions.find((o) => o.value === filter.value)?.label)
const timePillLabel = computed(() => timeOptions.find((o) => o.value === dateRange.value)?.label)

const scope = computed(() => rangeBounds(dateRange.value, customStart.value, customEnd.value))
const hasFilter = computed(
  () =>
    !!normKeyword(keyword.value) ||
    dateRange.value !== 'all' ||
    filter.value !== 'all' ||
    !!brokerFilter.value
)

function resetFilter() {
  keyword.value = ''
  dateRange.value = 'all'
  customStart.value = ''
  customEnd.value = ''
  filter.value = 'all'
  brokerFilter.value = ''
}

// 类型 + 券商 + 关键词 + 日期区间，四者是「且」的关系
function tradeHit(t) {
  if (filter.value === 'bs' && t.type !== 'buy' && t.type !== 'sell') return false
  if (filter.value === 'div' && t.type !== 'div') return false
  if (filter.value === 'gift_rights' && t.type !== 'gift' && t.type !== 'rights') return false
  if (filter.value === 'win' && t.type !== 'win') return false
  if (brokerFilter.value && (t.broker || '') !== brokerFilter.value) return false
  if (!matchTrade(keyword.value, t)) return false
  return inRange(t.date, scope.value.start, scope.value.end)
}

// 按月分组（参考图样式），并汇总当月流入/流出：买入+配股+费用算流出，卖出+分红算流入
function monthLabel(m) {
  const [y, mo] = m.split('-')
  return `${y}年${Number(mo)}月`
}
function tradeFlow(t) {
  const q = Number(t.shares) || 0
  const p = Number(t.price) || 0
  const fee = Number(t.fee) || 0
  const tax = Number(t.tax) || 0
  if (t.type === 'div') return { out: 0, in: Number(t.amount) || 0 }
  if (t.type === 'gift') return { out: 0, in: 0 }
  if (t.type === 'sell') return { out: 0, in: q * p - fee - tax }
  return { out: q * p + fee + tax, in: 0 }
}
const monthGroups = computed(() => {
  const list = [...portfolio.trades]
    .filter(tradeHit)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.id || 0) - (a.id || 0))
  const groups = []
  const map = {}
  for (const t of list) {
    const m = t.date.slice(0, 7)
    if (!map[m]) {
      map[m] = { month: m, label: monthLabel(m), items: [], out: 0, in: 0 }
      groups.push(map[m])
    }
    const f = tradeFlow(t)
    map[m].out += f.out
    map[m].in += f.in
    map[m].items.push(t)
  }
  return groups
})
const tradeCount = computed(() => monthGroups.value.reduce((a, g) => a + g.items.length, 0))

const cashList = computed(() =>
  [...portfolio.cashFlows]
    .filter((c) => {
      if (brokerFilter.value && (c.broker || '') !== brokerFilter.value) return false
      if (!matchFlow(keyword.value, c)) return false
      return inRange(c.date, scope.value.start, scope.value.end)
    })
    .sort((a, b) => b.date.localeCompare(a.date) || (b.id || 0) - (a.id || 0))
)

// 卖出行展示该笔的已实现盈亏（calc 重放时按卖出回合算好，trade id 一一对应）
const realizedByTrade = computed(() => {
  const m = new Map()
  for (const e of portfolio.realizedEvents) {
    if (e.type === 'sell') m.set(e.id, Number(e.amount) || 0)
  }
  return m
})

function shortDate(d) {
  const [, mo, day] = String(d).split('-')
  return `${Number(mo)}月${Number(day)}日`
}

// 空态要说清是「本来就没记录」还是「筛选没命中」，并给一键清空
const emptyText = computed(() => {
  if (!hasFilter.value) return null
  const seg = []
  if (normKeyword(keyword.value)) seg.push(`关键词「${keyword.value.trim()}」`)
  if (filter.value !== 'all') seg.push(typePillLabel.value)
  if (brokerFilter.value) seg.push(brokerFilter.value)
  if (dateRange.value !== 'all') seg.push(rangeLabel(dateRange.value, customStart.value, customEnd.value))
  return `没有符合 ${seg.join(' · ')} 的记录`
})

function tradeAmount(t) {
  if (t.type === 'div') return t.amount
  if (t.type === 'gift') return null
  const q = Number(t.shares) || 0
  const p = Number(t.price) || 0
  return q * p
}

function typeClass(t) {
  return { buy: 'tag-buy', sell: 'tag-sell', div: 'tag-div', gift: 'tag-gift', rights: 'tag-rights', win: 'tag-win' }[t.type] || ''
}

function openEdit(t) {
  editingTrade.value = t
  tradeVisible.value = true
}

function openAdd() {
  editingTrade.value = null
  tradeVisible.value = true
}

async function delTrade(t) {
  try {
    await ElMessageBox.confirm(`确定删除 ${t.name || t.code} 的「${typeLabel(t.type)}」记录？`, '删除确认', { type: 'warning' })
    await portfolio.deleteTrade(t.id)
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}

// 「新建仓」自动产生的入金由系统维护（金额 = 建仓成本、日期随建仓记录联动），不允许手动改：
// 结构化标记是 origin='initial'，老数据可能没回填，再按备注前缀兜底
function isAutoFlow(c) {
  return (
    c.type === 'deposit' &&
    (c.origin === 'initial' || String(c.note || '').startsWith('初始建仓-自动入金（'))
  )
}

function openEditCash(c) {
  if (isAutoFlow(c)) return
  editingCash.value = c
  cashVisible.value = true
}

function openAddCash() {
  editingCash.value = null
  cashVisible.value = true
}

async function delCash(c) {
  // 「新建仓」自动生成的入金与其买入记录成对联动：要删就删对应的建仓买入，
  // 单独删会让那笔买入失去配对的资金记录，本金与成本口径错位
  if (isAutoFlow(c)) {
    ElMessage.warning('该入金由「新建仓」自动生成，请到交易列表删除对应的建仓买入记录')
    return
  }
  try {
    await ElMessageBox.confirm(`确定删除该笔资金记录（${c.type === 'deposit' ? '入金' : '出金'} ¥${fmtNum(c.amount, 2)}）？`, '删除确认', { type: 'warning' })
    await portfolio.deleteCashFlow(c.id)
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}
</script>

<template>
  <div>
    <div class="page-header">
      <div class="row gap8">
        <el-icon class="back-icon" @click="router.back()"><ArrowLeft /></el-icon>
        <div class="page-title">交易</div>
      </div>
      <div class="row gap8">
        <el-icon class="hdr-icon" :class="{ on: searchOpen }" @click="searchOpen = !searchOpen"><Search /></el-icon>
        <el-button size="small" @click="openAddCash">资金</el-button>
        <el-button size="small" type="primary" @click="openAdd">记一笔</el-button>
      </div>
    </div>

    <!-- 查找：关键词（点放大镜展开） -->
    <div v-show="searchOpen" class="search-bar">
      <el-input v-model="keyword" size="small" placeholder="搜名称 / 代码 / 备注 / 券商" clearable>
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
    </div>

    <!-- 筛选 pill：类型 / 时间 / 券商，点击弹底部选项 -->
    <div class="filter-bar">
      <span class="pill" :class="{ active: filter !== 'all' }" @click="openSheet('type')">
        {{ typePillLabel }} <el-icon :size="12"><ArrowDown /></el-icon>
      </span>
      <span class="pill" :class="{ active: dateRange !== 'all' }" @click="openSheet('time')">
        {{ timePillLabel }} <el-icon :size="12"><ArrowDown /></el-icon>
      </span>
      <span class="pill" :class="{ active: !!brokerFilter }" @click="openSheet('broker')">
        {{ brokerFilter || '全部券商' }} <el-icon :size="12"><ArrowDown /></el-icon>
      </span>
    </div>
    <div v-if="dateRange === 'custom'" class="custom-range">
      <el-date-picker
        v-model="customStart"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="开始日期"
        size="small"
        class="range-date"
      />
      <span class="muted">→</span>
      <el-date-picker
        v-model="customEnd"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="结束日期"
        size="small"
        class="range-date"
      />
    </div>
    <div v-if="hasFilter" class="row between filter-summary">
      <span class="muted num">命中 交易 {{ tradeCount }} 笔 · 资金 {{ cashList.length }} 笔</span>
      <span class="clear-link" @click="resetFilter">清空筛选</span>
    </div>

    <!-- 交易流水（按月分组，月度汇总流入/流出） -->
    <template v-if="monthGroups.length">
      <div v-for="g in monthGroups" :key="g.month" class="date-group">
        <div class="month-row">
          <span class="month-label">{{ g.label }}</span>
          <span class="muted num month-flow">
            <template v-if="g.out">流出 ¥{{ fmtNum(g.out, 0) }}</template>
            <template v-if="g.out && g.in"> · </template>
            <template v-if="g.in">流入 ¥{{ fmtNum(g.in, 0) }}</template>
          </span>
        </div>
        <div v-for="t in g.items" :key="t.id" class="trade-item card">
          <div class="row between">
            <div class="row gap8 flex1" style="min-width: 0">
              <span class="type-badge" :class="typeClass(t)">{{ typeLabel(t.type) }}</span>
              <span class="t-name" @click="router.push(`/stock/${t.market}/${t.code}`)">{{ t.name || t.code }}</span>
              <el-tag size="small" effect="plain" type="success">{{ marketLabel(t.market) }}</el-tag>
              <el-tag v-if="t.broker" size="small" effect="plain" type="warning">{{ t.broker }}</el-tag>
            </div>
            <div class="row gap8">
              <el-icon class="del" @click="openEdit(t)"><Edit /></el-icon>
              <el-icon class="del" @click="delTrade(t)"><Delete /></el-icon>
            </div>
          </div>
          <div class="row between t-detail">
            <div class="muted num">
              <template v-if="t.type === 'div'">
                分红 ¥{{ fmtNum(t.amount, 2) }}
              </template>
              <template v-else-if="t.type === 'gift'">
                送股 {{ fmtShares(t.shares, t.market) }} 股
              </template>
              <template v-else>
                {{ t.code }} · {{ fmtShares(t.shares, t.market) }} 股 × {{ fmtNum(t.price, 3) }}
                <span v-if="t.fee || t.tax" class="muted">
                  （费 ¥{{ fmtNum(t.fee, 2) }} · 税 ¥{{ fmtNum(t.tax, 2) }}）
                </span>
              </template>
              <span v-if="t.note" style="margin-left: 8px">{{ t.note }}</span>
              <div v-if="t.type === 'sell' && realizedByTrade.has(t.id)" class="realized-line">
                已实现盈亏
                <span class="num" :class="pnlClass(realizedByTrade.get(t.id))">
                  {{ realizedByTrade.get(t.id) > 0 ? '+' : '' }}¥{{ fmtNum(realizedByTrade.get(t.id), 2) }}
                </span>
              </div>
            </div>
            <div class="col-end">
              <div class="num t-amount" v-if="tradeAmount(t) !== null">
                ¥{{ fmtNum(tradeAmount(t), 2) }}
              </div>
              <div class="muted t-date">{{ shortDate(t.date) }}</div>
            </div>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty-tip">
      <div class="icon">📝</div>
      <template v-if="emptyText">
        <div>{{ emptyText }}</div>
        <div class="clear-link" style="margin-top: 8px" @click="resetFilter">清空筛选</div>
      </template>
      <template v-else>
        <div>暂无交易记录</div>
        <div class="muted">点击右上角「记一笔」开始</div>
      </template>
    </div>

    <!-- 资金流水 -->
    <div class="cash-section">
      <div class="cash-header" @click="showCash = !showCash">
        <span>资金流水<span v-if="hasFilter" class="muted"> · {{ cashList.length }} 笔</span></span>
        <el-icon :class="{ flip: !showCash }"><ArrowDown /></el-icon>
      </div>
      <template v-if="showCash">
        <div v-if="cashList.length" class="card cash-list">
          <div v-for="c in cashList" :key="c.id" class="row between cash-item">
            <div>
              <span class="type-badge" :class="c.type === 'deposit' ? 'tag-deposit' : 'tag-withdraw'">
                {{ c.type === 'deposit' ? '入金' : '出金' }}
              </span>
              <span v-if="isAutoFlow(c)" class="auto-badge">补录</span>
              <span class="muted" style="margin-left: 8px">{{ c.date }}<span v-if="c.note"> · {{ c.note }}</span></span>
            </div>
            <div class="row gap8">
              <span class="num" :class="c.type === 'deposit' ? 'up' : 'down'">
                {{ c.type === 'deposit' ? '+' : '-' }}¥{{ fmtNum(c.amount, 2) }}
              </span>
              <el-icon v-if="!isAutoFlow(c)" class="del" @click="openEditCash(c)"><Edit /></el-icon>
              <el-icon v-if="!isAutoFlow(c)" class="del" @click="delCash(c)"><Delete /></el-icon>
            </div>
          </div>
        </div>
        <div v-else class="muted" style="text-align: center; padding: 10px">
          {{ emptyText || '暂无资金记录' }}
        </div>
      </template>
    </div>
  </div>

  <TradeForm v-model="tradeVisible" :trade="editingTrade" />
  <CashForm v-model="cashVisible" :flow="editingCash" />

  <!-- 筛选底部弹层：取消 / 标题 / 重置 + 选项列表 -->
  <el-drawer
    v-model="sheetVisible"
    direction="btt"
    :with-header="false"
    :size="drawerSize"
    class="filter-sheet"
  >
    <div class="sheet">
      <div class="sheet-head">
        <span class="sheet-cancel" @click="sheetVisible = false">取消</span>
        <span class="sheet-title">{{ sheetTitle }}</span>
        <span class="sheet-reset" @click="resetSheet">重置</span>
      </div>
      <div
        v-for="o in sheetOptions"
        :key="o.value"
        class="sheet-option"
        @click="pick(o)"
      >
        <span>{{ o.label }}</span>
        <el-icon v-if="o.value === sheetValue" class="sheet-check"><Check /></el-icon>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.search-bar {
  padding: 4px 16px 8px;
}
.filter-bar {
  display: flex;
  gap: 8px;
  padding: 4px 16px 8px;
  overflow-x: auto;
}
.filter-bar .chip .el-icon {
  vertical-align: -1px;
  margin-right: 2px;
}
.hdr-icon {
  font-size: 20px;
  color: var(--text-2);
  cursor: pointer;
  padding: 4px;
}
.hdr-icon.on {
  color: var(--primary);
}
.pill {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: 20px;
  background: #fff;
  color: var(--text-1, #1e293b);
  font-size: 13px;
  font-weight: 600;
  border: 1px solid var(--border);
  cursor: pointer;
}
.pill .el-icon {
  color: var(--text-2);
}
.pill.active {
  color: var(--primary);
  border-color: var(--primary);
  background: rgba(15, 157, 120, 0.06);
}
.pill.active .el-icon {
  color: var(--primary);
}
.month-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 10px 16px 2px;
}
.month-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1, #1e293b);
}
.month-flow {
  font-size: 11px;
}
.realized-line {
  margin-top: 2px;
}
.col-end {
  text-align: right;
}
.t-date {
  font-size: 11px;
  margin-top: 2px;
}
.custom-range {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 8px;
}
.range-date {
  width: 130px;
}
.filter-summary {
  padding: 0 16px 8px;
}
.clear-link {
  font-size: 12px;
  color: var(--primary);
  cursor: pointer;
}
.chip {
  flex-shrink: 0;
  padding: 6px 16px;
  border-radius: 20px;
  background: #fff;
  color: var(--text-2);
  font-size: 13px;
  border: 1px solid var(--border);
}
.chip.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}
.date-group {
  margin: 6px 0;
}
.date-label {
  font-size: 12px;
  color: var(--text-2);
  padding: 6px 16px 2px;
}
.trade-item {
  margin: 8px 12px;
  padding: 12px 14px;
}
.type-badge {
  flex-shrink: 0;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  font-weight: 600;
}
.tag-buy,
.tag-deposit {
  background: #fdecec;
  color: #e63946;
}
.tag-sell,
.tag-withdraw {
  background: #e7f8f1;
  color: #10b981;
}
.tag-div {
  background: #fef3e2;
  color: #d97706;
}
.tag-gift,
.tag-rights {
  background: #e8f0fe;
  color: #1d4ed8;
}
/* 中签：绿色，和日历上的星星呼应 */
.tag-win {
  background: #dcfce7;
  color: #15803d;
}
.t-name {
  font-weight: 600;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-detail {
  margin-top: 8px;
}
.t-amount {
  font-weight: 600;
}
.del {
  color: #cbd5e1;
  font-size: 16px;
}
.del:active {
  color: #e63946;
}
.cash-section {
  margin: 16px 12px 8px;
}
.cash-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 15px;
  padding: 4px 2px;
}
.cash-header .el-icon {
  transition: transform 0.2s;
}
.cash-header .flip {
  transform: rotate(180deg);
}
.cash-list {
  padding: 4px 14px;
}
.cash-item {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.cash-item:last-child {
  border-bottom: none;
}
/* 「新建仓」自动生成的入金：系统维护，不可编辑 */
.auto-badge {
  margin-left: 6px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #f1f5f9;
  color: #94a3b8;
}
.back-icon {
  font-size: 20px;
  color: var(--text-2);
}
</style>

<!-- 弹层传送到 body，scoped 样式够不到，这里用全局样式 -->
<style>
.filter-sheet .el-drawer__body {
  padding: 0;
}
.filter-sheet .sheet {
  padding: 10px 20px calc(16px + env(safe-area-inset-bottom));
}
.filter-sheet .sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0 12px;
}
.filter-sheet .sheet-cancel {
  font-size: 14px;
  color: var(--text-2);
  cursor: pointer;
}
.filter-sheet .sheet-title {
  font-size: 15px;
  font-weight: 700;
}
.filter-sheet .sheet-reset {
  font-size: 14px;
  color: var(--primary);
  cursor: pointer;
}
.filter-sheet .sheet-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0;
  font-size: 15px;
  border-top: 1px solid var(--border);
  cursor: pointer;
}
.filter-sheet .sheet-option:first-of-type {
  border-top: none;
}
.filter-sheet .sheet-check {
  color: var(--primary);
  font-size: 18px;
}
</style>
