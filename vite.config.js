import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

// 版本号单一来源：package.json 的 version，构建时注入为 __APP_VERSION__ 供界面显示
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig({
  base: '/stock-ledger/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/icon-512.png'],
      manifest: {
        name: '股票记账本',
        short_name: '记账本',
        description: '单机股票记账软件：持仓、交易、盈亏分析、报表导出',
        lang: 'zh-CN',
        theme_color: '#0f9d78',
        background_color: '#f5f7fa',
        display: 'standalone',
        start_url: '/stock-ledger/',
        scope: '/stock-ledger/',
        icons: [
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true
      }
    })
  ],
  server: { host: true, port: 5173 },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          'element-plus': ['element-plus', '@element-plus/icons-vue'],
          echarts: ['echarts'],
          sql: ['sql.js'],
          xlsx: ['xlsx'],
          jspdf: ['jspdf']
        }
      }
    }
  }
})
