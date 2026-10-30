/**
 * 一次性诊断（用完即删，连同 Settings.vue 里的入口一起删）。
 *
 * 三个用途：
 * 1) 「今日变化」在多台设备上对不上时，看净值序列末两点差在哪；
 * 2) 「今日盈亏」与「今日变化」为什么不是一个数 —— 两者口径不同，这里把差额拆开量化；
 * 3) 盈亏日历里「今天」那一格为什么没有数字。
 */

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// buy / rights / win 都算买入（与 calc.js 的 isBuyType 一致）
const BUY_TYPES = ['buy', 'rights', 'win']

export function buildTodayChangeReport(portfolio) {
  const p = portfolio
  const n2 = (v) => (Number(v) || 0).toFixed(2)
  const out = []
  const s = Array.isArray(p.netValue) ? p.netValue : []
  const last = s[s.length - 1]
  const prev = s[s.length - 2]
  const td = todayStr()

  out.push('【当前资产】')
  out.push('净资产 ' + n2(last && last.netValue) + '　现金 ' + n2(last && last.cash) + '　市值 ' + n2(last && last.marketValue))
  out.push('行情最后更新 ' + (p.lastQuoteAt || '—'))

  out.push('')
  out.push('【净值序列最后 6 点】')
  if (!s.length) out.push('（序列为空）')
  for (const x of s.slice(-6)) {
    out.push(x.date + '　净值 ' + n2(x.netValue) + '　现金 ' + n2(x.cash) + '　市值 ' + n2(x.marketValue))
  }

  out.push('')
  out.push('【今日变化】')
  const todayChange = last && prev ? last.netValue - prev.netValue : null
  if (last && prev) {
    out.push('末点 ' + last.date + '　基准 ' + prev.date)
    out.push('差值 ' + n2(todayChange))
    out.push('（基准不是上一个交易日时，这个差值是好几天的累计）')
  } else {
    out.push('（序列不足两点，无法相减）')
  }

  // ===== 今日盈亏 vs 今日变化：差额拆解 =====
  out.push('')
  out.push('【今日盈亏 vs 今日变化】')
  const dayPnl = p.totals ? p.totals.dayPnl : null
  out.push('今日盈亏（浮动盈亏口径，不含手续费） ' + n2(dayPnl))
  out.push('今日变化（净资产口径，含手续费与资金进出） ' + n2(todayChange))
  if (todayChange !== null && dayPnl !== null) {
    out.push('差额（变化 − 盈亏） ' + n2(todayChange - dayPnl))
  }

  // 今日的交易：成交额、手续费/税、不使用现金的买入
  const tt = (p.trades || []).filter((t) => t.date === td)
  let buyAmt = 0
  let sellAmt = 0
  let feeSum = 0
  let divAmt = 0
  let noCashAmt = 0
  const tradeLines = []
  for (const t of tt) {
    const fee = (Number(t.fee) || 0) + (Number(t.tax) || 0)
    const amt = (Number(t.price) || 0) * (Number(t.shares) || 0)
    const key = t.market + ':' + t.code
    if (BUY_TYPES.includes(t.type)) {
      buyAmt += amt
      feeSum += fee
      if (t.no_cash) noCashAmt += amt
      tradeLines.push('  ' + key + ' 买入 ' + n2(amt) + '　费用 ' + n2(fee) + (t.no_cash ? '　(不计现金)' : ''))
    } else if (t.type === 'sell') {
      sellAmt += amt
      feeSum += fee
      tradeLines.push('  ' + key + ' 卖出 ' + n2(amt) + '　费用 ' + n2(fee))
    } else if (t.type === 'div') {
      const v = Number(t.amount) || 0
      divAmt += v
      tradeLines.push('  ' + key + ' 分红 ' + n2(v))
    } else {
      tradeLines.push('  ' + key + ' ' + t.type + ' ' + n2(amt) + '　费用 ' + n2(fee))
    }
  }
  out.push('今日交易 ' + tt.length + ' 笔：买入额 ' + n2(buyAmt) + '　卖出额 ' + n2(sellAmt) + '　手续费税合计 ' + n2(feeSum) + '　分红 ' + n2(divAmt))
  for (const line of tradeLines) out.push(line)

  // 今日的资金流水（入金 / 出金）
  const cf = (p.cashFlows || []).filter((c) => c.date === td)
  let dep = 0
  let wd = 0
  for (const c of cf) {
    const a = Number(c.amount) || 0
    if (c.type === 'deposit') dep += a
    else if (c.type === 'withdraw') wd += a
  }
  out.push('今日资金流水：入金 ' + n2(dep) + '　出金 ' + n2(wd))

  // 预期差额 = 分红进现金 + 入金 − 出金 − 手续费税 + 不计现金的买入
  const expectDiff = divAmt + dep - wd - feeSum + noCashAmt
  if (todayChange !== null && dayPnl !== null) {
    out.push('预期差额 = 分红 + 入金 − 出金 − 费用 + 不计现金的买入 = ' + n2(expectDiff))
    out.push('实际差额 ' + n2(todayChange - dayPnl) + '　吻合度 ' + n2(Math.abs(todayChange - dayPnl - expectDiff)) + '（越小越吻合）')
  }

  // 有持仓但算不出今日盈亏的（缺行情/缺昨收）：它计入今日变化，不计入今日盈亏
  const blind = (p.positions || []).filter((x) => x.dayCny === null || !x.quote)
  out.push('无行情/缺昨收的持仓 ' + blind.length + ' 只（这些只进「今日变化」，不进「今日盈亏」）：')
  for (const x of blind.slice(0, 12)) {
    out.push('  ' + x.market + ':' + x.code + ' ' + (x.name || '') + '　市值 ' + n2(x.mvCny) + '　有行情=' + (x.quote ? '是' : '否'))
  }

  // ===== 盈亏日历「今天」那一格 =====
  out.push('')
  out.push('【盈亏日历 今天那一格】')
  const dh = p.dailyHolding || []
  const todayRow = dh.find((x) => x.date === td)
  out.push('今天 ' + td + '　日历行数 ' + dh.length)
  out.push('日历最后 5 行：')
  for (const x of dh.slice(-5)) out.push('  ' + x.date + '　盈亏 ' + n2(x.amount))

  if (!todayRow) {
    out.push('今天那一格：不存在该行 → 日历上不显示数字')
  } else if (todayRow.amount === 0) {
    out.push('今天那一格：存在但盈亏恰为 0 → 按现有展示规则不显示数字（金额 0 的格子留白）')
  } else {
    out.push('今天那一格：存在，盈亏 ' + n2(todayRow.amount))
  }

  // 复算 store 里判定「今天是否写入实时口径」的两个开关
  let quoteToday = false
  let noQuoteCount = 0
  const samples = []
  for (const x of p.positions || []) {
    const q = x.quote
    if (!q) {
      noQuoteCount++
      continue
    }
    const okT = !!q.time && String(q.time).replace(/[-: ]/g, '').startsWith(td.replace(/-/g, ''))
    if (okT) quoteToday = true
    if (samples.length < 4) {
      samples.push('  ' + x.market + ':' + x.code + ' time=' + JSON.stringify(q.time) + (okT ? ' → 认今天 ✓' : ' → 不匹配 ✗'))
    }
  }
  const by = (p.klineCache && p.klineCache.bySymbol) || {}
  const hasTodayBar = Object.values(by).some((m) => m && m.days && m.days.length && m.days[m.days.length - 1][0] === td)
  const dayReady = (p.positions || []).some((x) => x.dayCny !== null)
  out.push('写入条件：dayReady=' + dayReady + '　quoteToday=' + quoteToday + '　hasTodayBar=' + hasTodayBar)
  out.push('（三个都要求成立才写入：dayReady 且与 quoteToday/hasTodayBar 之一）')
  out.push('无行情持仓数 ' + noQuoteCount + '　时间戳样本：')
  for (const line of samples) out.push(line)

  // ===== 日K状态 =====
  out.push('')
  out.push('【日K状态】')
  let maxDay = ''
  const per = []
  for (const [k, m] of Object.entries(by)) {
    const days = Array.isArray(m && m.days) ? m.days : []
    const d = days.length ? days[days.length - 1][0] : '—'
    per.push(k + ' ' + d + '（' + days.length + ' 根）')
    if (d !== '—' && d > maxDay) maxDay = d
  }
  out.push('日K最远 ' + (maxDay || '—') + '　缓存 ' + Object.keys(by).length + ' 只')
  out.push('缺历史 ' + (p.klineMissing || []).length + ' 只　日线落后 ' + (p.klineStale || []).length + ' 只')
  if ((p.klineStale || []).length) {
    out.push('  落后标的：' + p.klineStale.map((x) => (x.name || x.code) + '@' + x.last).join('、'))
  }
  out.push('各标的最后一根：')
  for (const line of per) out.push('  ' + line)

  return out.join('\n')
}
