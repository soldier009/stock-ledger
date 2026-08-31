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
 * 净资产曲线：从最早交易/资金日期到今天，逐日按当前行情估算
 * 注：因缺少历史行情，历史市值使用最新行情近似，主要用于观察资产规模变化
 */
export function netValueSeries(trades, cashFlows, currentPrices, rates, currentDate) {
  const allDates = new Set([currentDate])
  for (const t of trades || []) allDates.add(t.date)
  for (const c of cashFlows || []) allDates.add(c.date)
  const sortedDates = [...allDates].sort()

  const posMap = new Map()
  let cash = 0
  const points = []

  const ensurePos = (market, code) => {
    const key = `${market}:${code}`
    if (!posMap.has(key)) {
      posMap.set(key, { market, code, shares: 0, basis: 0, avgCost: 0 })
    }
    return posMap.get(key)
  }

  for (const date of sortedDates) {
    const dayTrades = (trades || [])
      .filter((t) => t.date === date)
      .sort((a, b) => (a.id || 0) - (b.id || 0))
    for (const t of dayTrades) {
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
        const key = `${t.market}:${t.code}`
        const p = posMap.get(key)
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

    const dayCash = (cashFlows || [])
      .filter((c) => c.date === date)
      .sort((a, b) => (a.id || 0) - (b.id || 0))
    for (const c of dayCash) {
      const amt = Number(c.amount) || 0
      if (c.type === 'deposit') cash += amt
      else cash -= amt
    }

    let mv = 0
    for (const p of posMap.values()) {
      if (p.shares > 0) {
        const price = currentPrices[`${p.market}:${p.code}`] || 0
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
