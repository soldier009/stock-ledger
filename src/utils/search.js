/**
 * 关键词匹配：名称 / 代码 / 备注 / 券商 / 标签 / 用途。
 * 规则刻意做得很宽松——忽略大小写与空格，只要包含即命中：
 * 搜「600519」「600 519」「贵州」都应该找得到。
 */

const squash = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, '')

export function normKeyword(kw) {
  return squash(kw)
}

/** 关键词为空时视为全部命中，调用方无需分支 */
export function matchFields(kw, ...fields) {
  const k = normKeyword(kw)
  if (!k) return true
  return fields.some((f) => squash(f).includes(k))
}

export function matchTrade(kw, t) {
  return matchFields(kw, t.name, t.code, t.note, t.broker)
}

export function matchFlow(kw, c) {
  return matchFields(kw, c.note, c.broker)
}

/** 持仓：代码/名称/标签/用途都算，标签是 JSON 数组字符串，先取人类可读的形式 */
export function matchPosition(kw, p, parseTags) {
  const tags = parseTags ? parseTags(p.tag) : []
  return matchFields(kw, p.name, p.code, (tags || []).join(' '), p.purpose, p.broker)
}
