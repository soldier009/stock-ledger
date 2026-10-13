<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, ArrowDown, ArrowRight, Edit, Delete } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney } from '../utils/format'
import CashForm from '../components/CashForm.vue'

const router = useRouter()
const portfolio = usePortfolioStore()
const totals = computed(() => portfolio.totals)

const cashVisible = ref(false)
const cashBroker = ref('')
const editingCash = ref(null)

// 「新建仓」自动产生的入金由系统维护（金额 = 建仓成本、日期随建仓记录联动），不允许手动改：
// 结构化标记是 origin='initial'，老数据可能没回填，再按备注前缀兜底
function isAutoFlow(c) {
  return (
    c.type === 'deposit' &&
    (c.origin === 'initial' || String(c.note || '').startsWith('初始建仓-自动入金（'))
  )
}

function openAddCash(broker = '') {
  editingCash.value = null
  cashBroker.value = broker || portfolio.defaultBroker
  cashVisible.value = true
}

function openEditCash(c) {
  if (isAutoFlow(c)) return
  editingCash.value = c
  cashBroker.value = ''
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
    await ElMessageBox.confirm(
      `确定删除该笔${c.type === 'deposit' ? '入金' : '出金'}（${fmtMoney(c.amount, 2)}）？`,
      '删除确认',
      { type: 'warning' }
    )
    await portfolio.deleteCashFlow(c.id)
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}

// 累计入金 / 出金（全部账户合计）
const inflow = computed(() =>
  portfolio.cashFlows.filter((c) => c.type === 'deposit').reduce((a, c) => a + Number(c.amount || 0), 0)
)
const outflow = computed(() =>
  portfolio.cashFlows.filter((c) => c.type === 'withdraw').reduce((a, c) => a + Number(c.amount || 0), 0)
)
// 累计入金中属于「补录建仓」自动生成的部分：虚拟入金，不是手动转进来的钱
const initialInflow = computed(() =>
  portfolio.cashFlows
    .filter((c) => c.type === 'deposit' && c.origin === 'initial')
    .reduce((a, c) => a + Number(c.amount || 0), 0)
)

// 一个券商一行：余额 + 该账户累计出入金 + 该账户流水
const rows = computed(() => {
  const bal = totals.value.brokerCash || {}
  const names = [...portfolio.brokers]
  // 历史数据里可能存在已不在券商列表中的账户名（如改名前的旧名），单独列出来，
  // 否则会出现「合计对得上、单个账户对不上」却找不到那笔钱的困惑
  for (const c of portfolio.cashFlows) {
    const b = c.broker || portfolio.defaultBroker
    if (b && !names.includes(b)) names.push(b)
  }
  return names.map((name) => {
    const flows = portfolio.cashFlows
      .filter((c) => (c.broker || portfolio.defaultBroker) === name)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.id || 0) - (a.id || 0))
    const dep = flows.filter((c) => c.type === 'deposit').reduce((a, c) => a + Number(c.amount || 0), 0)
    const wd = flows.filter((c) => c.type === 'withdraw').reduce((a, c) => a + Number(c.amount || 0), 0)
    return { name, balance: bal[name] || 0, deposit: dep, withdraw: wd, flows }
  })
})

// 流水展开状态：默认全部折叠，账户多时页面不至于被几千条流水撑爆
const expanded = ref(new Set())
function toggle(name) {
  const next = new Set(expanded.value)
  next.has(name) ? next.delete(name) : next.add(name)
  expanded.value = next
}
const FLOW_LIMIT = 30
function shownFlows(r) {
  return r.flows.slice(0, FLOW_LIMIT)
}
</script>

<template>
  <div>
    <div class="page-header">
      <div class="row gap8">
        <el-icon class="back-icon" @click="router.back()"><ArrowLeft /></el-icon>
        <div class="page-title">资金账户</div>
      </div>
      <el-button size="small" type="primary" round @click="openAddCash()">＋ 出入金</el-button>
    </div>

    <!-- 合计 -->
    <div class="card total-card">
      <div class="muted">现金合计</div>
      <div class="big-value num">{{ fmtMoney(totals.cash, 2) }}</div>
      <div class="hr"></div>
      <div class="row between">
        <div class="muted">累计入金 <span class="num up">+{{ fmtMoney(inflow, 2) }}</span></div>
        <div class="muted">累计出金 <span class="num down">-{{ fmtMoney(outflow, 2) }}</span></div>
      </div>
      <div v-if="initialInflow > 0" class="muted note">
        累计入金包含补录建仓 {{ fmtMoney(initialInflow, 0) }}（补录历史持仓时自动生成，非手动转入）
      </div>
      <div class="muted note">
        账户的新增 / 改名 / 删除在
        <span class="link" @click="router.push('/settings')">设置 › 券商管理</span>
      </div>
    </div>

    <!-- 各券商账户 -->
    <div v-for="r in rows" :key="r.name" class="card broker-card">
      <div class="row between">
        <div class="row gap8">
          <span class="broker-name">{{ r.name }}</span>
          <span v-if="r.name === portfolio.defaultBroker" class="default-badge">默认</span>
        </div>
        <el-button size="small" @click="openAddCash(r.name)">出入金</el-button>
      </div>
      <div class="num balance" :class="{ down: r.balance < 0 }">{{ fmtMoney(r.balance, 2) }}</div>
      <div class="row between">
        <span class="muted">入金 <span class="num up">+{{ fmtMoney(r.deposit, 2) }}</span></span>
        <span class="muted">出金 <span class="num down">-{{ fmtMoney(r.withdraw, 2) }}</span></span>
      </div>
      <div v-if="r.balance < 0" class="muted warn">
        余额为负：该账户的买入金额已超过累计入金，通常是用「新建仓」以外的买入记账后未补入金
      </div>

      <div class="flow-toggle" @click="toggle(r.name)">
        <span>流水 {{ r.flows.length }} 笔</span>
        <el-icon :class="{ flip: !expanded.has(r.name) }"><ArrowDown /></el-icon>
      </div>

      <template v-if="expanded.has(r.name)">
        <div v-if="r.flows.length" class="flow-list">
          <div v-for="c in shownFlows(r)" :key="c.id" class="row flow-item">
            <div class="flex1">
              <span class="type-badge" :class="c.type === 'deposit' ? 'tag-deposit' : 'tag-withdraw'">
                {{ c.type === 'deposit' ? '入金' : '出金' }}
              </span>
              <span v-if="isAutoFlow(c)" class="auto-badge">补录</span>
              <div class="muted flow-meta">
                {{ c.date }}<span v-if="c.note"> · {{ c.note }}</span>
              </div>
            </div>
            <span class="num flow-amount" :class="c.type === 'deposit' ? 'up' : 'down'">
              {{ c.type === 'deposit' ? '+' : '-' }}{{ fmtMoney(Math.abs(Number(c.amount) || 0), 2) }}
            </span>
            <el-icon v-if="!isAutoFlow(c)" class="del" @click="openEditCash(c)"><Edit /></el-icon>
            <el-icon v-if="!isAutoFlow(c)" class="del" @click="delCash(c)"><Delete /></el-icon>
          </div>
          <div v-if="r.flows.length > FLOW_LIMIT" class="muted flow-more">
            仅显示最近 {{ FLOW_LIMIT }} 笔，共 {{ r.flows.length }} 笔
          </div>
        </div>
        <div v-else class="muted flow-empty">该账户暂无资金记录</div>
      </template>
    </div>

    <div v-if="!rows.length" class="empty-tip">
      <div class="icon"><el-icon :size="40"><ArrowRight /></el-icon></div>
      <div>暂无券商账户</div>
      <div class="muted">到「设置 › 券商管理」先建一个账户</div>
    </div>

    <CashForm v-model="cashVisible" :preset-broker="cashBroker" :flow="editingCash" />
  </div>
</template>

<style scoped>
.back-icon {
  font-size: 20px;
  cursor: pointer;
}
.total-card {
  padding: 16px 14px;
}
.big-value {
  font-size: 28px;
  font-weight: 700;
  margin-top: 4px;
}
.hr {
  height: 1px;
  background: var(--border, #f1f5f9);
  margin: 12px 0;
}
.note {
  font-size: 11px;
  margin-top: 6px;
}
.link {
  color: var(--primary);
  cursor: pointer;
}
.broker-card {
  padding: 14px;
}
.broker-name {
  font-size: 15px;
  font-weight: 700;
}
.default-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #e8f0fe;
  color: #1d4ed8;
}
.balance {
  font-size: 22px;
  font-weight: 700;
  margin: 6px 0 4px;
}
.warn {
  color: #d97706;
  margin-top: 6px;
}
.flow-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border, #f1f5f9);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.flow-toggle .el-icon {
  transition: transform 0.2s;
}
.flow-toggle .flip {
  transform: rotate(-90deg);
}
.flow-item {
  padding: 10px 0;
  border-bottom: 1px solid var(--border, #f1f5f9);
}
.flow-item:last-child {
  border-bottom: none;
}
.flow-meta {
  font-size: 11px;
  margin-top: 4px;
}
.flow-amount {
  font-weight: 600;
  font-size: 13px;
}
.flow-more {
  text-align: center;
  padding: 8px 0 2px;
}
.flow-empty {
  text-align: center;
  padding: 10px 0 2px;
}
.type-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
}
.tag-deposit {
  background: #fdeaea;
  color: #e63946;
}
.tag-withdraw {
  background: #e7f8f1;
  color: #10b981;
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
.del {
  color: #cbd5e1;
  font-size: 16px;
  margin-left: 6px;
}
.del:active {
  color: #e63946;
}
.empty-tip {
  font-size: 13px;
}
</style>
