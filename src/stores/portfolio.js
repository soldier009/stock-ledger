import { defineStore } from 'pinia'
import {
  all,
  get,
  run,
  persist,
  initDB,
  getBrokers,
  insertBroker,
  renameBroker as dbRenameBroker,
  deleteBroker as dbDeleteBroker,
  getDefaultBroker as dbGetDefaultBroker,
  setDefaultBroker as dbSetDefaultBroker,
  markDirty,
  getKv,
  setKv
} from '../db'
import {
  computeAll,
  monthlyRealized,
  yearlyRealized,
  yearlyStockDetail,
  cumulativeRealized,
  netValueSeries,
  dailyRealized,
  dailyHoldingPnl,
  drawdown
} from '../services/calc'
import { fetchQuotes, fetchRates } from '../services/quotes'
import { fetchDayKlines } from '../services/kline'
import { rateOf } from '../utils/format'
import { DEFAULT_BROKER } from '../constants'
import { useSettingsStore } from './settings'

// 行情日K缓存（IndexedDB，独立于 sqlite 备份；不触发本地脏标记）
const KLINE_KEY = 'stock-ledger-kline-v1'

function fmtDay(d) {
  const m = d.getMonth() + 1
  const dd = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd
}

function dayAfter(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + 1)
  return fmtDay(d)
}

export const usePortfolioStore = defineStore('portfolio', {
  state: () => ({
    ready: false,
    trades: [],
    cashFlows: [],
    stocks: [],
    brokers: [],
    defaultBroker: DEFAULT_BROKER,
    positions: [],
    realizedEvents: [],
    monthly: [],
    yearly: [],
    yearlyDetail: [],
    cumulative: [],
    netValue: [],
    dailyPnl: [],
    drawdownStats: null,
    dailyHolding: [],
    klineCache: { bySymbol: {}, updatedAt: '' },
    klineSyncing: false,
    klineError: '',
    // 日K数据完整性状态：'idle' | 'syncing' | 'ready' | 'missing'
    klineState: 'idle',
    // 目前还缺日K的股票（按交易记录逐只核对）
    klineMissing: [],
    // 需要整段历史补全（首次/换设备）时阻断日历显示，避免残缺数字上屏
    klineBlocking: false,
    // 本轮补全进度
    klineTotal: 0,
    klineFetched: 0,
    quotes: {},
    rates: { usd: 7.2, hkd: 0.92 },
    totals: {
      cash: 0,
      principal: 0,
      totalAssets: 0,
      totalPnl: 0,
      totalPnlPct: null,
      totalRealized: 0,
      floating: 0,
      mvTotal: 0,
      dayPnl: 0
    },
    lastQuoteAt: null,
    refreshing: false,
    quoteError: ''
  }),
  getters: {
    activeSymbols() {
      return this.positions.map((p) => ({ market: p.market, code: p.code }))
    }
  },
  actions: {
    async init() {
      await initDB()
      const settings = useSettingsStore()
      settings.load()
      this.rates = { ...this.rates, usd: settings.rates.usd, hkd: settings.rates.hkd }
      await this.loadData()
      await this.loadKlineCache()
      this.ready = true
      this.refreshQuotes()
    },

    async loadData() {
      this.trades = all('SELECT * FROM trades ORDER BY date, id')
      this.cashFlows = all('SELECT * FROM cash_flows ORDER BY date, id')
      this.syncStocks()
      this.brokers = getBrokers().map((b) => b.name)
      // 读取默认券商设置并校验：必须存在于券商列表，否则回退到「默认账户」或列表中首个券商
      let def = dbGetDefaultBroker()
      if (!this.brokers.includes(def)) {
        def = this.brokers.includes(DEFAULT_BROKER) ? DEFAULT_BROKER : this.brokers[0] || DEFAULT_BROKER
      }
      // 列表为空时至少保留一个可用账户（兼容全新库）
      if (this.brokers.length === 0) this.brokers.unshift(def)
      if (dbGetDefaultBroker() !== def) dbSetDefaultBroker(def)
      this.defaultBroker = def
      this.recompute()
    },

    // 从交易记录回填/清理股票主数据表（兼容老库），并刷新内存中的股票列表
    syncStocks() {
      const seen = new Set()
      for (const t of this.trades) {
        const key = t.market + ':' + t.code
        if (seen.has(key)) continue
        seen.add(key)
        const exist = get('SELECT id, name FROM stocks WHERE market = ? AND code = ?', [t.market, t.code])
        if (!exist) {
          run('INSERT INTO stocks (market, code, name, broker) VALUES (?,?,?,?)', [t.market, t.code, t.name || '', t.broker || this.defaultBroker])
        } else if (t.name && !exist.name) {
          run('UPDATE stocks SET name = ? WHERE id = ?', [t.name, exist.id])
        }
      }
      // 清理已无任何交易记录的股票
      const valid = new Set(this.trades.map((t) => t.market + ':' + t.code))
      for (const s of all('SELECT * FROM stocks')) {
        if (!valid.has(s.market + ':' + s.code)) {
          run('DELETE FROM stocks WHERE id = ?', [s.id])
        }
      }
      this.stocks = all('SELECT * FROM stocks ORDER BY market, code')
    },

    recompute() {
      const r = computeAll(this.trades, this.cashFlows, this.defaultBroker)
      const settings = useSettingsStore()
      const rates = {
        usd: this.rates.usd || settings.rates.usd || 7.2,
        hkd: this.rates.hkd || settings.rates.hkd || 0.92
      }

      const stockMap = new Map()
      for (const s of this.stocks) stockMap.set(s.market + ':' + s.code, s)

      let mvTotal = 0
      let floating = 0
      let dayPnl = 0
      const positions = r.positions.map((p) => {
        const q = this.quotes[p.market + ':' + p.code] || null
        const price = q && q.price ? q.price : p.avgCost
        const rate = rateOf(p.market, rates)
        const mv = p.shares * price
        const mvCny = mv * rate
        const pnl = (price - p.avgCost) * p.shares
        const pnlCny = pnl * rate
        const day = q && q.prevClose ? (price - q.prevClose) * p.shares : null
        const dayCny = day === null ? null : day * rate
        const st = stockMap.get(p.market + ':' + p.code)
        mvTotal += mvCny
        floating += pnlCny
        if (dayCny !== null) dayPnl += dayCny
        return {
          ...p,
          tag: st ? st.tag : '[]',
          note: st ? st.note : '',
          broker: st && st.broker ? st.broker : this.defaultBroker,
          quote: q,
          price,
          rate,
          mv,
          mvCny,
          pnl,
          pnlCny,
          day,
          dayCny,
          pnlPct: p.avgCost > 0 ? (pnl / (p.avgCost * p.shares)) * 100 : null
        }
      })

      const cash = r.cash
      const totalAssets = cash + mvTotal
      const totalPnl = totalAssets - r.principal

      this.positions = positions
      this.realizedEvents = r.realizedEvents
      this.monthly = monthlyRealized(r.realizedEvents)
      this.yearly = yearlyRealized(r.realizedEvents)
      this.yearlyDetail = yearlyStockDetail(r.realizedEvents)
      this.cumulative = cumulativeRealized(r.realizedEvents)

      this.dailyPnl = dailyRealized(r.realizedEvents)
      this.refreshSeries(rates)

      // 各券商可用现金（未出现在计算中的券商补 0）
      const brokerCash = {}
      for (const b of this.brokers) brokerCash[b] = (r.brokerCash || {})[b] || 0

      this.totals = {
        cash,
        brokerCash,
        principal: r.principal,
        totalAssets,
        totalPnl,
        totalPnlPct: r.principal > 0 ? (totalPnl / r.principal) * 100 : null,
        totalRealized: r.totalRealized,
        floating,
        mvTotal,
        dayPnl
      }
    },

    async refreshQuotes(silent = false) {
      if (this.refreshing) return
      this.refreshing = true
      this.quoteError = ''
      try {
        const settings = useSettingsStore()
        if (settings.rates.auto) {
          const fetched = await fetchRates()
          if (fetched.usd) this.rates.usd = fetched.usd
          if (fetched.hkd) this.rates.hkd = fetched.hkd
        }
        const need = this.activeSymbols
        if (need.length) {
          const q = await fetchQuotes(need)
          for (const k of Object.keys(q)) this.quotes[k] = q[k]
          // 用行情回填股票名称
          for (const p of this.positions) {
            const qq = this.quotes[p.market + ':' + p.code]
            if (qq && qq.name && !p.name) {
              run("UPDATE trades SET name = ? WHERE market = ? AND code = ? AND name = ''", [qq.name, p.market, p.code])
            }
          }
        }
        this.lastQuoteAt = new Date()
        this.recompute()
      } catch (e) {
        this.quoteError = e.message || String(e)
      } finally {
        this.refreshing = false
      }
      // 行情更新后顺带增量补齐日K（后台静默执行）
      this.syncKlines()
    },

    // ===== 持仓盈亏日历：日K缓存与逐日持仓盈亏 =====

    // 从 IndexedDB 读日K缓存并计算逐日持仓盈亏
    async loadKlineCache() {
      try {
        const v = await getKv(KLINE_KEY)
        if (v && v.bySymbol) {
          this.klineCache = { bySymbol: v.bySymbol, updatedAt: v.updatedAt || '' }
        }
      } catch {
        /* 缓存读取失败时用空缓存 */
      }
      this.recomputeDailyHolding()
      // 依据当前缓存与交易记录更新缺失清单；随后后台自动补齐（不阻塞首屏）
      this._finishKlineSync()
      this.syncKlines()
    },

    // ===== 净资产曲线 / 回撤 / 逐日持仓盈亏：行情或日K变化后统一刷新 =====

    // 持仓已由 recompute 算好；这里基于最新持仓、现价与日K缓存刷新三条时间序列
    refreshSeries(rates) {
      const r = rates || {
        usd: this.rates.usd || 7.2,
        hkd: this.rates.hkd || 0.92
      }
      const currentPrices = {}
      for (const p of this.positions) currentPrices[p.market + ':' + p.code] = p.price
      const today = new Date().toISOString().slice(0, 10)
      this.netValue = netValueSeries(this.trades, this.cashFlows, currentPrices, r, today, this.klineCache.bySymbol)
      this.drawdownStats = drawdown(this.netValue)
      let rows = dailyHoldingPnl(this.trades, this.klineCache.bySymbol, this.rates)
      // “今天”这一格单独用实时行情口径：Σ 每只当前持仓 (现价 − 昨收) × 现持股
      // 与顶部「今日盈亏」指标同源，不区分当日是否买卖、不依赖今日日K是否已更新。
      const td = fmtDay(new Date())
      let dayAmt = 0
      let dayBase = 0
      let dayReady = false
      let quoteToday = false
      for (const p of this.positions) {
        const q = p.quote || null
        const prev = q && q.prevClose
        if (!prev || prev <= 0 || p.day === null || p.dayCny === null) continue
        dayReady = true
        dayAmt += p.dayCny
        dayBase += prev * p.shares * p.rate
        if (q.time && String(q.time).replace(/[-: ]/g, '').startsWith(td.replace(/-/g, ''))) quoteToday = true
      }
      // 只在“今天是交易日”（有当日行情或日K已含今日）时写入实时口径，避免周末/假期重复上一天盈亏
      const hasTodayBar = Object.values(this.klineCache.bySymbol || {}).some(
        (m) => m && m.days && m.days.length && m.days[m.days.length - 1][0] === td
      )
      if (dayReady && (quoteToday || hasTodayBar)) {
        rows = rows.filter((x) => x.date !== td)
        rows.push({ date: td, amount: dayAmt, base: dayBase })
        rows.sort((a, b) => (a.date < b.date ? -1 : 1))
      }
      this.dailyHolding = rows
    },

    recomputeDailyHolding() {
      this.refreshSeries()
    },

    // 依据交易记录得出需要的股票清单：{ key: { market, code, name, first(最早建仓日) } }
    _requiredSymbols() {
      const map = new Map()
      for (const t of this.trades) {
        const key = t.market + ':' + t.code
        const r = map.get(key)
        if (r) {
          if (t.date < r.first) r.first = t.date
          if (!r.name && t.name) r.name = t.name
        } else {
          map.set(key, { market: t.market, code: t.code, name: t.name || t.code, first: t.date })
        }
      }
      return map
    },

    // 依据当前缓存核算：哪些股票仍缺完整日K（已确认 ok 且覆盖到最早建仓日的才算不缺）
    _missingSymbols() {
      const by = this.klineCache.bySymbol || {}
      const missing = []
      for (const [key, r] of this._requiredSymbols()) {
        const meta = by[key]
        const good = meta && meta.ok === true && meta.from && meta.from <= r.first
        if (!good) missing.push({ key, market: r.market, code: r.code, name: r.name })
      }
      return missing
    },

    // 一次同步结束后核算最终状态（不发起网络请求）
    _finishKlineSync() {
      const missing = this._missingSymbols()
      this.klineMissing = missing
      this.klineState = missing.length ? 'missing' : 'ready'
      this.klineBlocking = false
    },

    /**
     * 同步历史日K（幂等）：
     * - 需要的股票若没有“完整”缓存，会整段从最早建仓日拉取到今日（换设备/清缓存后的首次补全）；
     * - 已有完整缓存的，仅增量补齐到今日；
     * - 整段补全期间置 klineBlocking=true，界面应提示“补全中”，而不是把残缺数字显示出来。
     */
    async syncKlines() {
      if (this.klineSyncing || !this.trades.length) {
        if (!this.trades.length) {
          this.klineMissing = []
          this.klineState = 'ready'
          this.klineBlocking = false
        }
        return
      }
      const today = fmtDay(new Date())
      const dow = new Date().getDay()
      // 周末不增量拉取（整段补全不受影响）
      const isWeekend = dow === 0 || dow === 6
      const by = this.klineCache.bySymbol
      const jobs = []
      let needFull = false
      for (const [key, r] of this._requiredSymbols()) {
        const meta = by[key]
        // 完整覆盖判定：曾完整拉取过（ok）且缓存起点不晚于最早建仓日
        const covered = meta && meta.ok === true && meta.from && meta.from <= r.first
        if (!covered) {
          // 缺整段：从最早建仓日拉到现在（含旧缓存缺 ok 标记的一次性修复）
          jobs.push({ key, market: r.market, code: r.code, from: r.first, full: true })
          needFull = true
          continue
        }
        // 已有完整历史：只增量补当天（交易日才拉；周末交给下一次）
        if (!isWeekend && meta.updated < today) {
          const days = meta.days || []
          const lastBar = days.length ? days[days.length - 1][0] : ''
          if (lastBar && lastBar < today) {
            const after = dayAfter(lastBar)
            if (after <= today) jobs.push({ key, market: r.market, code: r.code, from: after, full: false })
          }
        }
      }
      if (!jobs.length) {
        this.klineError = ''
        this._finishKlineSync()
        return
      }

      this.klineSyncing = true
      this.klineState = 'syncing'
      this.klineBlocking = needFull
      this.klineTotal = jobs.length
      this.klineFetched = 0
      try {
        let changed = false
        // 并发逐只拉取；每只完成后更新进度（供界面显示 x/N）
        await Promise.all(
          jobs.map(async (job) => {
            try {
              const res = await fetchDayKlines([
                { market: job.market, code: job.code, from: job.from, to: today }
              ])
              const got = res.data && res.data[job.key]
              if (got && got.days && got.days.length) {
                const meta = by[job.key] || { from: '', days: [] }
                const prev = meta.days || []
                const merged = new Map()
                for (const [d, c] of prev) merged.set(d, c)
                for (const [d, c] of got.days) merged.set(d, c)
                by[job.key] = {
                  from: meta.from && meta.from <= job.from ? meta.from : job.from,
                  updated: today,
                  // 整段补全时按来源是否完整标记；增量补齐不降低已有完整度
                  ok: job.full ? !!got.complete : meta.ok === true,
                  days: [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
                }
                changed = true
              }
            } catch {
              /* 该只失败不影响其它股票 */
            } finally {
              this.klineFetched++
            }
          })
        )
        if (changed) {
          this.klineCache.updatedAt = new Date().toISOString()
          this.recomputeDailyHolding()
          try {
            await setKv(KLINE_KEY, { bySymbol: by, updatedAt: this.klineCache.updatedAt })
          } catch {
            /* 缓存写失败忽略，不影响主流程 */
          }
        }
      } catch (e) {
        this.klineError = e.message || String(e)
      } finally {
        this.klineSyncing = false
        this._finishKlineSync()
      }
    },

    // 手动“重试补全”（用于缺失提示里的按钮）：只补齐目前还缺的股票
    async retryKlines() {
      if (this.klineSyncing) return
      return this.syncKlines()
    },

    // 记一笔：写入交易，并同步股票主数据（含标签、所属券商）
    async addTrade(t) {
      const broker = t.broker || this.defaultBroker
      run(
        'INSERT INTO trades (date, market, code, name, type, shares, price, fee, tax, amount, note, broker) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [t.date, t.market, t.code, t.name || '', t.type, t.shares || 0, t.price || 0, t.fee || 0, t.tax || 0, t.amount || 0, t.note || '', broker]
      )
      const exist = get('SELECT id FROM stocks WHERE market = ? AND code = ?', [t.market, t.code])
      if (exist) {
        if (t.name) run('UPDATE stocks SET name = ? WHERE id = ?', [t.name, exist.id])
        if (broker) run('UPDATE stocks SET broker = ? WHERE id = ?', [broker, exist.id])
        if (Array.isArray(t.tag) && t.tag.length) {
          run('UPDATE stocks SET tag = ? WHERE id = ?', [JSON.stringify(t.tag), exist.id])
        }
      } else {
        run('INSERT INTO stocks (market, code, name, tag, note, broker) VALUES (?,?,?,?,?,?)', [
          t.market,
          t.code,
          t.name || '',
          JSON.stringify(Array.isArray(t.tag) ? t.tag : []),
          '',
          broker
        ])
      }
      await this.loadData()
      markDirty()
      await persist()
      this.syncKlines()
    },

    // 初始建仓：录入使用本软件之前已持有的股票
    // 与「记录买入」的区别：同时自动生成一笔等额入金记录，
    // 使现金不变、本金增加，净资产/总盈亏/收益率均正确（等价于当初用这笔钱买入）
    async addInitialPosition({ date, market, code, name, shares, costPrice, broker, note, tag }) {
      const qty = Number(shares) || 0
      const price = Number(costPrice) || 0
      const cost = Math.round(qty * price * 100) / 100
      const b = broker || this.defaultBroker
      const tagArr = Array.isArray(tag) ? tag.filter(Boolean) : []
      const tagStr = JSON.stringify(tagArr)
      run(
        'INSERT INTO trades (date, market, code, name, type, shares, price, fee, tax, amount, note, broker) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [date, market, code, name || '', 'buy', qty, price, 0, 0, 0, note || '', b]
      )
      run('INSERT INTO cash_flows (date, type, amount, note, broker) VALUES (?,?,?,?,?)', [
        date,
        'deposit',
        cost,
        `初始建仓-自动入金（${name || code}）`,
        b
      ])
      const exist = get('SELECT id FROM stocks WHERE market = ? AND code = ?', [market, code])
      if (exist) {
        if (name) run('UPDATE stocks SET name = ? WHERE id = ?', [name, exist.id])
        if (b) run('UPDATE stocks SET broker = ? WHERE id = ?', [b, exist.id])
        if (tagArr.length) run('UPDATE stocks SET tag = ? WHERE id = ?', [tagStr, exist.id])
      } else {
        run('INSERT INTO stocks (market, code, name, tag, note, broker) VALUES (?,?,?,?,?,?)', [
          market,
          code,
          name || '',
          tagStr,
          '',
          b
        ])
      }
      await this.loadData()
      markDirty()
      await persist()
      this.syncKlines()
    },

    // 编辑交易记录
    async updateTrade(id, t) {
      const broker = t.broker || this.defaultBroker
      run(
        'UPDATE trades SET date=?, market=?, code=?, name=?, type=?, shares=?, price=?, fee=?, tax=?, amount=?, note=?, broker=? WHERE id=?',
        [t.date, t.market, t.code, t.name || '', t.type, t.shares || 0, t.price || 0, t.fee || 0, t.tax || 0, t.amount || 0, t.note || '', broker, id]
      )
      if (t.name) run('UPDATE stocks SET name = ? WHERE market = ? AND code = ?', [t.name, t.market, t.code])
      if (broker) run('UPDATE stocks SET broker = ? WHERE market = ? AND code = ?', [broker, t.market, t.code])
      if (Array.isArray(t.tag) && t.tag.length) {
        run('UPDATE stocks SET tag = ? WHERE market = ? AND code = ?', [JSON.stringify(t.tag), t.market, t.code])
      }
      await this.loadData()
      markDirty()
      await persist()
      this.syncKlines()
    },

    async deleteTrade(id) {
      run('DELETE FROM trades WHERE id = ?', [id])
      await this.loadData()
      markDirty()
      await persist()
      this.syncKlines()
    },

    // 新增/更新股票主数据（标签、备注、所属券商等）
    async upsertStock({ market, code, name = '', tag = null, note = null, broker = null }) {
      const exist = get('SELECT * FROM stocks WHERE market = ? AND code = ?', [market, code])
      if (exist) {
        if (name) run('UPDATE stocks SET name = ? WHERE id = ?', [name, exist.id])
        if (Array.isArray(tag)) run('UPDATE stocks SET tag = ? WHERE id = ?', [JSON.stringify(tag), exist.id])
        if (note !== null && note !== undefined) run('UPDATE stocks SET note = ? WHERE id = ?', [note, exist.id])
        if (broker) run('UPDATE stocks SET broker = ? WHERE id = ?', [broker, exist.id])
      } else {
        run('INSERT INTO stocks (market, code, name, tag, note, broker) VALUES (?,?,?,?,?,?)', [
          market,
          code,
          name,
          JSON.stringify(Array.isArray(tag) ? tag : []),
          note || '',
          broker || this.defaultBroker
        ])
      }
      await this.loadData()
      markDirty()
      await persist()
    },

    // 编辑股票信息（详情页）：名称/标签/备注/所属券商，名称变化时同步到历史交易
    // syncTrades=true 时，将该股票全部交易记录的所属券商一并改为新券商
    async updateStockInfo(market, code, patch, syncTrades = false) {
      const exist = get('SELECT * FROM stocks WHERE market = ? AND code = ?', [market, code])
      const name = patch.name ?? exist?.name ?? ''
      const tag = Array.isArray(patch.tag) ? JSON.stringify(patch.tag) : (exist?.tag ?? '[]')
      const note = patch.note ?? exist?.note ?? ''
      const broker = patch.broker ?? exist?.broker ?? this.defaultBroker
      if (exist) {
        run('UPDATE stocks SET name = ?, tag = ?, note = ?, broker = ? WHERE id = ?', [name, tag, note, broker, exist.id])
      } else {
        run('INSERT INTO stocks (market, code, name, tag, note, broker) VALUES (?,?,?,?,?,?)', [market, code, name, tag, note, broker])
      }
      if (name) run('UPDATE trades SET name = ? WHERE market = ? AND code = ?', [name, market, code])
      if (syncTrades) {
        run('UPDATE trades SET broker = ? WHERE market = ? AND code = ?', [broker, market, code])
      }
      await this.loadData()
      markDirty()
      await persist()
    },

    // 删除股票：连同其全部交易记录一起删除
    async deleteStock(market, code) {
      run('DELETE FROM trades WHERE market = ? AND code = ?', [market, code])
      run('DELETE FROM stocks WHERE market = ? AND code = ?', [market, code])
      await this.loadData()
      markDirty()
      await persist()
      this.syncKlines()
    },

    async addCashFlow(c) {
      run('INSERT INTO cash_flows (date, type, amount, note, broker) VALUES (?,?,?,?,?)', [
        c.date,
        c.type,
        c.amount,
        c.note || '',
        c.broker || this.defaultBroker
      ])
      await this.loadData()
      markDirty()
      await persist()
    },

    async deleteCashFlow(id) {
      run('DELETE FROM cash_flows WHERE id = ?', [id])
      await this.loadData()
      markDirty()
      await persist()
    },

    async importData(bytes) {
      const { loadBytes } = await import('../db')
      loadBytes(bytes)
      await this.loadData()
      markDirty()
      await persist()
      // 导入的新账本里可能有不在这台设备缓存中的股票，触发自动补全
      this.syncKlines()
    },

    async clearAll() {
      run('DELETE FROM trades')
      run('DELETE FROM cash_flows')
      run('DELETE FROM stocks')
      await this.loadData()
      markDirty()
      await persist()
      // 清空后日K缓存一并丢弃，避免残留旧股票数据
      this.klineCache = { bySymbol: {}, updatedAt: '' }
      this.klineState = 'idle'
      this.klineMissing = []
      this.klineBlocking = false
      this.klineTotal = 0
      this.klineFetched = 0
      this.klineError = ''
      try {
        await setKv(KLINE_KEY, { bySymbol: {}, updatedAt: '' })
      } catch {
        /* 忽略 */
      }
    },

    // ===== 券商管理 =====
    async addBroker(name) {
      const n = (name || '').trim()
      if (!n) return
      if (get('SELECT id FROM brokers WHERE name = ?', [n])) return
      insertBroker(n)
      await this.loadData()
      markDirty()
      await persist()
    },

    async renameBroker(oldName, newName) {
      const n = (newName || '').trim()
      if (!n || n === oldName) return
      // 重命名的是默认账户时，默认设置同步更新
      if (oldName === this.defaultBroker) dbSetDefaultBroker(n)
      dbRenameBroker(oldName, n)
      await this.loadData()
      markDirty()
      await persist()
    },

    async deleteBroker(name) {
      // 删除的是默认账户时，先将默认标记移交给其他券商，数据也归入该账户
      let fallback = this.defaultBroker
      if (name === this.defaultBroker) {
        fallback = this.brokers.find((b) => b !== name) || DEFAULT_BROKER
        if (fallback && this.brokers.includes(fallback)) dbSetDefaultBroker(fallback)
      }
      dbDeleteBroker(name, fallback)
      await this.loadData()
      markDirty()
      await persist()
    },

    async setDefaultBroker(name) {
      if (!this.brokers.includes(name)) return
      dbSetDefaultBroker(name)
      this.defaultBroker = name
      markDirty()
      await persist()
    }
  }
})
