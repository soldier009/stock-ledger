<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { registerSW } from 'virtual:pwa-register'
import { usePortfolioStore } from './stores/portfolio'
import { useSettingsStore } from './stores/settings'
import { debounce } from './utils/debounce'

const route = useRoute()
const portfolio = usePortfolioStore()
const settings = useSettingsStore()
const online = ref(navigator.onLine)

let quoteTimer = null
let backupTimer = null

// PWA：检测到新版 Service Worker 下载完成后提示刷新，避免用户长期停留在旧缓存版本
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    // 首次安装（无旧版控制器接管）不需要提示
    if (!registration || !navigator.serviceWorker?.controller) return
    let prompted = false
    registration.addEventListener('updatefound', () => {
      const nw = registration.installing
      if (!nw) return
      nw.addEventListener('statechange', () => {
        if (prompted || nw.state !== 'installed') return
        prompted = true
        ElMessageBox.confirm(
          `已下载新版本 v${__APP_VERSION__}，刷新后立即生效。若正在同步/备份，请稍后再刷新。`,
          '发现新版本',
          { confirmButtonText: '立即刷新', cancelButtonText: '稍后', distinguishCancelAndClose: true }
        )
          .then(() => location.reload())
          .catch(() => {})
      })
    })
  }
})

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

function onNetChange() {
  online.value = navigator.onLine
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
  window.addEventListener('online', onNetChange)
  window.addEventListener('offline', onNetChange)
})

onBeforeUnmount(() => {
  clearInterval(quoteTimer)
  clearInterval(backupTimer)
  window.removeEventListener('focus', onFocus)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('online', onNetChange)
  window.removeEventListener('offline', onNetChange)
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
    <div class="splash-ver">v{{ __APP_VERSION__ }}</div>
  </div>
  <div v-else class="app" :class="{ 'has-offline-bar': !online }">
    <div v-if="!online" class="offline-bar">当前离线：行情刷新与云同步暂不可用</div>
    <div class="ver-badge">v{{ __APP_VERSION__ }}</div>
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

<style scoped>
.ver-badge {
  position: fixed;
  right: 10px;
  top: 6px;
  z-index: 999;
  font-size: 10px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 10px;
  color: rgba(0, 0, 0, 0.4);
  background: rgba(255, 255, 255, 0.8);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  pointer-events: none;
  user-select: none;
}
.offline-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  background: #f59e0b;
  color: #fff;
  font-size: 12px;
  text-align: center;
  padding: calc(6px + env(safe-area-inset-top)) 10px 6px;
}
.has-offline-bar .ver-badge {
  top: calc(32px + env(safe-area-inset-top));
}
.splash-ver {
  margin-top: 10px;
  font-size: 11px;
  color: rgba(0, 0, 0, 0.3);
}
</style>
