import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 版本号单一来源：package.json 的 version，构建时注入为 __APP_VERSION__ 供界面显示
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// 构建时刻（dev 下就是 dev server 启动的时刻）。
// 版本号是编译期常量，dev 时不会随 HMR 更新 —— 改了 package.json 后界面还显示旧版本，
// 很容易误以为代码没生效。带上这个时间就能一眼看出「跑的是哪一次启动/构建」。
// 统一按北京时间（UTC+8）算：CI（GitHub Actions 的 runner）跑在 UTC，
// 直接取运行环境本地时间会显示成早 8 小时的时刻，看着像陈旧构建。
// 下面一律用 getUTC* —— 因为 now 已经偏移到 UTC+8 上了。
const now = new Date(Date.now() + 8 * 3600 * 1000)
const pad2 = (n) => String(n).padStart(2, '0')
const buildTime = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())} ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}`

export default defineConfig({
  // 相对路径构建：同一份产物既能部署在域名根目录（CloudBase），也能部署在子目录（GitHub Pages）
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime)
  },
  plugins: [
    // 版本与构建时刻：走虚拟模块而不是 define。
    // define 在 build 下能把 __APP_VERSION__ 替换掉，但 dev 下不作用于 .vue 的 script ——
    // 那里写裸标识符会直接 ReferenceError 白屏。虚拟模块在 dev/build 下都会真正执行 load()，
    // dev 下取到的是 server 启动时刻，正好用来判断「重启生效没有」
    {
      name: 'build-info',
      resolveId(id) {
        if (id === 'virtual:build-info') return '\0virtual:build-info'
      },
      load(id) {
        if (id !== '\0virtual:build-info') return null
        return `export const APP_VERSION = ${JSON.stringify(pkg.version)}\nexport const BUILD_TIME = ${JSON.stringify(buildTime)}\n`
      }
    },
    {
      // 升版本号后 dev server 不会自动重启，界面会一直停在启动时读到的那个旧版本：
      // package.json 既不是 vite.config.js（改它 Vite 会主动重启），也不在它的模块依赖里
      // （这里是 readFileSync 读的，不是 import），Vite 无从察觉改动。
      // 手动监听并在变化后重启，改完版本号即时生效，不必再手工 Ctrl+C
      name: 'restart-on-version',
      configureServer(server) {
        const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url))
        const target = pkgPath.toLowerCase()
        server.watcher.add(pkgPath)
        server.watcher.on('change', (p) => {
          // Windows 下路径分隔符与大小写不完全一致，统一成小写再比
          if (String(p).toLowerCase() === target) server.restart()
        })
      }
    },
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      // 开发时不要注册 Service Worker：它会把旧资源缓存下来，改完代码刷新仍是白屏/旧界面，
      // 且 sw.js 在 dev 下拿到的是上次构建的清单，容易与当前 dev 资源对不上
      devOptions: { enabled: false },
      includeAssets: ['favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: '股票记账本',
        short_name: '记账本',
        description: '单机股票记账软件：持仓、交易、盈亏分析、报表导出',
        lang: 'zh-CN',
        theme_color: '#0f9d78',
        background_color: '#f5f7fa',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true
      }
    })
  ],
  // dev server 用 5173；8000 留给 `npm run preview`（预览构建产物），两者分开避免抢端口
  server: { host: true, port: 5173 },
  preview: { host: true, port: 8000 },
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
