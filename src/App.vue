<script setup>
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { usePortfolioStore } from './stores/portfolio'
import { useSettingsStore } from './stores/settings'
import { debounce } from './utils/debounce'

const route = useRoute()
const portfolio = usePortfolioStore()
const settings = useSettingsStore()

let quoteTimer = null
let backupTimer = null

const debouncedBackup = debounce(() => {
  if (settings.github.autoBackup) settings.backupNow(true)
}, 20000)

function startQuoteTimer() {
  clearInterval(quoteTimer)
  const minutes = Math.max(1, settings.refreshMinutes || 10)
  quoteTimer = setInterval(() => portfolio.refreshQuotes(true), minutes * 60 * 1000)
}

// 多端自动同步：距上次同步超过 2 分钟才执行，避免频繁请求
async function autoSync() {
  if (!settings.isGithubReady) return
  const last = settings.lastSyncAt ? new Date(settings.lastSyncAt).getTime() : 0
  if (Date.now() - last < 2 * 60 * 1000) return
  const action = await settings.sync(true)
  if (action === 'downloaded') await portfolio.loadData()
}

function onFocus() {
  portfolio.refreshQuotes(true)
  autoSync()
}

function onVisibility() {
  if (document.visibilityState === 'visible') {
    portfolio.refreshQuotes(true)
    autoSync()
  }
}

onMounted(async () => {
  await portfolio.init()
  startQuoteTimer()
  autoSync()
  backupTimer = setInterval(() => {
    if (settings.github.autoBackup && settings.isGithubReady) settings.backupNow(true)
    autoSync()
  }, 6 * 3600 * 1000)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  clearInterval(quoteTimer)
  clearInterval(backupTimer)
  window.removeEventListener('focus', onFocus)
  document.removeEventListener('visibilitychange', onVisibility)
})

watch(() => settings.refreshMinutes, () => startQuoteTimer())

watch(
  () => [portfolio.trades.length, portfolio.cashFlows.length],
  () => debouncedBackup()
)
</script>

<template>
  <div v-if="!portfolio.ready" class="splash">
    <div class="splash-logo">📊</div>
    <div class="muted">正在加载数据...</div>
  </div>
  <div v-else class="app">
    <div class="page-wrap">
      <router-view />
    </div>
    <nav class="tabbar">
      <router-link to="/" class="tab" :class="{ active: route.path === '/' }">
        <el-icon :size="22"><Grid /></el-icon>
        <span>总览</span>
      </router-link>
      <router-link to="/assets" class="tab" :class="{ active: route.path === '/assets' }">
        <el-icon :size="22"><Box /></el-icon>
        <span>资产</span>
      </router-link>
      <router-link to="/analysis" class="tab" :class="{ active: route.path === '/analysis' }">
        <el-icon :size="22"><TrendCharts /></el-icon>
        <span>分析</span>
      </router-link>
      <router-link to="/settings" class="tab" :class="{ active: route.path === '/settings' }">
        <el-icon :size="22"><Setting /></el-icon>
        <span>设置</span>
      </router-link>
    </nav>
  </div>
</template>
