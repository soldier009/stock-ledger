<script setup>
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { DEFAULT_BROKER } from '../constants'

const visible = defineModel({ type: Boolean, default: false })
const props = defineProps({
  // 预设券商：从资产页某券商卡片进入时预填
  presetBroker: { type: String, default: '' }
})
const portfolio = usePortfolioStore()
const submitting = ref(false)

const form = reactive({
  date: dayjs().format('YYYY-MM-DD'),
  type: 'deposit',
  amount: null,
  note: '',
  broker: ''
})

watch(visible, (v) => {
  if (!v) return
  Object.assign(form, {
    date: dayjs().format('YYYY-MM-DD'),
    type: 'deposit',
    amount: null,
    note: '',
    broker: props.presetBroker || portfolio.brokers[0] || DEFAULT_BROKER
  })
})

async function submit() {
  if (!form.date) return ElMessage.warning('请选择日期')
  if (!form.amount || Number(form.amount) <= 0) return ElMessage.warning('请输入金额')
  submitting.value = true
  try {
    await portfolio.addCashFlow({
      date: form.date,
      type: form.type,
      amount: Number(form.amount),
      note: form.note.trim(),
      broker: form.broker || DEFAULT_BROKER
    })
    ElMessage.success('记录成功')
    visible.value = false
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="资金出入" width="90%" :show-close="false">
    <el-form label-position="top" size="large">
      <el-form-item label="所属券商">
        <el-select v-model="form.broker" style="width: 100%">
          <el-option v-for="b in portfolio.brokers" :key="b" :label="b" :value="b" />
        </el-select>
        <div class="muted" style="margin-top: 4px">入金/出金只影响该券商账户的可用现金</div>
      </el-form-item>
      <el-form-item label="类型">
        <el-radio-group v-model="form.type">
          <el-radio-button value="deposit">入金</el-radio-button>
          <el-radio-button value="withdraw">出金</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="日期">
        <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item label="金额（元）">
        <el-input-number v-model="form.amount" :min="0" :precision="2" :controls="false" style="width: 100%" />
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
