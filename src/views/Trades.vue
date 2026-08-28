<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtNum, typeLabel, marketLabel } from '../utils/format'
import TradeForm from '../components/TradeForm.vue'
import CashForm from '../components/CashForm.vue'

const router = useRouter()

const portfolio = usePortfolioStore()
const tradeVisible = ref(false)
const cashVisible = ref(false)
const editingTrade = ref(null)
const filter = ref('all')
const showCash = ref(true)

const filters = [
  { label: '全部', value: 'all' },
  { label: '买入', value: 'buy' },
  { label: '卖出', value: 'sell' },
  { label: '分红', value: 'div' },
  { label: '送配', value: 'gift_rights' }
]

const tradeGroups = computed(() => {
  let list = [...portfolio.trades].sort((a, b) => b.date.localeCompare(a.date) || (b.id || 0) - (a.id || 0))
  if (filter.value === 'buy') list = list.filter((t) => t.type === 'buy')
  else if (filter.value === 'sell') list = list.filter((t) => t.type === 'sell')
  else if (filter.value === 'div') list = list.filter((t) => t.type === 'div')
  else if (filter.value === 'gift_rights') list = list.filter((t) => t.type === 'gift' || t.type === 'rights')
  const groups = []
  const map = {}
  for (const t of list) {
    if (!map[t.date]) {
      map[t.date] = { date: t.date, items: [] }
      groups.push(map[t.date])
    }
    map[t.date].items.push(t)
  }
  return groups
})

const cashList = computed(() =>
  [...portfolio.cashFlows].sort((a, b) => b.date.localeCompare(a.date) || (b.id || 0) - (a.id || 0))
)

function tradeAmount(t) {
  if (t.type === 'div') return t.amount
  if (t.type === 'gift') return null
  const q = Number(t.shares) || 0
  const p = Number(t.price) || 0
  return q * p
}

function typeClass(t) {
  return { buy: 'tag-buy', sell: 'tag-sell', div: 'tag-div', gift: 'tag-gift', rights: 'tag-rights' }[t.type] || ''
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

async function delCash(c) {
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
        <el-button size="small" @click="cashVisible = true">资金</el-button>
        <el-button size="small" type="primary" @click="openAdd">记一笔</el-button>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="filter-bar">
      <span
        v-for="f in filters"
        :key="f.value"
        class="chip"
        :class="{ active: filter === f.value }"
        @click="filter = f.value"
      >
        {{ f.label }}
      </span>
    </div>

    <!-- 交易流水 -->
    <template v-if="tradeGroups.length">
      <div v-for="g in tradeGroups" :key="g.date" class="date-group">
        <div class="date-label">{{ g.date }}</div>
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
                送股 {{ fmtNum(t.shares, 3) }} 股
              </template>
              <template v-else>
                {{ t.code }} · {{ fmtNum(t.shares, 3) }} 股 × {{ fmtNum(t.price, 3) }}
                <span v-if="t.fee || t.tax" class="muted">
                  （费 ¥{{ fmtNum(t.fee, 2) }} · 税 ¥{{ fmtNum(t.tax, 2) }}）
                </span>
              </template>
              <span v-if="t.note" style="margin-left: 8px">{{ t.note }}</span>
            </div>
            <div class="num t-amount" v-if="tradeAmount(t) !== null">
              ¥{{ fmtNum(tradeAmount(t), 2) }}
            </div>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty-tip">
      <div class="icon">📝</div>
      <div>暂无交易记录</div>
      <div class="muted">点击右上角「记一笔」开始</div>
    </div>

    <!-- 资金流水 -->
    <div class="cash-section">
      <div class="cash-header" @click="showCash = !showCash">
        <span>资金流水</span>
        <el-icon :class="{ flip: !showCash }"><ArrowDown /></el-icon>
      </div>
      <template v-if="showCash">
        <div v-if="cashList.length" class="card cash-list">
          <div v-for="c in cashList" :key="c.id" class="row between cash-item">
            <div>
              <span class="type-badge" :class="c.type === 'deposit' ? 'tag-deposit' : 'tag-withdraw'">
                {{ c.type === 'deposit' ? '入金' : '出金' }}
              </span>
              <span class="muted" style="margin-left: 8px">{{ c.date }}<span v-if="c.note"> · {{ c.note }}</span></span>
            </div>
            <div class="row gap8">
              <span class="num" :class="c.type === 'deposit' ? 'up' : 'down'">
                {{ c.type === 'deposit' ? '+' : '-' }}¥{{ fmtNum(c.amount, 2) }}
              </span>
              <el-icon class="del" @click="delCash(c)"><Delete /></el-icon>
            </div>
          </div>
        </div>
        <div v-else class="muted" style="text-align: center; padding: 10px">暂无资金记录</div>
      </template>
    </div>
  </div>

  <TradeForm v-model="tradeVisible" :trade="editingTrade" />
  <CashForm v-model="cashVisible" />
</template>

<style scoped>
.filter-bar {
  display: flex;
  gap: 8px;
  padding: 4px 16px 8px;
  overflow-x: auto;
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
.back-icon {
  font-size: 20px;
  color: var(--text-2);
}
</style>
