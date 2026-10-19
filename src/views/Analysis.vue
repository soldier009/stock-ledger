<script setup>
/**
 * 分析页：三个页签的容器
 * 配置 = 资产曲线 + 成本与盈亏入口
 * 收益 = 收益曲线 + 买卖盈亏日历 + 回撤分析/事件
 * 分红 = 分红汇总 + 分红日历 + 明细 + 按标的汇总
 * 页签用 v-if 挂载子组件：切换即销毁旧图、新页签自行重绘，无需在这里统一刷新
 */
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getKv, setKv } from '../db'
import AnalysisConfig from './analysis/AnalysisConfig.vue'
import AnalysisReturns from './analysis/AnalysisReturns.vue'
import AnalysisDividends from './analysis/AnalysisDividends.vue'

const TABS = [
  { key: 'config', label: '配置' },
  { key: 'returns', label: '收益' },
  { key: 'dividends', label: '分红' }
]
const TAB_KEY = 'stock-ledger-analysis-tab-v1'

const route = useRoute()
const router = useRouter()
const isTab = (v) => TABS.some((t) => t.key === v)
const tab = ref(isTab(route.query.tab) ? route.query.tab : 'config')

// 上次选择的页签：地址栏有指定时不覆盖
if (!isTab(route.query.tab)) {
  getKv(TAB_KEY)
    .then((v) => {
      if (!isTab(route.query.tab) && isTab(v && v.tab)) tab.value = v.tab
    })
    .catch(() => {})
}

watch(tab, (v) => {
  setKv(TAB_KEY, { tab: v }).catch((e) => console.warn('[分析] 页签保存失败', e))
  // 同步到地址栏方便深链/收藏；用 replace 不产生历史记录，返回键仍是上一页
  router.replace({ query: { ...route.query, tab: v } }).catch(() => {})
})
</script>

<template>
  <div>
    <div class="page-header">
      <div class="page-title">分析</div>
    </div>

    <div class="page-tabs">
      <span
        v-for="t in TABS"
        :key="t.key"
        class="page-tab"
        :class="{ active: tab === t.key }"
        @click="tab = t.key"
      >{{ t.label }}</span>
    </div>

    <AnalysisConfig v-if="tab === 'config'" />
    <AnalysisReturns v-else-if="tab === 'returns'" />
    <AnalysisDividends v-else />
  </div>
</template>

<style scoped>
/* 页签栏滚动时吸顶：内容很长，切页签不用先回到顶部 */
.page-tabs {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  gap: 6px;
  margin: -4px 0 10px;
  padding: 6px 0;
  background: var(--bg, #f5f7fa);
  border-bottom: 1px solid #eef2f7;
}
.page-tab {
  flex: 1;
  text-align: center;
  font-size: 13px;
  padding: 6px 0;
  border-radius: 8px;
  background: #f1f5f9;
  color: var(--text-2, #64748b);
  cursor: pointer;
}
.page-tab.active {
  background: #fff;
  color: #dc2626;
  font-weight: 700;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}
</style>
