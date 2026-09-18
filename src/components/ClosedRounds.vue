<script setup>
import { ref, computed } from 'vue'
import { ArrowLeft } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { fmtMoney, fmtNum, fmtPct, pnlClass } from '../utils/format'

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue'])

const portfolio = usePortfolioStore()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const sortBy = ref('time') // time | pnl
const expanded = ref('')

// 当前仍有持仓的股票（清仓后又买入的，这里会标记「持有中」，历史清仓记录不会被隐藏）
const holdingKeys = computed(() => {
  const set = new Set()
  for (const p of portfolio.positions) set.add(p.market + ':' + p.code)
  return set
})

const list = computed(() => {
  const rows = [...portfolio.closedRounds]
  if (sortBy.value === 'pnl') rows.sort((a, b) => b.realized - a.realized)
  return rows
})

const stat = computed(() => portfolio.closedStat)

function rid(r) {
  return r.key + '#' + r.index
}

function toggle(r) {
  const id = rid(r)
  expanded.value = expanded.value === id ? '' : id
}

function isOpen(r) {
  return expanded.value === rid(r)
}

// 持有天数：同一天买入并清仓显示「当日」
function holdText(r) {
  if (!r.days) return '当日平仓'
  return `持有 ${r.days} 天`
}

function typeLabel(t) {
  if (t.type === 'buy') return '买入'
  if (t.type === 'rights') return '配股'
  if (t.type === 'gift') return '送股'
  if (t.type === 'sell') return '卖出'
  if (t.type === 'div') return '分红'
  return t.type || '其他'
}

// 明细行的右侧金额：买入为付出成本，卖出为到账金额，分红为到账金额
function rowAmount(t) {
  if (t.type === 'sell') return t.proceeds || 0
  if (t.type === 'div') return Number(t.amount) || 0
  return t.cost || 0
}

function signed(v) {
  return (v > 0 ? '+' : '') + fmtMoney(v, 0)
}

function close() {
  visible.value = false
}

// 右滑关闭：与净资产走势面板同款交互
const dragX = ref(0)
const dragging = ref(false)
let startX = 0
let startY = 0

const panelStyle = computed(() => (dragX.value ? { transform: `translateX(${dragX.value}px)` } : {}))

function onTouchStart(e) {
  const t = e.touches && e.touches[0]
  if (!t) return
  startX = t.clientX
  startY = t.clientY
  dragging.value = false
}

function onTouchMove(e) {
  const t = e.touches && e.touches[0]
  if (!t) return
  const dx = t.clientX - startX
  const dy = t.clientY - startY
  if (!dragging.value) {
    if (dx > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) dragging.value = true
    else return
  }
  dragX.value = Math.max(0, Math.min(dx, 260))
  if (e.cancelable) e.preventDefault()
}

function onTouchEnd() {
  const passed = dragX.value > 72
  dragging.value = false
  dragX.value = 0
  if (passed) close()
}
</script>

<template>
  <teleport to="body">
    <div v-if="visible" class="cr-overlay" @click.self="close">
      <div
        class="cr-panel"
        :class="{ dragging }"
        :style="panelStyle"
        @touchstart.passive="onTouchStart"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
      >
        <div class="cr-header">
          <div class="cr-back" @click="close">
            <el-icon :size="22"><ArrowLeft /></el-icon>
          </div>
          <div class="cr-title">已清仓记录</div>
          <div class="cr-back" style="visibility: hidden">
            <el-icon :size="22"><ArrowLeft /></el-icon>
          </div>
        </div>

        <div class="cr-summary">
          <div class="cr-sum-left">
            <div class="cr-sum-label">累计已实现（含分红）</div>
            <div class="cr-sum-value num" :class="pnlClass(stat.realized)">{{ signed(stat.realized) }}</div>
          </div>
          <div class="cr-sum-right">
            <div class="cr-sum-sub">
              <span class="up">{{ stat.win }} 笔盈利</span>
              <span class="cr-dot">·</span>
              <span class="down">{{ stat.loss }} 笔亏损</span>
            </div>
            <div class="cr-sum-sub muted">共 {{ stat.count }} 笔 / {{ stat.stockCount }} 只</div>
          </div>
        </div>

        <div class="cr-toolbar">
          <span
            class="cr-chip"
            :class="{ active: sortBy === 'time' }"
            @click="sortBy = 'time'"
          >按清仓时间</span>
          <span
            class="cr-chip"
            :class="{ active: sortBy === 'pnl' }"
            @click="sortBy = 'pnl'"
          >按盈亏</span>
        </div>

        <div class="cr-list">
          <div v-for="r in list" :key="rid(r)" class="cr-item">
            <div class="cr-row" @click="toggle(r)">
              <div class="cr-line1">
                <div class="cr-name-wrap">
                  <span class="cr-name">{{ r.name }}</span>
                  <span class="cr-code">{{ r.code }}</span>
                  <span v-if="r.total > 1" class="cr-round">第 {{ r.index }} 轮</span>
                  <span v-if="holdingKeys.has(r.key)" class="cr-holding">持有中</span>
                </div>
                <div class="cr-pnl num" :class="pnlClass(r.realized)">{{ signed(r.realized) }}</div>
              </div>
              <div class="cr-line2">
                <span>{{ r.start }} → {{ r.end }}</span>
                <span class="cr-sep">·</span>
                <span>{{ holdText(r) }}</span>
                <span class="cr-sep">·</span>
                <span>{{ r.tradeCount }} 笔交易</span>
              </div>
              <div class="cr-line3">
                <span>买入 {{ fmtMoney(r.buyAmount, 0) }}</span>
                <span class="cr-sep">·</span>
                <span>卖出 {{ fmtMoney(r.sellAmount, 0) }}</span>
                <span v-if="r.div" class="cr-sep">·</span>
                <span v-if="r.div">分红 {{ fmtMoney(r.div, 0) }}</span>
                <span class="cr-rate num" :class="pnlClass(r.pnlPct)">
                  {{ r.pnlPct > 0 ? '+' : '' }}{{ fmtPct(r.pnlPct) }}
                </span>
              </div>
            </div>

            <div v-if="isOpen(r)" class="cr-detail">
              <div v-for="(t, i) in r.trades" :key="i" class="cr-detail-row">
                <div class="cr-d-left">
                  <span class="cr-d-type" :class="'t-' + t.type">{{ typeLabel(t) }}</span>
                  <span class="cr-d-date">{{ t.date }}</span>
                </div>
                <div class="cr-d-mid">
                  <span v-if="t.qty">{{ fmtNum(t.qty, 2) }} 股</span>
                  <span v-if="t.price" class="cr-d-price">@ {{ fmtNum(t.price, 2) }}</span>
                </div>
                <div class="cr-d-right">
                  <span class="num">{{ fmtMoney(rowAmount(t), 0) }}</span>
                  <span
                    v-if="t.realized !== null && t.realized !== undefined"
                    class="num cr-d-realized"
                    :class="pnlClass(t.realized)"
                  >{{ signed(t.realized) }}</span>
                </div>
              </div>
              <div class="cr-d-note">分红与卖出的已实现盈亏均计入本轮；收益率 = 已实现盈亏 ÷ 本轮买入成本</div>
            </div>
          </div>

          <div v-if="!list.length" class="cr-empty">
            还没有已清仓的股票<br />
            <span class="muted">全部卖出（持仓归零）后，这里会留下一条清仓记录</span>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.cr-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(15, 23, 42, 0.4);
  display: flex;
  justify-content: center;
  align-items: stretch;
  padding: 16px;
}
.cr-panel {
  background: #fff;
  width: 100%;
  max-width: 480px;
  border-radius: 16px;
  box-shadow: 0 12px 48px rgba(15, 23, 42, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: transform 0.22s ease;
}
.cr-panel.dragging {
  transition: none;
}
.cr-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 4px;
  flex-shrink: 0;
}
.cr-back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  cursor: pointer;
  color: var(--text-1, #1f2937);
}
.cr-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1, #1f2937);
}
.cr-summary {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 16px 10px;
  border-bottom: 1px solid #f1f5f9;
  flex-shrink: 0;
}
.cr-sum-label {
  font-size: 12px;
  color: var(--text-2, #64748b);
}
.cr-sum-value {
  font-size: 24px;
  font-weight: 800;
  margin-top: 2px;
}
.cr-sum-value.up {
  color: #dc2626;
}
.cr-sum-value.down {
  color: #10b981;
}
.cr-sum-right {
  text-align: right;
  font-size: 12px;
  line-height: 1.7;
}
.cr-sum-sub .up {
  color: #dc2626;
  font-weight: 600;
}
.cr-sum-sub .down {
  color: #10b981;
  font-weight: 600;
}
.cr-dot {
  color: #cbd5e1;
  margin: 0 4px;
}
.cr-toolbar {
  display: flex;
  gap: 6px;
  padding: 10px 16px 0;
  flex-shrink: 0;
}
.cr-chip {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 15px;
  background: #f1f5f9;
  color: var(--text-2, #64748b);
  cursor: pointer;
}
.cr-chip.active {
  background: #fdecec;
  color: #dc2626;
  font-weight: 600;
}
.cr-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cr-item {
  border: 1px solid #f1f5f9;
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
}
.cr-row {
  padding: 10px 12px;
  cursor: pointer;
}
.cr-row:active {
  background: #f8fafc;
}
.cr-line1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.cr-name-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  flex-wrap: wrap;
}
.cr-name {
  font-size: 14px;
  font-weight: 700;
  color: #1f2937;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 130px;
}
.cr-code {
  font-size: 11px;
  color: #94a3b8;
}
.cr-round {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #f1f5f9;
  color: #64748b;
  flex-shrink: 0;
}
.cr-holding {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #fff7ed;
  color: #d97706;
  flex-shrink: 0;
}
.cr-pnl {
  font-size: 15px;
  font-weight: 800;
  flex-shrink: 0;
}
.cr-pnl.up {
  color: #dc2626;
}
.cr-pnl.down {
  color: #10b981;
}
.cr-line2,
.cr-line3 {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-2, #64748b);
  margin-top: 6px;
  flex-wrap: wrap;
}
.cr-sep {
  color: #cbd5e1;
}
.cr-rate {
  margin-left: auto;
  font-weight: 700;
}
.cr-rate.up {
  color: #dc2626;
}
.cr-rate.down {
  color: #10b981;
}
.cr-detail {
  border-top: 1px dashed #e2e8f0;
  background: #f8fafc;
  padding: 8px 12px 10px;
}
.cr-detail-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 0;
  color: #334155;
}
.cr-d-left {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 106px;
  flex-shrink: 0;
}
.cr-d-type {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 6px;
  background: #e2e8f0;
  color: #475569;
}
.cr-d-type.t-buy,
.cr-d-type.t-rights,
.cr-d-type.t-gift {
  background: #fee2e2;
  color: #dc2626;
}
.cr-d-type.t-sell {
  background: #d1fae5;
  color: #10b981;
}
.cr-d-type.t-div {
  background: #fef3c7;
  color: #d97706;
}
.cr-d-date {
  color: #94a3b8;
  font-size: 11px;
}
.cr-d-mid {
  flex: 1;
  color: var(--text-2, #64748b);
  font-size: 11px;
}
.cr-d-price {
  margin-left: 4px;
}
.cr-d-right {
  text-align: right;
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex-shrink: 0;
}
.cr-d-realized {
  font-size: 11px;
  font-weight: 700;
}
.cr-d-realized.up {
  color: #dc2626;
}
.cr-d-realized.down {
  color: #10b981;
}
.cr-d-note {
  margin-top: 6px;
  font-size: 10px;
  line-height: 1.5;
  color: #94a3b8;
}
.cr-empty {
  padding: 40px 10px;
  text-align: center;
  font-size: 13px;
  color: var(--text-2, #64748b);
  line-height: 1.8;
}

@media (max-width: 540px) {
  .cr-overlay {
    padding: 0;
  }
  .cr-panel {
    max-width: none;
    border-radius: 0;
  }
}
</style>
