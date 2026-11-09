<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { FEE_TIERS, feeSummary, rateToWan, tierLabel, wanToRate } from '../utils/fee'
import { fmtMoney } from '../utils/format'

const router = useRouter()
const portfolio = usePortfolioStore()

const newBroker = ref('')

// ===== 券商增删改 =====
async function addBroker() {
  const n = newBroker.value.trim()
  if (!n) return
  if (portfolio.brokers.includes(n)) return ElMessage.warning('券商已存在')
  await portfolio.addBroker(n)
  newBroker.value = ''
  ElMessage.success('已添加')
}

async function removeBroker(name) {
  if (portfolio.brokers.length <= 1) return ElMessage.warning('至少保留一个券商')
  let msg
  if (name === portfolio.defaultBroker) {
    const next = portfolio.brokers.find((b) => b !== name) || portfolio.defaultBroker
    msg = `「${name}」是当前默认账户，删除后默认账户将切换为「${next}」，其名下数据也会一并归入该账户。确定删除？`
  } else {
    msg = `删除券商「${name}」后，其名下股票与交易将归入「${portfolio.defaultBroker}」账户，确定删除？`
  }
  try {
    await ElMessageBox.confirm(msg, '删除券商', { type: 'warning' })
    await portfolio.deleteBroker(name)
    if (editingFee.value === name) editingFee.value = ''
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}

async function setDefaultBroker(name) {
  await portfolio.setDefaultBroker(name)
  ElMessage.success(`已将「${name}」设为默认账户`)
}

async function renameBroker(name) {
  try {
    const { value } = await ElMessageBox.prompt('请输入新的券商名称', '重命名券商', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValue: name,
      inputPattern: /\S+/,
      inputErrorMessage: '名称不能为空'
    })
    const n = String(value || '').trim()
    if (!n || n === name) return
    if (portfolio.brokers.includes(n)) return ElMessage.warning('券商已存在')
    await portfolio.renameBroker(name, n)
    if (editingFee.value === name) editingFee.value = ''
    ElMessage.success('已重命名')
  } catch {
    /* 取消 */
  }
}

// ===== 费率档位 =====
// 一次只编辑一个券商：tiers 为四个固定档位（股票/基金/可转债/兜底），费率按「万分之几」录入
const editingFee = ref('')
const tiers = ref([])
const trialAmount = ref(10000)

function startEditFee(name) {
  const saved = (portfolio.brokerFee || {})[name] || { tiers: [] }
  const byKey = {}
  for (const t of saved.tiers || []) byKey[t.key] = t
  tiers.value = FEE_TIERS.map(({ key }) => ({
    key,
    rateWan: rateToWan(byKey[key] ? byKey[key].rate : 0),
    min: Number(byKey[key] ? byKey[key].min : 0) || 0
  }))
  editingFee.value = name
}

function cancelEditFee() {
  editingFee.value = ''
}

async function saveFee(name) {
  const payload = tiers.value.map((t) => ({
    key: t.key,
    rate: wanToRate(t.rateWan),
    min: Number(t.min) || 0
  }))
  await portfolio.setBrokerFee(name, payload)
  editingFee.value = ''
  ElMessage.success('费率已保存')
}

// 试算：按该档当前录入的费率算一笔成交金额的佣金（与 utils/fee 的算法一致）
function trialFee(t) {
  const amt = Number(trialAmount.value) || 0
  const rate = wanToRate(t.rateWan)
  const min = Number(t.min) || 0
  if (amt <= 0 || (rate <= 0 && min <= 0)) return 0
  const fee = rate > 0 ? Math.max(amt * rate, min) : min
  return Math.round(fee * 100) / 100
}

function summaryOf(name) {
  return feeSummary((portfolio.brokerFee || {})[name]) || '未设置费率'
}
</script>

<template>
  <div>
    <div class="page-header">
      <div class="row gap8">
        <el-icon class="back-icon" @click="router.back()"><ArrowLeft /></el-icon>
        <div class="page-title">券商管理</div>
      </div>
    </div>

    <div class="card">
      <div class="muted note">
        买卖、分红与资金出入只在该股票所属券商账户内流动。设置费率后，记账时手续费会按成交金额与品种自动带出（仍可手改）。
      </div>
      <div class="row gap8" style="margin-top: 12px">
        <el-input v-model="newBroker" placeholder="券商名称，如：华泰证券" @keyup.enter="addBroker" />
        <el-button type="primary" @click="addBroker">添加</el-button>
      </div>
    </div>

    <div v-for="b in portfolio.brokers" :key="b" class="card broker-card">
      <div class="row between">
        <div class="row gap8">
          <span class="broker-name">{{ b }}</span>
          <span v-if="b === portfolio.defaultBroker" class="default-badge">默认</span>
        </div>
        <div class="row gap4">
          <el-button v-if="b !== portfolio.defaultBroker" size="small" text type="primary" @click="setDefaultBroker(b)">设为默认</el-button>
          <el-button size="small" text @click="editingFee === b ? cancelEditFee() : startEditFee(b)">
            {{ editingFee === b ? '收起' : '费率' }}
          </el-button>
          <el-button size="small" text @click="renameBroker(b)">重命名</el-button>
          <el-button size="small" text type="danger" @click="removeBroker(b)">删除</el-button>
        </div>
      </div>

      <div class="fee-summary muted">{{ summaryOf(b) }}</div>

      <!-- 费率档位编辑 -->
      <div v-if="editingFee === b" class="fee-editor">
        <div v-for="t in tiers" :key="t.key" class="tier-row">
          <span class="tier-name">{{ tierLabel(t.key) }}</span>
          <el-input-number v-model="t.rateWan" :min="0" :precision="3" :controls="false" size="small" placeholder="费率" style="width: 92px" />
          <span class="muted">万分之</span>
          <el-input-number v-model="t.min" :min="0" :precision="2" :controls="false" size="small" placeholder="最低" style="width: 82px" />
          <span class="muted">元起</span>
        </div>
        <div class="muted note">
          「兜底」用于没匹配到具体品种的标的（如港美股）；四个档位都留空则不自动带出，恢复手填。
        </div>

        <div class="trial">
          <span class="muted">试算买入</span>
          <el-input-number v-model="trialAmount" :min="0" :precision="2" :controls="false" size="small" style="width: 110px" />
          <span class="muted">元：</span>
          <span class="trial-item" v-for="t in tiers" :key="t.key">
            {{ tierLabel(t.key) }}
            <b class="num">{{ fmtMoney(trialFee(t), 2) }}</b>
          </span>
        </div>

        <div class="row gap8" style="margin-top: 12px">
          <el-button type="primary" size="small" @click="saveFee(b)">保存</el-button>
          <el-button size="small" @click="cancelEditFee">取消</el-button>
        </div>
      </div>
    </div>

    <div v-if="!portfolio.brokers.length" class="empty-tip">
      <div>暂无券商账户</div>
      <div class="muted">在上方输入名称添加一个</div>
    </div>
  </div>
</template>

<style scoped>
.back-icon {
  font-size: 20px;
  cursor: pointer;
}
.note {
  font-size: 11px;
  line-height: 1.6;
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
  border-radius: 4px;
  background: var(--primary);
  color: #fff;
}
.fee-summary {
  font-size: 12px;
  margin-top: 6px;
  line-height: 1.5;
}
.fee-editor {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border, #e2e8f0);
}
.tier-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.tier-name {
  width: 48px;
  font-size: 13px;
  color: var(--text-2, #475569);
}
.trial {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
}
.trial-item {
  color: var(--text-2, #475569);
}
.trial-item b {
  color: var(--primary);
}
</style>
