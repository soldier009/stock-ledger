<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import dayjs from 'dayjs'
import { usePortfolioStore } from '../stores/portfolio'
import { useSettingsStore } from '../stores/settings'
import { exportBytes, listLocalSnapshots, getLocalSnapshotBytes, listCloudArchives } from '../db'
import { exportExcel, exportPdf, buildReportData } from '../services/export'
import { testConnection, downloadBackup, parseRepo } from '../services/github'

const portfolio = usePortfolioStore()
const settings = useSettingsStore()

const fileInput = ref(null)
const testing = ref(false)
const backingUp = ref(false)
const restoring = ref(false)

const backupStateMap = {
  idle: { text: '未备份', cls: 'muted' },
  running: { text: '备份中...', cls: 'up' },
  ok: { text: '备份成功', cls: 'down' },
  error: { text: '备份失败', cls: 'up' }
}
const APP_VERSION = __APP_VERSION__

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ===== 列表右侧状态文案 =====
// 统一用相对时间（"2 分钟前"），避免完整时间戳把一行撑开
function relTime(ts) {
  if (!ts) return '从未'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 0) return dayjs(ts).format('MM-DD HH:mm')
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return dayjs(ts).format('YYYY-MM-DD')
}

const syncValueText = computed(() => {
  if (settings.syncing) return '同步中...'
  if (!settings.isGithubReady) return '未配置'
  if (settings.syncConflict) return '待选择方向'
  return settings.lastSyncAt ? relTime(settings.lastSyncAt) : '从未同步'
})

const backupValueText = computed(() => {
  if (backingUp.value) return '备份中...'
  if (!settings.isGithubReady) return '未配置'
  if (settings.backupState === 'error') return '上次失败'
  if (!settings.lastBackupAt) return settings.github.autoBackup ? '自动备份已开' : '从未备份'
  return relTime(settings.lastBackupAt)
})

const rateValueText = computed(() => (settings.rates.auto ? '自动获取' : `USD ${settings.rates.usd}`))

// ===== 底部抽屉 =====
const sheet = ref('')
const sheetVisible = ref(false)
const SHEET_TITLES = {
  sync: '同步配置',
  snapshots: '同步自动留底',
  refresh: '行情刷新',
  rates: '汇率设置',
  brokers: '券商管理',
  tags: '标签管理',
  docs: '数据说明'
}
const sheetTitle = computed(() => SHEET_TITLES[sheet.value] || '')
// 表单类抽屉给足高度，纯说明/选项类收紧一些
const sheetSize = computed(() =>
  ['sync', 'brokers', 'tags'].includes(sheet.value) ? 'min(640px, 84vh)' : 'min(640px, 62vh)'
)

function openSheet(name) {
  sheet.value = name
  sheetVisible.value = true
  if (name === 'snapshots') refreshSnapshots()
}

function setRefresh(minutes) {
  settings.saveRefreshMinutes(minutes)
}

function showVersion() {
  ElMessageBox.alert(
    `股票记账本 v${APP_VERSION}。数据保存在本机浏览器（IndexedDB），通过 GitHub 私有仓库多端自动同步。`,
    '版本信息',
    { confirmButtonText: '知道了' }
  )
}

async function test() {
  testing.value = true
  try {
    const info = await testConnection(settings.github.token, settings.github.repo, settings.github.path)
    ElMessage.success(`连接成功：${info.repo}（令牌账号 ${info.login}，尾号 ${info.tokenTail}）`)
  } catch (e) {
    const msg = e.message || '连接失败'
    const isLong = msg.includes('\n')
    if (isLong) {
      // 多行报错用对话框展示，保留换行与代码样式，便于用户阅读和复制诊断信息
      ElMessageBox.alert(
        `<div style="white-space: pre-wrap; word-break: break-all; line-height: 1.6; font-family: Consolas, Monaco, monospace; font-size: 13px; text-align: left">${escHtml(msg)}</div>`,
        '连接失败',
        { dangerouslyUseHTMLString: true, confirmButtonText: '知道了', customStyle: { maxWidth: '560px' } }
      )
    } else {
      ElMessage.error(msg)
    }
  } finally {
    testing.value = false
  }
}

async function backup() {
  backingUp.value = true
  try {
    const ok = await settings.backupNow(false)
    if (ok) ElMessage.success('备份完成')
    else ElMessage.error(settings.backupError || '备份失败')
  } finally {
    backingUp.value = false
  }
}

async function syncNow() {
  restoring.value = true
  try {
    const action = await settings.sync(false)
    if (action === 'downloaded') {
      await portfolio.loadData()
      portfolio.syncKlines()
      ElMessage.success('已下载云端最新数据')
    } else if (action === 'uploaded') {
      ElMessage.success('本地数据已同步到云端')
    } else if (action === 'same') {
      ElMessage.success('数据已是最新')
    } else if (action === 'conflict') {
      // 本地与云端在上次达成一致后各自都有新改动，让用户选择覆盖方向（不再静默覆盖）
      restoring.value = false
      const fmtLocal = settings.syncConflictLocalAt
        ? dayjs(settings.syncConflictLocalAt).format('YYYY-MM-DD HH:mm')
        : '未知'
      const fmtCloud = settings.syncConflictCloudAt
        ? dayjs(settings.syncConflictCloudAt).format('YYYY-MM-DD HH:mm')
        : '未知'
      try {
        await ElMessageBox.confirm(
          `本地与云端在达成一致后各自都新增了改动，无法自动合并，已暂停自动覆盖。\n\n本地最后修改：${fmtLocal}\n云端最后修改：${fmtCloud}\n\n下载云端：以云端数据覆盖本地（覆盖前本地会自动留底）；\n上传本地：以本地数据覆盖云端（覆盖前云端旧版本会自动留底到 backup/history/）。`,
          '需要选择同步方向',
          { confirmButtonText: '下载云端', cancelButtonText: '上传本地', distinguishCancelAndClose: true }
        )
        await settings.restore()
        await portfolio.loadData()
        portfolio.syncKlines()
        ElMessage.success('已用云端数据覆盖本地（覆盖前本地已自动留底）')
      } catch (err) {
        if (err === 'cancel') {
          // 用户选择以本地覆盖云端
          try {
            await settings.uploadNow()
            ElMessage.success('已用本地数据覆盖云端（覆盖前云端版本已自动留底）')
          } catch (e) {
            ElMessage.error(e.message || '上传失败')
          }
        } else if (err && err !== 'close') {
          ElMessage.error(err.message || '同步失败')
        }
      }
      return
    }
  } catch (e) {
    ElMessage.error(e.message || '同步失败')
  } finally {
    restoring.value = false
    refreshSnapshots()
  }
}

function doExportExcel() {
  exportExcel(buildReportData(portfolio))
  ElMessage.success('Excel 已导出')
}

function doExportPdf() {
  exportPdf(buildReportData(portfolio))
  ElMessage.success('PDF 已导出')
}

function downloadLocalBackup() {
  saveBytesAsFile(`stock-ledger-${dayjs().format('YYYYMMDD-HHmmss')}.db`, exportBytes())
}

function saveBytesAsFile(name, bytes) {
  if (!bytes || !bytes.length) return
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// ===== 同步留底：覆盖前自动保存的版本，可下载或恢复到本地 =====
const snapshotRows = ref([])

async function refreshSnapshots() {
  try {
    const [local, cloud] = await Promise.all([listLocalSnapshots(), listCloudArchives()])
    const rows = [
      ...local.map((x) => ({ ...x, kind: 'local' })),
      ...cloud.map((x) => ({ ...x, kind: 'cloud' }))
    ]
    rows.sort((a, b) => b.ts - a.ts)
    snapshotRows.value = rows
  } catch {
    snapshotRows.value = []
  }
}

async function getSnapshotBytes(row) {
  if (row.kind === 'local') return getLocalSnapshotBytes(row.ts)
  if (!settings.isGithubReady) throw new Error('未配置 GitHub，无法读取云端留底')
  const [owner, repo] = parseRepo(settings.github.repo)
  const r = await downloadBackup(settings.github.token, owner, repo, row.path)
  return r ? r.bytes : null
}

async function downloadSnapshot(row) {
  try {
    const bytes = await getSnapshotBytes(row)
    saveBytesAsFile(`stock-ledger-snapshot-${dayjs(row.ts).format('YYYYMMDD-HHmmss')}.db`, bytes)
    ElMessage.success('留底文件已下载')
  } catch (e) {
    ElMessage.error('下载失败：' + (e.message || String(e)))
  }
}

async function restoreSnapshot(row) {
  try {
    await ElMessageBox.confirm(
      `确定把当前本地数据恢复到 ${dayjs(row.ts).format('YYYY-MM-DD HH:mm')} 这份留底吗？\n\n当前本地数据会被这份留底替换（不会改动云端）。恢复后请到「账户同步 → 立即同步」选择一次方向，避免与云端再次冲突。`,
      '恢复留底',
      { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' }
    )
    const bytes = await getSnapshotBytes(row)
    if (!bytes || !bytes.length) throw new Error('留底内容为空或已不可用')
    await portfolio.importData(bytes)
    await settings.flagSyncConflict()
    ElMessage.success('已恢复到该留底版本，请执行一次同步确认方向')
    refreshSnapshots()
  } catch (err) {
    if (err && err !== 'cancel' && err !== 'close') {
      ElMessage.error('恢复失败：' + (err.message || String(err)))
    }
  }
}

onMounted(refreshSnapshots)

function onImportFile(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const bytes = new Uint8Array(reader.result)
      await portfolio.importData(bytes)
      // 导入会改变本地数据，标记冲突待处理，避免自动同步把这份数据静默推上云端覆盖
      await settings.flagSyncConflict()
      refreshSnapshots()
      ElMessage.success('导入成功（已暂停自动同步，请做一次「立即同步」确认方向）')
    } catch (err) {
      ElMessage.error('导入失败：' + (err.message || String(err)))
    }
  }
  reader.readAsArrayBuffer(file)
  e.target.value = ''
}

async function clearAll() {
  try {
    await ElMessageBox.confirm('此操作将删除全部交易记录、资金流水和设置，且无法撤销。建议先备份再清空。确定继续吗？', '危险操作', { type: 'error', confirmButtonText: '清空' })
    await portfolio.clearAll()
    ElMessage.success('数据已清空')
  } catch {
    /* 取消 */
  }
}

function saveRates() {
  settings.saveRates({ usd: settings.rates.usd, hkd: settings.rates.hkd, auto: settings.rates.auto })
  portfolio.rates = { usd: settings.rates.usd, hkd: settings.rates.hkd }
  portfolio.recompute()
  ElMessage.success('汇率已保存')
}

// ===== 券商管理 =====
const newBroker = ref('')
const editingBroker = ref('')
const brokerRename = ref('')

async function addBroker() {
  const n = newBroker.value.trim()
  if (!n) return
  if (portfolio.brokers.includes(n)) return ElMessage.warning('券商已存在')
  await portfolio.addBroker(n)
  newBroker.value = ''
  ElMessage.success('已添加')
}

async function removeBroker(name) {
  if (portfolio.brokers.length <= 1) return ElMessage.warning('至少保留一个券商')
  let msg
  if (name === portfolio.defaultBroker) {
    const next = portfolio.brokers.find((b) => b !== name) || portfolio.defaultBroker
    msg = `「${name}」是当前默认账户，删除后默认账户将切换为「${next}」，其名下数据也会一并归入该账户。确定删除？`
  } else {
    msg = `删除券商「${name}」后，其名下股票与交易将归入「${portfolio.defaultBroker}」账户，确定删除？`
  }
  try {
    await ElMessageBox.confirm(msg, '删除券商', { type: 'warning' })
    await portfolio.deleteBroker(name)
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}

async function setDefaultBroker(b) {
  await portfolio.setDefaultBroker(b)
  ElMessage.success(`已将「${b}」设为默认账户`)
}

function startRenameBroker(name) {
  editingBroker.value = name
  brokerRename.value = name
}

async function commitRenameBroker(oldName) {
  const n = brokerRename.value.trim()
  if (!n) return ElMessage.warning('名称不能为空')
  if (portfolio.brokers.includes(n) && n !== oldName) return ElMessage.warning('券商已存在')
  await portfolio.renameBroker(oldName, n)
  editingBroker.value = ''
  ElMessage.success('已重命名')
}

// ===== 标签管理 =====
const newTag = ref('')
const editingTag = ref('')
const renameInput = ref('')

function addTag() {
  const t = newTag.value.trim()
  if (!t) return
  if (settings.tags.includes(t)) return ElMessage.warning('标签已存在')
  settings.saveTags([...settings.tags, t])
  newTag.value = ''
  ElMessage.success('已添加')
}

async function removeTag(t) {
  try {
    await ElMessageBox.confirm(`将「${t}」从标签组移除？已使用该标签的持仓不受影响。`, '移除标签', { type: 'warning' })
    settings.saveTags(settings.tags.filter((x) => x !== t))
    ElMessage.success('已移除')
  } catch {
    /* 取消 */
  }
}

function startRename(t) {
  editingTag.value = t
  renameInput.value = t
}

function commitRename(oldTag) {
  const name = renameInput.value.trim()
  if (!name) return ElMessage.warning('名称不能为空')
  if (settings.tags.includes(name) && name !== oldTag) return ElMessage.warning('标签已存在')
  settings.saveTags(settings.tags.map((x) => (x === oldTag ? name : x)))
  editingTag.value = ''
  ElMessage.success('已重命名')
}
</script>

<template>
  <div>
    <div class="page-header">
      <div class="page-title">设置</div>
    </div>

    <div v-if="settings.syncConflict" class="warn-tip">
      ⚠ 本地与云端在上次同步后各自都有新改动，为避免误覆盖已暂停自动同步。点下方「立即同步」选择方向。
    </div>

    <!-- ===== 账户同步 ===== -->
    <div class="group-title">账户同步</div>
    <div class="group">
      <div class="srow" @click="openSheet('sync')">
        <el-icon class="ico"><Operation /></el-icon>
        <span class="row-title">同步配置</span>
        <span class="row-value" :class="{ ok: settings.isGithubReady }">{{ settings.isGithubReady ? '已连接' : '未配置' }}</span>
        <el-icon class="chev"><ArrowRight /></el-icon>
      </div>
      <div class="srow" @click="syncNow">
        <el-icon class="ico"><Refresh /></el-icon>
        <span class="row-title">立即同步</span>
        <span class="row-value" :class="{ warn: settings.syncConflict }">{{ syncValueText }}</span>
        <el-icon v-if="restoring || settings.syncing" class="chev spin"><Loading /></el-icon>
      </div>
      <div class="srow" @click="backup">
        <el-icon class="ico"><Cloudy /></el-icon>
        <span class="row-title">立即备份</span>
        <span class="row-value">{{ backupValueText }}</span>
        <el-icon v-if="backingUp" class="chev spin"><Loading /></el-icon>
      </div>
      <div class="srow" @click="openSheet('snapshots')">
        <el-icon class="ico"><Timer /></el-icon>
        <span class="row-title">同步自动留底</span>
        <span class="row-value">{{ snapshotRows.length }} 条</span>
        <el-icon class="chev"><ArrowRight /></el-icon>
      </div>
    </div>
    <div class="group-note">
      在每台设备填入相同的仓库地址与令牌，打开应用会自动同步，多端共享同一份账本。任何覆盖发生前都会自动留底，可随时找回。
    </div>

    <!-- ===== 数据管理 ===== -->
    <div class="group-title">数据管理</div>
    <div class="group">
      <div class="srow" @click="doExportExcel">
        <el-icon class="ico"><Tickets /></el-icon>
        <span class="row-title">导出 Excel</span>
      </div>
      <div class="srow" @click="doExportPdf">
        <el-icon class="ico"><Document /></el-icon>
        <span class="row-title">导出 PDF</span>
      </div>
      <div class="srow" @click="downloadLocalBackup">
        <el-icon class="ico"><Download /></el-icon>
        <span class="row-title">下载本地备份</span>
      </div>
      <div class="srow" @click="fileInput.click()">
        <el-icon class="ico"><Upload /></el-icon>
        <span class="row-title">从备份恢复</span>
      </div>
      <input ref="fileInput" type="file" accept=".db,.sqlite,.sqlite3" style="display: none" @change="onImportFile" />
    </div>
    <div class="group-note">
      报表包含总览、持仓、交易流水、月度/年度盈亏与年度个股明细；备份文件为 SQLite 数据库（.db），可用于本地存档或手动迁移。
    </div>

    <div class="group" style="margin-top: 12px">
      <div class="srow danger" @click="clearAll">
        <span class="row-title">清空所有数据</span>
      </div>
    </div>

    <!-- ===== 显示设置 ===== -->
    <div class="group-title">显示设置</div>
    <div class="group">
      <div class="srow" @click="openSheet('refresh')">
        <el-icon class="ico"><Clock /></el-icon>
        <span class="row-title">行情刷新</span>
        <span class="row-value">每 {{ settings.refreshMinutes }} 分钟</span>
        <el-icon class="chev"><ArrowRight /></el-icon>
      </div>
      <div class="srow" @click="openSheet('rates')">
        <el-icon class="ico"><Coin /></el-icon>
        <span class="row-title">汇率设置</span>
        <span class="row-value">{{ rateValueText }}</span>
        <el-icon class="chev"><ArrowRight /></el-icon>
      </div>
      <div class="srow" @click="openSheet('brokers')">
        <el-icon class="ico"><OfficeBuilding /></el-icon>
        <span class="row-title">券商管理</span>
        <span class="row-value">{{ portfolio.brokers.length }} 个账户</span>
        <el-icon class="chev"><ArrowRight /></el-icon>
      </div>
      <div class="srow" @click="openSheet('tags')">
        <el-icon class="ico"><PriceTag /></el-icon>
        <span class="row-title">标签管理</span>
        <span class="row-value">{{ settings.tags.length }} 个标签</span>
        <el-icon class="chev"><ArrowRight /></el-icon>
      </div>
    </div>

    <!-- ===== 关于 ===== -->
    <div class="group-title">关于</div>
    <div class="group" style="margin-bottom: 8px">
      <div class="srow" @click="showVersion">
        <el-icon class="ico"><InfoFilled /></el-icon>
        <span class="row-title">版本信息</span>
        <span class="row-value">v{{ APP_VERSION }}</span>
        <el-icon class="chev"><ArrowRight /></el-icon>
      </div>
      <div class="srow" @click="openSheet('docs')">
        <el-icon class="ico"><Reading /></el-icon>
        <span class="row-title">数据说明</span>
        <el-icon class="chev"><ArrowRight /></el-icon>
      </div>
      <router-link to="/privacy" class="srow">
        <el-icon class="ico"><Lock /></el-icon>
        <span class="row-title">隐私政策</span>
        <el-icon class="chev"><ArrowRight /></el-icon>
      </router-link>
    </div>

    <!-- ===== 底部抽屉：承载复杂表单与列表 ===== -->
    <el-drawer v-model="sheetVisible" direction="btt" :size="sheetSize" :with-header="false" class="st-drawer">
      <div class="st-sheet">
        <div class="st-handle"></div>
        <div class="st-head">
          <span class="st-title">{{ sheetTitle }}</span>
          <span class="st-close" @click="sheetVisible = false"><el-icon><Close /></el-icon></span>
        </div>
        <div class="st-body">
          <!-- 同步配置 -->
          <template v-if="sheet === 'sync'">
            <div class="st-note">
              在<b>每台设备</b>上填入<b>相同的仓库地址与令牌</b>，打开应用会自动同步最新数据。同步按整份账本的新旧整体替换；若本机与云端在达成一致后各自都有新改动，会暂停并请您选择方向（不会静默覆盖）。
            </div>
            <el-form label-position="top" size="default" class="st-form">
              <el-form-item label="仓库地址（owner/仓库名）">
                <el-input v-model="settings.github.repo" placeholder="如 myname/stock-ledger-backup" @change="settings.saveGithub()" />
              </el-form-item>
              <el-form-item label="访问令牌 (PAT)">
                <el-input v-model="settings.github.token" type="password" show-password placeholder="ghp_..." @change="settings.saveGithub()" />
              </el-form-item>
              <el-form-item label="备份路径">
                <el-input v-model="settings.github.path" placeholder="backup/stock-ledger.db" @change="settings.saveGithub()" />
              </el-form-item>
            </el-form>
            <div class="srow switch-row">
              <span class="row-title">自动备份（变更后延迟保存）</span>
              <el-switch v-model="settings.github.autoBackup" @change="settings.saveGithub()" />
            </div>

            <div class="st-btns">
              <el-button :loading="testing" @click="test">测试连接</el-button>
              <el-button type="primary" :loading="restoring" @click="syncNow">立即同步</el-button>
              <el-button :loading="backingUp" @click="backup">立即备份</el-button>
            </div>

            <div class="st-status">
              <div>
                上次备份：
                <span v-if="settings.lastBackupAt">{{ dayjs(settings.lastBackupAt).format('YYYY-MM-DD HH:mm') }}</span>
                <span v-else>从未</span>
                · 状态：<span :class="backupStateMap[settings.backupState]?.cls || 'muted'">{{ backupStateMap[settings.backupState]?.text }}</span>
              </div>
              <div>
                上次同步：
                <span v-if="settings.lastSyncAt">{{ dayjs(settings.lastSyncAt).format('YYYY-MM-DD HH:mm') }}</span>
                <span v-else>从未</span>
                <template v-if="settings.syncing"> · 同步中...</template>
              </div>
              <div v-if="settings.syncConflict" class="warn-text">待处理：本地与云端在上次同步后各自都有新改动，请点上方「立即同步」选择覆盖方向。</div>
              <div v-if="settings.backupError" class="up">备份错误：{{ settings.backupError }}</div>
              <div v-if="settings.syncError" class="up">同步错误：{{ settings.syncError }}</div>
            </div>

            <el-collapse class="st-guide">
              <el-collapse-item title="如何创建 PAT 令牌？">
                <ol class="guide">
                  <li>打开 <b>github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)</b></li>
                  <li>点击 <b>Generate new token (classic)</b>，勾选 <b>repo</b> 权限</li>
                  <li>生成后复制形如 <code>ghp_xxxx</code> 的令牌（只显示一次）</li>
                  <li>在 GitHub 上先创建一个 <b>私有仓库（Private）</b>，如 stock-ledger-backup</li>
                  <li>回到本页填入仓库地址与令牌，点击「测试连接」</li>
                </ol>
                <div class="muted">令牌仅保存在本机浏览器数据库中，不会上传到任何第三方。</div>
              </el-collapse-item>
            </el-collapse>
          </template>

          <!-- 同步自动留底 -->
          <template v-else-if="sheet === 'snapshots'">
            <div class="st-note">
              每次同步覆盖发生前（无论以云端覆盖本地、还是以本地覆盖云端），系统都会自动留一份底：本地留底保存在本机，云端留底存放在仓库的 backup/history/ 目录。每类自动保留最近 12 份。「恢复」会替换当前本地数据，之后请做一次同步确认方向。
            </div>
            <template v-if="snapshotRows.length">
              <div v-for="r in snapshotRows" :key="r.kind + '-' + r.ts" class="tag-row">
                <div style="flex: 1; min-width: 0">
                  <div class="row gap8">
                    <span class="tag-name">{{ r.kind === 'local' ? '本地留底' : '云端留底' }}</span>
                    <span class="muted" style="font-size: 12px">{{ dayjs(r.ts).format('YYYY-MM-DD HH:mm') }}</span>
                  </div>
                  <div v-if="r.note" class="muted" style="font-size: 12px">{{ r.note }}</div>
                </div>
                <div class="row gap4">
                  <el-button size="small" text type="primary" @click="downloadSnapshot(r)">下载</el-button>
                  <el-button size="small" text @click="restoreSnapshot(r)">恢复</el-button>
                </div>
              </div>
            </template>
            <div v-else class="muted" style="margin-top: 12px">暂无留底记录（发生覆盖行为后才会自动生成）</div>
          </template>

          <!-- 行情刷新 -->
          <template v-else-if="sheet === 'refresh'">
            <div class="st-note">行情（价格、涨跌幅）按此间隔在应用前台自动刷新；切回应用到前台时也会立即刷新一次。</div>
            <div class="st-opts">
              <div v-for="m in [5, 10, 15, 30]" :key="m" class="st-opt" @click="setRefresh(m)">
                <span>每 {{ m }} 分钟</span>
                <el-icon v-if="settings.refreshMinutes === m" class="st-check"><Check /></el-icon>
              </div>
            </div>
          </template>

          <!-- 汇率设置 -->
          <template v-else-if="sheet === 'rates'">
            <div class="st-note">港股与美股持仓需要按汇率折算成人民币。开启自动获取后，汇率从公开行情接口读取。</div>
            <div class="srow switch-row">
              <span class="row-title">自动获取汇率</span>
              <el-switch v-model="settings.rates.auto" @change="saveRates" />
            </div>
            <div v-if="!settings.rates.auto" class="row gap8" style="margin-top: 12px">
              <div class="flex1">
                <div class="muted" style="margin-bottom: 4px">USD/CNY</div>
                <el-input-number v-model="settings.rates.usd" :precision="4" :step="0.01" :controls="false" style="width: 100%" @change="saveRates" />
              </div>
              <div class="flex1">
                <div class="muted" style="margin-bottom: 4px">HKD/CNY</div>
                <el-input-number v-model="settings.rates.hkd" :precision="4" :step="0.01" :controls="false" style="width: 100%" @change="saveRates" />
              </div>
            </div>
            <div class="muted" style="margin-top: 12px">当前汇率：USD/CNY {{ settings.rates.usd }} · HKD/CNY {{ settings.rates.hkd }}</div>
          </template>

          <!-- 券商管理 -->
          <template v-else-if="sheet === 'brokers'">
            <div class="st-note">建立多个券商账户分别记账。股票的买卖、分红与资金出入只在该股票所属券商账户内流动。至少保留一个账户。</div>
            <div class="row gap8" style="margin: 12px 0">
              <el-input v-model="newBroker" placeholder="券商名称，如：华泰证券" @keyup.enter="addBroker" />
              <el-button type="primary" @click="addBroker">添加</el-button>
            </div>
            <div v-for="b in portfolio.brokers" :key="b" class="tag-row">
              <template v-if="editingBroker === b">
                <el-input v-model="brokerRename" size="small" style="flex: 1" @keyup.enter="commitRenameBroker(b)" />
                <el-button size="small" type="primary" @click="commitRenameBroker(b)">保存</el-button>
                <el-button size="small" @click="editingBroker = ''">取消</el-button>
              </template>
              <template v-else>
                <div class="row gap8">
                  <span class="tag-name">{{ b }}</span>
                  <span v-if="b === portfolio.defaultBroker" class="muted" style="font-size: 12px">（默认）</span>
                </div>
                <div class="row gap4">
                  <el-button v-if="b !== portfolio.defaultBroker" size="small" text type="primary" @click="setDefaultBroker(b)">设为默认</el-button>
                  <el-button size="small" text @click="startRenameBroker(b)">重命名</el-button>
                  <el-button size="small" text type="danger" @click="removeBroker(b)">删除</el-button>
                </div>
              </template>
            </div>
          </template>

          <!-- 标签管理 -->
          <template v-else-if="sheet === 'tags'">
            <div class="st-note">用于给持仓分类，同一标签的股票在资产页归为一组，可在「记一笔」时直接新建。</div>
            <div class="row gap8" style="margin: 12px 0">
              <el-input v-model="newTag" placeholder="输入新标签，如：长期持有" @keyup.enter="addTag" />
              <el-button type="primary" @click="addTag">添加</el-button>
            </div>
            <template v-if="settings.tags.length">
              <div v-for="tg in settings.tags" :key="tg" class="tag-row">
                <template v-if="editingTag === tg">
                  <el-input v-model="renameInput" size="small" style="flex: 1" @keyup.enter="commitRename(tg)" />
                  <el-button size="small" type="primary" @click="commitRename(tg)">保存</el-button>
                  <el-button size="small" @click="editingTag = ''">取消</el-button>
                </template>
                <template v-else>
                  <span class="tag-name">{{ tg }}</span>
                  <div class="row gap4">
                    <el-button size="small" text @click="startRename(tg)">重命名</el-button>
                    <el-button size="small" text type="danger" @click="removeTag(tg)">删除</el-button>
                  </div>
                </template>
              </div>
            </template>
            <div v-else class="muted">暂无标签，点击上方添加</div>
          </template>

          <!-- 数据说明 -->
          <template v-else-if="sheet === 'docs'">
            <div class="st-note">
              <b>行情来源</b>：A股/港股（腾讯实时行情）、美股与汇率（Yahoo Finance）。行情接口为免费公开接口，可能出现延迟或中断，请以实际成交为准。
            </div>
            <div class="st-note">
              <b>数据存储</b>：数据保存在本机浏览器（IndexedDB），并通过 GitHub 私有仓库多端自动同步，手机与电脑可共同使用同一份数据。
            </div>
            <div class="st-note">
              <b>报表与备份</b>：Excel / PDF 报表包含总览、持仓、交易流水、月度/年度盈亏与年度个股明细；备份为 SQLite 数据库（.db）文件，可用于本地存档或手动迁移。
            </div>
          </template>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
/* ===== 分组列表 ===== */
.group-title {
  font-size: 13px;
  color: var(--text-2);
  padding: 18px 16px 8px;
}

.group {
  background: var(--card);
  margin: 0 12px;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 1px 6px rgba(15, 23, 42, 0.05);
}

.srow {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 0 14px;
  position: relative;
  cursor: pointer;
  text-decoration: none;
  color: inherit;
}

.srow + .srow::before {
  content: '';
  position: absolute;
  left: 48px;
  right: 0;
  top: 0;
  height: 1px;
  background: var(--border);
}

.srow:active {
  background: rgba(15, 23, 42, 0.03);
}

.srow .ico {
  flex: 0 0 20px;
  font-size: 19px;
  color: var(--primary);
}

.srow .row-title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
}

.srow .row-value {
  font-size: 13px;
  color: #9aa3af;
  white-space: nowrap;
}
.srow .row-value.ok {
  color: var(--primary);
}
.srow .row-value.warn {
  color: #b45309;
}

.srow .chev {
  flex: 0 0 15px;
  font-size: 15px;
  color: #cbd2da;
}

.srow.danger {
  justify-content: center;
}
.srow.danger .row-title {
  flex: 0 0 auto;
  text-align: center;
  color: var(--up);
  font-weight: 500;
}

.spin {
  animation: st-spin 1s linear infinite;
}
@keyframes st-spin {
  to {
    transform: rotate(360deg);
  }
}

.group-note {
  font-size: 12px;
  color: var(--text-2);
  padding: 8px 16px 0;
  line-height: 1.7;
}

.warn-tip {
  margin: 10px 12px 0;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  color: #b45309;
  background: #fef3c7;
  border: 1px solid #fde68a;
}

/* ===== 抽屉内容 ===== */
.st-sheet {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.st-handle {
  width: 38px;
  height: 4px;
  border-radius: 2px;
  background: #e3e7ec;
  margin: 8px auto 10px;
  flex: 0 0 auto;
}
.st-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px 12px;
  flex: 0 0 auto;
}
.st-title {
  font-size: 16px;
  font-weight: 600;
}
.st-close {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #f1f3f6;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8a94a2;
  cursor: pointer;
}
.st-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 18px 20px;
}
.st-note {
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.75;
}
.st-note + .st-note {
  margin-top: 10px;
}
.st-form {
  margin-top: 12px;
}
.switch-row {
  min-height: 44px;
  padding: 0;
}
.switch-row::before {
  display: none;
}
.st-btns {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.st-btns .el-button {
  flex: 1;
}
.st-btns :deep(.el-button + .el-button) {
  margin-left: 0;
}
.st-status {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.8;
}
.warn-text {
  color: #b45309;
}
.st-guide {
  margin-top: 8px;
  border: none;
}
.st-opts {
  margin-top: 8px;
}
.st-opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  font-size: 14.5px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.st-opt:last-child {
  border-bottom: none;
}
.st-check {
  color: var(--primary);
  font-size: 18px;
}

.guide {
  padding-left: 18px;
  margin: 6px 0;
  line-height: 1.9;
  font-size: 13px;
}
.guide code {
  background: #f1f5f9;
  padding: 1px 6px;
  border-radius: 4px;
}
.tag-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--border);
}
.tag-row:last-child {
  border-bottom: none;
}
.tag-name {
  font-size: 14px;
}
.gap4 {
  gap: 4px;
}
</style>

<style>
/* 底部抽屉挂载到 body：需全局样式；宽度收在 520px 手机列内居中 */
.el-drawer.st-drawer {
  width: min(100%, 520px) !important;
  left: 0 !important;
  right: 0 !important;
  margin: 0 auto;
}
.st-drawer .el-drawer__body {
  padding: 0;
  overflow: hidden;
}
</style>
