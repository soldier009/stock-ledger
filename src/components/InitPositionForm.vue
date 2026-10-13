<script setup>
import { ref, watch } from 'vue'
import StockEntryForm from './StockEntryForm.vue'

// 薄壳：只负责弹窗容器与按钮，表单字段全部交给 StockEntryForm，
// 「新增资产」页面的股票页签复用同一份表单，避免两处逻辑走偏
const visible = defineModel({ type: Boolean, default: false })
const formRef = ref(null)

// 弹窗内容在首次打开后才挂载，之后一直留着：每次打开都要清空上一次填的内容
watch(visible, (v) => {
  if (v) formRef.value?.reset()
})

function submit() {
  formRef.value?.submit()
}

function onSaved() {
  visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" title="新建仓（录入已有持仓）" width="92%" :show-close="false">
    <StockEntryForm ref="formRef" :show-submit="false" @saved="onSaved" />
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="!!formRef?.submitting" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>
