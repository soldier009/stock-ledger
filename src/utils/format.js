import dayjs from 'dayjs'

export function fmtMoney(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
  const n = Number(v)
  const sign = n < 0 ? '-' : ''
  return (
    sign +
    '¥' +
    Math.abs(n).toLocaleString('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    })
  )
}

export function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
  const n = Number(v)
  if (Math.abs(n) >= 10000) {
    return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ''
  }
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

export function fmtShares(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
  const n = Number(v)
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

export function fmtPct(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—'
  return v.toFixed(digits) + '%'
}

export function fmtDate(d) {
  return dayjs(d).format('YYYY-MM-DD')
}

export function fmtTime(dt) {
  if (!dt) return ''
  return dayjs(dt).format('HH:mm:ss')
}

// 红涨绿跌（A股习惯）
export function pnlClass(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v)) || v === 0) return 'flat'
  return v > 0 ? 'up' : 'down'
}

export function rateOf(market, rates) {
  if (market === 'US') return rates?.usd || 1
  if (market === 'HK') return rates?.hkd || 1
  return 1
}

export function typeLabel(t) {
  const map = {
    buy: '买入',
    sell: '卖出',
    div: '分红',
    gift: '送股',
    rights: '配股'
  }
  return map[t] || t
}

export function marketLabel(m) {
  return { A: 'A股', HK: '港股', US: '美股' }[m] || m
}

// 解析股票标签（JSON 数组字符串 -> 数组），容错
export function parseTags(v) {
  if (Array.isArray(v)) return v
  if (!v) return []
  try {
    const r = JSON.parse(v)
    return Array.isArray(r) ? r : []
  } catch {
    return []
  }
}
