/**
 * 常用排序比较器。
 * 日期统一用 YYYY-MM-DD 字符串直接比较（字典序 = 时间序），不必转成 Date/dayjs。
 */

/** [[日期, 值]] 数组按日期升序 */
export const byDateAsc = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)

/** 带 .date 字段的对象数组按日期升序 */
export const byDateFieldAsc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
