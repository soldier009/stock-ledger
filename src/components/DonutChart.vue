<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import { fmtNum } from '../utils/format'
import { PALETTE } from '../utils/composition'

// 环形图：中心可显示标题 + 数值，扇区颜色取自 item.color，缺省按调色板顺序取色
const props = defineProps({
  items: { type: Array, default: () => [] }, // [{ name, value, color? }]
  centerLabel: { type: String, default: '' },
  centerValue: { type: String, default: '' },
  centerSub: { type: String, default: '' },
  centerFontSize: { type: Number, default: 18 },
  height: { type: String, default: '260px' },
  radius: { type: Array, default: () => ['42%', '68%'] },
  showLabel: { type: Boolean, default: false }
})

const el = ref(null)
let chart = null

function draw() {
  if (!el.value) return
  if (!chart) chart = echarts.init(el.value)
  const data = props.items
    .filter((it) => (Number(it.value) || 0) > 0)
    .map((it) => ({
      name: it.name,
      value: Math.round((Number(it.value) || 0) * 100) / 100,
      itemStyle: it.color ? { color: it.color } : undefined
    }))
  if (!data.length) {
    chart.clear()
    return
  }
  const graphic = []
  if (props.centerLabel) {
    graphic.push({
      type: 'text',
      left: 'center',
      top: props.centerValue ? '39%' : '45%',
      style: { text: props.centerLabel, textAlign: 'center', fill: '#94a3b8', fontSize: 12 }
    })
  }
  if (props.centerValue) {
    graphic.push({
      type: 'text',
      left: 'center',
      top: props.centerSub ? '46%' : '50%',
      style: {
        text: props.centerValue,
        textAlign: 'center',
        fill: '#1f2937',
        fontSize: props.centerFontSize,
        fontWeight: 700
      }
    })
  }
  if (props.centerSub) {
    graphic.push({
      type: 'text',
      left: 'center',
      top: '58%',
      style: { text: props.centerSub, textAlign: 'center', fill: '#94a3b8', fontSize: 12 }
    })
  }
  chart.setOption({
    tooltip: {
      trigger: 'item',
      formatter: (p) => `${p.name}<br/>¥${fmtNum(p.value, 0)}（${p.percent}%）`
    },
    graphic,
    series: [
      {
        type: 'pie',
        radius: props.radius,
        center: ['50%', '50%'],
        itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
        label: props.showLabel
          ? { color: '#334155', fontSize: 11, formatter: '{b}\n{d}%' }
          : { show: false },
        labelLine: { show: props.showLabel },
        color: PALETTE,
        data
      }
    ]
  })
}

watch(
  () => props.items.map((i) => `${i.name}:${Math.round(Number(i.value) || 0)}`).join('|'),
  async () => {
    await nextTick()
    draw()
  }
)
watch(() => [props.centerLabel, props.centerValue, props.centerSub, props.showLabel], () => draw())

function onResize() {
  chart && chart.resize()
}

onMounted(async () => {
  await nextTick()
  draw()
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  if (chart) chart.dispose()
})
</script>

<template>
  <div ref="el" class="donut" :style="{ height }"></div>
</template>

<style scoped>
.donut {
  width: 100%;
}
</style>
