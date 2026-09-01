import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'
import './styles/main.css'

const app = createApp(App)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')

// 仅在「已安装到桌面 / 全屏 PWA」下接管安卓返回键，普通浏览器标签页保持默认行为
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true

if (isStandalone) {
  // 栈底压入一条哨兵记录：在首页按返回键时回到它，即可拦截一次退出
  const pushGuard = () => {
    history.pushState({ ...(history.state || {}), __exitGuard: true }, '', location.href)
  }
  let lastBackAt = 0
  router.isReady().then(pushGuard)
  window.addEventListener('popstate', (e) => {
    if (!e.state || !e.state.__exitGuard) return
    const now = Date.now()
    if (now - lastBackAt < 2000) return // 2 秒内再次按下：放行，真正退出
    lastBackAt = now
    pushGuard() // 抵消刚才那次返回
    ElMessage({ message: '再按一次退出应用', duration: 1500, showClose: false })
  })
}
