/**
 * ECharts 实例生命周期的公共封装。
 *
 * 之前 DonutChart / NetWorthCurve / StockTrend / Analysis 各自写了
 * 「init + resize 监听 + ResizeObserver 兜底 + dispose」这一套，逐步走样
 * （StockTrend 甚至漏了窗口 resize 监听）。这里统一收口：
 *  - 容器 ref 出现后才 init（v-if 下的容器反复挂载也安全）
 *  - window resize + ResizeObserver 双保险：容器尺寸由 0 变为可用时会触发回调
 *  - 卸载时自动移除监听并 dispose
 */
import * as echarts from 'echarts'
import { onBeforeUnmount, onMounted, watch } from 'vue'

/** hex -> rgba，用于渐变填充 */
export function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/**
 * 单个图表实例。
 * @param {import('vue').Ref<HTMLElement|null>} elRef 画布容器
 * @param {Object} [opts]
 *   - observe: 是否用 ResizeObserver 跟随容器尺寸（默认 true）
 *   - autoResize: 是否监听 window resize（默认 true）
 *   - onResize: 尺寸变化时的回调；未给则执行 chart.resize()
 * @returns {{ get, resize, dispose, clear }}
 */
export function useEcharts(elRef, { observe = true, autoResize = true, onResize } = {}) {
  let chart = null
  let ro = null
  let stopWatch = null

  const kill = () => {
    if (chart) {
      try {
        chart.dispose()
      } catch {
        /* 已销毁则忽略 */
      }
      chart = null
    }
  }

  // 惰性初始化：容器存在才建实例；
  // 容器被 v-if 重建过时旧实例指向已失效的画布，直接重建（否则打开浮层会一片空白）
  const get = () => {
    const el = elRef.value
    if (!el) return null
    if (chart && chart.getDom && chart.getDom() !== el) kill()
    if (!chart) chart = echarts.init(el)
    return chart
  }

  const resize = () => {
    if (chart) chart.resize()
  }

  const handle = () => {
    if (onResize) onResize()
    else resize()
  }

  const dispose = () => {
    if (ro) {
      ro.disconnect()
      ro = null
    }
    kill()
  }

  const attachObserver = () => {
    if (!observe || typeof ResizeObserver === 'undefined') return
    disconnectObserver()
    if (!elRef.value) return
    ro = new ResizeObserver(() => handle())
    ro.observe(elRef.value)
  }
  const disconnectObserver = () => {
    if (ro) {
      ro.disconnect()
      ro = null
    }
  }

  onMounted(() => {
    if (autoResize) window.addEventListener('resize', handle)
    attachObserver()
    // 容器被 v-if 重新挂载后重新挂监听
    stopWatch = watch(elRef, attachObserver, { flush: 'post' })
  })

  onBeforeUnmount(() => {
    if (autoResize) window.removeEventListener('resize', handle)
    if (stopWatch) stopWatch()
    disconnectObserver()
    dispose()
  })

  return { get, resize, dispose, handle }
}

/**
 * 多图表实例池（一个页面多个 key 各自对应一个容器）。
 * 容器被 v-if 销毁时调 release(key)，否则下次会复用失效实例导致空白。
 * @returns {{ get, release, resizeAll, disposeAll }}
 */
export function createCharts() {
  const map = {}
  const kill = (key) => {
    try {
      map[key] && map[key].dispose()
    } catch {
      /* 已销毁则忽略 */
    }
    delete map[key]
  }
  return {
    get(key, el) {
      if (!el) return null
      // 容器被 v-if 重建过：旧实例指向已失效的画布，重建
      if (map[key] && map[key].getDom && map[key].getDom() !== el) kill(key)
      if (!map[key]) map[key] = echarts.init(el)
      return map[key]
    },
    release(key) {
      if (!map[key]) return
      kill(key)
    },
    resizeAll() {
      for (const c of Object.values(map)) c && c.resize()
    },
    disposeAll() {
      for (const key of Object.keys(map)) map[key] && map[key].dispose()
      for (const key of Object.keys(map)) delete map[key]
    }
  }
}
