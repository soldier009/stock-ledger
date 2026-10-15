import { parseTags } from './format'

// 资产构成的两个分组维度：
//   tag     = 资产类别（标的上的标签，取第一个标签分组，与「持仓分布-按标签」同口径）
//   purpose = 用途标签（与资产类别并列的第二个维度，单值）
export const DIM_TAG = 'tag'
export const DIM_PURPOSE = 'purpose'
// 按个股：不做分组，每只持仓单独一块（与总览「持仓分布-按个股」同口径）
export const DIM_STOCK = 'stock'
export const UNTAGGED = '未分类'
export const CASH_COLOR = '#cbd5e1'
export const PALETTE = [
  '#dc2626',
  '#3b82f6',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#14b8a6',
  '#f97316',
  '#64748b'
]

export function dimLabel(dim) {
  if (dim === DIM_STOCK) return '标的'
  return dim === DIM_PURPOSE ? '用途' : '资产类别'
}

export function otherDim(dim) {
  return dim === DIM_PURPOSE ? DIM_TAG : DIM_PURPOSE
}

/** 某条持仓在指定维度下的原始值，未设置时返回空字符串 */
export function dimKeyOf(p, dim) {
  if (dim === DIM_PURPOSE) return String(p.purpose || '').trim()
  const tags = parseTags(p.tag)
  return tags.length ? String(tags[0] || '').trim() : ''
}

/** 某条持仓是否属于该维度下的某个分组（未设置归入「未分类」） */
export function matchDim(p, dim, key) {
  return (dimKeyOf(p, dim) || UNTAGGED) === key
}

/**
 * 按维度对持仓分组（金额口径 = 实时市值 mvCny）
 * includeUntagged: 为 false 时丢弃未设置该维度的持仓，避免「未分类」占位
 */
export function groupBy(positions, dim, { includeUntagged = false } = {}) {
  const map = {}
  for (const p of positions) {
    const raw = dimKeyOf(p, dim)
    const key = raw || UNTAGGED
    if (!raw && !includeUntagged) continue
    const g = map[key] || (map[key] = { key, name: key, value: 0, count: 0, items: [] })
    g.value += Number(p.mvCny) || 0
    g.count += 1
    g.items.push(p)
  }
  return Object.values(map).sort((a, b) => b.value - a.value)
}

/** 未设置该维度的持仓合计（用于提示「还有多少未计入」） */
export function untaggedOf(positions, dim) {
  let value = 0
  let count = 0
  for (const p of positions) {
    if (dimKeyOf(p, dim)) continue
    value += Number(p.mvCny) || 0
    count += 1
  }
  return { value, count }
}
