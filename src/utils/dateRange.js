import dayjs from 'dayjs'

// 日期区间页签（自定义档用起止日期）：分析页回撤与交易页筛选共用，保证两处口径一致
export const RANGE_OPTIONS = [
  { label: '近一月', key: '1m' },
  { label: '近三月', key: '3m' },
  { label: '近一年', key: '1y' },
  { label: '全部', key: 'all' },
  { label: '自定义', key: 'custom', icon: true }
]

/**
 * 区间的起止时间（dayjs）。
 * 自定义档没填日期时回退到近一月，避免出现「结束早于开始」的空区间。
 */
export function rangeBounds(key, customStart = '', customEnd = '') {
  const today = dayjs()
  let start
  switch (key) {
    case '7d': start = today.subtract(7, 'day'); break
    case '30d': start = today.subtract(30, 'day'); break
    case 'mtd': start = today.startOf('month'); break
    case '1m': start = today.subtract(1, 'month'); break
    case '3m': start = today.subtract(3, 'month'); break
    case 'ytd': start = today.startOf('year'); break
    case '1y': start = today.subtract(1, 'year'); break
    case 'all': start = dayjs('1900-01-01'); break
    case 'custom': start = customStart ? dayjs(customStart) : today.subtract(1, 'month'); break
    default: start = today.subtract(1, 'month')
  }
  const end = key === 'custom' && customEnd ? dayjs(customEnd) : today
  return { start, end }
}

/** 'YYYY-MM-DD' 是否落在区间内（首尾都算） */
export function inRange(dateStr, start, end) {
  if (!dateStr) return false
  const d = dayjs(dateStr).format('YYYY-MM-DD')
  return d >= start.format('YYYY-MM-DD') && d <= end.format('YYYY-MM-DD')
}

/** 区间的人话描述，用于空态提示 */
export function rangeLabel(key, customStart = '', customEnd = '') {
  const { start, end } = rangeBounds(key, customStart, customEnd)
  const s = start.format('YYYY-MM-DD')
  const e = end.format('YYYY-MM-DD')
  return {
    '7d': '最近 7 天',
    '30d': '最近 30 天',
    mtd: '本月',
    '1m': '近一月',
    '3m': '近三月',
    ytd: '今年以来',
    '1y': '近一年',
    all: '全部日期'
  }[key] || `${s} ~ ${e}`
}
