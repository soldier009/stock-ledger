<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  loading: { type: Boolean, default: false },
  threshold: { type: Number, default: 50 }
})
const emit = defineEmits(['refresh'])

const wrap = ref(null)
const pull = ref(0)
let startY = 0
let pulling = false

function onTouchStart(e) {
  if (props.loading) return
  pulling = true
  startY = e.touches[0].clientY
}

function onTouchMove(e) {
  if (!pulling || props.loading) return
  const delta = e.touches[0].clientY - startY
  if (delta > 0 && window.scrollY <= 0 && wrap.value.scrollTop <= 0) {
    pull.value = Math.min(delta * 0.5, 90)
    if (pull.value > 0 && e.cancelable) e.preventDefault()
  }
}

function onTouchEnd() {
  if (!pulling) return
  pulling = false
  if (pull.value >= props.threshold) {
    pull.value = props.threshold
    emit('refresh')
  } else {
    pull.value = 0
  }
}

onMounted(() => {
  const el = wrap.value
  el.addEventListener('touchstart', onTouchStart, { passive: true })
  el.addEventListener('touchmove', onTouchMove, { passive: false })
  el.addEventListener('touchend', onTouchEnd, { passive: true })
})

onBeforeUnmount(() => {
  const el = wrap.value
  if (!el) return
  el.removeEventListener('touchstart', onTouchStart)
  el.removeEventListener('touchmove', onTouchMove)
  el.removeEventListener('touchend', onTouchEnd)
})
</script>

<template>
  <div ref="wrap" class="pull-wrap">
    <div class="pull-indicator" :style="{ height: pull + 'px' }">
      <span v-if="!loading && pull === 0">下拉刷新行情</span>
      <span v-else-if="!loading" class="num">下拉 {{ Math.round((threshold - pull) / (threshold / 100)) }}%</span>
      <span v-else class="num">正在刷新...</span>
    </div>
    <div class="pull-content" :style="{ transform: `translateY(${pull}px)` }">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.pull-indicator {
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  font-size: 13px;
  transition: height 0.25s ease;
}
.pull-content {
  transition: transform 0.25s ease;
}
</style>
