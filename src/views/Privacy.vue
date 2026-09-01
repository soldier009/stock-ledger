<script setup>
import { useRouter } from 'vue-router'

const router = useRouter()
const APP_VERSION = __APP_VERSION__
</script>

<template>
  <div>
    <div class="page-header row between">
      <div class="page-title">隐私政策</div>
      <el-button size="small" @click="router.back()">返回</el-button>
    </div>

    <div class="card">
      <div class="sec">一、数据存储</div>
      <div class="para">
        本应用为纯本地单机应用。你的交易记录、持仓、资金流水、账户设置等全部数据，
        仅保存在<b>当前设备的浏览器本地数据库（IndexedDB）</b>中，
        <b>不会上传至开发者或任何第三方服务器</b>。
      </div>

      <div class="sec">二、网络请求</div>
      <div class="para">
        应用仅在以下情形发起网络请求，且<b>不包含任何个人身份信息</b>：
      </div>
      <div class="para">
        1. <b>行情与汇率刷新</b>：向公开行情接口请求股票代码与汇率信息（A股/港股：腾讯行情；美股与汇率：Yahoo Finance）。
        请求内容仅为股票代码，不含你的持仓数量、成本或盈亏。
      </div>
      <div class="para">
        2. <b>多端同步与云备份（需你主动开启）</b>：若你在「设置 → 多端同步与云备份」中配置了 GitHub 仓库地址与令牌，
        应用会向你<b>自己名下</b>的私有仓库上传或下载备份文件。该令牌仅保存在本机，不会发送给除 GitHub 以外的任何一方。
      </div>

      <div class="sec">三、信息收集</div>
      <div class="para">
        本应用<b>不收集、不统计、不共享</b>任何个人信息，未集成任何数据分析、广告或第三方统计 SDK，
        不申请通讯录、定位、相机、麦克风等敏感权限。
      </div>

      <div class="sec">四、数据风险与备份建议</div>
      <div class="para">
        由于数据仅存放在本机，<b>清除浏览器数据、卸载应用、更换设备或刷机均可能导致数据永久丢失</b>。
        建议你开启 GitHub 云备份，或定期使用「设置 → 数据管理 → 下载本地备份」导出备份文件另行保存。
      </div>

      <div class="sec">五、儿童隐私</div>
      <div class="para">本应用不面向儿童提供服务，也不会故意收集儿童的任何信息。</div>

      <div class="sec">六、政策更新</div>
      <div class="para">
        若未来功能调整导致数据处理方式发生变化，本政策将随之更新，并在应用内同步告知。
      </div>

      <div class="muted" style="margin-top: 16px">股票记账本 v{{ APP_VERSION }} · 最近更新：2026-09-01</div>
    </div>
  </div>
</template>

<style scoped>
.sec {
  font-size: 14px;
  font-weight: 700;
  margin: 14px 0 6px;
}
.sec:first-child {
  margin-top: 0;
}
.para {
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-2);
  margin-bottom: 6px;
}
</style>
