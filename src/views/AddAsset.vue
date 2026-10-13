<script setup>
import { ref, reactive, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import dayjs from 'dayjs'
import { ArrowLeft } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney } from '../utils/format'
import StockEntryForm from '../components/StockEntryForm.vue'

const router = useRouter()
const portfolio = usePortfolioStore()

const tab = ref('stock')

// ===== 现金 / 券商账户页签 =====
const cash = reactive({
  broker: portfolio.defaultBroker || '',
  amount: null,
  date: dayjs().format('YYYY-MM-DD'),
  note: ''
})
const submitting = ref(false)
// 输入的账户名不在现有券商里 → 保存时顺带建这个账户
const isNewBroker = computed(() => {
  const n = String(cash.broker || '').trim()
  return !!n && !portfolio.brokers.includes(n)
})

async function submitCash() {
  const name = String(cash.broker || '').trim()
  if (!name) return ElMessage.warning('请选择或输入账户名称')
  if (!cash.date) return ElMessage.warning('请选择日期')
  if (!cash.amount || Number(cash.amount) <= 0) return ElMessage.warning('请输入金额')
  submitting.value = true
  try {
    if (isNewBroker.value) await portfolio.addBroker(name)
    await portfolio.addCashFlow({
      date: cash.date,
      type: 'deposit',
      amount: Number(cash.amount),
      note: String(cash.note || '').trim() || '账户初始资金',
      broker: name
    })
    ElMessage.success(isNewBroker.value ? `已建账户「${name}」并入金` : '已记录入金')
    router.back()
  } finally {
    submitting.value = false
  }
}

function onStockSaved() {
  router.back()
}
</script>

<template>
  <div>
    <div class="page-header">
      <div class="row gap8">
        <el-icon class="back-icon" @click="router.back()"><ArrowLeft /></el-icon>
        <div class="page-title">新增资产</div>
      </div>
    </div>

    <div class="card tab-card">
      <el-radio-group v-model="tab" class="tab-group">
        <el-radio-button value="stock">股票</el-radio-button>
        <el-radio-button value="cash">现金 / 券商账户</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 股票：补录已有持仓，或关联券商的真实买入 -->
    <div v-if="tab === 'stock'" class="card form-card">
      <StockEntryForm @saved="onStockSaved" />
    </div>

    <!-- 现金 / 券商账户：建账户并记一笔初始入金 -->
    <div v-else class="card form-card">
      <div class="init-tip">
        记录某个券商账户里的现金。账户不存在时会顺带创建；已有账户则直接记一笔入金。
        股票的买卖会从这个账户的余额里扣，余额不足时账户余额会变负（不会阻止记账）。
      </div>

      <el-form label-position="top" size="large">
        <el-form-item label="账户类型">
          <div class="type-chips">
            <span class="type-chip active">证券账户</span>
            <span class="muted" style="margin-left: 8px">本软件按券商账户分账记账</span>
          </div>
        </el-form-item>

        <el-form-item label="账户名称">
          <el-select
            v-model="cash.broker"
            filterable
            allow-create
            default-first-option
            :reserve-keyword="false"
            placeholder="选择已有账户，或输入新账户名"
            style="width: 100%"
          >
            <el-option v-for="b in portfolio.brokers" :key="b" :label="b" :value="b" />
          </el-select>
          <div v-if="isNewBroker" class="muted" style="margin-top: 4px">
            将新建账户「{{ cash.broker }}」
          </div>
          <div v-else class="muted" style="margin-top: 4px">
            当前可用 {{ fmtMoney((portfolio.totals.brokerCash || {})[cash.broker] || 0, 2) }}
          </div>
        </el-form-item>

        <div class="row gap8">
          <el-form-item label="金额（元）" class="flex1">
            <el-input-number v-model="cash.amount" :min="0" :precision="2" :controls="false" placeholder="账户余额" style="width: 100%" />
          </el-form-item>
          <el-form-item label="日期" class="flex1">
            <el-date-picker v-model="cash.date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width: 100%" :editable="false" />
          </el-form-item>
        </div>

        <el-form-item label="备注">
          <el-input v-model="cash.note" placeholder="默认：账户初始资金" />
        </el-form-item>
      </el-form>

      <el-button type="primary" class="submit-btn" :loading="submitting" @click="submitCash">保存</el-button>
    </div>
  </div>
</template>

<style scoped>
.back-icon {
  font-size: 20px;
  cursor: pointer;
}
.tab-card {
  padding: 10px 14px;
}
.tab-group {
  display: flex;
  width: 100%;
}
.tab-group :deep(.el-radio-button) {
  flex: 1;
}
.tab-group :deep(.el-radio-button__inner) {
  width: 100%;
}
.form-card {
  padding: 14px;
}
.init-tip {
  background: #fff7ed;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  color: #7c4a03;
  margin-bottom: 16px;
}
.type-chips {
  display: flex;
  align-items: center;
}
.type-chip {
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 10px;
  background: var(--bg);
  color: var(--text-2);
}
.type-chip.active {
  background: var(--primary);
  color: #fff;
  font-weight: 600;
}
.submit-btn {
  width: 100%;
  margin-top: 8px;
}
</style>
