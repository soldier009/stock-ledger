<script setup>
/**
 * 在打新日历里直接记中签 —— 不跳页面、不用手输代码。
 *
 * 和通用交易表单（TradeForm）的区别：那个表单面向所有交易类型，字段多、还要选代码；
 * 这里只做「中签」这一件事，标的（代码/名称/市场/是否可转债）由日历条目锁定，
 * 所以只需填数量和价格，券商可选，并决定是否真的从券商账户扣钱。
 */
import { computed, reactive, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney } from '../utils/format'

const props = defineProps({
  modelValue: Boolean,
  /** 日历里的新股/可转债条目 */
  item: { type: Object, default: null },
  /** 已存在的中签记录：有值则为编辑模式 */
  trade: { type: Object, default: null },
  /** 默认日期（通常是日历当前选中的那天） */
  defaultDate: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'saved'])

const portfolio = usePortfolioStore()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const unit = computed(() => (props.item && props.item.kind === 'cb' ? '张' : '股'))
const saving = ref(false)
const chargeCash = ref(true)
const form = reactive({ date: '', shares: null, price: null, broker: '', note: '' })

/**
 * 发行价默认值：可转债按面值 100 申购；新股用数据源给的发行价。
 * 让用户改是因为同一份数据里偶尔会有折价发行 / 数据源填错的情况。
 */
function defaultPrice(item) {
  if (!item) return null
  if (item.kind === 'cb') return 100
  return Number(item.issuePrice) || null
}

// 每次打开都重新预填：编辑时带出原值，新增时用发行价与日历选中日
watch(
  () => [props.modelValue, props.item && props.item.id, props.trade && props.trade.id],
  () => {
    if (!props.modelValue) return
    const t = props.trade
    if (t) {
      form.date = t.date
      form.shares = Number(t.shares) || null
      form.price = Number(t.price) || null
      form.broker = t.broker || portfolio.defaultBroker
      form.note = t.note || ''
      chargeCash.value = !t.no_cash
    } else {
      form.date = props.defaultDate || dayjs().format('YYYY-MM-DD')
      form.shares = null
      form.price = defaultPrice(props.item)
      form.broker = portfolio.defaultBroker
      form.note = ''
      chargeCash.value = true
    }
  }
)

const amount = computed(() => (Number(form.shares) || 0) * (Number(form.price) || 0))

async function submit() {
  if (!form.date) return ElMessage.warning('请选择中签日期')
  if (!form.shares || Number(form.shares) <= 0) return ElMessage.warning(`请输入中签${unit.value}数`)
  if (!form.price || Number(form.price) <= 0) return ElMessage.warning('请输入发行价')
  saving.value = true
  try {
    const payload = {
      date: form.date,
      market: props.item.market,
      code: props.item.code,
      name: props.item.name || '',
      type: 'win',
      shares: Number(form.shares),
      price: Number(form.price),
      fee: 0,
      tax: 0,
      amount: 0,
      note: form.note.trim(),
      broker: form.broker || portfolio.defaultBroker,
      no_cash: chargeCash.value ? 0 : 1
    }
    if (props.trade) await portfolio.updateTrade(props.trade.id, payload)
    else await portfolio.addTrade(payload)
    ElMessage.success(props.trade ? '已更新中签记录' : '已记录中签')
    visible.value = false
    emit('saved')
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!props.trade) return
  try {
    await ElMessageBox.confirm('删除这笔中签记录？对应持仓会一并消失。', '删除中签记录', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  await portfolio.deleteTrade(props.trade.id)
  ElMessage.success('已删除中签记录')
  visible.value = false
  emit('saved')
}
</script>

<template>
  <el-dialog v-model="visible" :title="trade ? '编辑中签' : '记中签'" width="92%">
    <div v-if="item" class="win-head">
      <b>{{ item.name }}</b>
      <span class="muted">{{ item.code }}</span>
      <span class="win-kind">{{ item.kind === 'cb' ? '可转债' : '新股' }}</span>
    </div>

    <el-form label-width="84px" size="small">
      <el-form-item label="中签日期">
        <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="unit === '张' ? '中签张数' : '中签股数'">
        <el-input-number
          v-model="form.shares"
          :min="0"
          :precision="0"
          :controls="false"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item label="发行价">
        <el-input-number
          v-model="form.price"
          :min="0"
          :precision="3"
          :controls="false"
          style="width: 100%"
        />
        <div class="muted" style="font-size: 11px; line-height: 1.5">
          <template v-if="item && item.kind === 'cb'">可转债按面值 100 申购</template>
          <template v-else-if="item && item.issuePriceRaw">
            数据源发行价 {{ item.issuePriceRaw }}
          </template>
        </div>
      </el-form-item>
      <el-form-item label="券商账户">
        <el-select v-model="form.broker" style="width: 100%">
          <el-option v-for="b in portfolio.brokers" :key="b" :label="b" :value="b" />
        </el-select>
      </el-form-item>
      <el-form-item label="从券商扣款">
        <el-switch v-model="chargeCash" />
        <div class="muted" style="margin-top: 4px; font-size: 11px; line-height: 1.5">
          应付 <b>{{ fmtMoney(amount) }}</b>
          <template v-if="chargeCash">，将从「{{ form.broker }}」扣除</template>
          <template v-else>
            ：券商现金不变，成本照记，但<b>净资产会偏高</b> —— 钱不是从这个账户出时用它
          </template>
        </div>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.note" placeholder="可选" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      <el-button v-if="trade" type="danger" text @click="remove">删除</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.win-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.win-kind {
  padding: 1px 5px;
  border-radius: 4px;
  background: #f1f5f9;
  color: #475569;
  font-size: 10px;
}
</style>
