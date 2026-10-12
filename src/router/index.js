import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'overview', component: () => import('../views/Overview.vue') },
  { path: '/assets', name: 'assets', component: () => import('../views/Assets.vue') },
  { path: '/analysis', name: 'analysis', component: () => import('../views/Analysis.vue') },
  { path: '/trades', name: 'trades', component: () => import('../views/Trades.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/Settings.vue') },
  { path: '/composition', name: 'composition', component: () => import('../views/Composition.vue') },
  { path: '/pnl', name: 'pnl-breakdown', component: () => import('../views/PnlBreakdown.vue') },
  { path: '/stock/:market/:code', name: 'stock-detail', component: () => import('../views/StockDetail.vue') },
  { path: '/privacy', name: 'privacy', component: () => import('../views/Privacy.vue') }
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
  // 页面滚动是 window 级的，切换路由时不会自动重置：
  // 从滚到很下面的总览点进详情页，会直接落在详情页底部。
  // 新页面统一回到顶部；系统返回/前进时恢复离开时的位置。
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    return { top: 0 }
  }
})
