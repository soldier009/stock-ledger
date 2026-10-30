/**
 * 一次性诊断（用完即删，连同 Settings.vue 里的入口一起删）。
 *
 * 用途：同一份账本在几台设备上「今日变化」对不上时，看净值序列末两点到底差在哪：
 * 是末点净值不同（行情快照时刻不同 / 数据没同步），还是基准点不同（日线落后导致跨天）。
 */
export function buildTodayChangeReport(portfolio) {
  const p = portfolio
  const n2 = (v) => (Number(v) || 0).toFixed(2)
  const out = []
  const s = Array.isArray(p.netValue) ? p.netValue : []
  const last = s[s.length - 1]
  const prev = s[s.length - 2]

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
  if (last && prev) {
    out.push('末点 ' + last.date + '　基准 ' + prev.date)
    out.push('差值 ' + n2(last.netValue - prev.netValue))
    out.push('（基准不是上一个交易日时，这个差值是好几天的累计）')
  } else {
    out.push('（序列不足两点，无法相减）')
  }

  out.push('')
  out.push('【日K状态】')
  const by = (p.klineCache && p.klineCache.bySymbol) || {}
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
