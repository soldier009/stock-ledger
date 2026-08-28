<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { fmtShares, fmtNum, fmtPct, pnlClass, marketLabel, parseTags } from '../utils/format'

const props = defineProps({
  p: { type: Object, required: true }
})

const router = useRouter()
const pnlCls = computed(() => pnlClass(props.p.pnlCny))
const tags = computed(() => parseTags(props.p.tag))

function goDetail() {
  router.push(`/stock/${props.p.market}/${props.p.code}`)
}
</script>

<template>
  <div class="pos-card card" @click="goDetail">
    <div class="row between">
      <div class="flex1">
        <div class="row gap8">
          <span class="pos-name">{{ p.name || p.code }}</span>
          <el-tag size="small" effect="plain" type="success">{{ marketLabel(p.market) }}</el-tag>
          <el-tag v-if="p.broker" size="small" effect="plain" type="warning">{{ p.broker }}</el-tag>
        </div>
        <div class="muted num" style="margin-top: 4px">
          {{ p.code }} · {{ fmtShares(p.shares) }} 股
        </div>
        <div v-if="tags.length" class="row gap4" style="margin-top: 6px">
          <el-tag v-for="tg in tags" :key="tg" size="small" effect="light" type="info">{{ tg }}</el-tag>
        </div>
      </div>
      <div class="right-col">
        <div class="num price">{{ p.quote ? fmtNum(p.price, 3) : '—' }}</div>
        <div class="muted" v-if="p.quote && p.quote.changePct !== null" :class="pnlClass(p.quote.changePct)">
          {{ p.quote.changePct > 0 ? '+' : '' }}{{ fmtPct(p.quote.changePct) }}
        </div>
        <div class="muted" v-else>暂无行情</div>
        <el-icon class="chevron"><ArrowRight /></el-icon>
      </div>
    </div>

    <div class="divider"></div>

    <div class="grid">
      <div>
        <div class="muted">成本价</div>
        <div class="num">{{ fmtNum(p.avgCost, 3) }}</div>
      </div>
      <div>
        <div class="muted">市值(¥)</div>
        <div class="num">{{ fmtNum(p.mvCny, 0) }}</div>
      </div>
      <div>
        <div class="muted">浮动盈亏(¥)</div>
        <div class="num" :class="pnlCls">
          {{ p.pnlCny > 0 ? '+' : '' }}{{ fmtNum(p.pnlCny, 0) }}
        </div>
      </div>
      <div>
        <div class="muted">盈亏率</div>
        <div class="num" :class="pnlCls">{{ p.pnlPct === null ? '—' : (p.pnlPct > 0 ? '+' : '') + fmtPct(p.pnlPct) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pos-card {
  padding: 14px 14px 12px;
  margin-bottom: 10px;
  cursor: pointer;
  transition: transform 0.1s;
}
.pos-card:active {
  transform: scale(0.99);
}
.chevron {
  color: #cbd5e1;
  font-size: 14px;
  margin-top: 6px;
}
.gap4 {
  gap: 4px;
}
.row.gap4 {
  display: flex;
  flex-wrap: wrap;
}
.pos-name {
  font-size: 16px;
  font-weight: 600;
}
.price {
  font-size: 16px;
  font-weight: 600;
  text-align: right;
}
.right-col {
  text-align: right;
}
.divider {
  height: 1px;
  background: var(--border);
  margin: 10px 0;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  gap: 8px;
}
.grid > div > .num {
  margin-top: 3px;
  font-size: 13px;
}
</style>
