<script setup>
import { reactive, ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { useSettingsStore } from '../stores/settings'
import { lookupQuote } from '../services/quotes'
import { fmtNum } from '../utils/format'
import { DEFAULT_BROKER } from '../constants'

const visible = defineModel({ type: Boolean, default: false })
const portfolio = usePortfolioStore()
const settings = useSettingsStore()
const submitting = ref(false)
const lookupError = ref('')

const form = reactive({
  market: 'A',
  code: '',
  name: '',
  shares: null,
  costPrice: null,
  date: dayjs().format('YYYY-MM-DD'),
  broker: '',
  note: '',
  tag: []
})

watch(visible, (v) => {
  if (!v) return
  lookupError.value = ''
  Object.assign(form, {
    market: 'A',
    code: '',
    name: '',
    shares: null,
    costPrice: null,
    date: dayjs().format('YYYY-MM-DD'),
    broker: portfolio.defaultBroker || DEFAULT_BROKER,
    note: '',
    tag: []
  })
})

// 选择下拉中新建的标签时，立即并入标签组（无需等待表单提交）
function syncTags(v) {
  const arr = Array.isArray(v) ? v : []
  const fresh = arr.filter((x) => x && !settings.tags.includes(x))
  if (fresh.length) settings.saveTags([...settings.tags, ...fresh])
}

const totalCost = computed(() => {
  const q = Number(form.shares) || 0
  const p = Number(form.costPrice) || 0
  return q * p
})

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
  if (!form.date) return ElMessage.warning('请选择建仓日期')
  if (!code) return ElMessage.warning('请输入证券代码')
  if (!form.shares || Number(form.shares) <= 0) return ElMessage.warning('请输入持仓数量')
  if (!form.costPrice || Number(form.costPrice) <= 0) return ElMessage.warning('请输入成本价')
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
      tag: [...form.tag]
    })
    ElMessage.success(`已录入初始持仓，成本 ¥${fmtNum(totalCost.value, 2)} 已自动计入本金`)
    visible.value = false
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="新建仓（录入已有持仓）" width="92%" :show-close="false">
    <div class="init-tip">
      用于录入使用本软件<b>之前已持有</b>的股票：填写持仓数量与<b>历史成本价</b>即可。
      保存后系统会自动生成一笔等额入金记录并<b>计入本金</b>，不影响当前现金余额，
      后续的市值、盈亏、收益率计算都会以你的真实成本为准。
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
        <el-form-item label="建仓日期" class="flex1">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width: 100%" />
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
        <div v-if="lookupError" class="lookup-error">{{ lookupError }}</div>
      </el-form-item>

      <el-form-item label="股票名称">
        <el-input v-model="form.name" placeholder="可留空，自动补全" />
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

      <div class="row gap8">
        <el-form-item label="持仓数量" class="flex1">
          <el-input-number v-model="form.shares" :min="0" :precision="3" :controls="false" placeholder="股数" style="width: 100%" />
        </el-form-item>
        <el-form-item label="历史成本价（元）" class="flex1">
          <el-input-number v-model="form.costPrice" :min="0" :precision="4" :controls="false" placeholder="含历史费用的买入均价" style="width: 100%" />
        </el-form-item>
      </div>

      <div v-if="totalCost > 0" class="amount-preview num">
        初始投入成本：<b>¥{{ fmtNum(totalCost, 2) }}</b>
        <span class="muted">（将自动生成一笔等额入金记录）</span>
      </div>

      <el-form-item label="所属券商">
        <div class="row gap8" style="width: 100%">
          <el-select v-model="form.broker" style="flex: 1" placeholder="选择券商">
            <el-option v-for="b in portfolio.brokers" :key="b" :label="b" :value="b" />
          </el-select>
          <el-button @click="openAddBroker">新建</el-button>
        </div>
      </el-form-item>

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
