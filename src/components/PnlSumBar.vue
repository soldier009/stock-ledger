<script setup>
/**
 * 盈亏汇总条：成本 / 市值 / 浮动盈亏 / 今日盈亏 / 已实现盈亏 / 合计盈亏 / 收益率。
 * 成本与盈亏页的一级与二级都用它，改一处即可统一口径与样式。
 */
import { fmtMoney, pnlClass } from '../utils/format'

const props = defineProps({
  sum: { type: Object, required: true }, // sumRows() 的结果
  signed: { type: Function, required: true }, // 带正负号的金额格式化
  signedPct: { type: Function, required: true },
  todayText: { type: Function, required: true }
})
</script>

<template>
  <div class="pnl-sum">
    <div class="pnl-sum-item">
      <div class="pnl-sum-label">成本</div>
      <div class="pnl-sum-value">{{ fmtMoney(props.sum.cost, 0) }}</div>
    </div>
    <div class="pnl-sum-item">
      <div class="pnl-sum-label">市值</div>
      <div class="pnl-sum-value">{{ fmtMoney(props.sum.mv, 0) }}</div>
    </div>
    <div class="pnl-sum-item">
      <div class="pnl-sum-label">浮动盈亏</div>
      <div class="pnl-sum-value" :class="pnlClass(props.sum.floating)">{{ props.signed(props.sum.floating, 0) }}</div>
    </div>
    <div class="pnl-sum-item">
      <div class="pnl-sum-label">今日盈亏</div>
      <div class="pnl-sum-value" :class="props.sum.hasToday ? pnlClass(props.sum.today) : ''">
        {{ props.todayText(props.sum) }}
      </div>
    </div>
    <div class="pnl-sum-item">
      <div class="pnl-sum-label">已实现盈亏</div>
      <div class="pnl-sum-value" :class="pnlClass(props.sum.realized)">{{ props.signed(props.sum.realized, 0) }}</div>
    </div>
    <div class="pnl-sum-item">
      <div class="pnl-sum-label">合计盈亏</div>
      <div class="pnl-sum-value" :class="pnlClass(props.sum.totalPnl)">{{ props.signed(props.sum.totalPnl, 0) }}</div>
    </div>
    <div class="pnl-sum-item">
      <div class="pnl-sum-label">收益率</div>
      <div class="pnl-sum-value" :class="pnlClass(props.sum.returnPct)">{{ props.signedPct(props.sum.returnPct) }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 合计条：七个指标三列铺开（样式随组件走，宿主 <style scoped> 对子组件内部不生效） */
.pnl-sum {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 6px 0 12px;
}
.pnl-sum-item {
  background: #f8fafc;
  border-radius: 8px;
  padding: 8px 10px;
}
.pnl-sum-label {
  font-size: 11px;
  color: var(--text-2, #64748b);
}
.pnl-sum-value {
  font-size: 14px;
  font-weight: 600;
  margin-top: 2px;
}
</style>
