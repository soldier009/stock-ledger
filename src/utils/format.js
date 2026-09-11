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

// 资产二级分类：股票 / 基金 / 可转债（可转债单列）
export const ASSET_CLASSES = [
  { value: 'stock', label: '股票' },
  { value: 'fund', label: '基金' },
  { value: 'bond', label: '可转债' }
]

export function assetClassLabel(t) {
  return { stock: '股票', fund: '基金', bond: '可转债' }[t] || '其他'
}

/**
 * 按市场与代码推断资产类别（仅在用户未人工标注时使用）
 * - A股：沪市 11x / 深市 12x 为可转债；沪市 5xx、深市 15x/16x 为场内基金(ETF/LOF)；其余为股票
 * - 港股/美股：代码无规律，无法区分 ETF，默认按股票，可在标的详情页人工标注修正
 */
export function guessAssetClass(market, code) {
  const c = String(code || '').trim()
  if (market !== 'A') return 'stock'
  if (/^1[12]/.test(c)) return 'bond'
  if (/^5/.test(c) || /^1[56]/.test(c)) return 'fund'
  return 'stock'
}

/** 资产类别：人工标注优先，未标注时按市场与代码推断 */
export function assetClass(market, code, assetType) {
  const t = String(assetType || '').trim()
  return t || guessAssetClass(market, code)
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
