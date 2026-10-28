import { defineStore } from 'pinia'
// 新股数据存数据库的 settings 表（而不是 KV）：整库同步导出的是 sql.js 的字节，
// KV 存在 IndexedDB 另一个 store 里、根本不在导出范围内 —— 那样换设备新股数据就丢了。
// getKv 只为迁移老数据保留。
import { getKv, getSetting, setSetting, markDirty, persist } from '../db'
import {
  fetchItickIpos,
  fetchEmNewStocks,
  normalizeManual,
  prevWeekday,
  ipoResultDate
} from '../services/ipo'
import { usePortfolioStore } from './portfolio'

const KEY = 'stock-ledger-ipo-v1'

/** 去重键：同一市场同一代码同一上市日视为同一只新股 */
const dedupeKey = (x) => `${x.market}:${x.code}:${x.listingDate || ''}`

/** 手动 + 自动（iTick + 东财）合并去重，手动优先 */
function mergedList(s) {
  const manualKeys = new Set(s.manual.map(dedupeKey))
  // 同一只新股可能同时出现在多个源里（如 iTick 的 upcoming/recent、东财名单），按去重键只留一条。
  // 顺序即优先级：iTick 字段最全，东财只补上市日期，故放在最后兜底
  const auto = new Map()
  for (const x of [...s.remote, ...s.recent, ...s.em]) {
    const k = dedupeKey(x)
    if (!auto.has(k)) auto.set(k, x)
  }
  return [...s.manual, ...[...auto.values()].filter((x) => !manualKeys.has(dedupeKey(x)))]
}

function toPlain(v) {
  return JSON.parse(JSON.stringify(v))
}

export const useIpoStore = defineStore('ipo', {
  state: () => ({
    /** 手动录入的新股（本地持久化，优先于自动数据） */
    manual: [],
    /** 上次从 iTick 拉到的「即将上市」新股 */
    remote: [],
    /** 上次从 iTick 拉到的「近期已上市」新股（单独拉取，见 fetchRemote 的额度说明） */
    recent: [],
    /** 东方财富 A 股新股名单（无需 key 的兜底源，只有代码/名称/上市日期） */
    em: [],
    lastFetchAt: 0,
    loading: false,
    error: ''
  }),

  getters: {
    /** 手动 + 自动合并去重，手动优先 */
    all(s) {
      return mergedList(s).sort((a, b) => (b.listingDate || '').localeCompare(a.listingDate || ''))
    },

    /**
     * 按日期索引：Map<YYYY-MM-DD, [{ item, kind }]>
     * kind: subscribe 招股中 / result 中签公布 / won 中签（你自己账本记的那天）/ dark 暗盘 / listing 上市
     * 招股期是区间，区间内每一天都会出现一条 subscribe 记录。
     */
    byDate(s) {
      const list = mergedList(s)
      const map = new Map()
      const push = (date, item, kind) => {
        if (!date) return
        if (!map.has(date)) map.set(date, [])
        const arr = map.get(date)
        // 同一天同一只只记一次，kind 合并（如招股最后一天同时是截止日）
        const hit = arr.find((x) => x.item === item)
        if (hit) {
          if (!hit.kinds.includes(kind)) hit.kinds.push(kind)
        } else {
          arr.push({ item, kinds: [kind] })
        }
      }
      const nextDay = (d) => {
        const t = new Date(d + 'T00:00:00Z')
        t.setUTCDate(t.getUTCDate() + 1)
        return t.toISOString().slice(0, 10)
      }
      for (const it of list) {
        const start = it.subscribeStart
        const end = it.subscribeEnd
        if (start && end && start <= end) {
          for (let d = start; d <= end; d = nextDay(d)) push(d, it, 'subscribe')
        } else if (start) {
          push(start, it, 'subscribe')
        } else if (end) {
          push(end, it, 'subscribe')
        }
        if (it.darkPoolDate) push(it.darkPoolDate, it, 'dark')
        if (it.listingDate) push(it.listingDate, it, 'listing')
      }
      // 「中签」= 你自己中了，所以**完全由交易账本驱动**（交易记录里得有一笔 type='win'）。
      // 「这天公布中签结果」是市场事件，跟你中不中无关 —— 给每只新股都标一下，
      // 等于在日历上宣称你中了所有新股。
      // 落在哪天：优先中签公布日（手填 > 申购后 T+2 推算），都算不出来才退回你记账那天
      const won = this.wonBySymbol
      for (const it of list) {
        const info = won.get(`${it.market}:${it.code}`)
        if (!info || !(info.wonDates || []).length) continue
        const announced = ipoResultDate(it)
        for (const d of info.wonDates) push(announced || d, it, 'won')
      }
      for (const arr of map.values()) {
        arr.sort((a, b) => {
          const rank = { listing: 0, dark: 1, won: 2, subscribe: 3 }
          return (rank[a.kinds[0]] ?? 9) - (rank[b.kinds[0]] ?? 9)
        })
      }
      return map
    },

    /**
     * 与打新记录联动：Map<`market:code`, { shares 中签股数, soldShares 已卖, firstDayPnl 首日卖出盈亏 }>
     * 中签在交易记录里是 type==='win'（独立类型，按发行价扣款计成本）。
     * 只有该股在本新股列表里出现时才算「打新中签」，避免把普通买入误判成中签。
     */
    wonBySymbol(s) {
      const out = new Map()
      const portfolio = usePortfolioStore()
      // 本列表里已有的 市场:代码
      const known = new Set(this.all.map((x) => `${x.market}:${x.code}`))
      const agg = new Map()
      for (const t of portfolio.trades || []) {
        const key = `${t.market}:${t.code}`
        if (!known.has(key)) continue
        if (!agg.has(key))
          agg.set(key, { shares: 0, soldShares: 0, firstDaySell: 0, firstDayShares: 0, wonDates: [] })
        const a = agg.get(key)
        const qty = Number(t.shares) || 0
        if (t.type === 'win') {
          a.shares += qty
          // 记账这天就是「知道自己中签了」的日子。日历上要看得见，
          // 否则会出现「明明记了中签，日历却什么都没有」的情况
          if (t.date && !a.wonDates.includes(t.date)) a.wonDates.push(t.date)
        } else if (t.type === 'sell') a.soldShares += qty
      }
      // 首日卖出盈亏：上市当天卖出的部分，按发行价估算
      for (const x of this.all) {
        const key = `${x.market}:${x.code}`
        const a = agg.get(key)
        if (!a || !x.listingDate) continue
        let amt = 0
        let qty = 0
        for (const t of portfolio.trades || []) {
          if (`${t.market}:${t.code}` !== key) continue
          if (t.type !== 'sell' || t.date !== x.listingDate) continue
          qty += Number(t.shares) || 0
          amt += (Number(t.price) || 0) * (Number(t.shares) || 0)
        }
        if (qty) {
          a.firstDayShares = qty
          a.firstDaySell = x.issuePrice ? amt - x.issuePrice * qty : null
        }
        out.set(key, a)
      }
      // 有交易记录但没有对应上市日的（如已上市很久）也要带出来
      for (const [key, a] of agg) if (!out.has(key)) out.set(key, a)
      return out
    }
  },

  actions: {
    async load() {
      let saved = getSetting(KEY, null)
      // 老版本存在 IndexedDB 的 KV 里，搬进数据库一次，别让用户重新导入
      if (!saved) {
        const legacy = await getKv(KEY)
        if (legacy && typeof legacy === 'object') {
          saved = legacy
          setSetting(KEY, toPlain(legacy))
          markDirty()
          await persist()
        }
      }
      if (saved && typeof saved === 'object') {
        this.manual = Array.isArray(saved.manual) ? saved.manual : []
        this.remote = Array.isArray(saved.remote) ? saved.remote : []
        this.recent = Array.isArray(saved.recent) ? saved.recent : []
        this.em = Array.isArray(saved.em) ? saved.em : []
        this.lastFetchAt = Number(saved.lastFetchAt) || 0
      }
    },

    async save() {
      setSetting(
        KEY,
        toPlain({
          manual: this.manual,
          remote: this.remote,
          recent: this.recent,
          em: this.em,
          lastFetchAt: this.lastFetchAt
        })
      )
      // 标记「本地有改动」并落盘：自动备份是靠这个时间戳判断要不要推送的，
      // 少了这两步，新股改了但整库没标记为脏，云端就收不到
      markDirty()
      await persist()
    },

    /**
     * 从 iTick 拉取三地新股。失败时保留上次数据并置 error，由界面降级提示。
     *
     * 每次只拉一种 type：iTick 免费套餐限 REST 每分钟 5 次调用，而一次拉取要按
     * region 发 4 个请求（SH/SZ/HK/US），同时拉 upcoming + recent 就是 8 次会被限流。
     * 所以「即将上市」与「近期已上市」走两个入口，各自都控制在 5 次以内。
     * @param {'upcoming'|'recent'} type
     */
    async fetchRemote(token, type = 'upcoming') {
      this.loading = true
      this.error = ''
      try {
        const list = await fetchItickIpos(token, type)
        if (type === 'recent') this.recent = list
        else this.remote = list
        this.lastFetchAt = Date.now()
        await this.save()
        return list.length
      } catch (e) {
        this.error = e.message || '拉取失败'
        throw e
      } finally {
        this.loading = false
      }
    },

    /**
     * 拉东方财富 A 股新股名单（无需 key 的兜底源）。
     * 只能补上「代码/名称/上市日期」，招股期、发行价一概没有，且都是已上市的。
     * 失败时保留上次数据并置 error，由界面提示后降级到手动录入。
     */
    async fetchEm() {
      this.loading = true
      this.error = ''
      try {
        const list = await fetchEmNewStocks()
        if (!list.length) throw new Error('东财未返回新股（可能限流，稍后再试）')
        this.em = list
        await this.save()
        return list.length
      } catch (e) {
        this.error = e.message || '拉取失败'
        throw e
      } finally {
        this.loading = false
      }
    },

    /**
     * 批量导入粘贴解析出来的新股（去重后并入 manual，手动项优先级最高）。
     * @param {Array} rows services/ipo.js 的 parsePastedTable 输出
     * @returns {{added:number, replaced:number}} 新增数与覆盖数
     */
    async importPasted(rows) {
      let added = 0
      let replaced = 0
      for (const r of rows) {
        const one = normalizeManual(r)
        const key = dedupeKey(one)
        const idx = this.manual.findIndex((x) => dedupeKey(x) === key)
        if (idx >= 0) {
          this.manual.splice(idx, 1, one)
          replaced++
        } else {
          this.manual.unshift(one)
          added++
        }
      }
      await this.save()
      return { added, replaced }
    },

    async addManual(item) {
      const one = normalizeManual(item)
      // 同一只同上市日已存在则覆盖
      const key = dedupeKey(one)
      const idx = this.manual.findIndex((x) => dedupeKey(x) === key)
      if (idx >= 0) this.manual.splice(idx, 1, one)
      else this.manual.unshift(one)
      await this.save()
      return one
    },

    async removeManual(id) {
      const idx = this.manual.findIndex((x) => x.id === id)
      if (idx >= 0) {
        this.manual.splice(idx, 1)
        await this.save()
      }
    },

    /** 手动项改上市日后，港股暗盘要跟着重算 */
    async refreshDarkPool() {
      let changed = false
      for (const x of this.manual) {
        if (x.market === 'HK' && x.listingDate && !x.darkPoolDate) {
          x.darkPoolDate = prevWeekday(x.listingDate)
          changed = true
        }
      }
      if (changed) await this.save()
    }
  }
})
