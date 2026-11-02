import { tencentDay, eastmoneyDay, sinaDay } from './market-day'

/**
 * 大盘指数：用于资产曲线的收益对比。
 *
 * 指数不能沿用个股的日K管道：中证指数代码（000300 / 000905）会被个股解析器
 * 判成深市（sz000300 / 0.000300），实际在上交所（sh000300 / 1.000300），
 * 因此这里为每个指数写死各源的符号，逐个尝试直到拿到数据。
 * 实测可用：腾讯 sh000300 / sh000905 / hkHSI；东财 1.000300 / 1.000905 / 100.HSI / 100.NDX；
 * 新浪 jsonp .NDX（雅虎 chart 当前返回 403，腾讯无纳指日K）
 *
 * 纳指100 是唯一腾讯取不到的指数，原先只依赖东财；东财在部分网络下会被服务端断开
 * TLS（且 https 页面无法降级 http），此时纳指100 会一直显示「无数据」—— 故补新浪兜底。
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
// 新浪符号（jsonp 兜底，见文件头说明）
const SINA_SYMBOL = { ndx: '.NDX' }

// 东方财富指数日线：[[date, close]] 升序（与个股共用抓取层，含 http 兜底域名）
function emDays(secid, from, to) {
  return eastmoneyDay([secid], from, to)
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
      if (TENCENT_SYMBOL[key]) days = await tencentDay(TENCENT_SYMBOL[key], from, to)
      if (!days && EM_SID[key]) days = await emDays(EM_SID[key], from, to)
      if (!days && SINA_SYMBOL[key]) days = await sinaDay(SINA_SYMBOL[key], from, to)
      out[key] = { days: days || [], ok: !!(days && days.length) }
    })
  )
  return out
}
