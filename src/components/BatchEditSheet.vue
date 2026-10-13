<script setup>
import { ref, watch } from 'vue'
import { useSettingsStore } from '../stores/settings'

const visible = defineModel({ type: Boolean, default: false })
const props = defineProps({
  count: { type: Number, default: 0 },
  brokers: { type: Array, default: () => [] },
  // 选中标的涉及的交易条数 / 可连带迁移的自动入金条数：执行前的影响预览
  impactTrades: { type: Number, default: 0 },
  impactFlows: { type: Number, default: 0 }
})
const emit = defineEmits(['apply'])

const settings = useSettingsStore()

// 三个维度默认都不启用，只有勾选了的才写库，避免一次误触改掉整个持仓
const tagOn = ref(false)
const purposeOn = ref(false)
const brokerOn = ref(false)
const tagMode = ref('set') // set | clear
const tagValue = ref('')
const purposeValue = ref('')
const brokerValue = ref('')
// 迁移深度：默认连带交易 + 资金流水，保证目的券商的可用资金算得对
const syncTrades = ref(true)
const syncCash = ref(true)

watch(visible, (v) => {
  if (!v) return
  tagOn.value = false
  purposeOn.value = false
  brokerOn.value = false
  tagMode.value = 'set'
  tagValue.value = ''
  purposeValue.value = ''
  brokerValue.value = props.brokers[0] || ''
  syncTrades.value = true
  syncCash.value = true
})

function summary() {
  const out = []
  if (tagOn.value) out.push(tagMode.value === 'clear' ? '清空资产类别标签' : `资产类别标签 → ${tagValue.value || '清空'}`)
  if (purposeOn.value) out.push(`用途 → ${purposeValue.value || '清空'}`)
  if (brokerOn.value && brokerValue.value) out.push(`所属券商 → ${brokerValue.value}`)
  return out
}

function submit() {
  if (!summary().length) return
  const patch = {}
  if (tagOn.value) patch.tag = tagMode.value === 'set' && tagValue.value ? [tagValue.value] : []
  if (purposeOn.value) patch.purpose = purposeValue.value || ''
  if (brokerOn.value && brokerValue.value) {
    patch.broker = brokerValue.value
    patch.syncTrades = syncTrades.value
    patch.syncCash = syncCash.value
  }
  emit('apply', patch)
}
</script>

<template>
  <el-dialog v-model="visible" title="批量修改" width="92%">
    <div class="muted sheet-tip">已选 {{ count }} 只标的；只有勾选的维度会被修改</div>

    <div class="opt">
      <el-checkbox v-model="tagOn"><b>资产类别标签</b></el-checkbox>
      <template v-if="tagOn">
        <el-radio-group v-model="tagMode" size="small" class="mode">
          <el-radio-button value="set">设为</el-radio-button>
          <el-radio-button value="clear">清空</el-radio-button>
        </el-radio-group>
        <el-select
          v-if="tagMode === 'set'"
          v-model="tagValue"
          filterable
          allow-create
          clearable
          default-first-option
          size="small"
          placeholder="选择或输入新标签"
          class="full"
        >
          <el-option v-for="tg in settings.tags" :key="tg" :label="tg" :value="tg" />
        </el-select>
        <div class="muted">标签整体替换（单选），不会留下看不见的第二个标签</div>
      </template>
    </div>

    <div class="opt">
      <el-checkbox v-model="purposeOn"><b>用途</b></el-checkbox>
      <el-select
        v-if="purposeOn"
        v-model="purposeValue"
        filterable
        allow-create
        clearable
        default-first-option
        size="small"
        placeholder="留空=清空，如 长期持有 / 打新 / 波段"
        class="full"
      >
        <el-option v-for="pp in settings.purposes" :key="pp" :label="pp" :value="pp" />
        </el-select>
        <div v-if="purposeOn" class="muted">每只股票只有一个用途；不选新值表示清空成「未设置」</div>
    </div>

    <div class="opt">
      <el-checkbox v-model="brokerOn"><b>所属券商</b></el-checkbox>
      <template v-if="brokerOn">
        <el-select v-model="brokerValue" size="small" placeholder="选择目标券商" class="full">
          <el-option v-for="b in brokers" :key="b" :label="b" :value="b" />
        </el-select>
        <div class="muted">历史数据怎么带：</div>
        <el-checkbox v-model="syncTrades" size="small">
          连带 {{ impactTrades }} 笔交易记录
        </el-checkbox>
        <el-checkbox v-model="syncCash" size="small" :disabled="!syncTrades">
          连带 {{ impactFlows }} 笔「初始建仓」入金
        </el-checkbox>
        <div class="muted">
          现金按券商分账：交易与对应的自动入金一起迁，目的券商的可用资金才不会算成负数
        </div>
      </template>
    </div>

    <template v-if="summary().length" class="summary">
      <div class="divider"></div>
      <div class="muted">本次将修改：</div>
      <div v-for="s in summary()" :key="s" class="sum-line">{{ s }}</div>
    </template>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!summary().length" @click="submit">应用</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.sheet-tip {
  font-size: 12px;
  margin-bottom: 8px;
}
.opt {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.opt:last-of-type {
  border-bottom: none;
}
.mode {
  margin: 6px 0 0;
}
.full {
  display: block;
  width: 100%;
  margin-top: 6px;
}
.muted {
  font-size: 11px;
  margin-top: 4px;
}
.divider {
  height: 1px;
  background: var(--border);
  margin: 10px 0 8px;
}
.sum-line {
  font-size: 13px;
  font-weight: 600;
  margin-top: 2px;
}
</style>
