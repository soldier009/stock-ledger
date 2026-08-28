import { defineStore } from 'pinia'
import {
  getSetting,
  setSetting,
  exportBytes,
  persist,
  loadBytes,
  markDirty,
  getLocalChangedAt,
  readBytesChangedAt,
  hasData
} from '../db'
import { uploadBackup, downloadBackup, parseRepo } from '../services/github'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    github: { token: '', repo: '', path: 'backup/stock-ledger.db', autoBackup: true },
    rates: { usd: 7.2, hkd: 0.92, auto: true },
    stampTaxRate: 0.0005,
    refreshMinutes: 10,
    tags: [],
    lastBackupAt: '',
    backupState: 'idle', // idle | running | ok | error
    backupError: '',
    lastSyncAt: '',
    syncing: false,
    syncState: 'idle', // idle | running | ok | error
    syncError: ''
  }),
  getters: {
    isGithubReady: (s) => !!(s.github.token && s.github.repo)
  },
  actions: {
    load() {
      const github = getSetting('github')
      const rates = getSetting('rates')
      const stampTaxRate = getSetting('stampTaxRate')
      const refreshMinutes = getSetting('refreshMinutes')
      const tags = getSetting('tags')
      const lastBackupAt = getSetting('lastBackupAt')
      const lastSyncAt = getSetting('lastSyncAt')
      if (github) this.github = { ...this.github, ...github }
      if (rates) this.rates = { ...this.rates, ...rates }
      if (stampTaxRate != null) this.stampTaxRate = stampTaxRate
      if (refreshMinutes != null) this.refreshMinutes = refreshMinutes
      if (Array.isArray(tags)) this.tags = tags
      if (lastBackupAt) this.lastBackupAt = lastBackupAt
      if (lastSyncAt) this.lastSyncAt = lastSyncAt
    },
    async saveTags(v) {
      this.tags = [...new Set(v.filter(Boolean))]
      setSetting('tags', this.tags)
      markDirty()
      await persist()
    },
    async saveGithub(patch = {}) {
      this.github = { ...this.github, ...patch }
      // 清理粘贴时带入的空白字符（从文档复制 PAT 常带换行/空格）
      this.github.token = String(this.github.token || '').replace(/\s+/g, '')
      this.github.repo = String(this.github.repo || '').trim()
      this.github.path = String(this.github.path || '').trim()
      setSetting('github', this.github)
      await persist()
    },
    async saveRates(patch = {}) {
      this.rates = { ...this.rates, ...patch }
      setSetting('rates', this.rates)
      markDirty()
      await persist()
    },
    async saveRefreshMinutes(v) {
      this.refreshMinutes = v
      setSetting('refreshMinutes', v)
      markDirty()
      await persist()
    },
    async saveStampTaxRate(v) {
      this.stampTaxRate = v
      setSetting('stampTaxRate', v)
      markDirty()
      await persist()
    },

    async backupNow(silent = false) {
      if (!this.isGithubReady) {
        if (!silent) {
          this.backupState = 'error'
          this.backupError = '请先在「设置」中配置 GitHub 仓库与 Token'
        }
        return false
      }
      if (this.backupState === 'running') return false
      const bytes = exportBytes()
      if (!bytes) return false
      this.backupState = 'running'
      this.backupError = ''
      try {
        const [owner, repo] = parseRepo(this.github.repo)
        // 手动备份前检查：若云端数据比本地新，拒绝直接覆盖，防止误操作
        if (!silent) {
          const cloud = await downloadBackup(this.github.token, owner, repo, this.github.path)
          if (cloud && cloud.bytes) {
            const cloudAt = readBytesChangedAt(cloud.bytes) || cloud.committedAt || 0
            if (cloudAt > getLocalChangedAt()) {
              this.backupState = 'error'
              this.backupError =
                '云端数据比本地新，直接备份会用本地覆盖云端。请改用「立即同步」获取云端数据。'
              return false
            }
          }
        }
        const at = await uploadBackup(this.github.token, owner, repo, this.github.path, bytes)
        this.lastBackupAt = at
        setSetting('lastBackupAt', at)
        await persist()
        this.backupState = 'ok'
        return true
      } catch (e) {
        this.backupState = 'error'
        this.backupError = e.message || String(e)
        return false
      }
    },

    async restore() {
      if (!this.isGithubReady) throw new Error('请先配置 GitHub 仓库与 Token')
      const [owner, repo] = parseRepo(this.github.repo)
      const cloud = await downloadBackup(this.github.token, owner, repo, this.github.path)
      if (!cloud || !cloud.bytes) throw new Error('云端没有找到备份文件，或仓库为空')
      loadBytes(cloud.bytes)
      await persist()
      return true
    },

    /**
     * 多端双向同步：
     * - 云端有更新 → 下载覆盖本地
     * - 本地有更新 → 上传覆盖云端
     * - 一致 → 无操作
     * 返回 'downloaded' | 'uploaded' | 'same' | 'noop'
     */
    async sync(silent = true) {
      if (!this.isGithubReady) {
        if (!silent) {
          this.syncState = 'error'
          this.syncError = '请先配置 GitHub 仓库与 Token'
        }
        return 'noop'
      }
      if (this.syncing) return 'noop'
      this.syncing = true
      this.syncState = 'running'
      this.syncError = ''
      try {
        const [owner, repo] = parseRepo(this.github.repo)
        const cloud = await downloadBackup(this.github.token, owner, repo, this.github.path)
        if (!cloud || !cloud.bytes) {
          // 云端还没有备份：上传本地
          const ok = await this.backupNow(true)
          return ok ? 'uploaded' : 'noop'
        }
        const inDbAt = readBytesChangedAt(cloud.bytes)
        const cloudAt = inDbAt || cloud.committedAt || 0
        const localAt = getLocalChangedAt()
        if (cloudAt > localAt) {
          // 本地从未记录过修改时间（如老版本用户），且本地已有数据时，
          // 无法判断本地是否更新，自动同步保守处理，避免误覆盖
          if (localAt === 0 && hasData()) return 'conflict'
          loadBytes(cloud.bytes)
          await persist()
          this.lastSyncAt = new Date().toISOString()
          setSetting('lastSyncAt', this.lastSyncAt)
          this.syncState = 'ok'
          return 'downloaded'
        }
        if (localAt > cloudAt) {
          const ok = await this.backupNow(true)
          if (ok) {
            this.lastSyncAt = new Date().toISOString()
            setSetting('lastSyncAt', this.lastSyncAt)
            this.syncState = 'ok'
            return 'uploaded'
          }
          // 上传失败：手动同步时向 UI 抛出明确错误
          if (!silent) throw new Error(this.backupError || '本地数据上传失败，请检查网络与 Token')
          return 'noop'
        }
        this.lastSyncAt = new Date().toISOString()
        setSetting('lastSyncAt', this.lastSyncAt)
        this.syncState = 'ok'
        return 'same'
      } catch (e) {
        this.syncState = 'error'
        this.syncError = e.message || String(e)
        // 手动同步时向 UI 抛出，让用户看到具体失败原因
        if (!silent) throw e
        return 'noop'
      } finally {
        this.syncing = false
      }
    }
  }
})
