<script setup>
import { reactive, ref, computed, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { useSettingsStore } from '../stores/settings'
import { lookupQuote } from '../services/quotes'
import { fmtNum, fmtMoney } from '../utils/format'
import { DEFAULT_BROKER } from '../constants'

// 表单主体：既被「新建仓」弹窗引用，也被「新增资产」页面的股票页签引用。
// showSubmit 关闭时由外层（弹窗 footer）触发 submit()
const props = defineProps({
  showSubmit: { type: Boolean, default: true }
})
const emit = defineEmits(['saved'])

const portfolio = usePortfolioStore()
const settings = useSettingsStore()
const submitting = ref(false)
const lookupError = ref('')
// 查到的当前价，仅作参考展示（补录时要填的是历史成本价）
const lastPrice = ref(null)
const tagSelect = ref(null)

const form = reactive({
  market: 'A',
  code: '',
  name: '',
  shares: null,
  costPrice: null,
  date: dayjs().format('YYYY-MM-DD'),
  broker: '',
  note: '',
  tag: [],
  purpose: '',
  // 关联扣款账户：打开 = 真实买入，从该券商现金里扣；关闭 = 补录历史持仓，自动生成等额入金
  linkCash: false
})

function reset() {
  lookupError.value = ''
  lastPrice.value = null
  Object.assign(form, {
    market: 'A',
    code: '',
    name: '',
    shares: null,
    costPrice: null,
    date: dayjs().format('YYYY-MM-DD'),
    broker: portfolio.defaultBroker || DEFAULT_BROKER,
    note: '',
    tag: [],
    purpose: '',
    linkCash: false
  })
}
reset()

// 资产类别标签为单选：底层仍按数组存储（兼容历史数据），这里做单值桥接
const tagValue = computed({
  get: () => (Array.isArray(form.tag) && form.tag.length ? form.tag[0] : ''),
  set: (v) => {
    form.tag = v ? [v] : []
  }
})

// 选择下拉中新建的标签时，立即并入标签组（无需等待表单提交）
function syncTags(v) {
  if (v && !settings.tags.includes(v)) settings.saveTags([...settings.tags, v])
  // 选中后自动收起下拉，避免面板一直展开
  nextTick(() => tagSelect.value?.blur?.())
}

// 用途标签同样是单选，新建的值并入用途标签组
function syncPurposes(v) {
  if (v && !settings.purposes.includes(v)) settings.savePurposes([...settings.purposes, v])
}

// A股没有碎股：数量输入精度按市场切换（港股/美股保留 3 位小数）
const sharePrecision = computed(() => (form.market === 'A' ? 0 : 3))

const totalCost = computed(() => (Number(form.shares) || 0) * (Number(form.costPrice) || 0))

// 关联账户的可用余额，用于提示「扣款后会不会变负」
const brokerBalance = computed(() => (portfolio.totals.brokerCash || {})[form.broker] || 0)
const cashShort = computed(() => form.linkCash && totalCost.value > brokerBalance.value + 1e-6)

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
      lastPrice.value = q.price
    } else if (!st) {
      lookupError.value = `未查询到代码「${code}」对应的证券，请检查代码或所选市场是否正确`
    }
  } catch {
    if (!st) lookupError.value = '网络异常，行情获取失败，请稍后重试'
  }
}

async function openAddBroker() {
  try {
    const { value } = await ElMessageBox.prompt('请输入券商名称（如：华泰证券、东方财富）', '新建券商', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPattern: /\S+/,
      inputErrorMessage: '名称不能为空'
    })
    const name = String(value || '').trim()
    if (!name) return
    if (portfolio.brokers.includes(name)) return ElMessage.warning('券商已存在')
    await portfolio.addBroker(name)
    form.broker = name
    ElMessage.success(`已创建券商「${name}」`)
  } catch {
    /* 取消 */
  }
}

async function submit() {
  const code = String(form.code || '').trim()
  if (!form.date) return ElMessage.warning(`请选择${form.linkCash ? '买入' : '建仓'}日期`)
  if (!code) return ElMessage.warning('请输入证券代码')
  if (!form.shares || Number(form.shares) <= 0) return ElMessage.warning('请输入持仓数量')
  if (!form.costPrice || Number(form.costPrice) <= 0)
    return ElMessage.warning(`请输入${form.linkCash ? '买入价格' : '历史成本价'}`)
  submitting.value = true
  try {
    await portfolio.addInitialPosition({
      date: form.date,
      market: form.market,
      code,
      name: form.name.trim(),
      shares: Number(form.shares),
      costPrice: Number(form.costPrice),
      broker: form.broker || portfolio.defaultBroker || DEFAULT_BROKER,
      note: form.note.trim(),
      tag: [...form.tag],
      purpose: form.purpose || '',
      fund: form.linkCash ? 'cash' : 'auto'
    })
    ElMessage.success(
      form.linkCash
        ? `已记录买入，${fmtMoney(totalCost.value, 2)} 从「${form.broker}」现金中扣除`
        : `已录入初始持仓，成本 ¥${fmtNum(totalCost.value, 2)} 已自动计入本金`
    )
    emit('saved')
    reset()
  } finally {
    submitting.value = false
  }
}

defineExpose({ submit, reset, submitting })
</script>

<template>
  <div>
    <div class="init-tip">
      用于录入使用本软件<b>之前已持有</b>的股票：填写持仓数量与<b>历史成本价</b>即可。
      保存后系统会自动生成一笔等额入金记录并<b>计入本金</b>，不影响当前现金余额，
      后续的市值、盈亏、收益率计算都会以你的真实成本为准。
      净资产走势中该持仓会<b>并入曲线起点</b>（自账本第一天起按行情重估，补录当天不出现跳变）；
      若真实持有早于账本起点，建议把<b>建仓日期</b>填成真实开始持有的日期。
    </div>

    <el-form label-position="top" size="large">
      <div class="row gap8">
        <el-form-item label="市场" class="flex1">
          <el-select v-model="form.market" style="width: 100%">
            <el-option label="A股" value="A" />
            <el-option label="港股" value="HK" />
            <el-option label="美股" value="US" />
          </el-select>
        </el-form-item>
        <el-form-item :label="form.linkCash ? '买入日期' : '建仓日期'" class="flex1">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width: 100%" :editable="false" />
        </el-form-item>
      </div>

      <el-form-item label="证券代码">
        <div class="row gap8" style="width: 100%">
          <el-input
            v-model="form.code"
            placeholder="股票:600519 / ETF:510300 / 港股:00700 / 美股:AAPL"
            @blur="lookup"
          />
          <el-button @click="lookup">查询</el-button>
        </div>
        <div class="muted" style="margin-top: 4px">输入代码后自动获取名称（需联网），支持股票、场内基金(ETF/LOF)、可转债</div>
        <div v-if="lastPrice" class="muted" style="margin-top: 4px">
          当前价 ¥{{ fmtNum(lastPrice, 3) }}（仅供参考；{{ form.linkCash ? '实际成交价请按成交单填写' : '历史成本价请按你的实际买入均价填写' }}）
        </div>
        <div v-if="lookupError" class="lookup-error">{{ lookupError }}</div>
      </el-form-item>

      <el-form-item label="股票名称">
        <el-input v-model="form.name" placeholder="可留空，自动补全" />
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
          v-model="form.purpose"
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

      <div class="row gap8">
        <el-form-item label="持仓数量" class="flex1">
          <el-input-number v-model="form.shares" :min="0" :precision="sharePrecision" :controls="false" placeholder="股数" style="width: 100%" />
        </el-form-item>
        <el-form-item :label="form.linkCash ? '买入价格（元）' : '历史成本价（元）'" class="flex1">
          <el-input-number v-model="form.costPrice" :min="0" :precision="4" :controls="false" :placeholder="form.linkCash ? '成交价' : '含历史费用的买入均价'" style="width: 100%" />
        </el-form-item>
      </div>

      <el-form-item label="所属券商">
        <div class="row gap8" style="width: 100%">
          <el-select v-model="form.broker" style="flex: 1" placeholder="选择券商">
            <el-option v-for="b in portfolio.brokers" :key="b" :label="b" :value="b" />
          </el-select>
          <el-button @click="openAddBroker">新建</el-button>
        </div>
      </el-form-item>

      <!-- 关联扣款账户：打开后这笔就是真实买入，从该券商现金扣款 -->
      <el-form-item>
        <div class="row between" style="width: 100%">
          <span>
            <b>关联扣款账户</b>
            <div class="muted" style="margin-top: 2px">
              关闭＝补录历史持仓（自动生成等额入金，不动现金）；打开＝真实买入，从所选券商现金中扣除
            </div>
          </span>
          <el-switch v-model="form.linkCash" />
        </div>
      </el-form-item>

      <div v-if="totalCost > 0" class="amount-preview num">
        金额：<b>¥{{ fmtNum(totalCost, 2) }}</b>
        <span v-if="form.linkCash" class="muted">
          （从「{{ form.broker }}」扣除，当前可用 {{ fmtMoney(brokerBalance, 2) }}）
        </span>
        <span v-else class="muted">（将自动生成一笔等额入金记录）</span>
      </div>
      <div v-if="cashShort" class="short-warn">
        「{{ form.broker }}」现金不足，保存后该账户余额将为负（{{ fmtMoney(brokerBalance - totalCost, 2) }}）。
        如果是补录历史持仓，请关闭「关联扣款账户」；如果确实是从别的账户付的钱，可先到资金账户页给该账户补一笔入金。
      </div>

      <el-form-item label="备注">
        <el-input v-model="form.note" placeholder="可选" />
      </el-form-item>
    </el-form>

    <el-button v-if="showSubmit" type="primary" class="submit-btn" :loading="submitting" @click="submit">
      保存
    </el-button>
  </div>
</template>

<style scoped>
.init-tip {
  background: #fff7ed;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  color: #7c4a03;
  margin-bottom: 16px;
}
.amount-preview {
  background: #f0fdf9;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  font-size: 14px;
}
.amount-preview b {
  color: var(--primary);
  font-size: 16px;
}
.short-warn {
  background: #fff7ed;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 16px;
  font-size: 12px;
  line-height: 1.6;
  color: #b45309;
}
.lookup-error {
  color: #e63946;
  font-size: 12px;
  margin-top: 4px;
}
.submit-btn {
  width: 100%;
  margin-top: 8px;
}
</style>
