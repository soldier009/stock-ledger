/**
 * 按券商佣金配置估算手续费。
 *
 * 规则与常见券商一致：成交金额 × 佣金率，不足最低佣金时按最低收，四舍五入到分。
 * 只算佣金 —— 印花税、过户费、港股交易征费等仍在表单里单独填（各地规则差异大，
 * 券商之间也不统一，自动算出来反而容易错）。估算值只是表单的默认值，用户可以改。
 *
 * @param {number} amount 成交金额（不含费用）
 * @param {{rate?: number, min?: number}} cfg 券商佣金配置，rate 为小数（万2.5 = 0.00025）
 * @returns {number} 手续费，未配置时返回 0
 */
export function calcBrokerFee(amount, cfg) {
  const a = Number(amount) || 0
  const rate = Number(cfg && cfg.rate) || 0
  const min = Number(cfg && cfg.min) || 0
  if (a <= 0) return 0
  if (rate <= 0 && min <= 0) return 0
  const fee = rate > 0 ? Math.max(a * rate, min) : min
  return Math.round(fee * 100) / 100
}
