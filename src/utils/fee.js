/**
 * 券商佣金档位与手续费估算。
 *
 * 同一券商对不同品种的费率不同（例如 A股 万1.654、ETF/LOF 万0.55、可转债 万0.1，
 * 且各档最低收费也可能不同），所以按「资产类别」分档；没配到的档位落到兜底档。
 * 档位 key 与资产类别保持一致：stock / fund / bond（见 utils/format 的 ASSET_CLASSES）。
 *
 * 只算佣金 —— 印花税、过户费、港股交易征费等仍在表单里单独填（各地规则差异大，
 * 券商之间也不统一，自动算出来反而容易错）。估算值只是表单的默认值，用户可以改。
 */

/** 档位定义：顺序即界面展示顺序 */
export const FEE_TIERS = [
  { key: 'stock', label: '股票' },
  { key: 'fund', label: '基金' },
  { key: 'bond', label: '可转债' },
  { key: 'default', label: '兜底' }
]

export function tierLabel(key) {
  const t = FEE_TIERS.find((x) => x.key === key)
  return t ? t.label : key
}

function hasRate(t) {
  return !!t && (Number(t.rate) > 0 || Number(t.min) > 0)
}

/**
 * 取适用于该资产类别的档位：先按类别精确匹配，没有再落兜底档，都没有返回 null。
 * cfg 既可以是 { tiers: [...] }（新），也可以是 { rate, min }（老的单档配置）
 */
export function pickTier(cfg, assetClass) {
  if (!cfg) return null
  const tiers = Array.isArray(cfg.tiers) ? cfg.tiers : []
  if (tiers.length) {
    const exact = tiers.find((t) => t.key === assetClass && hasRate(t))
    if (exact) return exact
    const fallback = tiers.find((t) => t.key === 'default' && hasRate(t))
    return fallback || null
  }
  return hasRate(cfg) ? cfg : null
}

/**
 * 按券商费率估算手续费：成交金额 × 该档费率，不足最低收费时按最低收，四舍五入到分。
 *
 * @param {number} amount 成交金额（不含费用）
 * @param {{tiers?: Array}|{rate?: number, min?: number}} cfg 券商佣金配置
 * @param {string} [assetClass] 资产类别 stock / fund / bond，缺省时只用兜底档
 * @returns {number} 手续费，未配置对应档位时返回 0
 */
export function calcBrokerFee(amount, cfg, assetClass) {
  const a = Number(amount) || 0
  if (a <= 0) return 0
  const tier = pickTier(cfg, assetClass)
  if (!tier) return 0
  const rate = Number(tier.rate) || 0
  const min = Number(tier.min) || 0
  const fee = rate > 0 ? Math.max(a * rate, min) : min
  return Math.round(fee * 100) / 100
}

/** 费率转「万分之几」显示口径（万2.5 → 2.5），去掉多余小数 */
export function rateToWan(rate) {
  const n = Number(rate) || 0
  return n > 0 ? Math.round(n * 10000 * 1000) / 1000 : 0
}

/** 「万分之几」录入值转存储用小数（2.5 → 0.00025） */
export function wanToRate(wan) {
  const n = Number(wan) || 0
  return n > 0 ? n / 10000 : 0
}

/** 档位摘要文案：股票 万1.654（最低5元） · 基金 万1 */
export function feeSummary(cfg) {
  const tiers = (cfg && Array.isArray(cfg.tiers) ? cfg.tiers : []).filter(hasRate)
  if (!tiers.length) return ''
  return tiers
    .map((t) => {
      const wan = rateToWan(t.rate)
      const head = wan > 0 ? `万${wan}` : '固定'
      const min = Number(t.min) || 0
      return `${tierLabel(t.key)} ${head}${min > 0 ? `（最低${min}元）` : ''}`
    })
    .join(' · ')
}
