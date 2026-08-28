<script setup>
import { reactive, ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { useSettingsStore } from '../stores/settings'
import { lookupQuote } from '../services/quotes'
import { fmtNum, parseTags } from '../utils/format'
import { DEFAULT_BROKER } from '../constants'

const visible = defineModel({ type: Boolean, default: false })
const props = defineProps({
  // 编辑模式：传入要修改的交易记录
  trade: { type: Object, default: null },
  // 预填：传入 { market, code, name, tag, broker } 用于详情页快速记一笔
  preset: { type: Object, default: null }
})

const defaultBroker = () => portfolio.brokers[0] || DEFAULT_BROKER
const portfolio = usePortfolioStore()
const settings = useSettingsStore()
const submitting = ref(false)
const title = ref('记一笔')
const lookupError = ref('')

const form = reactive({
  type: 'buy',
  market: 'A',
  code: '',
  name: '',
  date: dayjs().format('YYYY-MM-DD'),
  shares: null,
  price: null,
  fee: 0,
  tax: 0,
  amount: null,
  note: '',
  tag: [],
  broker: ''
})

watch(visible, (v) => {
  if (!v) return
  lookupError.value = ''
  if (props.trade) {
    // 编辑模式
    title.value = '编辑交易'
    const t = props.trade
    const st = portfolio.stocks.find((s) => s.market === t.market && s.code === t.code)
    Object.assign(form, {
      type: t.type,
      market: t.market,
      code: t.code,
      name: st?.name || t.name || '',
      date: t.date,
      shares: t.shares || null,
      price: t.price || null,
      fee: t.fee || 0,
      tax: t.tax || 0,
      amount: t.amount || null,
      note: t.note || '',
      tag: st ? parseTags(st.tag) : [],
      broker: t.broker || (st && st.broker) || defaultBroker()
    })
  } else {
    title.value = '记一笔'
    if (props.preset) {
      Object.assign(form, {
        type: 'buy',
        market: props.preset.market || 'A',
        code: props.preset.code || '',
        name: props.preset.name || '',
        date: dayjs().format('YYYY-MM-DD'),
        shares: null,
        price: null,
        fee: 0,
        tax: 0,
        amount: null,
        note: '',
        tag: Array.isArray(props.preset.tag) ? [...props.preset.tag] : [],
        broker: props.preset.broker || defaultBroker()
      })
    } else {
      reset()
    }
  }
})

// 选择下拉中新建的标签时，立即并入标签组（无需等待表单提交）
function syncTags(v) {
  const arr = Array.isArray(v) ? v : []
  const fresh = arr.filter((x) => x && !settings.tags.includes(x))
  if (fresh.length) settings.saveTags([...settings.tags, ...fresh])
}

const typeOptions = [
  { label: '买入', value: 'buy' },
  { label: '卖出', value: 'sell' },
  { label: '分红', value: 'div' },
  { label: '送股', value: 'gift' },
  { label: '配股', value: 'rights' }
]

watch(
  () => form.type,
  (t) => {
    if (t !== 'div') form.amount = null
    if (t === 'div' || t === 'gift') form.price = null
    if (t === 'div') {
      form.shares = null
      form.fee = 0
      form.tax = 0
    }
    if (t === 'gift') {
      form.price = null
      form.fee = 0
      form.tax = 0
    }
  }
)

const computedAmount = computed(() => {
  if (form.type === 'div') return form.amount
  if (form.type === 'gift') return null
  const q = Number(form.shares) || 0
  const p = Number(form.price) || 0
  const fee = Number(form.fee) || 0
  const tax = Number(form.tax) || 0
  if (form.type === 'sell') return q * p - fee - tax
  return q * p + fee + tax
})

function suggestTax() {
  if (form.type === 'sell' && form.market === 'A' && Number(form.tax) === 0) {
    const q = Number(form.shares) || 0
    const p = Number(form.price) || 0
    form.tax = Math.round(q * p * (settings.stampTaxRate || 0.0005) * 100) / 100
  }
}

watch(() => [form.type, form.market, form.shares, form.price], suggestTax)

async function lookup() {
  const code = String(form.code || '').trim()
  if (!code) return
  lookupError.value = ''
  // 该股票已有主数据时，自动带出名称与所属券商
  const st = portfolio.stocks.find((s) => s.market === form.market && s.code === code)
  if (st) {
    if (!form.name) form.name = st.name || ''
    if (st.broker) form.broker = st.broker
  }
  try {
    const q = await lookupQuote(form.market, code)
    if (q) {
      if (!form.name) form.name = q.name
      if (form.type !== 'div' && form.type !== 'gift' && (!form.price || Number(form.price) === 0)) {
        form.price = q.price
      }
    } else if (!st) {
      // 行情源无此代码且本地也没有该证券主数据 → 判定为代码无效
      lookupError.value = `未查询到代码「${code}」对应的证券，请检查代码或所选市场是否正确`
    }
  } catch {
    // 网络异常：仅当本地也无此证券时才提示
    if (!st) lookupError.value = '网络异常，行情获取失败，请稍后重试'
  }
}

async function submit() {
  if (!form.date) return ElMessage.warning('请选择日期')
  const code = String(form.code || '').trim()
  if (!code) return ElMessage.warning('请输入股票代码')
  const t = form.type
  if (t === 'div') {
    if (!form.amount || Number(form.amount) <= 0) return ElMessage.warning('请输入分红金额')
  } else if (t === 'gift') {
    if (!form.shares || Number(form.shares) <= 0) return ElMessage.warning('请输入送股数量')
  } else {
    if (!form.shares || Number(form.shares) <= 0) return ElMessage.warning('请输入数量')
    if (!form.price || Number(form.price) <= 0) return ElMessage.warning('请输入价格')
  }
  submitting.value = true
  try {
    const payload = {
      date: form.date,
      market: form.market,
      code,
      name: form.name.trim(),
      type: t,
      shares: t === 'div' ? 0 : Number(form.shares) || 0,
      price: t === 'div' || t === 'gift' ? 0 : Number(form.price) || 0,
      fee: Number(form.fee) || 0,
      tax: Number(form.tax) || 0,
      amount: t === 'div' ? Number(form.amount) || 0 : 0,
      note: form.note.trim(),
      tag: Array.isArray(form.tag) ? [...form.tag] : [],
      broker: form.broker || defaultBroker()
    }
    if (props.trade) {
      await portfolio.updateTrade(props.trade.id, payload)
      ElMessage.success('已保存')
    } else {
      await portfolio.addTrade(payload)
      ElMessage.success('记录成功')
    }
    // 新标签并入标签组，便于下次选择
    if (payload.tag.length) {
      settings.saveTags([...settings.tags, ...payload.tag])
    }
    visible.value = false
    reset()
  } finally {
    submitting.value = false
  }
}

function reset() {
  lookupError.value = ''
  Object.assign(form, {
    type: 'buy',
    market: 'A',
    code: '',
    name: '',
    date: dayjs().format('YYYY-MM-DD'),
    shares: null,
    price: null,
    fee: 0,
    tax: 0,
    amount: null,
    note: '',
    tag: [],
    broker: defaultBroker()
  })
}
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="92%" :show-close="false">
    <el-form label-position="top" size="large">
      <el-form-item label="交易类型">
        <el-radio-group v-model="form.type" class="type-group">
          <el-radio-button v-for="o in typeOptions" :key="o.value" :value="o.value">{{ o.label }}</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <div class="row gap8">
        <el-form-item label="市场" class="flex1">
          <el-select v-model="form.market" style="width: 100%">
            <el-option label="A股" value="A" />
            <el-option label="港股" value="HK" />
            <el-option label="美股" value="US" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期" class="flex1">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width: 100%" />
        </el-form-item>
      </div>

      <el-form-item label="证券代码">
        <div class="row gap8" style="width: 100%">
          <el-input
            v-model="form.code"
            placeholder="股票:600519 / ETF:510300 / 转债:113050 / 港股:00700 / 美股:AAPL"
            @blur="lookup"
          />
          <el-button @click="lookup">查询</el-button>
        </div>
        <div class="muted" style="margin-top: 4px">输入代码后自动获取名称与现价（需联网），支持股票、场内基金(ETF/LOF)、可转债</div>
        <div v-if="lookupError" class="lookup-error">{{ lookupError }}</div>
      </el-form-item>

      <el-form-item label="股票名称">
        <el-input v-model="form.name" placeholder="可留空，自动补全" />
      </el-form-item>

      <el-form-item label="所属券商">
        <el-select v-model="form.broker" style="width: 100%" placeholder="选择券商">
          <el-option v-for="b in portfolio.brokers" :key="b" :label="b" :value="b" />
        </el-select>
        <div class="muted" style="margin-top: 4px">买卖资金只在该券商账户内流动（可在设置中管理券商）</div>
      </el-form-item>

      <el-form-item label="标签（可多选，用于持仓分类）">
        <el-select
          v-model="form.tag"
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

      <template v-if="form.type !== 'div' && form.type !== 'gift'">
        <div class="row gap8">
          <el-form-item label="数量" class="flex1">
            <el-input-number v-model="form.shares" :min="0" :precision="3" :controls="false" placeholder="股数" style="width: 100%" />
          </el-form-item>
          <el-form-item label="价格" class="flex1">
            <el-input-number v-model="form.price" :min="0" :precision="4" :controls="false" placeholder="成交价" style="width: 100%" />
          </el-form-item>
        </div>
      </template>

      <template v-if="form.type === 'gift'">
        <el-form-item label="送股数量">
          <el-input-number v-model="form.shares" :min="0" :precision="3" :controls="false" style="width: 100%" />
        </el-form-item>
      </template>

      <template v-if="form.type === 'div'">
        <el-form-item label="分红金额（元）">
          <el-input-number v-model="form.amount" :min="0" :precision="2" :controls="false" style="width: 100%" />
        </el-form-item>
      </template>

      <template v-if="form.type !== 'div' && form.type !== 'gift'">
        <div class="row gap8">
          <el-form-item label="手续费" class="flex1">
            <el-input-number v-model="form.fee" :min="0" :precision="2" :controls="false" style="width: 100%" />
          </el-form-item>
          <el-form-item label="税费(印花税等)" class="flex1">
            <el-input-number v-model="form.tax" :min="0" :precision="2" :controls="false" style="width: 100%" />
          </el-form-item>
        </div>
        <div v-if="computedAmount !== null" class="amount-preview num">
          {{ form.type === 'sell' ? '实收金额' : '总成本' }}：<b>¥{{ fmtNum(computedAmount, 2) }}</b>
          <span class="muted">（A股卖出印花税默认 0.05%，可手动修改）</span>
        </div>
      </template>

      <el-form-item label="备注">
        <el-input v-model="form.note" placeholder="可选" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.type-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.type-group :deep(.el-radio-button__inner) {
  border-radius: 8px !important;
  border: 1px solid var(--border);
  padding: 8px 14px;
}
.amount-preview {
  background: #f0fdf9;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 16px;
  font-size: 14px;
}
.amount-preview b {
  color: var(--primary);
  font-size: 16px;
}
.lookup-error {
  color: #e63946;
  font-size: 12px;
  margin-top: 4px;
}
</style>
