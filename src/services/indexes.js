/**
 * 大盘指数：用于资产曲线的收益对比。
 *
 * 指数不能沿用个股的日K管道：中证指数代码（000300 / 000905）会被个股解析器
 * 判成深市（sz000300 / 0.000300），实际在上交所（sh000300 / 1.000300），
 * 因此这里为每个指数写死各源的符号，逐个尝试直到拿到数据。
 * 实测可用：腾讯 sh000300 / sh000905 / hkHSI；东财 1.000300 / 1.000905 / 100.HSI / 100.NDX
 * （雅虎 chart 当前返回 403，腾讯无纳指日K）
 */
export const INDEX_LIST = [
  { key: 'shIdx', name: '上证指数', color: '#16a34a' },
  { key: 'hs300', name: '沪深300', color: '#64748b' },
  { key: 'zz500', name: '中证500', color: '#0ea5e9' },
  { key: 'ndx', name: '纳指100', color: '#f59e0b' },
  { key: 'hsi', name: '恒生指数', color: '#8b5cf6' }
]

// 腾讯符号（中证指数在上交所行情里，港股指数用 hkHSI）
const TENCENT_SYMBOL = { shIdx: 'sh000001', hs300: 'sh000300', zz500: 'sh000905', hsi: 'hkHSI' }
// 东方财富 secid：中证指数在 1 号市场（沪市），港美股指数在 100 号市场
const EM_SID = { shIdx: '1.000001', hs300: '1.000300', zz500: '1.000905', hsi: '100.HSI', ndx: '100.NDX' }

const TENCENT_HOSTS = [
  'https://ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
]
const EM_HOSTS = ['https://push2his.eastmoney.com/api/qt/stock/kline/get']

async function getJSON(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 东方财富指数日线：[[date, close]] 升序 */
async function emDays(secid, from, to) {
  const fromNum = from.replace(/-/g, '')
  const toNum = to.replace(/-/g, '')
  for (const host of EM_HOSTS) {
    try {
      const url = `${host}?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=${fromNum}&end=${toNum}&lmt=100000`
      const j = await getJSON(url)
      const klines = j && j.data && j.data.klines
      if (!Array.isArray(klines) || !klines.length) continue
      const out = klines
        .map((s) => {
          const p = s.split(',')
          return [p[0], Number(p[2])]
        })
        .filter((x) => x[0] && x[1] > 0)
      if (out.length) return out.sort((a, b) => (a[0] < b[0] ? -1 : 1))
    } catch {
      /* 换下一个域名 */
    }
  }
  return null
}

/** 腾讯日线（指数符号如 hkHSI）：[[date, close]] 升序 */
async function tencentDays(symbol, from, to) {
  for (const base of TENCENT_HOSTS) {
    try {
      const url = `${base}?param=${symbol},day,${from},${to},800,qfq`
      const j = await getJSON(url)
      if (!j || j.code !== 0) continue
      const node = j.data && (j.data[symbol] || j.data[Object.keys(j.data || {})[0]])
      const rows = (node && (node.qfqday || node.day)) || []
      const out = rows.map((r) => [r[0], Number(r[2])]).filter((x) => x[0] && x[1] > 0)
      if (out.length) return out.sort((a, b) => (a[0] < b[0] ? -1 : 1))
    } catch {
      /* 换下一个域名 */
    }
  }
  return null
}

/**
 * 拉取指数日K
 * @param {Array} items [{ key, from, to }] key 取 INDEX_LIST 里的 key
 * @returns {Promise<Object>} { hs300: { days: [[date, close]], ok: Boolean }, ... }
 */
export async function fetchIndexKlines(items) {
  const out = {}
  await Promise.all(
    items.map(async ({ key, from, to }) => {
      let days = null
      if (TENCENT_SYMBOL[key]) days = await tencentDays(TENCENT_SYMBOL[key], from, to)
      if (!days && EM_SID[key]) days = await emDays(EM_SID[key], from, to)
      out[key] = { days: days || [], ok: !!(days && days.length) }
    })
  )
  return out
}
