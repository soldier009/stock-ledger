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
  buildClosedRounds,
  netValueSeries,
  netValueExFlows,
  assetValueSeries,
  holdingSeries,
  dailyRealized,
  dailyHoldingPnl,
  drawdown
} from '../services/calc'
import { fetchQuotes, fetchRates } from '../services/quotes'
import { fetchDayKlines } from '../services/kline'
import { INDEX_LIST, fetchIndexKlines } from '../services/indexes'
import { rateOf, assetClass, parseTags } from '../utils/format'
import { DEFAULT_BROKER } from '../constants'
import { byDateAsc, byDateFieldAsc } from '../utils/sort'
import { useSettingsStore } from './settings'

// 行情日K缓存（IndexedDB，独立于 sqlite 备份；不触发本地脏标记）
const KLINE_KEY = 'stock-ledger-kline-v1'
// 大盘指数日K缓存（供资产曲线收益对比）
const INDEX_KEY = 'stock-ledger-index-v1'
// 整段补全连续拿不到早于首建仓日的数据达到此次数后，认定数据源本身没有，不再反复拉取
const KLINE_GIVEUP_TRIES = 3

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
    // 已清仓记录（按持仓批次切分，每轮清仓一条）
    closedRounds: [],
    closedStat: { count: 0, stockCount: 0, realized: 0, win: 0, loss: 0 },
    netValue: [],
    // 剔除入金/出金后的净值序列（时间加权），供回撤分析使用
    netValueExFlow: [],
    // 资产曲线：逐日持仓市值 + 按市场 / 按标签的拆分
    assetSeries: [],
    dailyPnl: [],
    drawdownStats: null,
    dailyHolding: [],
    klineCache: { bySymbol: {}, updatedAt: '' },
    // 大盘指数日K：{ byKey: { hs300: { days: [[date, close]], ok } } }
    indexCache: { byKey: {}, updatedAt: '' },
    indexSyncing: false,
    klineSyncing: false,
    klineError: '',
    // 日K数据完整性状态：'idle' | 'syncing' | 'ready' | 'missing'
    klineState: 'idle',
    // 还缺日K、且重试有机会拿到的股票（按交易记录逐只核对）
    klineMissing: [],
    // 已尽力仍拿不到的股票：数据源本身没有该标的，或只提供 X 之后的数据（如新股上市前）。
    // 这类重试也没用，不再计入缺失，只在界面上说明其盈亏未计入
    klinePartial: [],
    // 需要整段历史补全（首次/换设备，缓存里全无数据）时阻断日历显示，避免残缺数字上屏
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
    },
    // 净资产曲线最后一点（序列还没算出来时回退到当前总资产口径）
    // 总览与净资产走势浮层共用，避免两处各写一份回退逻辑
    lastNetPoint() {
      const s = this.netValue
      if (s.length) return s[s.length - 1]
      const t = this.totals || {}
      return { date: '', netValue: t.totalAssets || 0, cash: t.cash || 0, marketValue: t.mvTotal || 0 }
    },
    // 分红记录（含折人民币金额 cny），供分析页「分红」页签使用。
    // 港美股分红是交易原币，这里与市值/盈亏走同一份生效汇率折算
    divEvents() {
      const rates = this._effectiveRates()
      const fx = (m) => (m === 'HK' ? rates.hkd : m === 'US' ? rates.usd : 1)
      return this.trades
        .filter((t) => t.type === 'div')
        .map((t) => ({ ...t, cny: (Number(t.amount) || 0) * fx(t.market) }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
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
      await this.loadIndexCache()
      this.ready = true
      this.refreshQuotes()
      this.syncIndexes()
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

    // 标的元信息查询器：一次遍历 stocks 建好全部索引，返回三个取值函数。
    // 标签/用途挂在「标的」上而非「持仓」上，因此即使标的已清仓，
    // 历史上的已实现盈亏依然能按标签/用途归组。
    // 原先 assetType / tag / purpose 三个 resolver 各扫一遍全表，一次 recompute 要扫 5 遍。
    buildMetaResolver() {
      const typeByKey = new Map()
      const tagByKey = new Map()
      const purposeByKey = new Map()
      for (const s of this.stocks) {
        const k = s.market + ':' + s.code
        typeByKey.set(k, s.asset_type || '')
        const t = parseTags(s.tag)
        // 一只股票有多个标签时只取第一个，保证各标签分组市值之和 = 总市值
        tagByKey.set(k, t.length ? t[0] : '')
        purposeByKey.set(k, s.purpose || '')
      }
      return {
        // 资产二级分类：人工标注优先，未标注按市场与代码推断
        assetTypeOf: (market, code) => assetClass(market, code, typeByKey.get(market + ':' + code)),
        tagOf: (market, code) => tagByKey.get(market + ':' + code) || '',
        purposeOf: (market, code) => purposeByKey.get(market + ':' + code) || ''
      }
    },

    // 生效汇率：已拉取过的 > 设置里手填的 > 内置兜底值。
    // recompute 与 refreshSeries 必须走同一份，否则市值曲线与日历盈亏口径会岔开
    _effectiveRates() {
      const settings = useSettingsStore()
      return {
        usd: this.rates.usd || settings.rates.usd || 7.2,
        hkd: this.rates.hkd || settings.rates.hkd || 0.92
      }
    },

    recompute() {
      const r = computeAll(this.trades, this.cashFlows, this.defaultBroker)
      const rates = this._effectiveRates()

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
        // 今日盈亏的涨跌幅分母：昨收市值（与 dayCny 同源，缺昨收时为 null）
        const dayBaseCny = q && q.prevClose ? q.prevClose * p.shares * rate : null
        const st = stockMap.get(p.market + ':' + p.code)
        mvTotal += mvCny
        floating += pnlCny
        if (dayCny !== null) dayPnl += dayCny
        return {
          ...p,
          tag: st ? st.tag : '[]',
          note: st ? st.note : '',
          // 资产二级分类的人工标注（空字符串表示按代码自动推断）
          assetType: st && st.asset_type ? st.asset_type : '',
          // 用途标签：与资产类别标签并列的第二个维度，单值字符串，空表示未设置
          purpose: st && st.purpose ? st.purpose : '',
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
          dayBaseCny,
          pnlPct: p.avgCost > 0 ? (pnl / (p.avgCost * p.shares)) * 100 : null
        }
      })

      const cash = r.cash
      const totalAssets = cash + mvTotal
      const totalPnl = totalAssets - r.principal

      this.positions = positions
      // 每条已实现盈亏打上资产类别（股票/基金/可转债），供收益曲线按类别拆分；
      // 同时打上标签与用途：标签/用途挂在「标的」上而非「持仓」上，
      // 因此即使该标的已经清仓（不在 positions 里），历史上的已实现盈亏依然能按标签/用途归组
      const { assetTypeOf, tagOf, purposeOf } = this.buildMetaResolver()
      this.realizedEvents = r.realizedEvents.map((e) => {
        const t = tagOf(e.market, e.code)
        return {
          ...e,
          asset: assetTypeOf(e.market, e.code),
          tag: t ? JSON.stringify([t]) : '[]',
          purpose: purposeOf(e.market, e.code)
        }
      })
      this.monthly = monthlyRealized(r.realizedEvents)
      this.yearly = yearlyRealized(r.realizedEvents)
      this.yearlyDetail = yearlyStockDetail(r.realizedEvents)
      this.cumulative = cumulativeRealized(r.realizedEvents)
      const cr = buildClosedRounds(this.trades)
      this.closedRounds = cr.rounds
      this.closedStat = cr.stat

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
      const r = rates || this._effectiveRates()
      const currentPrices = {}
      for (const p of this.positions) currentPrices[p.market + ':' + p.code] = p.price
      const today = new Date().toISOString().slice(0, 10)
      this.netValue = netValueSeries(this.trades, this.cashFlows, currentPrices, r, today, this.klineCache.bySymbol)
      // 剔除入金/出金后的净值序列：回撤分析用它，避免把取钱当成亏损、把入金当成盈利
      this.netValueExFlow = netValueExFlows(this.netValue)
      this.assetSeries = assetValueSeries(
        this.trades,
        this.cashFlows,
        currentPrices,
        r,
        today,
        this.klineCache.bySymbol,
        // tagOf 主维度；同一份索引里的 purposeOf 供成本与盈亏页的分组曲线使用（与标签口径并列）
        this.buildMetaResolver()
      )
      // 与回撤分析同口径：剔除入金/出金，否则取钱会被算成亏损
      this.drawdownStats = drawdown(this.netValueExFlow)
      // 与上面的市值/资产序列用同一份汇率 r，避免自定义汇率时日历盈亏与曲线口径不一致
      let rows = dailyHoldingPnl(this.trades, this.klineCache.bySymbol, r)
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
        rows.sort(byDateFieldAsc)
      }
      this.dailyHolding = rows
    },

    recomputeDailyHolding() {
      this.refreshSeries()
    },

    // ===== 大盘指数（资产曲线收益对比）=====

    async loadIndexCache() {
      try {
        const v = await getKv(INDEX_KEY)
        if (v && v.byKey) this.indexCache = { byKey: v.byKey, updatedAt: v.updatedAt || '' }
      } catch {
        /* 缓存读取失败时用空缓存 */
      }
    },

    // 指数曲线从最早一笔交易开始取，保证与资产曲线同起点
    _indexFrom() {
      let first = ''
      for (const t of this.trades) if (!first || t.date < first) first = t.date
      for (const c of this.cashFlows) if (!first || c.date < first) first = c.date
      if (!first) first = fmtDay(new Date(Date.now() - 365 * 86400000))
      return first
    },

    async syncIndexes() {
      if (this.indexSyncing) return
      this.indexSyncing = true
      try {
        const to = fmtDay(new Date())
        const from = this._indexFrom()
        const by = { ...(this.indexCache.byKey || {}) }
        const items = []
        for (const idx of INDEX_LIST) {
          const meta = by[idx.key]
          const last = meta && meta.days && meta.days.length ? meta.days[meta.days.length - 1][0] : ''
          const start = last ? dayAfter(last) : from
          if (start > to) continue
          items.push({ key: idx.key, from: start, to })
        }
        if (!items.length) return
        const res = await fetchIndexKlines(items)
        let changed = false
        for (const [key, v] of Object.entries(res || {})) {
          const prev = (by[key] && by[key].days) || []
          const map = new Map(prev.map((d) => [d[0], d[1]]))
          for (const [d, c] of v.days || []) map.set(d, c)
          const merged = [...map.entries()].sort(byDateAsc)
          if (merged.length !== prev.length) changed = true
          by[key] = { days: merged, ok: (by[key] && by[key].ok) || v.ok }
        }
        if (changed) {
          this.indexCache = { byKey: by, updatedAt: new Date().toISOString() }
          try {
            await setKv(INDEX_KEY, this.indexCache)
          } catch {
            /* 缓存写失败忽略 */
          }
        }
      } catch {
        /* 指数拉取失败不影响主流程 */
      } finally {
        this.indexSyncing = false
      }
    },

    // 单只股票的逐日走势（按需计算，不进入全局序列避免每次 recompute 都重算）
    stockSeries(market, code) {
      const currentPrices = {}
      for (const p of this.positions) currentPrices[p.market + ':' + p.code] = p.price
      const today = new Date().toISOString().slice(0, 10)
      return holdingSeries(this.trades, currentPrices, this.rates, today, this.klineCache.bySymbol, market, code)
    },

    // 依据交易记录得出需要的股票清单：{ key: { market, code, name, first(最早建仓日), initial? } }
    _requiredSymbols() {
      const map = new Map()
      for (const t of this.trades) {
        const key = t.market + ':' + t.code
        const r = map.get(key)
        if (r) {
          if (t.date < r.first) r.first = t.date
          if (t.origin === 'initial' && (t.type === 'buy' || t.type === 'rights')) r.initial = true
          if (!r.name && t.name) r.name = t.name
        } else {
          map.set(key, {
            market: t.market,
            code: t.code,
            name: t.name || t.code,
            first: t.date,
            initial: !!(t.origin === 'initial' && (t.type === 'buy' || t.type === 'rights'))
          })
        }
      }
      // 初始建仓（补录历史持仓）会被并入净资产序列起点，需要自整个序列最早日起的行情才能渲染
      // （只覆盖到补录日本身会造出“成本价→当日市价”的假台阶）
      let dataStart = ''
      for (const t of this.trades) {
        if (!dataStart || t.date < dataStart) dataStart = t.date
      }
      for (const c of this.cashFlows) {
        if (!dataStart || c.date < dataStart) dataStart = c.date
      }
      if (dataStart) {
        for (const r of map.values()) {
          if (r.initial && dataStart < r.first) r.first = dataStart
        }
      }
      return map
    },

    // 依据当前缓存逐只核算日K完整度，分两档：
    //   missing —— 还没请求过，或暂时失败，重试有机会拿到（界面提供「补全」按钮）
    //   partial —— 已请求过覆盖首建仓日的区间、来源也判定完整，但数据源给不出那么早
    //              （新股上市前 / 老股数据源只保留近年 / 停牌退市），重试也没用
    // 返回 { missing, partial }，元素形如 { key, market, code, name, since }
    // since = 数据源能提供的最早日期，完全没有该标的时为 null
    _klineStatus() {
      const by = this.klineCache.bySymbol || {}
      const missing = []
      const partial = []
      for (const [key, r] of this._requiredSymbols()) {
        const meta = by[key]
        const days = (meta && meta.days) || []
        // 是否已请求过覆盖首建仓日的整段（不只是"拿到过一点数据"）
        const tried = !!(meta && meta.ok === true && meta.from && meta.from <= r.first)
        // 数据源给得出的最早日期是否已覆盖首建仓日
        const since = days.length ? days[0][0] : null
        const covered = !!since && since <= r.first
        if (covered) continue
        const item = { key, market: r.market, code: r.code, name: r.name, since }
        // 请求过但给不出那么早，且已试够次数 —— 认定数据源本身没有，不再算缺失
        if (tried && (Number(meta.tries) || 0) >= KLINE_GIVEUP_TRIES) partial.push(item)
        else missing.push(item)
      }
      return { missing, partial }
    },

    // 一次同步结束后核算最终状态（不发起网络请求）
    _finishKlineSync() {
      const { missing, partial } = this._klineStatus()
      this.klineMissing = missing
      this.klinePartial = partial
      // 只有暂时拿不到的才算 missing；partial 属于数据源本身没有，不阻断日历
      this.klineState = missing.length ? 'missing' : 'ready'
      this.klineBlocking = false
    },

    /**
     * 同步历史日K（幂等）：
     * - 没请求过整段的，从最早建仓日整段拉到今日（换设备/清缓存后的首次补全）；
     * - 已覆盖到最早建仓日的，仅增量补齐到今日；
     * - 数据源本身给不出那么早的（新股未上市等），试满 KLINE_GIVEUP_TRIES 次后每天最多再试一次，
     *   不再每次打开都整段重拉（否则这类标的会永远拉不到、白白耗流量）；
     * - 仅当缓存里一只可用数据都没有时置 klineBlocking，让界面提示“补全中”而不是显示残缺数字。
     */
    async syncKlines() {
      if (this.klineSyncing || !this.trades.length) {
        if (!this.trades.length) {
          this.klineMissing = []
          this.klinePartial = []
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
      for (const [key, r] of this._requiredSymbols()) {
        const meta = by[key]
        const days = (meta && meta.days) || []
        // 是否已请求过覆盖首建仓日的整段，且来源判定完整（缺口不在已取区间内部）
        const tried = !!(meta && meta.ok === true && meta.from && meta.from <= r.first)
        // 数据源给得出的最早日期是否已覆盖首建仓日
        const covered = !!(days.length && days[0][0] <= r.first)
        if (!tried) {
          // 从没请求过整段：从最早建仓日拉到现在（含旧缓存缺 ok 标记的一次性修复）
          jobs.push({ key, market: r.market, code: r.code, from: r.first, full: true })
          continue
        }
        if (!covered) {
          const tries = Number(meta.tries) || 0
          if (tries < KLINE_GIVEUP_TRIES) {
            // 数据源给不出那么早，但还没试够次数：再试，可能是暂时失败
            jobs.push({ key, market: r.market, code: r.code, from: r.first, full: true })
          } else if (!isWeekend && meta.updated < today) {
            // 已认定数据源本身没有（新股未上市等）：不再每次打开都整段重拉，
            // 每天最多再试一次，这样新股上市后能自动补上而无需用户操作
            jobs.push({ key, market: r.market, code: r.code, from: r.first, full: true, quiet: true })
          }
          continue
        }
        // 已覆盖：只增量补当天（交易日才拉；周末交给下一次）
        if (!isWeekend && meta.updated < today) {
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

      // 只有当缓存里一只可用数据都没有（首次打开/换设备/清缓存）时才阻断日历显示；
      // 少数几只缺失不再让整块日历不可用
      const usable = Object.values(by).filter((m) => m && m.days && m.days.length).length
      this.klineSyncing = true
      this.klineState = 'syncing'
      this.klineBlocking = usable === 0
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
              const gotDays = (got && got.days) || []
              const meta = by[job.key] || { from: '', days: [] }
              if (job.full) {
                // 整段补全：即使这只数据源完全没有，也要落一条缓存记录，
                // 否则下次还会当成"没请求过"无限重拉
                const merged = new Map()
                for (const [d, c] of meta.days || []) merged.set(d, c)
                for (const [d, c] of gotDays) merged.set(d, c)
                const days = [...merged.entries()].sort(byDateAsc)
                // 数据源给不出早于首建仓日的数据时累加尝试次数，拿全了则清零
                const earliest = days.length ? days[0][0] : ''
                const reaches = !!earliest && earliest <= job.from
                by[job.key] = {
                  from: meta.from && meta.from <= job.from ? meta.from : job.from,
                  updated: today,
                  // 一只都没有 = 数据源确实没有该标的（未上市/已退市），不算失败
                  ok: gotDays.length ? !!got.complete : true,
                  tries: reaches ? 0 : (Number(meta.tries) || 0) + 1,
                  days
                }
                changed = true
              } else if (gotDays.length) {
                const merged = new Map()
                for (const [d, c] of meta.days || []) merged.set(d, c)
                for (const [d, c] of gotDays) merged.set(d, c)
                by[job.key] = {
                  from: meta.from && meta.from <= job.from ? meta.from : job.from,
                  updated: today,
                  // 增量补齐不降低已有完整度，也不动尝试次数
                  ok: meta.ok === true,
                  tries: Number(meta.tries) || 0,
                  days: [...merged.entries()].sort(byDateAsc)
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
        if (t.purpose) run('UPDATE stocks SET purpose = ? WHERE id = ?', [t.purpose, exist.id])
      } else {
        run('INSERT INTO stocks (market, code, name, tag, note, broker, purpose) VALUES (?,?,?,?,?,?,?)', [
          t.market,
          t.code,
          t.name || '',
          JSON.stringify(Array.isArray(t.tag) ? t.tag : []),
          '',
          broker,
          t.purpose || ''
        ])
      }
      await this.loadData()
      markDirty()
      await persist()
      this.syncKlines()
    },

    // 录入一只股票（「新增资产 › 股票」）
    // fund 决定这笔买入的钱从哪来：
    //   'auto'（默认，补录历史持仓）：同时自动生成一笔等额入金记录，使现金不变、本金增加，
    //         净资产/总盈亏/收益率均正确（等价于当初用这笔钱买入），并在净资产曲线上并入起点
    //   'cash'（关联扣款账户，真实买入）：记为一笔普通买入，从该券商现金里扣，不生成入金
    async addInitialPosition({ date, market, code, name, shares, costPrice, broker, note, tag, purpose, fund }) {
      const qty = Number(shares) || 0
      const price = Number(costPrice) || 0
      const cost = Math.round(qty * price * 100) / 100
      const b = broker || this.defaultBroker
      const tagArr = Array.isArray(tag) ? tag.filter(Boolean) : []
      const tagStr = JSON.stringify(tagArr)
      const purposeStr = String(purpose || '')
      const fromCash = fund === 'cash'
      run(
        'INSERT INTO trades (date, market, code, name, type, shares, price, fee, tax, amount, note, broker, origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [date, market, code, name || '', 'buy', qty, price, 0, 0, 0, note || '', b, fromCash ? '' : 'initial']
      )
      if (!fromCash) {
        // 入金记录用 ref_id 指向刚插入的买入记录，之后改期/改金额/删除都靠它精确定位
        const rowOf = get('SELECT MAX(id) AS id FROM trades')
        run(
          'INSERT INTO cash_flows (date, type, amount, note, broker, origin, ref_id) VALUES (?,?,?,?,?,?,?)',
          [
            date,
            'deposit',
            cost,
            `初始建仓-自动入金（${name || code}）`,
            b,
            'initial',
            rowOf ? rowOf.id : null
          ]
        )
      }
      const exist = get('SELECT id FROM stocks WHERE market = ? AND code = ?', [market, code])
      if (exist) {
        if (name) run('UPDATE stocks SET name = ? WHERE id = ?', [name, exist.id])
        if (b) run('UPDATE stocks SET broker = ? WHERE id = ?', [b, exist.id])
        if (tagArr.length) run('UPDATE stocks SET tag = ? WHERE id = ?', [tagStr, exist.id])
        if (purposeStr) run('UPDATE stocks SET purpose = ? WHERE id = ?', [purposeStr, exist.id])
      } else {
        run('INSERT INTO stocks (market, code, name, tag, note, broker, purpose) VALUES (?,?,?,?,?,?,?)', [
          market,
          code,
          name || '',
          tagStr,
          '',
          b,
          purposeStr
        ])
      }
      await this.loadData()
      markDirty()
      await persist()
      this.syncKlines()
    },

    // 初始建仓自动生成的那笔入金（编辑 / 删除时联动）
    // 首选按 ref_id 精确定位（新建仓时写入，老库由 migrate 一次性回填）；
    // 没有 ref_id 的老数据才退化为“同日+同券商+金额一致”的启发式匹配
    _initialDeposit(t, fallbackDate = false) {
      if (!t) return null
      if (t.id) {
        const byRef = get('SELECT * FROM cash_flows WHERE ref_id = ?', [t.id])
        if (byRef) return byRef
      }
      const cost = Math.round(
        ((Number(t.price) || 0) * (Number(t.shares) || 0) + (Number(t.fee) || 0) + (Number(t.tax) || 0)) * 100
      ) / 100
      const base = "SELECT * FROM cash_flows WHERE type = 'deposit' AND broker = ? AND ABS(amount - ?) <= 0.011"
      let cf = get(base + " AND date = ? AND (origin = 'initial' OR note LIKE '初始建仓-自动入金（%') ORDER BY id LIMIT 1", [
        t.broker,
        cost,
        t.date
      ])
      // 日期错位（如买入已改期而入金仍在原日期）时的兜底：同券商同金额且备注吻合的自动入金
      if (!cf && fallbackDate) {
        cf = get(
          base +
            " AND note LIKE '初始建仓-自动入金（%' AND (origin = 'initial' OR origin = '' OR origin IS NULL) ORDER BY date DESC, id DESC LIMIT 1",
          [t.broker, cost]
        )
      }
      return cf
    },

    // 编辑交易记录
    async updateTrade(id, t) {
      const broker = t.broker || this.defaultBroker
      const oldT = get('SELECT * FROM trades WHERE id = ?', [id])
      // 建仓记录（补录历史持仓）恒定为买入：即使上层误传了别的类型也强制纠正。
      // 一旦允许它变成卖出/分红，与之配对的自动入金就会失去资金来源的含义，
      // 持仓成本、本金与已实现盈亏的口径会一起错乱
      const keepInitial = !!(oldT && oldT.origin === 'initial')
      const type = keepInitial ? 'buy' : t.type
      run(
        'UPDATE trades SET date=?, market=?, code=?, name=?, type=?, shares=?, price=?, fee=?, tax=?, amount=?, note=?, broker=?, origin=? WHERE id=?',
        [t.date, t.market, t.code, t.name || '', type, t.shares || 0, t.price || 0, t.fee || 0, t.tax || 0, t.amount || 0, t.note || '', broker, keepInitial ? 'initial' : '', id]
      )
      // 初始建仓对应的自动入金：与买入记录成对联动——
      // 日期 / 券商 / 金额 / 备注（含股票名称）全部跟随，避免“买入某日、入金另一日”或
      // “交易金额改了、入金还是老金额”导致的本金虚增错位
      if (keepInitial) {
        const cf = this._initialDeposit(oldT, true)
        if (cf) {
          const cost = Math.round(
            ((Number(t.shares) || 0) * (Number(t.price) || 0) + (Number(t.fee) || 0) + (Number(t.tax) || 0)) * 100
          ) / 100
          run('UPDATE cash_flows SET date = ?, broker = ?, amount = ?, note = ?, origin = ? WHERE id = ?', [
            t.date,
            broker,
            cost,
            `初始建仓-自动入金（${t.name || t.code}）`,
            'initial',
            cf.id
          ])
        }
      }
      if (t.name) run('UPDATE stocks SET name = ? WHERE market = ? AND code = ?', [t.name, t.market, t.code])
      if (broker) run('UPDATE stocks SET broker = ? WHERE market = ? AND code = ?', [broker, t.market, t.code])
      if (Array.isArray(t.tag) && t.tag.length) {
        run('UPDATE stocks SET tag = ? WHERE market = ? AND code = ?', [JSON.stringify(t.tag), t.market, t.code])
      }
      if (t.purpose) {
        run('UPDATE stocks SET purpose = ? WHERE market = ? AND code = ?', [t.purpose, t.market, t.code])
      }
      await this.loadData()
      markDirty()
      await persist()
      this.syncKlines()
    },

    async deleteTrade(id) {
      // 初始建仓的自动入金与买入成对生成：删除买入时联动删除对应入金，避免现金端残留虚增
      const del = get('SELECT * FROM trades WHERE id = ?', [id])
      if (del && del.origin === 'initial' && (del.type === 'buy' || del.type === 'rights')) {
        const cf = this._initialDeposit(del, true)
        if (cf) run('DELETE FROM cash_flows WHERE id = ?', [cf.id])
      }
      run('DELETE FROM trades WHERE id = ?', [id])
      await this.loadData()
      markDirty()
      await persist()
      this.syncKlines()
    },

    // 新增/更新股票主数据（标签、备注、所属券商等）
    async upsertStock({ market, code, name = '', tag = null, note = null, broker = null, assetType = null, purpose = null }) {
      const exist = get('SELECT * FROM stocks WHERE market = ? AND code = ?', [market, code])
      if (exist) {
        if (name) run('UPDATE stocks SET name = ? WHERE id = ?', [name, exist.id])
        if (Array.isArray(tag)) run('UPDATE stocks SET tag = ? WHERE id = ?', [JSON.stringify(tag), exist.id])
        if (note !== null && note !== undefined) run('UPDATE stocks SET note = ? WHERE id = ?', [note, exist.id])
        if (broker) run('UPDATE stocks SET broker = ? WHERE id = ?', [broker, exist.id])
        if (assetType !== null && assetType !== undefined) {
          run('UPDATE stocks SET asset_type = ? WHERE id = ?', [assetType, exist.id])
        }
        if (purpose !== null && purpose !== undefined) {
          run('UPDATE stocks SET purpose = ? WHERE id = ?', [purpose, exist.id])
        }
      } else {
        run('INSERT INTO stocks (market, code, name, tag, note, broker, asset_type, purpose) VALUES (?,?,?,?,?,?,?,?)', [
          market,
          code,
          name,
          JSON.stringify(Array.isArray(tag) ? tag : []),
          note || '',
          broker || this.defaultBroker,
          assetType || '',
          purpose || ''
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
      const assetType = patch.assetType ?? exist?.asset_type ?? ''
      // 用途标签是单值字符串；未传时保留原值，传空串表示清空为「未设置」
      const purpose = patch.purpose ?? exist?.purpose ?? ''
      if (exist) {
        run('UPDATE stocks SET name = ?, tag = ?, note = ?, broker = ?, asset_type = ?, purpose = ? WHERE id = ?', [name, tag, note, broker, assetType, purpose, exist.id])
      } else {
        run('INSERT INTO stocks (market, code, name, tag, note, broker, asset_type, purpose) VALUES (?,?,?,?,?,?,?,?)', [market, code, name, tag, note, broker, assetType, purpose])
      }
      if (name) run('UPDATE trades SET name = ? WHERE market = ? AND code = ?', [name, market, code])
      if (syncTrades) {
        run('UPDATE trades SET broker = ? WHERE market = ? AND code = ?', [broker, market, code])
      }
      await this.loadData()
      markDirty()
      await persist()
    },

    /**
     * 批量修改标的主数据（资产页批量模式）
     * - targets: [{ market, code }]，按 (market, code) 定位 stocks 行
     * - patch 只写传了的字段：tag / purpose / broker；tag 传数组会按单选语义整体替换
     * - syncTrades: 券商圈选连带迁移这些标的的全部交易记录
     * - syncCash: 连带迁移与这些交易配对的「初始建仓」自动入金（cash_flows.ref_id → trades.id），
     *   因为现金是按券商分账的，只迁交易不迁入金会让目的券商的可用资金算成负数
     * 返回实际影响的对象数量，供上层做结果提示
     */
    async bulkUpdateStocks({ targets, patch = {}, syncTrades = false, syncCash = false }) {
      const list = (targets || []).filter((t) => t && t.market && t.code)
      if (!list.length) return { stocks: 0, trades: 0, flows: 0 }
      let affectedTrades = 0
      let affectedFlows = 0
      try {
        run('BEGIN')
        for (const t of list) {
          const fields = []
          const vals = []
          if (Array.isArray(patch.tag)) {
            fields.push('tag = ?')
            vals.push(JSON.stringify(patch.tag))
          }
          if (patch.purpose !== undefined) {
            fields.push('purpose = ?')
            vals.push(patch.purpose || '')
          }
          if (patch.broker) {
            fields.push('broker = ?')
            vals.push(patch.broker)
          }
          if (!fields.length) continue
          vals.push(t.market, t.code)
          run(`UPDATE stocks SET ${fields.join(', ')} WHERE market = ? AND code = ?`, vals)
        }
        if (patch.broker && syncTrades) {
          for (const t of list) {
            run('UPDATE trades SET broker = ? WHERE market = ? AND code = ?', [
              patch.broker,
              t.market,
              t.code
            ])
            affectedTrades += this._changes()
          }
        }
        if (patch.broker && syncCash) {
          // 只迁「跟着这笔买入走的钱」：ref_id 指向这些交易的那笔初始建仓入金
          for (const t of list) {
            const rows = all(
              'SELECT id FROM trades WHERE market = ? AND code = ?',
              [t.market, t.code]
            )
            for (const r of rows) {
              run('UPDATE cash_flows SET broker = ? WHERE ref_id = ?', [patch.broker, r.id])
              affectedFlows += this._changes()
            }
          }
        }
        run('COMMIT')
      } catch (e) {
        try { run('ROLLBACK') } catch {}
        throw e
      }
      await this.loadData()
      markDirty()
      await persist()
      return { stocks: list.length, trades: affectedTrades, flows: affectedFlows }
    },

    // sql.js 的 run 不返回受影响行数，用 changes() 读取（批量场景需要真实计数）
    _changes() {
      try {
        const row = get('SELECT changes() AS n')
        return Number(row?.n) || 0
      } catch {
        return 0
      }
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

    /**
     * 修改一笔手动记录的资金出入。
     * 只覆盖 date/type/amount/note/broker，不碰 origin：
     * 编辑「新建仓」联动生成的入金是被禁止的（UI 层拦），
     * 而 updateTrade / deleteTrade 对初始建仓的联动依赖 origin='initial'，这里绝不能改。
     */
    async updateCashFlow(id, c) {
      run('UPDATE cash_flows SET date = ?, type = ?, amount = ?, note = ?, broker = ? WHERE id = ?', [
        c.date,
        c.type,
        c.amount,
        c.note || '',
        c.broker || this.defaultBroker,
        id
      ])
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
      this.klinePartial = []
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
