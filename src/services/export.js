import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import dayjs from 'dayjs'
import { fmtMoney, fmtNum, fmtShares, fmtPct, typeLabel, marketLabel } from '../utils/format'

/** 组装导出数据 */
export function buildReportData(store) {
  const positions = store.positions.map((p) => ({
    名称: p.name || p.code,
    代码: p.code,
    市场: marketLabel(p.market),
    持仓数量: p.shares,
    成本价: p.avgCost,
    现价: p.quote ? p.quote.price : null,
    市值_CNY: p.mvCny,
    浮动盈亏_CNY: p.pnlCny,
    盈亏比例: p.avgCost > 0 ? ((p.price - p.avgCost) / p.avgCost) * 100 : null
  }))

  const trades = store.trades.map((t) => ({
    日期: t.date,
    市场: marketLabel(t.market),
    代码: t.code,
    名称: t.name,
    类型: typeLabel(t.type),
    数量: t.shares || null,
    价格: t.price || null,
    金额: t.type === 'div' ? t.amount : (t.type === 'gift' ? null : Number(t.price) * Number(t.shares)),
    费用: t.fee || null,
    税费: t.tax || null,
    备注: t.note || ''
  }))

  const monthly = store.monthly.map((m) => ({
    月份: m.month,
    已实现盈亏: m.realized,
    其中分红: m.div,
    交易笔数: m.count
  }))

  const yearly = store.yearly.map((y) => ({
    年份: y.year,
    已实现盈亏: y.realized,
    其中分红: y.div,
    交易笔数: y.count
  }))

  const yearlyDetail = store.yearlyDetail.map((d) => ({
    年份: d.year,
    市场: marketLabel(d.market),
    代码: d.code,
    名称: d.name,
    已实现盈亏: d.realized,
    其中分红: d.div
  }))

  const summary = {
    总资产_CNY: store.totals.totalAssets,
    现金_CNY: store.totals.cash,
    持仓市值_CNY: store.totals.mvTotal,
    累计总盈亏_CNY: store.totals.totalPnl,
    总收益率: store.totals.totalPnlPct,
    已实现盈亏_CNY: store.totals.totalRealized,
    浮动盈亏_CNY: store.totals.floating
  }

  return { positions, trades, monthly, yearly, yearlyDetail, summary }
}

export function exportExcel(data) {
  const wb = XLSX.utils.book_new()

  const summarySheet = XLSX.utils.json_to_sheet([data.summary])
  XLSX.utils.book_append_sheet(wb, summarySheet, '总览')

  const positionsSheet = XLSX.utils.json_to_sheet(data.positions)
  XLSX.utils.book_append_sheet(wb, positionsSheet, '持仓')

  const tradesSheet = XLSX.utils.json_to_sheet(data.trades)
  XLSX.utils.book_append_sheet(wb, tradesSheet, '交易流水')

  const monthlySheet = XLSX.utils.json_to_sheet(data.monthly)
  XLSX.utils.book_append_sheet(wb, monthlySheet, '月度盈亏')

  const yearlySheet = XLSX.utils.json_to_sheet(data.yearly)
  XLSX.utils.book_append_sheet(wb, yearlySheet, '年度盈亏')

  const yearlyDetailSheet = XLSX.utils.json_to_sheet(data.yearlyDetail)
  XLSX.utils.book_append_sheet(wb, yearlyDetailSheet, '年度个股明细')

  XLSX.writeFile(wb, `股票记账_${dayjs().format('YYYYMMDD_HHmm')}.xlsx`)
}

// ---------- PDF（用 Canvas 渲染表格以支持中文） ----------
const PAGE_W = 1240
const PAGE_H = 1754
const M_L = 70
const M_R = 70
const M_T = 150
const M_B = 70
const HEADER_H = 60
const ROW_H = 44

function drawTablePage(ctx, columns, colWidths, rows, pageRows, startIdx, title, subtitle) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, PAGE_W, PAGE_H)

  // 标题
  ctx.fillStyle = '#0f9d78'
  ctx.font = 'bold 44px sans-serif'
  ctx.fillText(title, M_L, 60)

  if (subtitle) {
    ctx.fillStyle = '#64748b'
    ctx.font = '24px sans-serif'
    ctx.fillText(subtitle, M_L, 108)
  }

  const tableW = PAGE_W - M_L - M_R
  ctx.fillStyle = '#0f9d78'
  ctx.fillRect(M_L, M_T, tableW, HEADER_H)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 26px sans-serif'
  let x = M_L
  columns.forEach((c, i) => {
    ctx.fillText(c, x + 12, M_T + HEADER_H / 2 + 9)
    x += colWidths[i]
  })

  ctx.font = '22px sans-serif'
  let y = M_T + HEADER_H
  for (let i = 0; i < pageRows.length; i++) {
    const row = rows[startIdx + i]
    if (i % 2 === 1) {
      ctx.fillStyle = '#f1f5f9'
      ctx.fillRect(M_L, y, tableW, ROW_H)
    }
    ctx.fillStyle = '#334155'
    x = M_L
    columns.forEach((c, ci) => {
      ctx.fillText(String(row[c] ?? ''), x + 12, y + ROW_H / 2 + 8)
      x += colWidths[ci]
    })
    y += ROW_H
  }
}

function renderTableToPdf(doc, { title, subtitle, columns, rows, weights }) {
  const tableW = PAGE_W - M_L - M_R
  const colWidths = weights.map((w) => (tableW * w) / weights.reduce((a, b) => a + b, 0))
  const perPage = Math.max(1, Math.floor((PAGE_H - M_T - M_B) / ROW_H))
  const pages = Math.max(1, Math.ceil(rows.length / perPage))

  for (let pi = 0; pi < pages; pi++) {
    const canvas = document.createElement('canvas')
    canvas.width = PAGE_W
    canvas.height = PAGE_H
    const ctx = canvas.getContext('2d')
    const start = pi * perPage
    const pageRows = rows.slice(start, start + perPage)
    drawTablePage(ctx, columns, colWidths, rows, pageRows, start, pi > 0 ? title : title, subtitle)
    if (pi > 0) doc.addPage()
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297)
  }
}

export function exportPdf(data) {
  const doc = new jsPDF('p', 'mm', 'a4')

  const summaryText = `总资产 ¥${fmtNum(data.summary.总资产_CNY, 0)}　累计盈亏 ¥${fmtNum(data.summary.累计总盈亏_CNY, 0)}　收益率 ${data.summary.总收益率 == null ? '—' : fmtPct(data.summary.总收益率)}　现金 ¥${fmtNum(data.summary.现金_CNY, 0)}`

  if (data.positions.length) {
    renderTableToPdf(doc, {
      title: '当前持仓',
      subtitle: summaryText,
      columns: ['名称', '代码', '市场', '持仓量', '成本价', '现价', '市值(¥)', '浮动盈亏(¥)', '盈亏%'],
      rows: data.positions,
      weights: [10, 7, 5, 7, 7, 7, 9, 10, 7]
    })
  } else {
    doc.text('暂无持仓', 14, 30)
  }

  if (data.trades.length) {
    renderTableToPdf(doc, {
      title: '交易流水',
      subtitle: `共 ${data.trades.length} 条记录`,
      columns: ['日期', '市场', '代码', '名称', '类型', '数量', '价格', '金额', '备注'],
      rows: data.trades,
      weights: [9, 5, 7, 9, 6, 7, 7, 9, 12]
    })
  }

  if (data.monthly.length) {
    renderTableToPdf(doc, {
      title: '月度盈亏',
      subtitle: '',
      columns: ['月份', '已实现盈亏', '其中分红', '交易笔数'],
      rows: data.monthly,
      weights: [8, 8, 8, 6]
    })
  }

  doc.save(`股票记账_${dayjs().format('YYYYMMDD_HHmm')}.pdf`)
}
