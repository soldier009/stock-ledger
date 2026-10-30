import { rateOf } from '../utils/format'
import { DEFAULT_BROKER } from '../constants'
import { byDateAsc } from '../utils/sort'
import dayjs from 'dayjs'

/** 无标签持仓在「按标签」分组里的归组键 */
export const NO_TAG = '未分类'

/**
 * 金额/数量兜底：脏数据（缺字段、undefined、空串）会算出 NaN，
 * 而 NaN 会顺着「成本 → 持仓盈亏 → 市值 → 曲线」一路污染下去且不报错。
 * 涉及金额与股数的乘法统一走这里。
 */
const n = (v) => Number(v) || 0

/**
 * 买入类交易：普通买入 / 配股 / **中签**。
 * 三者本质一样 —— 都是「按某个价格付钱拿到股份」，所以统一走「扣现金 + 计入持仓成本」这条路径。
 * 中签尤其不能按「送股」处理：它虽然自动到账，但申购时冻结的资金是真的被扣了，
 * 记为不扣钱的送股会让现金虚高、持仓成本归零，收益率跟着失真。
 */
const isBuyType = (t) => t === 'buy' || t === 'rights' || t === 'win'

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

    const price = n(t.price)
    if (isBuyType(type)) {
      const p = ensurePos(t)
      const cost = price * n(t.shares) + fee + tax
      p.basis += cost
      p.shares += n(t.shares)
      p.avgCost = p.shares > 0 ? p.basis / p.shares : 0
      // no_cash：钱不是从这个券商的账户出的（用别的账户付 / 暂时只记录持仓）。
      // 成本照常计入，但不动那个账户的现金 —— 净资产会因此偏高，界面上必须标出来
      if (!t.no_cash) addCash(t.broker, -cost)
    } else if (type === 'sell') {
      const p = posMap.get(keyOf(t))
      const want = n(t.shares)
      const held = p ? p.shares : 0
      const qty = Math.min(want, held)
      if (qty > 0) {
        const realized = (price - p.avgCost) * qty - fee - tax
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
        addCash(t.broker, price * qty - fee - tax)
      }
      // 卖出数量超过持仓（早期买入记录缺失 / 导入数据有出入）：多出的部分没有
      // 成本可结转，不能算已实现盈亏，但钱确实到账了 —— 计入现金，
      // 否则这笔资金会凭空消失（手续费已在上面整笔扣除，这里不再重复扣）。
      const extra = want - qty
      if (extra > 0) addCash(t.broker, price * extra)
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
      p.shares += n(t.shares)
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

/**
 * 累计已实现盈亏曲线（按日）
 * 同一天的多笔卖出合并成一个点：否则x轴会出现重复日期，
 * 且曲线会在同一天叠出多余台阶（看起来像每笔各画了一段）。
 * @returns [{ date, value(累计), dayAmount(当日合计), count(当日笔数) }]
 */
export function cumulativeRealized(realizedEvents) {
  const byDay = new Map()
  for (const e of realizedEvents || []) {
    if (!e || !e.date) continue
    const cur = byDay.get(e.date) || { amount: 0, count: 0 }
    cur.amount += Number(e.amount) || 0
    cur.count += 1
    byDay.set(e.date, cur)
  }
  const points = []
  let acc = 0
  for (const [date, d] of [...byDay.entries()].sort(byDateAsc)) {
    acc += d.amount
    points.push({ date, value: acc, dayAmount: d.amount, count: d.count })
  }
  return points
}

function daysBetween(start, end) {
  if (!start) return 0
  const a = new Date(start + 'T00:00:00')
  const b = end ? new Date(end + 'T00:00:00') : new Date()
  const d = Math.round((b - a) / 86400000)
  return d > 0 ? d : 0
}

/**
 * 已清仓记录：按「持仓批次（round trip）」切分
 * - 同一只股票：首次买入 → 清仓 = 一批次；清仓后再买入 = 开启新批次，所以每轮清仓各有一条记录
 *   （若按「当前是否无持仓」判断，清仓后又买入的股票会查不到，历史那轮就丢了）
 * - 成本核算与 computeAll 一致：移动加权平均
 * - 分红计入所属批次；清仓后才到账的分红归入最近结束的批次，不丢失
 * - 收益率 = 已实现盈亏（含分红）÷ 该批次累计买入成本（含费用）
 * @param {Array} trades 全部交易记录
 * @returns {{ rounds: Array, stocks: Array, stat: Object }}
 */
export function buildClosedRounds(trades) {
  const sorted = [...(trades || [])].sort((a, b) =>
    String(a.date) === String(b.date)
      ? (Number(a.id) || 0) - (Number(b.id) || 0)
      : String(a.date).localeCompare(String(b.date))
  )
  const byKey = new Map()
  const all = []
  const EPS = 1e-6

  const stateOf = (t) => {
    const key = t.market + ':' + t.code
    let s = byKey.get(key)
    if (!s) {
      s = { key, market: t.market, code: t.code, name: t.name || '', open: null, lastClosed: null, closed: [] }
      byKey.set(key, s)
    }
    if (t.name && !s.name) s.name = t.name
    return s
  }

  const newRound = (s, t) => {
    const r = {
      key: s.key,
      market: s.market,
      code: s.code,
      name: t.name || s.name || s.code,
      index: s.closed.length + 1,
      total: 0,
      start: t.date,
      end: '',
      shares: 0,
      basis: 0,
      avgCost: 0,
      buyAmount: 0,
      sellAmount: 0,
      realized: 0,
      div: 0,
      tradeCount: 0,
      trades: []
    }
    s.open = r
    all.push(r)
    return r
  }

  for (const t of sorted) {
    const type = t.type
    if (isBuyType(type) || type === 'gift') {
      const s = stateOf(t)
      const r = s.open || newRound(s, t)
      if (t.name && !r.name) r.name = t.name
      const qty = n(t.shares)
      const fee = Number(t.fee) || 0
      const tax = Number(t.tax) || 0
      // 送股只增加股数、不增加成本（与 computeAll 的 gift 分支一致）
      const cost = type === 'gift' ? fee + tax : n(t.price) * qty + fee + tax
      r.shares += qty
      r.basis += cost
      r.avgCost = r.shares > EPS ? r.basis / r.shares : 0
      r.buyAmount += cost
      r.tradeCount += 1
      r.trades.push({ ...t, qty, cost, realized: null })
    } else if (type === 'sell') {
      const s = stateOf(t)
      const r = s.open
      // 卖出数量超过本轮剩余持仓（缺早期买入记录）：超出部分无成本可结转，
      // 分批明细只按实际配对的部分展示（现金口径见 computeAll，已单独计入）
      if (!r || r.shares <= EPS) continue
      const qty = Math.min(n(t.shares), r.shares)
      const fee = Number(t.fee) || 0
      const tax = Number(t.tax) || 0
      const realized = (n(t.price) - r.avgCost) * qty - fee - tax
      const proceeds = n(t.price) * qty - fee - tax
      r.basis -= r.avgCost * qty
      r.shares -= qty
      r.avgCost = r.shares > EPS ? r.basis / r.shares : 0
      r.sellAmount += proceeds
      r.realized += realized
      r.tradeCount += 1
      r.trades.push({ ...t, qty, realized, proceeds })
      if (r.shares <= EPS) {
        r.shares = 0
        r.end = t.date
        s.open = null
        s.lastClosed = r
        s.closed.push(r)
      }
    } else if (type === 'div') {
      const s = stateOf(t)
      const amt = Number(t.amount) || 0
      if (!amt) continue
      const r = s.open || s.lastClosed
      if (!r) continue
      r.realized += amt
      r.div += amt
      r.tradeCount += 1
      r.trades.push({ ...t, qty: 0, realized: amt })
    }
  }

  const rounds = []
  const stocks = []
  for (const s of byKey.values()) {
    const total = s.closed.length + (s.open ? 1 : 0)
    for (const r of s.closed) {
      r.total = total
      r.pnlPct = r.buyAmount ? (r.realized / r.buyAmount) * 100 : 0
      r.days = daysBetween(r.start, r.end)
      rounds.push(r)
    }
    if (s.open) {
      s.open.total = total
      s.open.pnlPct = 0
      s.open.days = daysBetween(s.open.start, '')
    }
    if (s.closed.length || s.open) {
      stocks.push({
        key: s.key,
        market: s.market,
        code: s.code,
        name: s.name || s.code,
        total,
        closed: s.closed,
        holding: s.open || null
      })
    }
  }
  // 最近清仓的排在最前
  rounds.sort((a, b) => (a.end === b.end ? a.key.localeCompare(b.key) : a.end < b.end ? 1 : -1))
  const stat = {
    count: rounds.length,
    stockCount: new Set(rounds.map((r) => r.key)).size,
    realized: rounds.reduce((a, r) => a + r.realized, 0),
    win: rounds.filter((r) => r.realized > 0).length,
    loss: rounds.filter((r) => r.realized < 0).length
  }
  return { rounds, stocks, stat }
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
/**
 * 逐日资产重放（净资产曲线与资产曲线共用）
 * meta：标的元信息查询器 { tagOf, purposeOf }（store.buildMetaResolver() 的产物），
 *   传 null 时不拆分：按标签的结果全部落在 NO_TAG，不做按用途拆分。
 * 返回：{ date, cash, marketValue, byMarket, byTag, byPurpose, notes }
 */
function buildDailyAssets(trades, cashFlows, currentPrices, rates, currentDate, klines, meta, opts = {}) {
  const tagOf = meta && meta.tagOf
  const purposeOf = meta && meta.purposeOf
  // —— 补录历史持仓（初始建仓）并入净资产序列起点 ——
  // 「新建仓」录入的是本软件记账前就已持有的股票，其买入与自动入金都发生在补录当天；
  // 若仅从补录日开始计算，会在该日凭空产生“记账前浮盈亏”的台阶。
  // 这里把初始建仓的买入/自动入金视同发生在整个净资产序列最早一天：
  // 该持仓从曲线第一天起就存在，中途不再出现补录造成的跳变；
  // 其市值自起点起按当日真实收盘价估值（需要自起点起的日K，由 store 负责补拉）。
  // 普通入金/出金保持原发生日，在曲线上天然产生台阶（“有反应”）。
  const rawTrades = [...(trades || [])]
  const rawCash = [...(cashFlows || [])]
  let startDate = currentDate
  for (const t of rawTrades) if (t.date < startDate) startDate = t.date
  for (const c of rawCash) if (c.date < startDate) startDate = c.date
  const isInitialBuy = (t) => !!(t.origin === 'initial' && isBuyType(t.type))
  const wsTrades = rawTrades.map((t) =>
    isInitialBuy(t) && t.date > startDate ? { ...t, date: startDate } : t
  )
  const wsCash = rawCash.map((c) =>
    c.origin === 'initial' && c.type === 'deposit' && c.date > startDate ? { ...c, date: startDate } : c
  )

  // 按原始发生日记录资金事件注解（供走势图提示出入金 / 补录并入起点信息）
  const noteMap = new Map()
  const addNote = (date, note) => {
    if (!noteMap.has(date)) noteMap.set(date, [])
    noteMap.get(date).push(note)
  }
  for (const c of rawCash) {
    const amt = Number(c.amount) || 0
    if (amt <= 0) continue
    if (c.origin === 'initial' && c.type === 'deposit') {
      addNote(c.date, { kind: 'initial', label: '初始建仓并入起点（自动入金）', amount: amt })
    } else if (c.type === 'deposit') {
      addNote(c.date, { kind: 'flow', type: 'deposit', amount: amt })
    } else if (c.type === 'withdraw') {
      addNote(c.date, { kind: 'flow', type: 'withdraw', amount: amt })
    }
  }
  for (const t of rawTrades) {
    if (isInitialBuy(t)) {
      const cost = (Number(t.price) || 0) * (Number(t.shares) || 0)
      addNote(t.date, { kind: 'initialTrade', label: t.name || t.code, amount: cost })
    }
  }

  // 按市场:代码分组交易并排序
  const symTrades = new Map()
  for (const t of wsTrades) {
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
          [...meta.days].filter((x) => x && x[0]).sort(byDateAsc)
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
        if (isBuyType(t.type) || t.type === 'gift') shares += Number(t.shares) || 0
        else if (t.type === 'sell') shares = Math.max(0, shares - (Number(t.shares) || 0))
        ptr++
      }
      if (shares > 1e-6) heldDays.add(d)
    }
  }

  // 时间轴：全部事件日 + 持仓交易日 + 今天
  const timeline = new Set([currentDate])
  for (const t of wsTrades) timeline.add(t.date)
  for (const c of wsCash) timeline.add(c.date)
  for (const d of heldDays) timeline.add(d)
  const sortedDates = [...timeline].sort()

  const posMap = new Map()
  let cash = 0

  const ensurePos = (market, code) => {
    const key = `${market}:${code}`
    if (!posMap.has(key)) {
      posMap.set(key, {
        market,
        code,
        shares: 0,
        basis: 0,
        avgCost: 0,
        tag: tagOf ? tagOf(market, code) || '' : '',
        purpose: purposeOf ? purposeOf(market, code) || '' : ''
      })
    }
    return posMap.get(key)
  }

  const processTrade = (t) => {
    const fee = Number(t.fee) || 0
    const tax = Number(t.tax) || 0
    const type = t.type
    const price = n(t.price)
    if (isBuyType(type)) {
      const p = ensurePos(t.market, t.code)
      const cost = price * n(t.shares) + fee + tax
      p.basis += cost
      p.shares += n(t.shares)
      p.avgCost = p.shares > 0 ? p.basis / p.shares : 0
      if (!t.no_cash) cash -= cost
    } else if (type === 'sell') {
      const p = posMap.get(`${t.market}:${t.code}`)
      const want = n(t.shares)
      const held = p ? p.shares : 0
      const qty = Math.min(want, held)
      if (qty > 0) {
        p.basis -= p.avgCost * qty
        p.shares -= qty
        p.avgCost = p.shares > 0 ? p.basis / p.shares : 0
        cash += price * qty - fee - tax
      }
      // 与 computeAll 同口径：超出持仓的部分不计已实现盈亏，但资金计入现金
      const extra = want - qty
      if (extra > 0) cash += price * extra
    } else if (type === 'div') {
      const amt = Number(t.amount) || 0
      cash += amt
    } else if (type === 'gift') {
      const p = ensurePos(t.market, t.code)
      p.shares += n(t.shares)
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

  const allTrades = [...wsTrades].sort((a, b) =>
    a.date === b.date ? (a.id || 0) - (b.id || 0) : a.date.localeCompare(b.date)
  )
  const allCash = [...wsCash].sort((a, b) =>
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
    const byMarket = {}
    const byTag = {}
    const byPurpose = purposeOf ? {} : null
    const sym = opts.symbolDetail ? {} : null
    for (const p of posMap.values()) {
      if (p.shares > 1e-6) {
        const price = priceOf(`${p.market}:${p.code}`, date, p)
        const v = p.shares * price * rateOf(p.market, rates)
        mv += v
        byMarket[p.market] = (byMarket[p.market] || 0) + v
        const t = p.tag || NO_TAG
        byTag[t] = (byTag[t] || 0) + v
        if (byPurpose) {
          const u = p.purpose || NO_TAG
          byPurpose[u] = (byPurpose[u] || 0) + v
        }
        if (sym) sym[`${p.market}:${p.code}`] = { shares: p.shares, basis: p.basis, value: v }
      }
    }
    points.push({ date, cash, marketValue: mv, byMarket, byTag, byPurpose, sym, notes: noteMap.get(date) || [] })
  }
  return points
}

/** 净资产曲线（现金 + 持仓市值），供总览走势图与回撤分析使用 */
export function netValueSeries(trades, cashFlows, currentPrices, rates, currentDate, klines) {
  return buildDailyAssets(trades, cashFlows, currentPrices, rates, currentDate, klines, null).map((p) => ({
    date: p.date,
    netValue: p.cash + p.marketValue,
    cash: p.cash,
    marketValue: p.marketValue,
    notes: p.notes
  }))
}

/**
 * 净值曲线最后两点之间，基准点是不是上一个交易日。
 *
 * 「今日变化」取序列最后两点的差。只要中间跳过一个有行情的日子，这个差值就是
 * 好几天的累计涨跌，却被当成单日变化显示 —— K 线没补齐时会凭空多出几百块，
 * 让人以为今天亏了那么多。
 *
 * 结果分三档，因为「K 线那天空着」和「那天有行情却被跳过」不是一回事：
 *   ok   —— 中间没跳过交易日，两点之差就是单日变化
 *   gap  —— 中间的工作日在 K 线里找得到，说明那天确实有行情却没进序列 → 确认缺口
 *   soft —— 中间有工作日，但 K 线还没拉到那天，无从判断它是不是交易日。
 *           既不能确认缺口，也不能断言没问题，交给调用方决定怎么呈现
 *
 * 只看日历区分不了节假日和缺口（节假日数据源本来就没 K 线），所以要看这一天
 * 在缓存里的相对位置：是有、还是压根没拉到。
 *
 * @param {string} fromDate 序列倒数第二点的日期（基准）
 * @param {string} toDate   序列最后一点的日期（通常是今天）
 * @param {Set<string>} tradedDays K 线缓存里出现过的所有日期
 * @returns {'ok'|'gap'|'soft'}
 */
export function classifyTradeDayGap(fromDate, toDate, tradedDays) {
  if (!fromDate || !toDate) return 'ok'
  // 一条 K 线都没有：连「那天是不是交易日」都没有依据
  if (!tradedDays || !tradedDays.size) return 'soft'
  let maxDay = ''
  for (const d of tradedDays) if (d > maxDay) maxDay = d
  const pad = (n) => String(n).padStart(2, '0')
  const cur = new Date(fromDate + 'T00:00:00')
  const end = new Date(toDate + 'T00:00:00')
  cur.setDate(cur.getDate() + 1)
  while (cur < end) {
    const w = cur.getDay()
    const ds = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`
    if (w !== 0 && w !== 6) {
      // 缓存里有这天、序列却跳过了它 → 确确实实漏了
      if (tradedDays.has(ds)) return 'gap'
      // 缓存最远只到某天，这天还在它之后 → 没拉到，判断不了
      if (ds > maxDay) return 'soft'
      // ds ≤ maxDay 却不在缓存里 → 那天本来就没行情（法定休市），跳过去不算缺口
    }
    cur.setDate(cur.getDate() + 1)
  }
  return 'ok'
}

/** 收集 K 线缓存里出现过的所有交易日 */
export function tradedDaysOf(klines) {
  const out = new Set()
  for (const meta of Object.values(klines || {})) {
    const days = meta && meta.days
    // K 线还没拉到时 meta 存在但没有 days，直接 for...of 会在 undefined 上炸
    if (!Array.isArray(days)) continue
    for (const bar of days) if (bar && bar[0]) out.add(bar[0])
  }
  return out
}

/**
 * 单只标的「当日盈亏」的实时价口径 —— 按「昨收就持有」和「今日新成交」两段分别算。
 *
 * 不能笼统地用 (现价 − 昨收) × 现持股：今天买入的股票，买入之前今天已经涨（或跌）的
 * 那一段不属于今天的盈亏 —— 它已经体现在成交价里了，你的成本是成交价而不是昨收。
 *
 *   例：昨收 0.480，今天以 0.474 买入 1200 股，现价 0.470
 *       笼统算 (0.470 − 0.480) × 1200 = −12.0   ← 其中 7.2 是买入前跌的，跟你无关
 *       分段算 (0.470 − 0.474) × 1200 = −4.8    ← 真实的今日盈亏
 *
 * 今天卖出的部分按 (成交价 − 昨收) 结算 —— 这段收益当天落袋，
 * 卖出之后股价再涨跌就与它无关了。
 *
 * 补录的老仓（trades.origin='initial'，来自「＋新增资产 › 股票」且未关联扣款账户）
 * 不属于「今日买入」：它此前就已持有，按昨收起算。跟踪起点（没有昨收）时这段
 * 本来就不计入，所以不会把历史浮盈算成当天的盈亏。
 *
 * 注：这里**不含交易手续费**（浮动盈亏口径）。所以「今日盈亏」与总览「今日变化」
 * （净资产口径，含手续费）的差额就是当日交易成本 —— 这是刻意的，两者不是同一个口径。
 * 若日后要改成「净到手」口径，在此处扣减当日 fee/tax 即可，
 * 记得同步 utils/pnl.js 的 todayBase（todayPct 拿它当分母）。
 *
 * @param {number} price 现价（原币）
 * @param {number|null} prevClose 昨收，没有则为 null/0
 * @param {number} shares 当前持股
 * @param {Array} todayTrades 该标的今日的交易记录
 * @returns {{ amount: number, base: number }|null} amount 当日盈亏（原币），base 是算涨跌幅用的分母；算不出返回 null
 */
export function symbolDayPnl({ price, prevClose, shares, todayTrades }) {
  const legs = Array.isArray(todayTrades) ? todayTrades : []
  const hasPrev = Number(prevClose) > 0
  let bought = 0
  let sold = 0
  let boughtLeg = 0
  let soldLeg = 0
  let boughtBase = 0
  let soldBase = 0
  for (const t of legs) {
    const qty = Number(t.shares) || 0
    const px = Number(t.price) || 0
    if (qty <= 0) continue
    if (t.type === 'sell') {
      sold += qty
      if (hasPrev) {
        soldLeg += (px - prevClose) * qty
        soldBase += prevClose * qty
      }
    } else if (isBuyType(t.type)) {
      // 补录的老仓（origin='initial'）不算「今日买入」：它是此前就持有的仓位，
      // 归入下面「昨收就持有」那段按昨收起算。若按成交价起算，会把好几年的累计浮盈
      // 当成当天的盈亏 —— 实测补录 510880（成本 1.135、当日收盘 3.461）会虚增 2.3 万
      if (t.origin === 'initial') continue
      bought += qty
      boughtLeg += (price - px) * qty // 按成交价起算，而不是昨收
      boughtBase += px * qty
    }
    // gift（送股）没有成交价，不算买入；它在昨收时已持有，归入下面的持有段
  }
  // 没有昨收、今天也没买入 → 无从算起
  if (!hasPrev && bought === 0) return null
  // 昨日就持有、且今天没卖出的那部分
  const stillHeld = Math.max(0, (Number(shares) || 0) - bought)
  let amount = boughtLeg + soldLeg
  let base = boughtBase + soldBase
  if (hasPrev) {
    amount += (price - prevClose) * stillHeld
    base += prevClose * stillHeld
  }
  return { amount, base }
}

/**
 * 剔除资金进出后的净资产序列（时间加权口径 TWR），供回撤分析使用。
 *
 * 直接拿净资产算回撤会把存取款当成盈亏：
 *   账户 10 万取出 5 万 -> 净资产 -50%，会被算成一次巨大回撤（其实只是把钱取走了）；
 *   反过来大额入金会抬高历史峰值，把真实的持仓亏损掩盖成「已修复」。
 *
 * 这里逐日剔除资金流后递推收益率：
 *   当日收益率 r = (今日净值 − 当日净入金 − 昨日净值) / 昨日净值
 *   累计净值   = 上一日累计净值 × (1 + r)
 * 资金流只改变本金规模、不产生收益，因此既不进入 r，也不会造成净值跳变。
 *
 * 计入收益：持仓涨跌、现金分红、交易手续费等真实盈亏
 * 予以剔除：手动入金/出金（kind==='flow'）
 *
 * 不计入资金流：补录历史持仓时自动生成的虚拟入金（kind==='initial'）。它在现金里
 *   已被并入序列起点（见 buildDailyAssets 里 wsCash 的重定位），而注解仍记在原始发生日，
 *   若照注解逐日剔除，会在原始日把起点就已经算过的钱再扣一次，凭空造出巨大跌幅
 *   （曾出现「8/28→8/29 -39.67%」这种假回撤）。起点净资产本就是补录持仓的本金，不剔除。
 *
 * 上一日净值为 0（账户刚开立 / 资金刚进来）时算不出比率，
 * 该段按无收益处理，并把累计净值重置为当日净值作为新的本金基准。
 *
 * @param {Array} series netValueSeries 的输出 [{ date, netValue, notes }]
 * @returns {Array} [{ date, netValue, rawNetValue, flow }]，netValue 为剔除资金流后的净值
 */
export function netValueExFlows(series) {
  if (!series || !series.length) return []
  const flowOf = (notes) => {
    let f = 0
    for (const n of notes || []) {
      // 只剔除手动入金/出金；补录建仓的虚拟入金见上方说明，不参与剔除
      if (n.kind === 'flow') f += n.type === 'deposit' ? Number(n.amount) || 0 : -(Number(n.amount) || 0)
    }
    return f
  }
  const out = []
  let prevRaw = Number(series[0].netValue) || 0
  let adj = prevRaw
  out.push({ date: series[0].date, netValue: adj, rawNetValue: prevRaw, flow: flowOf(series[0].notes) })
  for (let i = 1; i < series.length; i++) {
    const raw = Number(series[i].netValue) || 0
    const flow = flowOf(series[i].notes)
    if (prevRaw > 0) {
      adj = adj * (1 + (raw - flow - prevRaw) / prevRaw)
    } else {
      // 上一点还没有净值：当日净值即新的本金基准，不存在收益率
      adj = raw
    }
    out.push({ date: series[i].date, netValue: adj, rawNetValue: raw, flow })
    prevRaw = raw
  }
  return out
}

/**
 * 资产曲线：逐日持仓市值，并按市场 / 按标签拆出各分组市值（不含现金）
 * meta 同 buildDailyAssets
 */
export function assetValueSeries(trades, cashFlows, currentPrices, rates, currentDate, klines, meta, opts = {}) {
  return buildDailyAssets(trades, cashFlows, currentPrices, rates, currentDate, klines, meta, opts).map((p) => ({
    date: p.date,
    marketValue: p.marketValue,
    byMarket: p.byMarket,
    byTag: p.byTag,
    byPurpose: p.byPurpose
  }))
}

/**
 * 单只股票的逐日走势（供「成本与盈亏 › 标的走势」页使用）
 * 复用逐日重放逻辑：市值 = 当日持股 × 当日收盘 × 汇率，成本 = 移动加权成本 × 汇率。
 * 只传入该股票的交易记录，因此时间轴从首次建仓日到今天（初始建仓同样并入起点）。
 */
export function holdingSeries(trades, currentPrices, rates, currentDate, klines, market, code) {
  const list = (trades || []).filter((t) => t.market === market && t.code === code)
  if (!list.length) return []
  const rate = rateOf(market, rates)
  const pts = buildDailyAssets(list, [], currentPrices, rates, currentDate, klines, null, { symbolDetail: true })
  return pts
    .map((p) => {
      const d = (p.sym || {})[`${market}:${code}`] || null
      const shares = d ? d.shares : 0
      const cost = d ? d.basis * rate : 0
      const value = d ? d.value : 0
      return { date: p.date, shares, cost, value, floating: value - cost }
    })
    // 清仓后 shares 归零，保留最后一个点即可（曲线自然落到 0）
    .filter((p, i, arr) => p.shares > 1e-6 || i === arr.length - 1)
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
    if (isBuyType(t.type) || t.type === 'gift') return shares + (Number(t.shares) || 0)
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
    if (isBuyType(t.type) || t.type === 'gift') return shares + (Number(t.shares) || 0)
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

/**
 * 多次回撤事件：净值跌破前高即开启一次事件，涨回前高即关闭。
 * 序列结束时仍未涨回前高的，记为「尚未修复」。
 * @param {Array} series 净值序列 [{ date, netValue }]
 * @param {Object} [opts] minPct：忽略跌幅小于该值（绝对值，百分比）的微小波动
 * @returns {Array} 按跌幅从大到小排序的事件数组
 */
export function drawdownEvents(series, { minPct = 0.5 } = {}) {
  if (!series || series.length < 2) return []
  const events = []
  let peak = series[0].netValue
  let peakDate = series[0].date
  let cur = null // 进行中的回撤事件

  for (const p of series) {
    if (cur) {
      if (p.netValue < cur.troughValue) {
        cur.troughValue = p.netValue
        cur.troughDate = p.date
      }
      // 涨回事件起点的高点即视为修复
      if (p.netValue >= cur.peakValue) {
        cur.recovered = true
        cur.recoveryDate = p.date
        cur.recoveryDays = dayjs(cur.recoveryDate).diff(dayjs(cur.troughDate), 'day')
        events.push(cur)
        cur = null
        peak = p.netValue
        peakDate = p.date
        continue
      }
    } else if (p.netValue < peak) {
      cur = {
        peakDate,
        peakValue: peak,
        troughValue: p.netValue,
        troughDate: p.date,
        recovered: false,
        recoveryDate: null,
        recoveryDays: 0
      }
    }
    if (!cur && p.netValue >= peak) {
      peak = p.netValue
      peakDate = p.date
    }
  }
  if (cur) events.push(cur)

  return events
    .map((e) => ({
      ...e,
      dropPct: e.peakValue > 0 ? ((e.troughValue - e.peakValue) / e.peakValue) * 100 : 0,
      dropDays: dayjs(e.troughDate).diff(dayjs(e.peakDate), 'day')
    }))
    .filter((e) => Math.abs(e.dropPct) >= minPct)
    .sort((a, b) => a.dropPct - b.dropPct)
}
