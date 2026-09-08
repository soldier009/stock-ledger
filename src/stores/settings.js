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
  hasData,
  getKv,
  setKv,
  saveLocalSnapshot,
  addCloudArchive
} from '../db'
import { uploadBackup, downloadBackup, parseRepo } from '../services/github'

/** 生成文件名的日期串：20260908-103000 */
function fmtStamp(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 主备份文件路径 → 历史留底路径：backup/stock-ledger.db → backup/history/stock-ledger-<时间>.db */
function historyPath(mainPath, ts) {
  const p = String(mainPath || '').trim().replace(/\/+$/, '') || 'backup/stock-ledger.db'
  const i = p.lastIndexOf('/')
  const dir = i >= 0 ? p.slice(0, i) : ''
  const file = i >= 0 ? p.slice(i + 1) : p
  const base = file.replace(/\.(db|sqlite|sqlite3)$/i, '') || 'stock-ledger'
  return [dir, 'history', `${base}-${fmtStamp(ts)}.db`].filter(Boolean).join('/')
}

/** 读取本机记录的上次与云端达成一致的时间戳 */
async function readAgreed() {
  return (await getKv('sync-agreed')) || 0
}

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
    syncError: '',
    // 同步冲突：本地与云端在达成一致后都各自被改动，等待用户选择方向，自动同步不擅自覆盖
    syncConflict: false,
    syncConflictLocalAt: 0,
    syncConflictCloudAt: 0
  }),
  getters: {
    isGithubReady: (s) => !!(s.github.token && s.github.repo)
  },
  actions: {
    /**
     * 从数据库读取设置到内存 store。
     * skipGithub=true 用于同步/恢复云端数据后重读本地设置：
     * 此时数据库刚被云端备份整体替换，需要刷新 tags/rates 等业务设置，
     * 但不覆盖本机 GitHub 配置（token 是本机隐私配置，不应被云端备份回写）。
     */
    load(skipGithub = false) {
      const github = getSetting('github')
      const rates = getSetting('rates')
      const stampTaxRate = getSetting('stampTaxRate')
      const refreshMinutes = getSetting('refreshMinutes')
      const tags = getSetting('tags')
      const lastBackupAt = getSetting('lastBackupAt')
      const lastSyncAt = getSetting('lastSyncAt')
      if (github && !skipGithub) this.github = { ...this.github, ...github }
      if (rates) this.rates = { ...this.rates, ...rates }
      if (stampTaxRate != null) this.stampTaxRate = stampTaxRate
      if (refreshMinutes != null) this.refreshMinutes = refreshMinutes
      if (Array.isArray(tags)) this.tags = tags
      // skipGithub 时同步/恢复云端数据刚替换本地库，保持本地操作时间戳不被云端旧值覆盖
      if (lastBackupAt && !skipGithub) this.lastBackupAt = lastBackupAt
      if (lastSyncAt && !skipGithub) this.lastSyncAt = lastSyncAt
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

    async backupNow(silent = false, force = false) {
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
        // 尝试读取云端当前版本：用于新旧判断、风险判定与覆盖前留底（读不到时不再额外报错）
        let cloud = null
        let cloudAt = 0
        try {
          const c = await downloadBackup(this.github.token, owner, repo, this.github.path)
          if (c && c.bytes) {
            cloud = c
            cloudAt = readBytesChangedAt(c.bytes) || c.committedAt || 0
          }
        } catch {
          /* 忽略：上传本身会再校验 */
        }
        const localAt = getLocalChangedAt()
        const agreed = await readAgreed()
        if (!force) {
          if (!silent) {
            // 手动备份：云端比本地新时拒绝直接覆盖（防止误操作把云端回退）
            if (cloud && cloud.bytes && cloudAt > localAt) {
              this.backupState = 'error'
              this.backupError =
                '云端数据比本地新，直接备份会用本地覆盖云端。请改用「立即同步」获取云端数据。'
              return false
            }
          } else {
            // 自动备份：有待处理冲突、云端比本地新、或本地/云端在达成一致后都被改动（拿不准）、
            // 或本地已无数据而云端有数据时，跳过本次自动覆盖，交给同步流程处理，防止误覆盖
            if (this.syncConflict) {
              this.backupState = 'ok'
              return true
            }
            const divergent =
              !!agreed && localAt > 0 && hasData() && cloudAt !== agreed && localAt !== agreed
            const cloudNewer = !!(cloud && cloud.bytes && cloudAt > localAt)
            const localEmpty = !hasData() && !!(cloud && cloud.bytes)
            if (cloudNewer || divergent || localEmpty) {
              this.backupState = 'ok'
              return true
            }
          }
        }
        // 覆盖云端前留底：云端存在，且其内容不是本机上次见过的那份（或用户明确选择强制覆盖）时，
        // 先把云端旧版本另存到仓库 backup/history/ 目录
        if (cloud && cloud.bytes) {
          const seen = !!agreed && agreed === cloudAt
          if (!seen || force) {
            try {
              await this.archiveCloud(owner, repo, cloud.bytes, '用本地数据覆盖云端前留底')
            } catch {
              /* 留底失败不阻塞上传：GitHub 提交历史仍保留旧版本 */
            }
          }
        }
        const at = await uploadBackup(this.github.token, owner, repo, this.github.path, bytes)
        this.lastBackupAt = at
        setSetting('lastBackupAt', at)
        await persist()
        await setKv('sync-agreed', getLocalChangedAt())
        // 手动备份成功表示用户已明确处理当前状态，清除待处理冲突标记
        if (!silent) this.clearSyncConflict()
        this.backupState = 'ok'
        return true
      } catch (e) {
        this.backupState = 'error'
        this.backupError = e.message || String(e)
        return false
      }
    },

    /** 把云端旧版本 bytes 另存为仓库 backup/history/ 下的带时间留底文件，并记录元数据 */
    async archiveCloud(owner, repo, bytes, note = '') {
      if (!bytes || !bytes.length) return
      const ts = Date.now()
      const path = historyPath(this.github.path, ts)
      await uploadBackup(this.github.token, owner, repo, path, bytes, '自动留底：' + note)
      await addCloudArchive(ts, path, note)
    },

    /** 用户明确选择「以本地覆盖云端」：不做自动风险拦截，但覆盖前仍先把云端旧版本留底 */
    async uploadNow() {
      if (!this.isGithubReady) throw new Error('请先配置 GitHub 仓库与 Token')
      const ok = await this.backupNow(true, true)
      if (!ok) throw new Error(this.backupError || '本地数据上传失败，请检查网络与 Token')
      // 若本地是从老版本迁移而来（从未记录修改时间），主动打上当前时间戳，
      // 避免以后每次同步都触发「无法判断新旧」的询问
      markDirty()
      await persist()
      await setKv('sync-agreed', getLocalChangedAt())
      this.lastSyncAt = new Date().toISOString()
      setSetting('lastSyncAt', this.lastSyncAt)
      this.syncState = 'ok'
      this.clearSyncConflict()
      return true
    },

    async restore() {
      if (!this.isGithubReady) throw new Error('请先配置 GitHub 仓库与 Token')
      const [owner, repo] = parseRepo(this.github.repo)
      const cloud = await downloadBackup(this.github.token, owner, repo, this.github.path)
      if (!cloud || !cloud.bytes) throw new Error('云端没有找到备份文件，或仓库为空')
      // 覆盖本地前留底：本地存在上次一致版本之外的改动时，先存一份快照到 IndexedDB，便于找回
      const localAt = getLocalChangedAt()
      const agreed = await readAgreed()
      if (localAt > 0 && localAt !== agreed) {
        try {
          await saveLocalSnapshot('云端数据覆盖本地前')
        } catch {
          /* 忽略 */
        }
      }
      loadBytes(cloud.bytes)
      this.load(true) // 云端备份替换本地库后，重读标签/汇率等设置，保持内存与数据库一致
      await persist()
      await setKv('sync-agreed', readBytesChangedAt(cloud.bytes) || cloud.committedAt || 0)
      this.clearSyncConflict()
      return true
    },

    clearSyncConflict() {
      this.syncConflict = false
      this.syncConflictLocalAt = 0
      this.syncConflictCloudAt = 0
    },

    /** 某些场景（如恢复旧留底）后本地与云端可能不一致，暂停自动同步并提示用户处理 */
    async flagSyncConflict() {
      this.syncConflict = true
    },

    /**
     * 多端双向同步：
     * - 云端有更新 → 下载覆盖本地（覆盖前按需给本地留底）
     * - 本地有更新 → 上传覆盖云端（覆盖前先把云端旧版本留底到 backup/history/）
     * - 一致 → 无操作
     * - 本地/云端在上次达成一致后各自都被改动 → 不自动覆盖，返回 'conflict' 交由用户选择
     * 返回 'downloaded' | 'uploaded' | 'same' | 'conflict' | 'noop'
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
          // 云端还没有备份：上传本地（无云端文件可被覆盖，直接推送，不受冲突标记阻塞）
          const ok = await this.backupNow(true, true)
          if (ok) {
            this.lastSyncAt = new Date().toISOString()
            setSetting('lastSyncAt', this.lastSyncAt)
            this.syncState = 'ok'
            this.clearSyncConflict()
            return 'uploaded'
          }
          return 'noop'
        }
        const inDbAt = readBytesChangedAt(cloud.bytes)
        const cloudAt = inDbAt || cloud.committedAt || 0
        const localAt = getLocalChangedAt()
        const localData = hasData()
        const agreed = await readAgreed()
        const done = async () => {
          this.lastSyncAt = new Date().toISOString()
          setSetting('lastSyncAt', this.lastSyncAt)
          this.syncState = 'ok'
          this.clearSyncConflict()
        }
        const markConflict = async () => {
          this.syncConflict = true
          this.syncConflictLocalAt = localAt
          this.syncConflictCloudAt = cloudAt
          this.syncState = 'idle'
          return 'conflict'
        }
        // 需要用户选择方向的情况：
        // 1) 老版本备份没有修改时间（localAt===0）但本地已有数据，无法判断新旧；
        // 2) 上次达成一致后，本地与云端各自都有新改动（真冲突，B 方案：不静默覆盖）
        const legacyUnknown = localAt === 0 && localData && cloudAt > localAt
        const bothChanged =
          !!agreed && localAt > 0 && localData && cloudAt !== agreed && localAt !== agreed
        // 存在待处理的冲突标记（例如刚从留底/备份文件恢复），且两侧确实不一致时，
        // 也交由用户明确选择，绝不静默把恢复出来的旧数据推上云端
        const pendingChoice = this.syncConflict && cloudAt !== localAt
        if (legacyUnknown || bothChanged || pendingChoice) {
          return markConflict()
        }
        if (cloudAt > localAt) {
          // 覆盖本地前留底：本地存在上次一致版本之外的改动时，先存快照便于找回
          if (localAt > 0 && localAt !== agreed) {
            try {
              await saveLocalSnapshot('云端数据覆盖本地前')
            } catch {
              /* 忽略 */
            }
          }
          loadBytes(cloud.bytes)
          this.load(true) // 云端备份替换本地库后，重读标签/汇率等设置，保持内存与数据库一致
          await persist()
          await setKv('sync-agreed', cloudAt)
          await done()
          return 'downloaded'
        }
        if (localAt > cloudAt) {
          // 本地无数据而云端有数据时不自动上传，避免把云端误清空
          if (!hasData() && cloud && cloud.bytes) {
            this.syncState = 'error'
            this.syncError = '本地没有数据，为避免清空云端，已取消自动上传。可在确认后到设置页手动备份。'
            if (!silent) throw new Error(this.syncError)
            return 'noop'
          }
          const ok = await this.backupNow(true)
          if (ok) {
            await done()
            return 'uploaded'
          }
          // 上传失败：手动同步时向 UI 抛出明确错误
          if (!silent) throw new Error(this.backupError || '本地数据上传失败，请检查网络与 Token')
          return 'noop'
        }
        await setKv('sync-agreed', cloudAt)
        await done()
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
