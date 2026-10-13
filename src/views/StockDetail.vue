<script setup>
import { ref, computed, reactive, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { useSettingsStore } from '../stores/settings'
import { computeAll } from '../services/calc'
import { fmtMoney, fmtNum, fmtShares, fmtPct, pnlClass, marketLabel, parseTags, typeLabel, rateOf, assetClass, assetClassLabel, ASSET_CLASSES } from '../utils/format'
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
// 用途标签：与资产类别并列的第二个维度，单值字符串，空表示未设置
const purposeText = computed(() => String(stock.value?.purpose || ''))
const broker = computed(() => stock.value?.broker || portfolio.defaultBroker || DEFAULT_BROKER)
// 资产二级分类：人工标注优先，未标注时按代码自动推断
const assetTypeValue = computed(() => assetClass(market, code, stock.value?.asset_type))

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
  presetTrade.value = { market, code, name: name.value, tag: tags.value, broker: broker.value, purpose: stock.value?.purpose || '' }
  tradeVisible.value = true
}

function openEdit(t) {
  editingTrade.value = t
  presetTrade.value = null
  tradeVisible.value = true
}

const infoForm = reactive({ name: '', tag: [], note: '', broker: '', assetType: '', purpose: '' })
const tagSelect = ref(null)

// 资产类别标签为单选：底层仍按数组存储（兼容历史数据），这里做单值桥接
const tagValue = computed({
  get: () => (Array.isArray(infoForm.tag) && infoForm.tag.length ? infoForm.tag[0] : ''),
  set: (v) => {
    infoForm.tag = v ? [v] : []
  }
})

function openInfoEdit() {
  infoForm.name = stock.value?.name || ''
  infoForm.tag = [...tags.value]
  infoForm.note = stock.value?.note || ''
  infoForm.broker = broker.value
  infoForm.assetType = stock.value?.asset_type || ''
  infoForm.purpose = stock.value?.purpose || ''
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
      broker: newBroker,
      assetType: infoForm.assetType,
      purpose: infoForm.purpose || ''
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

// ===== 快捷交易：详情页内直接买卖，不必打开完整表单 =====
const quickOpen = ref(true)
const quick = reactive({
  type: 'buy',
  mode: 'shares', // shares = 按份额输入；amount = 按金额输入（按现价折算股数）
  date: dayjs().format('YYYY-MM-DD'),
  shares: null,
  price: null, // 留空 = 用现价
  amount: null,
  fee: 0,
  tax: 0,
  broker: '',
  note: ''
})
// 券商默认跟随股票的所属账户
watch(broker, (b) => {
  if (!quick.broker) quick.broker = b
}, { immediate: true })

const quote = computed(() => portfolio.quotes[market + ':' + code] || null)
const quotePrice = computed(() => (quote.value && quote.value.price) || 0)
// 成交价：手填优先，留空则取现价
const effPrice = computed(() => Number(quick.price) || quotePrice.value || 0)
const priceFromQuote = computed(() => !Number(quick.price) && quotePrice.value > 0)

// 按金额买入时按现价折算股数：A股没有碎股取整，港美股保留 3 位
const quickShares = computed(() => {
  if (quick.mode !== 'amount') return Number(quick.shares) || 0
  if (!effPrice.value) return 0
  const raw = (Number(quick.amount) || 0) / effPrice.value
  return market === 'A' ? Math.round(raw) : Math.round(raw * 1000) / 1000
})
const quickGross = computed(() => quickShares.value * effPrice.value)
// 买入：应付总额（+费用）；卖出：实际到账（-费用-税）
const quickTotal = computed(() => {
  const fee = Number(quick.fee) || 0
  const tax = Number(quick.tax) || 0
  return quick.type === 'buy' ? quickGross.value + fee + tax : quickGross.value - fee - tax
})

const brokerBalance = computed(() => (portfolio.totals.brokerCash || {})[quick.broker] || 0)
const cashShort = computed(() => quick.type === 'buy' && quickTotal.value > brokerBalance.value + 1e-6)
const overSell = computed(() => quick.type === 'sell' && quickShares.value > (hold.value?.shares || 0) + 1e-6)
const amountDisabled = computed(() => !effPrice.value)
const sharePrecision = computed(() => (market === 'A' ? 0 : 3))

// A股卖出自动带出印花税（与完整表单同一口径），只在未手填时补
watch(
  () => [quick.type, quickShares.value, effPrice.value],
  () => {
    if (quick.type === 'sell' && market === 'A' && Number(quick.tax) === 0) {
      quick.tax = Math.round(quickShares.value * effPrice.value * (settings.stampTaxRate || 0.0005) * 100) / 100
    }
  }
)

const quickSubmitting = ref(false)
async function submitQuick() {
  if (!quick.date) return ElMessage.warning('请选择日期')
  if (quickShares.value <= 0) return ElMessage.warning(quick.mode === 'amount' ? '请输入买入金额' : '请输入数量')
  if (!effPrice.value)
    return ElMessage.warning(priceFromQuote.value ? '未能获取现价，请手填成交价' : '请输入成交价')
  if (overSell.value) {
    return ElMessage.warning(`最多可卖 ${fmtShares(hold.value?.shares || 0, market)} 股，当前超出持仓`)
  }
  quickSubmitting.value = true
  try {
    await portfolio.addTrade({
      date: quick.date,
      market,
      code,
      name: name.value,
      type: quick.type,
      shares: quickShares.value,
      price: effPrice.value,
      fee: Number(quick.fee) || 0,
      tax: Number(quick.tax) || 0,
      amount: 0,
      note: quick.note.trim(),
      tag: [...tags.value],
      purpose: stock.value?.purpose || '',
      broker: quick.broker || broker.value
    })
    ElMessage.success(quick.type === 'buy' ? '已记录买入' : '已记录卖出')
    Object.assign(quick, { shares: null, amount: null, price: null, fee: 0, tax: 0, note: '' })
  } finally {
    quickSubmitting.value = false
  }
}

// 交易记录分区：日常买卖 vs 分红/送股/配股（后者单独一个区块 + 专用添加按钮）
const tradeRows = computed(() => stockTrades.value.filter((t) => t.type === 'buy' || t.type === 'sell'))
const incomeRows = computed(() =>
  stockTrades.value.filter((t) => t.type === 'div' || t.type === 'gift' || t.type === 'rights')
)

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
  if (v && !settings.tags.includes(v)) settings.saveTags([...settings.tags, v])
  // 选中后自动收起下拉，避免面板一直展开
  nextTick(() => tagSelect.value?.blur?.())
}

// 用途标签同样是单选，新建的值并入用途标签组
function syncPurposes(v) {
  if (v && !settings.purposes.includes(v)) settings.savePurposes([...settings.purposes, v])
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
        <el-tag size="small" effect="plain">{{ assetClassLabel(assetTypeValue) }}</el-tag>
        <el-tag size="small" effect="plain" type="warning">{{ broker }}</el-tag>
        <el-tag v-for="tg in tags" :key="tg" size="small" effect="light" type="info">{{ tg }}</el-tag>
        <span v-if="!tags.length" class="muted">未设置标签</span>
        <el-tag v-if="purposeText" size="small" effect="plain" type="primary">{{ purposeText }}</el-tag>
        <span v-else class="muted">用途未设置</span>
      </div>
      <div v-if="stock?.note" class="muted note-text">{{ stock.note }}</div>
    </div>

    <!-- 当前持仓 -->
    <div v-if="hold" class="card hold-card">
      <div class="section-title">当前持仓</div>
      <div class="row between">
        <div class="muted">持仓数量</div>
        <div class="num">{{ fmtShares(hold.shares, market) }} 股</div>
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

    <!-- 快捷交易：详情页内直接买卖 -->
    <div class="card quick-card">
      <div class="row between" @click="quickOpen = !quickOpen">
        <span class="section-title" style="margin: 0">快捷交易</span>
        <el-icon :class="{ flip: !quickOpen }"><ArrowDown /></el-icon>
      </div>

      <template v-if="quickOpen">
        <el-radio-group v-model="quick.type" class="seg-group" size="small">
          <el-radio-button value="buy">买入</el-radio-button>
          <el-radio-button value="sell">卖出</el-radio-button>
        </el-radio-group>
        <el-radio-group v-model="quick.mode" class="seg-group" size="small" style="margin-top: 8px">
          <el-radio-button value="shares">按份额</el-radio-button>
          <el-radio-button value="amount" :disabled="amountDisabled">按金额</el-radio-button>
        </el-radio-group>
        <div v-if="quick.mode === 'amount' && amountDisabled" class="muted" style="margin-top: 4px">
          未获取到现价，请手填成交价或改用「按份额」
        </div>

        <div class="q-grid">
          <div>
            <div class="muted">日期</div>
            <el-date-picker
              v-model="quick.date"
              type="date"
              value-format="YYYY-MM-DD"
              size="small"
              :editable="false"
              style="width: 100%"
            />
          </div>
          <div>
            <div class="muted">{{ quick.mode === 'amount' ? '金额（元）' : '数量（股）' }}</div>
            <el-input-number
              v-if="quick.mode === 'amount'"
              v-model="quick.amount"
              :min="0"
              :precision="2"
              :controls="false"
              size="small"
              placeholder="金额"
              style="width: 100%"
            />
            <el-input-number
              v-else
              v-model="quick.shares"
              :min="0"
              :precision="sharePrecision"
              :controls="false"
              size="small"
              placeholder="股数"
              style="width: 100%"
            />
          </div>
          <div>
            <div class="muted">成交价（留空用现价）</div>
            <el-input-number
              v-model="quick.price"
              :min="0"
              :precision="4"
              :controls="false"
              size="small"
              :placeholder="quotePrice ? String(quotePrice) : '现价'"
              style="width: 100%"
            />
          </div>
          <div>
            <div class="muted">手续费</div>
            <el-input-number v-model="quick.fee" :min="0" :precision="2" :controls="false" size="small" style="width: 100%" />
          </div>
          <div>
            <div class="muted">税费</div>
            <el-input-number v-model="quick.tax" :min="0" :precision="2" :controls="false" size="small" style="width: 100%" />
          </div>
          <div>
            <div class="muted">{{ quick.type === 'buy' ? '扣款账户' : '到账账户' }}</div>
            <el-select v-model="quick.broker" size="small" style="width: 100%">
              <el-option v-for="b in portfolio.brokers" :key="b" :label="b" :value="b" />
            </el-select>
            <div class="muted" style="margin-top: 2px">可用 {{ fmtMoney(brokerBalance, 2) }}</div>
          </div>
        </div>

        <div v-if="quickGross > 0" class="q-preview num">
          <span v-if="quick.mode === 'amount'">约 </span>
          {{ fmtShares(quickShares, market) }} 股 × {{ fmtNum(effPrice, 3) }} ＝
          <b>{{ quick.type === 'buy' ? '应付' : '到账' }} {{ fmtMoney(quickTotal, 2) }}</b>
        </div>
        <div v-if="cashShort" class="short-warn">
          「{{ quick.broker }}」现金不足，保存后该账户余额将为负（{{ fmtMoney(brokerBalance - quickTotal, 2) }}）。
          可先到资金账户页给该账户补一笔入金。
        </div>
        <div v-if="overSell" class="short-warn">
          超出当前持仓 {{ fmtShares(hold?.shares || 0, market) }} 股，请先修正数量。
        </div>

        <el-button
          type="primary"
          class="q-submit"
          size="large"
          :loading="quickSubmitting"
          :disabled="overSell"
          @click="submitQuick"
        >
          保存{{ quick.type === 'buy' ? '买入' : '卖出' }}记录
        </el-button>
        <div class="muted" style="text-align: center; margin-top: 6px">
          分红 / 送股 / 配股请在下方「分红 / 送股 / 配股」区添加
        </div>
      </template>
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

    <!-- 分红 / 送股 / 配股：独立区块 + 专用添加按钮 -->
    <div class="trade-section">
      <div class="row between" style="padding: 4px 2px">
        <span class="section-title" style="margin: 0">分红 / 送股 / 配股（{{ incomeRows.length }}）</span>
        <el-button class="plus-btn" type="primary" circle size="small" @click="openAdd">
          <el-icon><Plus /></el-icon>
        </el-button>
      </div>
      <template v-if="incomeRows.length">
        <div v-for="t in incomeRows" :key="t.id" class="card trade-item">
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
              送股 {{ fmtShares(t.shares, market) }} 股
            </template>
            <template v-else>
              配股 {{ fmtShares(t.shares, market) }} 股 × {{ fmtNum(t.price, 3) }}
            </template>
            <span v-if="t.note" style="margin-left: 8px">{{ t.note }}</span>
          </div>
        </div>
      </template>
      <div v-else class="empty-tip">
        <div class="icon">📄</div>
        <div>暂无分红 / 送股 / 配股记录</div>
        <div class="muted">点右上角 ＋ 添加</div>
      </div>
    </div>

    <!-- 交易记录（买卖） -->
    <div class="trade-section">
      <div class="row between" style="padding: 4px 2px">
        <span class="section-title" style="margin: 0">交易记录（{{ tradeRows.length }}）</span>
      </div>

      <template v-if="tradeRows.length">
        <div v-for="t in tradeRows" :key="t.id" class="card trade-item">
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
              送股 {{ fmtShares(t.shares, market) }} 股
            </template>
            <template v-else>
              {{ fmtShares(t.shares, market) }} 股 × {{ fmtNum(t.price, 3) }}
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
        <div>暂无买卖记录</div>
        <div class="muted">买入 / 卖出请用上方「快捷交易」</div>
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
      <el-form-item label="资产类型">
        <el-select v-model="infoForm.assetType" style="width: 100%" placeholder="自动识别">
          <el-option label="自动识别（按代码判断）" value="" />
          <el-option v-for="c in ASSET_CLASSES" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
        <div class="muted" style="margin-top: 4px">
          用于资产分布归类。A股按代码可自动区分股票/场内基金/可转债，港股美股 ETF 建议手动指定
        </div>
      </el-form-item>
      <el-form-item label="资产类别（单选，用于持仓分类）">
        <el-select
          ref="tagSelect"
          v-model="tagValue"
          filterable
          allow-create
          clearable
          default-first-option
          :reserve-keyword="false"
          placeholder="选择或输入新标签后回车"
          style="width: 100%"
          @change="syncTags"
        >
          <el-option v-for="tg in settings.tags" :key="tg" :label="tg" :value="tg" />
        </el-select>
      </el-form-item>
      <el-form-item label="用途">
        <el-select
          v-model="infoForm.purpose"
          filterable
          allow-create
          clearable
          default-first-option
          :reserve-keyword="false"
          placeholder="未设置"
          style="width: 100%"
          @change="syncPurposes"
        >
          <el-option v-for="pp in settings.purposes" :key="pp" :label="pp" :value="pp" />
        </el-select>
        <div class="muted" style="margin-top: 4px">每只股票只能选一个用途，如长期持有 / 打新 / 波段</div>
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
.quick-card {
  padding: 12px 14px;
}
.quick-card .flip {
  transform: rotate(-90deg);
}
.quick-card .el-icon {
  transition: transform 0.2s;
}
.seg-group {
  display: flex;
  width: 100%;
  margin-top: 10px;
}
.seg-group :deep(.el-radio-button) {
  flex: 1;
}
.seg-group :deep(.el-radio-button__inner) {
  width: 100%;
}
.q-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 12px;
}
.q-grid .muted {
  margin-bottom: 4px;
}
.q-preview {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f0fdf9;
  font-size: 13px;
}
.q-preview b {
  color: var(--primary);
  font-size: 15px;
}
.short-warn {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fff7ed;
  color: #b45309;
  font-size: 12px;
  line-height: 1.6;
}
.q-submit {
  width: 100%;
  margin-top: 12px;
}
.plus-btn {
  width: 28px;
  height: 28px;
  padding: 0;
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
