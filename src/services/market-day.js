/**
 * 行情日K抓取的公共底层：腾讯 + 东方财富两个来源，各带域名轮询与超时。
 * 个股日K（services/kline.js）与大盘指数（services/indexes.js）共用这套实现，
 * 避免两处各写一份 fetch / hosts / 解析器而逐渐走样（如少了 http 兜底域名）。
 */
import { byDateAsc } from '../utils/sort'

// 腾讯历史K：ifzq.gtimg.cn（无 web. 前缀）为当前可用入口；
// web.ifzq.gtimg.cn 近期被腾讯 WAF 风控拦截（501），作为备用域名保留轮询
export const TENCENT_HOSTS = [
  'https://ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
]
// 东方财富：部分网络下 https 会被服务端断开（TLS 异常），
// 页面本身非 https 时可追加 http 兜底（https 页面下浏览器会拦 http 混内容，故不加）
export const EM_HOSTS = ['https://push2his.eastmoney.com/api/qt/stock/kline/get']
const proto = typeof location !== 'undefined' ? location.protocol : ''
if (proto === 'http:' || proto === 'file:') {
  EM_HOSTS.push('http://push2his.eastmoney.com/api/qt/stock/kline/get')
}

/** 轻量 fetch（带超时） */
export async function getJSON(url) {
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

/** 去重并按日期升序：[[date, close], ...] */
export function sortDays(list) {
  const map = new Map()
  for (const [d, c] of list) {
    const cv = Number(c)
    if (d && cv > 0) map.set(d, cv)
  }
  return [...map.entries()].sort(byDateAsc)
}

/**
 * 腾讯日K（A股/港股个股、指数符号均可）
 * @returns {Array|null} [[date, close], ...] 升序，失败返回 null
 */
export async function tencentDay(symbol, from, to) {
  for (const base of TENCENT_HOSTS) {
    try {
      const url = `${base}?param=${symbol},day,${from},${to},800,qfq`
      const j = await getJSON(url)
      if (!j || j.code !== 0) continue
      const node = j.data && (j.data[symbol] || j.data[Object.keys(j.data || {})[0]])
      if (!node) continue
      const rows = node.qfqday || node.day || []
      const out = rows.map((r) => [r[0], Number(r[2])]).filter((x) => x[0] && x[1] > 0)
      if (out.length) return sortDays(out)
    } catch {
      /* 该域名被拦/超时，换下一个域名重试 */
    }
  }
  return null
}

/**
 * 东方财富日K（前复权）
 * @param {Array} secids 候选 secid，逐个尝试；每个再逐个尝试可用域名
 * @returns {Array|null} [[date, close], ...] 升序，失败返回 null
 */
export async function eastmoneyDay(secids, from, to) {
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
        if (out.length) return sortDays(out)
      } catch {
        /* 换下一个域名 / 市场码 */
      }
    }
  }
  return null
}
