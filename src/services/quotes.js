import { loadScript } from '../utils/jsonp'

const GTIMG = 'https://qt.gtimg.cn/q='
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/'

/** 转换为腾讯行情代码 */
export function tencentSymbol(market, code) {
  const c = String(code).trim()
  if (market === 'A') {
    // 北交所：43/83/87/88/920 开头
    if (/^920/.test(c)) return 'bj' + c
    // 沪市：6 开头股票；5 开头场内基金/LOF（510~518/56x/58x）；11 开头沪市可转债（110/111/113/118）；9 开头沪市 B 股（900）
    if (/^6/.test(c) || /^5/.test(c) || /^11/.test(c) || /^9/.test(c)) return 'sh' + c
    if (/^[48]/.test(c)) return 'bj' + c
    // 深市：0/3 开头股票；12 开头深市可转债；15 开头深市基金
    return 'sz' + c
  }
  if (market === 'HK') return 'hk' + c.padStart(5, '0')
  if (market === 'US') return 'gb' + c.toLowerCase()
  return ''
}

/** 转换为雅虎行情代码 */
export function yahooSymbol(market, code) {
  const c = String(code).trim()
  if (market === 'A') {
    // 与腾讯规则保持一致：6/5/11/9 开头为沪市(SS)，920/4/8 开头为北交所(BJ)，其余为深市(SZ)
    if (/^920/.test(c)) return c + '.BJ'
    if (/^6/.test(c) || /^5/.test(c) || /^11/.test(c) || /^9/.test(c)) return c + '.SS'
    if (/^[48]/.test(c)) return c + '.BJ'
    return c + '.SZ'
  }
  if (market === 'HK') return c.padStart(5, '0') + '.HK'
  return c.toUpperCase()
}

function parseTencent(raw) {
  const p = raw.split('~')
  if (p.length < 34) return null
  const price = parseFloat(p[3])
  if (!price || Number.isNaN(price)) return null
  return {
    name: p[1] || '',
    price,
    prevClose: parseFloat(p[4]) || null,
    open: parseFloat(p[5]) || null,
    high: parseFloat(p[33]) || null,
    low: parseFloat(p[34]) || null,
    changePct: parseFloat(p[32]) || null,
    time: p[30] || ''
  }
}

async function fetchTencent(items) {
  const out = {}
  const symbols = items.map((s) => ({ ...s, t: tencentSymbol(s.market, s.code) }))
  for (let i = 0; i < symbols.length; i += 50) {
    const group = symbols.slice(i, i + 50)
    try {
      await loadScript(GTIMG + group.map((s) => s.t).join(','), 8000)
    } catch {
      /* 单组失败继续下一组 */
    }
    for (const s of group) {
      const raw = window['v_' + s.t]
      if (raw && typeof raw === 'string') {
        const q = parseTencent(raw)
        if (q) out[s.market + ':' + s.code] = { ...q, hasQuote: true }
      }
    }
  }
  return out
}

async function fetchYahoo(items) {
  const out = {}
  await Promise.all(
    items.map(async (s) => {
      try {
        const res = await fetch(
          `${YAHOO}${yahooSymbol(s.market, s.code)}?interval=1d&range=5d`,
          { cache: 'no-store' }
        )
        if (!res.ok) return
        const j = await res.json()
        const meta = j?.chart?.result?.[0]?.meta
        const price = meta?.regularMarketPrice
        if (price && !Number.isNaN(price)) {
          const prev = meta?.previousClose ?? meta?.chartPreviousClose ?? null
          out[s.market + ':' + s.code] = {
            name: meta.shortName || meta.longName || s.code,
            price,
            prevClose: prev,
            open: meta.regularMarketOpen || null,
            changePct: prev ? ((price / prev) - 1) * 100 : null,
            time: new Date().toTimeString().slice(0, 8),
            hasQuote: true
          }
        }
      } catch {
        /* 单个失败忽略 */
      }
    })
  )
  return out
}

/**
 * 批量获取行情
 * A股/港股走腾讯（实时），美股走雅虎（失败时回退腾讯 gb_）
 * @returns {Record<string, object>} key = `${market}:${code}`
 */
export async function fetchQuotes(items) {
  const us = items.filter((s) => s.market === 'US')
  const other = items.filter((s) => s.market !== 'US')
  const out = {}
  const [ot, uq] = await Promise.all([fetchTencent(other), fetchYahoo(us)])
  Object.assign(out, ot, uq)

  // 美股雅虎失败的回退腾讯
  const usMissing = us.filter((s) => !out[s.market + ':' + s.code])
  if (usMissing.length) {
    const tq = await fetchTencent(usMissing)
    Object.assign(out, tq)
  }
  return out
}

/** 获取单个代码的行情（用于表单自动补全） */
export async function lookupQuote(market, code) {
  const q = await fetchQuotes([{ market, code }])
  return q[market + ':' + code] || null
}

/** 获取汇率：USD/CNY、HKD/CNY（雅虎，失败返回空对象） */
export async function fetchRates() {
  const out = {}
  const targets = [
    { k: 'usd', y: 'USDCNY=X' },
    { k: 'hkd', y: 'HKDCNY=X' }
  ]
  await Promise.all(
    targets.map(async (t) => {
      try {
        const res = await fetch(`${YAHOO}${t.y}?interval=1d&range=1d`, { cache: 'no-store' })
        if (!res.ok) return
        const j = await res.json()
        const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice
        if (p && !Number.isNaN(p) && p > 0) out[t.k] = p
      } catch {
        /* 忽略 */
      }
    })
  )
  return out
}
