import { watch, onBeforeUnmount } from 'vue'

/**
 * 让「全屏浮层」（teleport 到 body 的覆盖层）接管浏览器/系统返回手势。
 *
 * 背景：这类浮层只是组件内的 DOM 覆盖层，不占路由、也不占历史记录，
 * 于是系统返回手势（iOS 左边缘右滑 / 安卓返回手势 / 浏览器后退）会直接退到
 * 上一条历史记录（往往是上一个 tab），而不是关闭浮层 —— 与左上角返回箭头的表现不一致。
 *
 * 做法：打开时压入一条哨兵历史记录，返回手势触发 popstate 时关闭浮层；
 * 组件内主动关闭（箭头/右滑/点遮罩）时同步弹出哨兵，保证历史栈不残留。
 *
 * @param {import('vue').Ref<boolean>} visible 浮层显示状态
 * @param {Function} close 关闭浮层的方法（只负责把 visible 置为 false）
 */
export function useOverlayHistory(visible, close) {
  let pushed = false

  // 返回手势：历史记录被弹出 = 用户想关掉浮层
  const onPop = () => {
    if (!pushed) return
    pushed = false
    close()
  }

  const push = () => {
    if (pushed) return
    history.pushState({ overlay: true }, '')
    pushed = true
    window.addEventListener('popstate', onPop)
  }

  // 组件内主动关闭：移除监听后回退一步，把之前压入的哨兵弹掉
  const release = () => {
    if (!pushed) return
    pushed = false
    window.removeEventListener('popstate', onPop)
    history.back()
  }

  watch(visible, (v) => (v ? push() : release()), { immediate: true })
  onBeforeUnmount(release)
}
