import { tencentSymbol } from './quotes'

// 腾讯历史K：ifzq.gtimg.cn（无 web. 前缀）为当前可用入口；
// web.ifzq.gtimg.cn 近期被腾讯 WAF 风控拦截（501），作为备用域名保留轮询
const TENCENT_HOSTS = [
  'https://ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
]
// 东方财富：部分网络下 https 会被服务端断开（TLS 异常），
// 页面本身非 https 时可追加 http 兜底（https 页面下浏览器会拦 http 混内容，故不加）
const EM_HOSTS = ['https://push2his.eastmoney.com/api/qt/stock/kline/get']
const proto = typeof location !== 'undefined' ? location.protocol : ''
if (proto === 'http:' || proto === 'file:') {
  EM_HOSTS.push('http://push2his.eastmoney.com/api/qt/stock/kline/get')
}
// 东方财富市场代码：105 纳斯达克 / 106 纽交所 / 107 美交所
const US_MARKETS = [105, 106, 107]
// 单次请求覆盖的日历天数（对应约 200+ 个交易日，避免历史过长时被截断）
const SEGMENT_DAYS = 400

/** 轻量 fetch（带超时） */
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

function byDate(list) {
  const map = new Map()
  for (const [d, c] of list) {
    const cv = Number(c)
    if (d && cv > 0) map.set(d, cv)
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

function fmt(d) {
  const m = d.getMonth() + 1
  const dd = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd
}

/** 把 [from, to] 切成若干段 */
function segments(from, to) {
  const out = []
  const start = new Date(from + 'T00:00:00')
  const end = new Date(to + 'T00:00:00')
  let cursor = start
  while (cursor <= end) {
    const segEnd = new Date(cursor)
    segEnd.setDate(segEnd.getDate() + SEGMENT_DAYS)
    const s = fmt(cursor)
    const e = segEnd < end ? fmt(segEnd) : to
    out.push({ from: s, to: e })
    const next = new Date(segEnd)
    next.setDate(next.getDate() + 1)
    cursor = next
  }
  return out
}

/**
 * 腾讯日K（A股/港股）
 * 返回值：[[date, close], ...] 升序，失败返回 null
 */
async function tencentDay(t, from, to) {
  for (const base of TENCENT_HOSTS) {
    try {
      const url = `${base}?param=${t},day,${from},${to},800,qfq`
      const j = await getJSON(url)
      if (!j || j.code !== 0) continue
      const node = j.data && (j.data[t] || j.data[Object.keys(j.data || {})[0]])
      if (!node) continue
      const rows = node.qfqday || node.day || []
      const out = rows.map((r) => [r[0], Number(r[2])]).filter((x) => x[0] && x[1] > 0)
      if (out.length) return byDate(out)
    } catch {
      /* 该域名被拦/超时，换下一个域名重试 */
    }
  }
  return null
}

/**
 * 东方财富日K（前复权）
 * secid 候选列表，逐个尝试；每个市场码再逐个尝试可用域名
 */
async function eastmoneyDay(secids, from, to) {
  const fromNum = from.replace(/-/g, '')
  const toNum = to.replace(/-/g, '')
  for (const sid of secids) {
    for (const host of EM_HOSTS) {
      try {
        const url = `${host}?secid=${sid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=${fromNum}&end=${toNum}&lmt=100000`
        const j = await getJSON(url)
        const klines = j && j.data && j.data.klines
        if (!Array.isArray(klines)) continue
        if (!klines.length) break // 该市场码无数据，试下一个市场码
        const out = klines
          .map((s) => {
            const p = s.split(',')
            return [p[0], Number(p[2])]
          })
          .filter((x) => x[0] && x[1] > 0)
        if (out.length) return byDate(out)
      } catch {
        /* 换下一个域名 / 市场码 */
      }
    }
  }
  return null
}

function emSecidOf(market, code) {
  const c = String(code)
  if (market === 'HK') return [`116.${c.padStart(5, '0')}`]
  if (market === 'A') {
    // 沪市：6/5/9/11 开头；其余（0/1/2/3/4/8/92 开头，含深市与北交所）走 0 号市场
    if (/^[659]/.test(c) || /^11/.test(c)) return [`1.${c}`]
    return [`0.${c}`]
  }
  const plain = c.toUpperCase().replace(/\./g, '-')
  return US_MARKETS.map((m) => `${m}.${plain}`)
}

function mergeDays(sets) {
  const map = new Map()
  for (const set of sets) {
    if (!set) continue
    for (const [d, c] of set) {
      if (!map.has(d)) map.set(d, c)
    }
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

/**
 * 批量获取历史日K（内部按时间窗分段拉取并合并）
 *
 * 每只股票会把时间窗切成若干段：
 * - 腾讯（A/港股）按段拉取；
 * - 东方财富支持单次返回整个区间，因此整段只请求一次，再按各段切分填充，
 *   避免把整段历史切成大量小请求（既慢又容易被限流）；
 * - 某一段只要任一来源成功即视为成功（来源失败但被另一来源补上，不算失败）；
 * - 空段（停牌/未上市等）不算失败，除非缺口位于已取到数据区间的内部。
 *
 * @param {Array} items [{ market, code, from, to }] 日期格式 YYYY-MM-DD
 * @returns {Promise<{ data: Object, failed: Array }>}
 *   data: { 'A:600000': { days: [[date, close]], complete: Boolean } }，仅成功项
 *   failed: 完全没拿到任何 K 线的项 [{ market, code }]
 */
export async function fetchDayKlines(items) {
  const data = {}
  const failed = []
  await Promise.all(
    items.map(async ({ market, code, from, to }) => {
      const key = market + ':' + code
      const segs = segments(from, to)
      const filled = segs.map(() => null) // 每段已拿到的结果
      const segErr = segs.map(() => false) // 每段最终是否仍有缺口
      const providers = []
      // 腾讯：只支持 A 股/港股，单次条数有限，按段拉取
      if (market === 'A' || market === 'HK') {
        const t = tencentSymbol(market, code)
        if (t) providers.push({ run: (f, t2) => tencentDay(t, f, t2) })
      }
      // 东方财富：整段一次拉取后按各段切分（美股仅此来源）
      const sids = emSecidOf(market, code)
      let emAll = null
      if (sids.length) {
        providers.push({
          run: async (f, t2) => {
            if (!emAll) emAll = await eastmoneyDay(sids, from, to)
            return (emAll || []).filter(([d]) => d >= f && d <= t2)
          }
        })
      }
      // 某段用所有来源尝试；只要任一来源返回数据即成功（并清除失败标记）
      const tryFill = async (i) => {
        if (filled[i]) return true
        for (const provider of providers) {
          try {
            const r = await provider.run(segs[i].from, segs[i].to)
            if (r && r.length) {
              filled[i] = r
              segErr[i] = false
              return true
            }
          } catch {
            segErr[i] = true
          }
        }
        return false
      }
      // 第一轮：逐段尝试
      for (let i = 0; i < segs.length; i++) await tryFill(i)
      // 第二轮：对仍空白的段重试，应对偶发超时/限流
      for (let i = 0; i < segs.length; i++) {
        if (!filled[i]) await tryFill(i)
      }

      const days = mergeDays(filled)
      if (days.length) {
        const first = days[0][0]
        const last = days[days.length - 1][0]
        // 仅当失败的缺口落在已取数据区间的内部时才视为不完整；
        // 早于首根K线（尚未上市）或晚于末根（已退市/未来）的空段不算失败。
        let incomplete = false
        for (let i = 0; i < segs.length; i++) {
          if (!filled[i] && segErr[i] && segs[i].to >= first && segs[i].from <= last) {
            incomplete = true
            break
          }
        }
        data[key] = { days, complete: !incomplete }
      } else {
        failed.push({ market, code })
      }
    })
  )
  return { data, failed }
}
