import { UNTAGGED, dimKeyOf, matchDim } from './composition'

/**
 * 成本与盈亏的通用口径：
 *   成本     = avgCost × 股数 × 汇率（与资产页一致，人民币）
 *   市值     = mvCny（实时行情，缺行情时回退成本价）
 *   浮动盈亏 = pnlCny = 市值 − 成本
 *   已实现盈亏 = 该标的历次卖出 + 分红（含已清仓的历史）
 *   合计盈亏  = 浮动盈亏 + 已实现盈亏
 *   收益率   = 浮动盈亏 ÷ 成本（持仓口径，与个股详情一致）
 *   占总投资 = 成本 ÷ 总成本
 *
 * 注意：已实现盈亏事件里的金额是交易原币金额（与全局「已实现盈亏」同源，未折算汇率）。
 */

/** 单条持仓的成本（人民币） */
export function costOf(p) {
  return (Number(p.avgCost) || 0) * (Number(p.shares) || 0) * (Number(p.rate) || 1)
}

/** 持仓的浮动盈亏（人民币），与 store 的 pnlCny 一致，缺字段时现算 */
export function floatingOf(p) {
  if (p.pnlCny !== undefined && p.pnlCny !== null) return Number(p.pnlCny) || 0
  return (Number(p.mvCny) || 0) - costOf(p)
}

const keyOfRow = (market, code) => market + ':' + code

/**
 * 把「当前持仓」和「已清仓标的」合并成一行一行的盈亏明细。
 * 已清仓标的没有持仓记录，用已实现盈亏事件反查（事件上已带标签/用途），
 * 成本取该标的各轮清仓的累计买入额，市值与浮动盈亏为 0。
 */
export function buildPnlRows(positions = [], realizedEvents = [], closedRounds = []) {
  const map = new Map()

  const ensure = (market, code, name) => {
    const key = keyOfRow(market, code)
    let row = map.get(key)
    if (!row) {
      row = {
        key,
        market,
        code,
        name: name || code,
        cost: 0,
        mv: 0,
        floating: 0,
        realized: 0,
        // 今日盈亏（人民币）：只有当前持仓且有昨收才有值，hasToday 用来区分「无行情」与「今日 0」
        today: 0,
        todayBase: 0,
        hasToday: false,
        closed: true, // 有持仓时置 false
        tag: '[]',
        purpose: '',
        roundCost: 0
      }
      map.set(key, row)
    }
    if (name && (!row.name || row.name === row.code)) row.name = name
    return row
  }

  for (const p of positions) {
    const row = ensure(p.market, p.code, p.name || p.code)
    row.closed = false
    row.cost = costOf(p)
    row.mv = Number(p.mvCny) || 0
    row.floating = floatingOf(p)
    row.today = Number(p.dayCny) || 0
    row.todayBase = Number(p.dayBaseCny) || 0
    row.hasToday = p.dayCny !== null && p.dayCny !== undefined
    row.tag = p.tag || '[]'
    row.purpose = String(p.purpose || '')
    row.pos = p
  }

  for (const e of realizedEvents) {
    const row = ensure(e.market, e.code, e.name)
    row.realized += Number(e.amount) || 0
    // 已清仓标的：标签/用途只能从事件上取（事件已打过标的的标签快照）
    if (row.closed) {
      if (!row.tag || row.tag === '[]') row.tag = e.tag || '[]'
      if (!row.purpose) row.purpose = String(e.purpose || '')
    }
  }

  // 已清仓标的的成本：各轮清仓的累计买入额
  for (const r of closedRounds) {
    const row = ensure(r.market, r.code, r.name)
    if (row.closed) row.roundCost += Number(r.buyAmount) || 0
  }
  for (const row of map.values()) {
    if (row.closed) row.cost = row.roundCost
  }

  const rows = [...map.values()].map((r) => ({
    ...r,
    totalPnl: r.floating + r.realized,
    returnPct: r.cost > 0 ? (r.floating / r.cost) * 100 : null,
    realizedPct: r.cost > 0 ? (r.realized / r.cost) * 100 : null,
    // 今日涨跌幅 = 今日盈亏 ÷ 昨收市值
    todayPct: r.hasToday && r.todayBase > 0 ? (r.today / r.todayBase) * 100 : null
  }))
  rows.sort((a, b) => b.cost - a.cost || b.totalPnl - a.totalPnl)
  return rows
}

/** 若干行的合计 */
export function sumRows(rows = []) {
  const s = {
    cost: 0,
    mv: 0,
    floating: 0,
    realized: 0,
    totalPnl: 0,
    today: 0,
    todayBase: 0,
    count: rows.length,
    closedCount: 0
  }
  let todayCount = 0
  for (const r of rows) {
    s.cost += Number(r.cost) || 0
    s.mv += Number(r.mv) || 0
    s.floating += Number(r.floating) || 0
    s.realized += Number(r.realized) || 0
    s.totalPnl += Number(r.totalPnl) || 0
    s.today += Number(r.today) || 0
    s.todayBase += Number(r.todayBase) || 0
    if (r.hasToday) todayCount += 1
    if (r.closed) s.closedCount += 1
  }
  // 一只都没拿到行情时置 false：界面显示「—」而不是 0，避免与「今日持平」混淆
  s.hasToday = todayCount > 0
  s.returnPct = s.cost > 0 ? (s.floating / s.cost) * 100 : null
  s.realizedPct = s.cost > 0 ? (s.realized / s.cost) * 100 : null
  s.totalPnlPct = s.cost > 0 ? (s.totalPnl / s.cost) * 100 : null
  s.todayPct = s.hasToday && s.todayBase > 0 ? (s.today / s.todayBase) * 100 : null
  return s
}

/** 按维度分组（金额口径 = 成本，占总投资也按成本） */
export function groupRows(rows, dim, { includeUntagged = false } = {}) {
  const map = {}
  for (const r of rows) {
    const raw = dimKeyOf(r, dim)
    const key = raw || UNTAGGED
    if (!raw && !includeUntagged) continue
    const g = map[key] || (map[key] = { key, name: key, count: 0, items: [] })
    g.count += 1
    g.items.push(r)
  }
  return Object.values(map)
    .map((g) => ({ ...g, ...sumRows(g.items) }))
    .sort((a, b) => b.cost - a.cost)
}

/** 未设置该维度的行合计 */
export function untaggedRows(rows, dim) {
  const list = rows.filter((r) => !dimKeyOf(r, dim))
  return { ...sumRows(list), count: list.length }
}

/**
 * 是否存在港美股的已实现盈亏：
 * 这类金额是交易原币（未折人民币），界面上加一句说明避免误读
 */
export function hasForeignRealized(rows = []) {
  return rows.some((r) => r.market && r.market !== 'A' && (Number(r.realized) || 0) !== 0)
}

export { matchDim }
