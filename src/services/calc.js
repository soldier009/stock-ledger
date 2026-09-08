import { rateOf } from '../utils/format'
import { DEFAULT_BROKER } from '../constants'
import dayjs from 'dayjs'

/**
 * 核心计算引擎：按时间顺序重放交易记录
 * 成本核算方式：移动加权平均
 * 现金按券商分账：每笔交易/资金流水归属于其所在券商账户
 */
export function computeAll(trades, cashFlows, defaultBroker = DEFAULT_BROKER) {
  const posMap = new Map()
  const realizedEvents = []
  const brokerCash = new Map()
  let totalRealized = 0

  const addCash = (broker, amt) => {
    const b = broker || defaultBroker
    brokerCash.set(b, (brokerCash.get(b) || 0) + amt)
  }

  const sorted = [...(trades || [])].sort((a, b) =>
    a.date === b.date ? (a.id || 0) - (b.id || 0) : a.date.localeCompare(b.date)
  )

  const keyOf = (t) => t.market + ':' + t.code

  const ensurePos = (t) => {
    const key = keyOf(t)
    let p = posMap.get(key)
    if (!p) {
      p = { market: t.market, code: t.code, name: t.name || '', shares: 0, basis: 0, avgCost: 0 }
      posMap.set(key, p)
    }
    if (t.name && !p.name) p.name = t.name
    return p
  }

  for (const t of sorted) {
    const fee = Number(t.fee) || 0
    const tax = Number(t.tax) || 0
    const type = t.type

    if (type === 'buy' || type === 'rights') {
      const p = ensurePos(t)
      const cost = Number(t.price) * Number(t.shares) + fee + tax
      p.basis += cost
      p.shares += Number(t.shares)
      p.avgCost = p.shares > 0 ? p.basis / p.shares : 0
      addCash(t.broker, -cost)
    } else if (type === 'sell') {
      const p = posMap.get(keyOf(t))
      if (p && p.shares > 0) {
        const qty = Math.min(Number(t.shares), p.shares)
        const realized = (Number(t.price) - p.avgCost) * qty - fee - tax
        totalRealized += realized
        realizedEvents.push({
          id: t.id,
          date: t.date,
          market: t.market,
          code: t.code,
          name: p.name || t.name,
          type: 'sell',
          amount: realized
        })
        p.basis -= p.avgCost * qty
        p.shares -= qty
        p.avgCost = p.shares > 0 ? p.basis / p.shares : 0
        addCash(t.broker, Number(t.price) * qty - fee - tax)
      }
    } else if (type === 'div') {
      const amt = Number(t.amount) || 0
      if (amt !== 0) {
        totalRealized += amt
        realizedEvents.push({
          id: t.id,
          date: t.date,
          market: t.market,
          code: t.code,
          name: t.name || '',
          type: 'div',
          amount: amt
        })
        addCash(t.broker, amt)
      }
    } else if (type === 'gift') {
      const p = ensurePos(t)
      p.shares += Number(t.shares)
      p.avgCost = p.shares > 0 ? p.basis / p.shares : 0
    }
  }

  let principal = 0
  for (const c of cashFlows || []) {
    const amt = Number(c.amount) || 0
    if (c.type === 'deposit') {
      principal += amt
      addCash(c.broker, amt)
    } else if (c.type === 'withdraw') {
      principal -= amt
      addCash(c.broker, -amt)
    }
  }

  const positions = [...posMap.values()]
    .filter((p) => p.shares > 0.000001)
    .map((p) => ({ ...p }))
    .sort((a, b) => (a.market + a.code).localeCompare(b.market + b.code))

  const cash = [...brokerCash.values()].reduce((a, b) => a + b, 0)
  return { positions, cash, brokerCash: Object.fromEntries(brokerCash), principal, totalRealized, realizedEvents }
}

/** 按月份聚合已实现盈亏 */
export function monthlyRealized(realizedEvents) {
  const map = new Map()
  for (const e of realizedEvents) {
    const key = e.date.slice(0, 7)
    if (!map.has(key)) map.set(key, { month: key, realized: 0, div: 0, count: 0 })
    const m = map.get(key)
    m.realized += e.amount
    if (e.type === 'div') m.div += e.amount
    m.count += 1
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month))
}

/** 按年度聚合已实现盈亏 */
export function yearlyRealized(realizedEvents) {
  const map = new Map()
  for (const e of realizedEvents) {
    const key = e.date.slice(0, 4)
    if (!map.has(key)) map.set(key, { year: key, realized: 0, div: 0, count: 0 })
    const m = map.get(key)
    m.realized += e.amount
    if (e.type === 'div') m.div += e.amount
    m.count += 1
  }
  return [...map.values()].sort((a, b) => a.year.localeCompare(b.year))
}

/** 年度 x 个股明细 */
export function yearlyStockDetail(realizedEvents) {
  const map = new Map()
  for (const e of realizedEvents) {
    const key = e.date.slice(0, 4) + '|' + e.market + ':' + e.code
    if (!map.has(key)) map.set(key, { year: e.date.slice(0, 4), market: e.market, code: e.code, name: e.name || '', realized: 0, div: 0 })
    const m = map.get(key)
    m.realized += e.amount
    if (e.type === 'div') m.div += e.amount
  }
  return [...map.values()].sort((a, b) => (a.year + a.code).localeCompare(b.year + b.code))
}

/** 累计已实现盈亏曲线（按日期） */
export function cumulativeRealized(realizedEvents) {
  const sorted = [...realizedEvents].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date.localeCompare(b.date)))
  const points = []
  let acc = 0
  for (const e of sorted) {
    acc += e.amount
    points.push({ date: e.date, value: acc })
  }
  return points
}

/**
 * 净资产曲线：逐交易日按真实收盘价估值
 * 口径：某日净资产 = 当日收盘后现金 + Σ 持仓股数 × 当日收盘价(前复权) × 汇率。
 * - 时间轴：持有期间的每个交易日（来自日K缓存）+ 全部交易/资金事件日 + 今天；
 *   卖出清仓后的空闲日不打点，避免出现大片水平线段。
 * - 行情：优先使用当日真实收盘价；无当日K线（休市/停牌/缓存缺失）沿用最近收盘；
 *   缓存尚未覆盖或整只股票无K线时回退到现价/成本价近似，尽量不出现异常塌陷。
 * - 汇率暂用当前设定值（无历史汇率），跨市场时存在小幅近似。
 * @param {Array} trades 全部交易记录
 * @param {Array} cashFlows 资金流水
 * @param {Object} currentPrices 最新价 { 'A:600000': 12.34 }（仅用于今天/兜底）
 * @param {Object} rates 汇率 { usd, hkd }
 * @param {String} currentDate 今日 YYYY-MM-DD
 * @param {Object} klines 行情缓存 { 'A:600000': { days: [[date, close], ...] } }，days 升序
 * @returns {Array} [{ date, netValue, cash, marketValue }] 按日期升序
 */
export function netValueSeries(trades, cashFlows, currentPrices, rates, currentDate, klines) {
  // 按市场:代码分组交易并排序
  const symTrades = new Map()
  for (const t of trades || []) {
    const key = t.market + ':' + t.code
    if (!symTrades.has(key)) symTrades.set(key, [])
    symTrades.get(key).push(t)
  }
  for (const list of symTrades.values()) {
    list.sort((a, b) => (a.date === b.date ? (a.id || 0) - (b.id || 0) : a.date.localeCompare(b.date)))
  }

  // 归一化日K（升序 [[date, close], ...]）
  const barsByKey = new Map()
  if (klines && typeof klines === 'object') {
    for (const [key, meta] of Object.entries(klines)) {
      if (meta && Array.isArray(meta.days) && meta.days.length) {
        barsByKey.set(
          key,
          [...meta.days]
            .filter((x) => x && x[0])
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        )
      }
    }
  }

  // 收集"持仓期间"的每个交易日：该股票当日收盘后仍有持仓的K线日才打点
  const heldDays = new Set()
  for (const [key, tlist] of symTrades) {
    const bars = barsByKey.get(key)
    if (!bars) continue
    let shares = 0
    let ptr = 0
    for (const [d] of bars) {
      while (ptr < tlist.length && tlist[ptr].date <= d) {
        const t = tlist[ptr]
        if (t.type === 'buy' || t.type === 'rights' || t.type === 'gift') shares += Number(t.shares) || 0
        else if (t.type === 'sell') shares = Math.max(0, shares - (Number(t.shares) || 0))
        ptr++
      }
      if (shares > 1e-6) heldDays.add(d)
    }
  }

  // 时间轴：全部事件日 + 持仓交易日 + 今天
  const timeline = new Set([currentDate])
  for (const t of trades || []) timeline.add(t.date)
  for (const c of cashFlows || []) timeline.add(c.date)
  for (const d of heldDays) timeline.add(d)
  const sortedDates = [...timeline].sort()

  const posMap = new Map()
  let cash = 0

  const ensurePos = (market, code) => {
    const key = `${market}:${code}`
    if (!posMap.has(key)) {
      posMap.set(key, { market, code, shares: 0, basis: 0, avgCost: 0 })
    }
    return posMap.get(key)
  }

  const processTrade = (t) => {
    const fee = Number(t.fee) || 0
    const tax = Number(t.tax) || 0
    const type = t.type
    if (type === 'buy' || type === 'rights') {
      const p = ensurePos(t.market, t.code)
      const cost = Number(t.price) * Number(t.shares) + fee + tax
      p.basis += cost
      p.shares += Number(t.shares)
      p.avgCost = p.shares > 0 ? p.basis / p.shares : 0
      cash -= cost
    } else if (type === 'sell') {
      const p = posMap.get(`${t.market}:${t.code}`)
      if (p && p.shares > 0) {
        const qty = Math.min(Number(t.shares), p.shares)
        p.basis -= p.avgCost * qty
        p.shares -= qty
        p.avgCost = p.shares > 0 ? p.basis / p.shares : 0
        cash += Number(t.price) * qty - fee - tax
      }
    } else if (type === 'div') {
      const amt = Number(t.amount) || 0
      cash += amt
    } else if (type === 'gift') {
      const p = ensurePos(t.market, t.code)
      p.shares += Number(t.shares)
      p.avgCost = p.shares > 0 ? p.basis / p.shares : 0
    }
  }

  // 逐 key 的"截至某日最近收盘价"滚动指针
  const priceState = new Map()
  const priceOf = (key, date, pos) => {
    let st = priceState.get(key)
    if (!st) {
      const bars = barsByKey.get(key) || []
      st = { bars, ptr: 0, last: 0 }
      priceState.set(key, st)
    }
    while (st.ptr < st.bars.length && st.bars[st.ptr][0] <= date) {
      st.last = Number(st.bars[st.ptr][1])
      st.ptr++
    }
    const live = currentPrices ? currentPrices[key] : undefined
    if (date === currentDate && live && live > 0) return live // 今天的点用最新价
    if (st.last > 0) return st.last
    if (live && live > 0) return live
    return pos ? pos.avgCost || 0 : 0 // 无行情时以成本价兜底，避免异常塌陷
  }

  const allTrades = [...(trades || [])].sort((a, b) =>
    a.date === b.date ? (a.id || 0) - (b.id || 0) : a.date.localeCompare(b.date)
  )
  const allCash = [...(cashFlows || [])].sort((a, b) =>
    a.date === b.date ? (a.id || 0) - (b.id || 0) : a.date.localeCompare(b.date)
  )
  let ti = 0
  let ci = 0
  const points = []

  for (const date of sortedDates) {
    while (ti < allTrades.length && allTrades[ti].date <= date) {
      if (allTrades[ti].date === date) processTrade(allTrades[ti])
      ti++
    }
    while (ci < allCash.length && allCash[ci].date <= date) {
      if (allCash[ci].date === date) {
        const amt = Number(allCash[ci].amount) || 0
        if (allCash[ci].type === 'deposit') cash += amt
        else cash -= amt
      }
      ci++
    }

    let mv = 0
    for (const p of posMap.values()) {
      if (p.shares > 1e-6) {
        const price = priceOf(`${p.market}:${p.code}`, date, p)
        mv += p.shares * price * rateOf(p.market, rates)
      }
    }
    points.push({ date, netValue: cash + mv, cash, marketValue: mv })
  }
  return points
}

/** 按日汇总已实现盈亏（用于盈亏日历） */
export function dailyRealized(realizedEvents) {
  const map = new Map()
  for (const e of realizedEvents) {
    if (!map.has(e.date)) {
      map.set(e.date, { date: e.date, amount: 0, events: [] })
    }
    const d = map.get(e.date)
    d.amount += e.amount
    d.events.push(e)
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 逐日持仓盈亏（用于「当日持仓盈亏日历」）
 * 口径：某交易日持仓市值相对前一交易日收盘的变动（已实现落袋部分归买卖日历，不重复计入）
 *   dayAmount = Σ (当日收盘 - 前收盘) × 当日盘前持股数 × 汇率
 *   dayBase   = Σ 前收盘 × 当日盘前持股数 × 汇率（作为当日涨跌幅的基准市值）
 * 说明：分红/送股等除权日前后因复权价与真实股数组合，可能存在小幅估算偏差。
 * @param {Array} trades 全部交易记录
 * @param {Object} klines 行情缓存 { 'A:600000': { days: [[date, close], ...] } }，days 升序
 * @param {Object} rates 汇率 { usd, hkd }
 * @returns {Array} [{ date, amount, base }] 按日期升序，金额单位 CNY
 */
export function dailyHoldingPnl(trades, klines, rates) {
  // 按市场:代码分组交易
  const bySym = new Map()
  for (const t of trades || []) {
    const key = t.market + ':' + t.code
    if (!bySym.has(key)) bySym.set(key, [])
    bySym.get(key).push(t)
  }
  for (const list of bySym.values()) {
    list.sort((a, b) => (a.date === b.date ? (a.id || 0) - (b.id || 0) : a.date.localeCompare(b.date)))
  }

  const applyTrade = (t, shares) => {
    if (t.type === 'buy' || t.type === 'rights' || t.type === 'gift') return shares + (Number(t.shares) || 0)
    if (t.type === 'sell') return Math.max(0, shares - (Number(t.shares) || 0))
    return shares
  }

  // date -> { amount, base }
  const acc = new Map()

  for (const [sym, list] of bySym) {
    const kl = klines[sym]
    if (!kl || !Array.isArray(kl.days) || kl.days.length < 2) continue
    const rate = rateOf(sym.split(':')[0], rates)
    let shares = 0
    let ptr = 0
    for (let i = 0; i < kl.days.length; i++) {
      const d = kl.days[i][0]
      const c = Number(kl.days[i][1])
      while (ptr < list.length && list[ptr].date < d) {
        shares = applyTrade(list[ptr], shares)
        ptr++
      }
      if (i > 0 && shares > 0) {
        const pc = Number(kl.days[i - 1][1])
        if (c > 0 && pc > 0) {
          const e = acc.get(d) || { amount: 0, base: 0 }
          e.amount += (c - pc) * shares * rate
          e.base += pc * shares * rate
          acc.set(d, e)
        }
      }
      while (ptr < list.length && list[ptr].date === d) {
        shares = applyTrade(list[ptr], shares)
        ptr++
      }
    }
  }

  return [...acc.entries()]
    .map(([date, v]) => ({ date, amount: v.amount, base: v.base }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 指定某一天的持仓盈亏按股明细（口径与 dailyHoldingPnl 完全一致）：
 *   每股 = (当日收盘 − 前收盘) × 当日盘前持股数 × 汇率
 * 仅返回该日盘前有持仓、且前后两个交易日收盘价都在行情缓存中的股票，
 * 各行金额合计恰好等于 dailyHoldingPnl 中该日 amount。
 * @returns {Array} [{ market, code, name, shares, prevClose, close, changePct, amount }]
 */
export function holdingDayDetail(trades, klines, rates, date) {
  const bySym = new Map()
  for (const t of trades || []) {
    const key = t.market + ':' + t.code
    if (!bySym.has(key)) bySym.set(key, [])
    bySym.get(key).push(t)
  }
  for (const list of bySym.values()) {
    list.sort((a, b) => (a.date === b.date ? (a.id || 0) - (b.id || 0) : a.date.localeCompare(b.date)))
  }
  const applyTrade = (t, shares) => {
    if (t.type === 'buy' || t.type === 'rights' || t.type === 'gift') return shares + (Number(t.shares) || 0)
    if (t.type === 'sell') return Math.max(0, shares - (Number(t.shares) || 0))
    return shares
  }

  const out = []
  for (const [sym, list] of bySym) {
    const kl = klines[sym]
    if (!kl || !Array.isArray(kl.days) || kl.days.length < 2) continue
    const days = kl.days
    let i = -1
    for (let k = 0; k < days.length; k++) {
      if (days[k][0] === date) {
        i = k
        break
      }
    }
    if (i < 1) continue
    const close = Number(days[i][1])
    const prevClose = Number(days[i - 1][1])
    if (!(close > 0) || !(prevClose > 0)) continue
    // 盘前持仓 = 该日之前全部交易累计
    let shares = 0
    for (const t of list) {
      if (t.date >= date) break
      shares = applyTrade(t, shares)
    }
    if (shares <= 0) continue
    const [market, code] = sym.split(':')
    const first = list.find((t) => t.name)
    const rate = rateOf(market, rates)
    out.push({
      market,
      code,
      name: (first && first.name) || code,
      shares,
      prevClose,
      close,
      changePct: (close / prevClose - 1) * 100,
      amount: (close - prevClose) * shares * rate
    })
  }
  return out
}

/**
 * 回撤分析
 * 返回：最大回撤百分比、峰值/谷底日期、下跌历时、
 * 是否已修复、修复日期/修复历时、当前回撤
 */
export function drawdown(series) {
  if (!series || series.length < 2) {
    return {
      maxDrawdownPct: 0,
      peakDate: null,
      troughDate: null,
      days: 0,
      recovered: true,
      recoveryDate: null,
      recoveryDays: 0,
      currentDrawdownPct: 0
    }
  }
  let peak = series[0].netValue
  let peakDate = series[0].date
  let maxDD = 0
  let maxPeakDate = peakDate
  let maxPeakValue = peak
  let maxTroughDate = peakDate

  for (const p of series) {
    if (p.netValue >= peak) {
      peak = p.netValue
      peakDate = p.date
    } else {
      const dd = peak > 0 ? (p.netValue - peak) / peak : 0
      if (dd < maxDD) {
        maxDD = dd
        maxPeakDate = peakDate
        maxPeakValue = peak
        maxTroughDate = p.date
      }
    }
  }

  const days = dayjs(maxTroughDate).diff(dayjs(maxPeakDate), 'day')

  // 最大回撤修复：谷底之后第一个净值回到峰值(maxPeakValue)的日期
  let recoveryDate = null
  let recoveryDays = 0
  const troughIdx = series.findIndex((p) => p.date === maxTroughDate)
  for (let i = troughIdx + 1; i < series.length; i++) {
    if (series[i].netValue >= maxPeakValue) {
      recoveryDate = series[i].date
      recoveryDays = dayjs(recoveryDate).diff(dayjs(maxTroughDate), 'day')
      break
    }
  }
  const recovered = recoveryDate !== null

  // 当前回撤：最新净值相对最近峰值
  let currentPeak = series[0].netValue
  for (const p of series) {
    if (p.netValue > currentPeak) currentPeak = p.netValue
  }
  const last = series[series.length - 1]
  const currentDrawdownPct = currentPeak > 0 ? ((last.netValue - currentPeak) / currentPeak) * 100 : 0

  return {
    maxDrawdownPct: maxDD * 100,
    peakDate: maxPeakDate,
    troughDate: maxTroughDate,
    days,
    recovered,
    recoveryDate,
    recoveryDays,
    currentDrawdownPct
  }
}
