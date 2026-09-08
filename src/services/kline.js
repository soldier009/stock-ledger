import { tencentSymbol } from './quotes'

const TENCENT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const EASTMONEY = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
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
  const url = `${TENCENT}?param=${t},day,${from},${to},800,qfq`
  const j = await getJSON(url)
  if (!j || j.code !== 0) return null
  const node = j.data && (j.data[t] || j.data[Object.keys(j.data || {})[0]])
  if (!node) return null
  const rows = node.qfqday || node.day || []
  const out = rows.map((r) => [r[0], Number(r[2])]).filter((x) => x[0] && x[1] > 0)
  return out.length ? byDate(out) : null
}

/**
 * 东方财富日K（前复权）
 * secid 候选列表，逐个尝试
 */
async function eastmoneyDay(secids, from, to) {
  const fromNum = from.replace(/-/g, '')
  const toNum = to.replace(/-/g, '')
  for (const sid of secids) {
    try {
      const url = `${EASTMONEY}?secid=${sid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=${fromNum}&end=${toNum}&lmt=100000`
      const j = await getJSON(url)
      const klines = j && j.data && j.data.klines
      if (!Array.isArray(klines) || !klines.length) continue
      const out = klines
        .map((s) => {
          const p = s.split(',')
          return [p[0], Number(p[2])]
        })
        .filter((x) => x[0] && x[1] > 0)
      if (out.length) return byDate(out)
    } catch {
      /* 尝试下一个市场码 */
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
 * 每只股票会把时间窗切成若干段，逐段尝试多个来源：
 * - 某段失败先在该来源内补拉一次，再尝试换来源补上，尽量避免历史中间出现空洞；
 * - 空段（停牌/未上市等）不算失败，只要其它段有数据即视为完整。
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
      const providers = []
      // 腾讯只支持 A 股/港股
      if (market === 'A' || market === 'HK') {
        const t = tencentSymbol(market, code)
        if (t) providers.push((f, t2) => tencentDay(t, f, t2))
      }
      // 东方财富兜底（美股仅此来源）
      const sids = emSecidOf(market, code)
      if (sids.length) providers.push((f, t2) => eastmoneyDay(sids, f, t2))

      const segs = segments(from, to)
      const filled = segs.map(() => null) // 每段已拿到的结果
      const segErr = segs.map(() => false) // 每段是否出过错
      // 第一轮：用每个来源尽量补齐所有段
      for (const provider of providers) {
        for (let i = 0; i < segs.length; i++) {
          if (filled[i]) continue
          try {
            const r = await provider(segs[i].from, segs[i].to)
            if (r && r.length) filled[i] = r
          } catch {
            segErr[i] = true
          }
        }
      }
      // 第二轮：对仍然空白的段重试（同来源 + 换来源），应对偶发超时
      for (let i = 0; i < segs.length; i++) {
        if (filled[i]) continue
        for (const provider of providers) {
          if (filled[i]) break
          try {
            const r = await provider(segs[i].from, segs[i].to)
            if (r && r.length) {
              filled[i] = r
              segErr[i] = false
            }
          } catch {
            /* 仍失败则保留该段缺口标记 */
          }
        }
      }

      const days = mergeDays(filled)
      if (days.length) {
        // complete=false 表示有段最终失败，历史中间可能存在空洞，调用方应安排整段重拉
        data[key] = { days, complete: !segErr.some(Boolean) }
      } else {
        failed.push({ market, code })
      }
    })
  )
  return { data, failed }
}
