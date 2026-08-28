<script setup>
import { ref, computed, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usePortfolioStore } from '../stores/portfolio'
import { useSettingsStore } from '../stores/settings'
import { computeAll } from '../services/calc'
import { fmtMoney, fmtNum, fmtPct, pnlClass, marketLabel, parseTags, typeLabel, rateOf } from '../utils/format'
import { DEFAULT_BROKER } from '../constants'
import TradeForm from '../components/TradeForm.vue'

const route = useRoute()
const router = useRouter()
const portfolio = usePortfolioStore()
const settings = useSettingsStore()

const market = String(route.params.market || '')
const code = String(route.params.code || '')

const stock = computed(() => portfolio.stocks.find((s) => s.market === market && s.code === code))
const name = computed(() => stock.value?.name || portfolio.trades.find((t) => t.market === market && t.code === code)?.name || code)
const tags = computed(() => parseTags(stock.value?.tag))
const broker = computed(() => stock.value?.broker || portfolio.defaultBroker || DEFAULT_BROKER)

// 该股票全部交易记录（倒序）
const stockTrades = computed(() =>
  portfolio.trades
    .filter((t) => t.market === market && t.code === code)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.id || 0) - (a.id || 0))
)

// 该股票持仓统计（重放交易）
const stat = computed(() => {
  const r = computeAll(stockTrades.value, [])
  const pos = r.positions.find((p) => p.market === market && p.code === code) || null
  return { pos, totalRealized: r.totalRealized }
})

const hold = computed(() => {
  const pos = stat.value.pos
  if (!pos) return null
  const q = portfolio.quotes[market + ':' + code] || null
  const price = q && q.price ? q.price : pos.avgCost
  const rate = rateOf(market, portfolio.rates)
  const mv = pos.shares * price
  const mvCny = mv * rate
  const pnl = (price - pos.avgCost) * pos.shares
  const pnlCny = pnl * rate
  const pnlPct = pos.avgCost > 0 ? (pnl / (pos.avgCost * pos.shares)) * 100 : null
  return { ...pos, price, mvCny, pnlCny, pnlPct, hasQuote: !!q }
})

const tradeVisible = ref(false)
const editVisible = ref(false)
const editingTrade = ref(null)
const presetTrade = ref(null)

function openAdd() {
  editingTrade.value = null
  // 预填股票的所属券商，新增记录时资金默认流入该券商，无需每次手动选择
  presetTrade.value = { market, code, name: name.value, tag: tags.value, broker: broker.value }
  tradeVisible.value = true
}

function openEdit(t) {
  editingTrade.value = t
  presetTrade.value = null
  tradeVisible.value = true
}

const infoForm = reactive({ name: '', tag: [], note: '', broker: '' })

function openInfoEdit() {
  infoForm.name = stock.value?.name || ''
  infoForm.tag = [...tags.value]
  infoForm.note = stock.value?.note || ''
  infoForm.broker = broker.value
  editVisible.value = true
}

async function saveInfo() {
  if (!infoForm.name.trim()) return ElMessage.warning('请填写股票名称')
  const newBroker = infoForm.broker || portfolio.defaultBroker || DEFAULT_BROKER
  let syncTrades = false
  // 券商发生变更且有交易记录时，询问是否一并修改全部记录
  if (newBroker !== broker.value && stockTrades.value.length) {
    try {
      await ElMessageBox.confirm(
        `是否将「${name.value}」的全部 ${stockTrades.value.length} 条交易记录的所属券商一并改为「${newBroker}」？`,
        '修改所属券商',
        { confirmButtonText: '是，全部修改', cancelButtonText: '否，仅改股票', type: 'warning' }
      )
      syncTrades = true
    } catch {
      syncTrades = false // 点「否」或关闭弹窗：仅改股票主数据
    }
  }
  await portfolio.updateStockInfo(
    market,
    code,
    {
      name: infoForm.name.trim(),
      tag: [...infoForm.tag],
      note: infoForm.note.trim(),
      broker: newBroker
    },
    syncTrades
  )
  ElMessage.success('已保存')
  editVisible.value = false
}

async function removeStock() {
  try {
    await ElMessageBox.confirm(
      `删除股票「${name.value}」将同时删除其全部 ${stockTrades.value.length} 条交易记录，且不可恢复。确定删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' }
    )
    await portfolio.deleteStock(market, code)
    ElMessage.success('已删除')
    router.back()
  } catch {
    /* 取消 */
  }
}

async function delTrade(t) {
  try {
    await ElMessageBox.confirm(`确定删除 ${t.date} 的「${typeLabel(t.type)}」记录？`, '删除确认', { type: 'warning' })
    await portfolio.deleteTrade(t.id)
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}

function tradeAmount(t) {
  if (t.type === 'div') return t.amount
  if (t.type === 'gift') return null
  return (Number(t.shares) || 0) * (Number(t.price) || 0)
}

function typeClass(t) {
  return { buy: 'tag-buy', sell: 'tag-sell', div: 'tag-div', gift: 'tag-gift', rights: 'tag-rights' }[t.type] || ''
}

// 选择下拉中新建的标签时，立即并入标签组
function syncTags(v) {
  const arr = Array.isArray(v) ? v : []
  const fresh = arr.filter((x) => x && !settings.tags.includes(x))
  if (fresh.length) settings.saveTags([...settings.tags, ...fresh])
}
</script>

<template>
  <div>
    <div class="page-header">
      <div class="row gap8">
        <el-icon class="back-icon" @click="router.back()"><ArrowLeft /></el-icon>
        <div>
          <div class="page-title" style="display: inline">{{ name }}</div>
          <span class="muted" style="margin-left: 8px; font-size: 13px">{{ code }} · {{ marketLabel(market) }}</span>
        </div>
      </div>
      <div class="row gap8">
        <el-button size="small" @click="openInfoEdit">编辑</el-button>
        <el-button size="small" type="danger" plain @click="removeStock">删除</el-button>
      </div>
    </div>

    <!-- 股票信息 -->
    <div class="card info-card">
      <div class="row between">
        <div class="muted">股票信息</div>
        <el-icon class="edit-icon" @click="openInfoEdit"><Edit /></el-icon>
      </div>
      <div class="row gap8" style="margin-top: 8px">
        <el-tag size="small" effect="plain" type="success">{{ marketLabel(market) }}</el-tag>
        <el-tag size="small" effect="plain" type="warning">{{ broker }}</el-tag>
        <el-tag v-for="tg in tags" :key="tg" size="small" effect="light" type="info">{{ tg }}</el-tag>
        <span v-if="!tags.length" class="muted">未设置标签</span>
      </div>
      <div v-if="stock?.note" class="muted note-text">{{ stock.note }}</div>
    </div>

    <!-- 当前持仓 -->
    <div v-if="hold" class="card hold-card">
      <div class="section-title">当前持仓</div>
      <div class="row between">
        <div class="muted">持仓数量</div>
        <div class="num">{{ fmtNum(hold.shares, 3) }} 股</div>
      </div>
      <div class="row between">
        <div class="muted">成本价</div>
        <div class="num">{{ fmtNum(hold.avgCost, 3) }}</div>
      </div>
      <div class="row between">
        <div class="muted">现价</div>
        <div class="num">{{ hold.hasQuote ? fmtNum(hold.price, 3) : fmtNum(hold.avgCost, 3) + '（无行情）' }}</div>
      </div>
      <div class="row between">
        <div class="muted">市值(¥)</div>
        <div class="num">{{ fmtMoney(hold.mvCny, 2) }}</div>
      </div>
      <div class="row between">
        <div class="muted">浮动盈亏(¥)</div>
        <div class="num" :class="pnlClass(hold.pnlCny)">
          {{ hold.pnlCny > 0 ? '+' : '' }}{{ fmtMoney(hold.pnlCny, 2) }}
        </div>
      </div>
      <div class="row between">
        <div class="muted">盈亏率</div>
        <div class="num" :class="pnlClass(hold.pnlPct)">
          {{ hold.pnlPct === null ? '—' : (hold.pnlPct > 0 ? '+' : '') + fmtPct(hold.pnlPct) }}
        </div>
      </div>
    </div>

    <!-- 累计已实现盈亏 -->
    <div v-if="stat.totalRealized" class="card hold-card">
      <div class="row between">
        <div class="muted">累计已实现盈亏（含分红）</div>
        <div class="num" :class="pnlClass(stat.totalRealized)">
          {{ stat.totalRealized > 0 ? '+' : '' }}{{ fmtMoney(stat.totalRealized, 2) }}
        </div>
      </div>
    </div>

    <!-- 交易记录 -->
    <div class="trade-section">
      <div class="row between" style="padding: 4px 2px">
        <span class="section-title" style="margin: 0">交易记录（{{ stockTrades.length }}）</span>
        <el-button size="small" type="primary" @click="openAdd">记一笔</el-button>
      </div>

      <template v-if="stockTrades.length">
        <div v-for="t in stockTrades" :key="t.id" class="card trade-item">
          <div class="row between">
            <div class="row gap8">
              <span class="type-badge" :class="typeClass(t)">{{ typeLabel(t.type) }}</span>
              <span class="muted">{{ t.date }}</span>
            </div>
            <div class="row gap8">
              <el-icon class="act" @click="openEdit(t)"><Edit /></el-icon>
              <el-icon class="act" @click="delTrade(t)"><Delete /></el-icon>
            </div>
          </div>
          <div class="muted num t-detail">
            <template v-if="t.type === 'div'">
              分红 ¥{{ fmtNum(t.amount, 2) }}
            </template>
            <template v-else-if="t.type === 'gift'">
              送股 {{ fmtNum(t.shares, 3) }} 股
            </template>
            <template v-else>
              {{ fmtNum(t.shares, 3) }} 股 × {{ fmtNum(t.price, 3) }}
              <span v-if="t.fee || t.tax">
                （费 ¥{{ fmtNum(t.fee, 2) }} · 税 ¥{{ fmtNum(t.tax, 2) }}）
              </span>
            </template>
            <span v-if="tradeAmount(t) !== null" class="t-amount">
              ¥{{ fmtNum(tradeAmount(t), 2) }}
            </span>
            <span v-if="t.note" style="margin-left: 8px">{{ t.note }}</span>
          </div>
        </div>
      </template>
      <div v-else class="empty-tip">
        <div class="icon">📄</div>
        <div>暂无交易记录</div>
        <div class="muted">点击「记一笔」添加</div>
      </div>
    </div>
  </div>

  <!-- 股票信息编辑 -->
  <el-dialog v-model="editVisible" title="编辑股票信息" width="92%">
    <el-form label-position="top" size="large">
      <el-form-item label="股票名称">
        <el-input v-model="infoForm.name" />
      </el-form-item>
      <el-form-item label="所属券商">
        <el-select v-model="infoForm.broker" style="width: 100%">
          <el-option v-for="b in portfolio.brokers" :key="b" :label="b" :value="b" />
        </el-select>
        <div class="muted" style="margin-top: 4px">该股票的买卖资金在此券商账户内流动</div>
      </el-form-item>
      <el-form-item label="标签（可多选，用于持仓分类）">
        <el-select
          v-model="infoForm.tag"
          multiple
          filterable
          allow-create
          default-first-option
          :reserve-keyword="false"
          placeholder="选择或输入新标签后回车"
          style="width: 100%"
          @change="syncTags"
        >
          <el-option v-for="tg in settings.tags" :key="tg" :label="tg" :value="tg" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="infoForm.note" type="textarea" :rows="2" placeholder="可选" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" @click="saveInfo">保存</el-button>
    </template>
  </el-dialog>

  <TradeForm v-model="tradeVisible" :trade="editingTrade" :preset="presetTrade" />
</template>

<style scoped>
.back-icon {
  font-size: 20px;
  color: var(--text-2);
}
.info-card {
  padding: 12px 14px;
  margin-bottom: 10px;
}
.edit-icon {
  color: #cbd5e1;
  font-size: 15px;
}
.edit-icon:active {
  color: var(--primary);
}
.note-text {
  margin-top: 8px;
  font-size: 13px;
}
.hold-card {
  padding: 12px 14px;
  margin-bottom: 10px;
}
.hold-card .row {
  padding: 5px 0;
}
.section-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 8px;
}
.trade-section {
  margin: 4px 12px;
}
.trade-item {
  padding: 10px 12px;
  margin-bottom: 8px;
}
.type-badge {
  flex-shrink: 0;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 6px;
  font-weight: 600;
}
.tag-buy {
  background: #fdecec;
  color: #e63946;
}
.tag-sell {
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
.t-detail {
  margin-top: 8px;
  font-size: 13px;
}
.t-amount {
  margin-left: 8px;
  color: var(--text-1);
}
.act {
  color: #cbd5e1;
  font-size: 15px;
}
.act:active {
  color: var(--primary);
}
</style>
