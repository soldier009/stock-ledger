import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'overview', component: () => import('../views/Overview.vue') },
  { path: '/assets', name: 'assets', component: () => import('../views/Assets.vue') },
  { path: '/analysis', name: 'analysis', component: () => import('../views/Analysis.vue') },
  { path: '/trades', name: 'trades', component: () => import('../views/Trades.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/Settings.vue') },
  { path: '/stock/:market/:code', name: 'stock-detail', component: () => import('../views/StockDetail.vue') }
]

export default createRouter({
  history: createWebHashHistory(),
  routes
})
