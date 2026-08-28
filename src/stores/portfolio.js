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
  markDirty
} from '../db'
import {
  computeAll,
  monthlyRealized,
  yearlyRealized,
  yearlyStockDetail,
  cumulativeRealized,
  netValueSeries,
  dailyRealized,
  drawdown
} from '../services/calc'
import { fetchQuotes, fetchRates } from '../services/quotes'
import { rateOf } from '../utils/format'
import { DEFAULT_BROKER } from '../constants'
import { useSettingsStore } from './settings'

export const usePortfolioStore = defineStore('portfolio', {
  state: () => ({
    ready: false,
    trades: [],
    cashFlows: [],
    stocks: [],
    brokers: [],
    positions: [],
    realizedEvents: [],
    monthly: [],
    yearly: [],
    yearlyDetail: [],
    cumulative: [],
    netValue: [],
    dailyPnl: [],
    drawdownStats: null,
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
      this.ready = true
      this.refreshQuotes()
    },

    async loadData() {
      this.trades = all('SELECT * FROM trades ORDER BY date, id')
      this.cashFlows = all('SELECT * FROM cash_flows ORDER BY date, id')
      this.syncStocks()
      this.brokers = getBrokers().map((b) => b.name)
      if (!this.brokers.includes(DEFAULT_BROKER)) this.brokers.unshift(DEFAULT_BROKER)
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
          run('INSERT INTO stocks (market, code, name, broker) VALUES (?,?,?,?)', [t.market, t.code, t.name || '', t.broker || DEFAULT_BROKER])
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
      const r = computeAll(this.trades, this.cashFlows)
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
          broker: st && st.broker ? st.broker : DEFAULT_BROKER,
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

      const currentPrices = {}
      for (const p of positions) currentPrices[p.market + ':' + p.code] = p.price
      const today = new Date().toISOString().slice(0, 10)
      this.netValue = netValueSeries(this.trades, this.cashFlows, currentPrices, rates, today)
      this.dailyPnl = dailyRealized(r.realizedEvents)
      this.drawdownStats = drawdown(this.netValue)

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
    },

    // 记一笔：写入交易，并同步股票主数据（含标签、所属券商）
    async addTrade(t) {
      const broker = t.broker || DEFAULT_BROKER
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
    },

    // 编辑交易记录
    async updateTrade(id, t) {
      const broker = t.broker || DEFAULT_BROKER
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
    },

    async deleteTrade(id) {
      run('DELETE FROM trades WHERE id = ?', [id])
      await this.loadData()
      markDirty()
      await persist()
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
          broker || DEFAULT_BROKER
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
      const broker = patch.broker ?? exist?.broker ?? DEFAULT_BROKER
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
    },

    async addCashFlow(c) {
      run('INSERT INTO cash_flows (date, type, amount, note, broker) VALUES (?,?,?,?,?)', [
        c.date,
        c.type,
        c.amount,
        c.note || '',
        c.broker || DEFAULT_BROKER
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
    },

    async clearAll() {
      run('DELETE FROM trades')
      run('DELETE FROM cash_flows')
      run('DELETE FROM stocks')
      await this.loadData()
      markDirty()
      await persist()
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
      dbRenameBroker(oldName, n)
      await this.loadData()
      markDirty()
      await persist()
    },

    async deleteBroker(name) {
      dbDeleteBroker(name)
      await this.loadData()
      markDirty()
      await persist()
    }
  }
})
