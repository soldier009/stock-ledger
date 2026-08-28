export function loadScript(src, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    let done = false
    const cleanup = () => {
      if (el.parentNode) el.parentNode.removeChild(el)
    }
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        cleanup()
        reject(new Error('加载超时'))
      }
    }, timeout)
    el.src = src
    el.async = true
    el.onload = () => {
      if (!done) {
        done = true
        clearTimeout(timer)
        cleanup()
        resolve()
      }
    }
    el.onerror = () => {
      if (!done) {
        done = true
        clearTimeout(timer)
        cleanup()
        reject(new Error('加载失败'))
      }
    }
    document.head.appendChild(el)
  })
}
