import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/stock-ledger/',
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
