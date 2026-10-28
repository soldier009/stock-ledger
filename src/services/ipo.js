/**
 * 新股（IPO）数据源
 *
 * 自动：iTick（api.itick.org/stock/ipo）—— 目前唯一覆盖 A/港/美且允许浏览器直连（CORS: *）的新股接口，
 *   文档 https://docs.itick.org/zh-cn/rest-api/stocks/stock-ipo
 *   响应字段：dt 上市日(ms) / cn 公司名 / sc 代码 / ex 交易所 / mc 市值 / pr 价格(可能是区间) /
 *            ct 国家 / bs 申购开始(s) / es 申购截止(s) / ro 公布中签结果(s)
 *   注意：iTick **不提供暗盘**数据，港股暗盘按「上市日的前一个工作日」推算（见 prevWeekday）。
 *
 * 手动：接口没配 key、额度用尽或拉失败时，用户在日历页自行录入，数据存本地 IndexedDB。
 * 两者按 id（市场:代码:上市日）合并去重，手动记录优先。
 */
const ITICK_HOST = 'https://api.itick.org/stock/ipo'

// iTick 按 region 查，A 股拆成上证/深证两次查询后合并
export const ITICK_REGIONS = { A: ['SH', 'SZ'], HK: ['HK'], US: ['US'] }

export const MARKET_LABEL = { A: 'A股', HK: '港股', US: '美股' }

/** 时间戳转 YYYY-MM-DD（ms=true 时入参为毫秒，否则为秒） */
function tsToDate(ts, ms = true) {
  if (!ts) return ''
  const d = new Date(ms ? Number(ts) : Number(ts) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

/** 取价格里的第一个数字（"3.50-4.50" → 3.5），用于估算首日涨幅 */
export function parseIssuePrice(pr) {
  const m = String(pr || '').match(/\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}

/**
 * 上一个工作日（周一~周五）
 * 港股暗盘在上市前一交易日的收盘后，这里只用工作日近似 —— 不排除公众假期，
 * 且只显示日期不显示价格，避免给出编造的数据。
 */
export function prevWeekday(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return ''
  for (let i = 1; i <= 7; i++) {
    const t = new Date(d.getTime() - i * 86400000)
    const w = t.getUTCDay()
    if (w !== 0 && w !== 6) return t.toISOString().slice(0, 10)
  }
  return ''
}

async function fetchOne(token, region, type) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(`${ITICK_HOST}?type=${type}&region=${region}`, {
      headers: { accept: 'application/json', token },
      signal: ctrl.signal,
      cache: 'no-store'
    })
    // 免费套餐限每分钟 5 次调用，超限会返回 429
    if (res.status === 429) throw new Error('请求过于频繁：免费套餐每分钟 5 次调用，请稍候再试')
    if (res.status === 401 || res.status === 403) throw new Error('API key 无效或额度已用尽')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const j = await res.json()
    if (j.code !== 0) throw new Error(j.msg || '接口返回错误')
    return (j.data && j.data.content) || []
  } finally {
    clearTimeout(timer)
  }
}

function normalize(raw, market) {
  const listingDate = tsToDate(raw.dt)
  if (!listingDate) return null
  const code = String(raw.sc || '').trim()
  if (!code) return null
  const item = {
    id: `${market}:${code}:${listingDate}`,
    market,
    code,
    name: raw.cn || code,
    exchange: raw.ex || '',
    marketCap: raw.mc || '',
    issuePriceRaw: raw.pr || '',
    issuePrice: parseIssuePrice(raw.pr),
    subscribeStart: tsToDate(raw.bs, false),
    subscribeEnd: tsToDate(raw.es, false),
    resultDate: tsToDate(raw.ro, false),
    listingDate,
    darkPoolDate: '',
    source: 'itick',
    updatedAt: Date.now()
  }
  // 暗盘只有港股有，按上市日前一个工作日推算
  if (market === 'HK') item.darkPoolDate = prevWeekday(listingDate)
  return item
}

/**
 * 拉取三地新股。单个市场失败不影响其它市场；全部失败才抛错，由调用方降级到手动数据。
 * @param {string} token iTick API key
 * @param {'upcoming'|'recent'} type
 * @returns {Promise<Array>} 归一化后的新股列表
 */
export async function fetchItickIpos(token, type = 'upcoming') {
  if (!token) throw new Error('未配置 iTick API key')
  const jobs = []
  for (const [market, regions] of Object.entries(ITICK_REGIONS)) {
    for (const r of regions) jobs.push({ market, region: r })
  }
  const settled = await Promise.allSettled(jobs.map((j) => fetchOne(token, j.region, type)))
  const out = []
  let failed = 0
  // 保留第一个失败原因：429 限流、401 key 无效、套餐不支持等信息都在里面，
  // 不能只报「拉取失败」，否则用户无从判断
  let firstErr = null
  settled.forEach((res, i) => {
    if (res.status !== 'fulfilled') {
      failed++
      if (!firstErr) firstErr = res.reason
      return
    }
    for (const raw of res.value) {
      const item = normalize(raw, jobs[i].market)
      if (item) out.push(item)
    }
  })
  if (!out.length) {
    const reason = firstErr ? String(firstErr.message || firstErr) : ''
    throw new Error(reason || (failed === jobs.length ? '三个市场都拉取失败' : '接口未返回新股数据'))
  }
  return out
}

/**
 * 测试 API key 是否可用：只发一个请求（港股），尽量少占免费额度（每分钟 5 次）。
 * @returns {Promise<{count:number}>} 成功时返回本次拉到的条数（0 条也说明 key 是好的）
 * @throws 失败原因原文：401 无效 / 429 超限 等
 */
export async function testIpoConnection(token) {
  if (!token) throw new Error('API key 为空')
  const rows = await fetchOne(token, 'HK', 'upcoming')
  return { count: Array.isArray(rows) ? rows.length : 0 }
}

/**
 * 东方财富 A 股新股名单（已上市的次新股）。
 *
 * 这是 iTick 之外的自动兜底：支持 CORS（ACAO:*）、浏览器可直连、**不需要任何 key**。
 * 代价是信息少 —— 只拿得到 代码 / 名称 / 上市日期，没有招股期、中签日、发行价；
 * 且列表里都是**已上市**的（有现价），不含正在招股的未上市新股。
 * 东财限流较严，失败时抛错，由调用方降级到手动录入。
 *
 * @returns {Promise<Array>} 规范化后的新股记录（market 固定为 A）
 */
export async function fetchEmNewStocks() {
  // fs=m:0+f:8 是「新股」筛选；f12 代码 / f14 名称 / f26 上市日期（实测确认）
  const url =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f26' +
    '&fs=m:0+f:8&fields=f12,f14,f26'
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error('东财接口 HTTP ' + res.status)
  const j = await res.json()
  const diff = j && j.data && j.data.diff
  if (!diff) throw new Error('东财未返回新股数据（可能限流，请稍后再试）')
  const rows = Array.isArray(diff) ? diff : Object.values(diff)
  const out = []
  for (const r of rows) {
    const code = String((r && r.f12) || '').trim()
    const name = String((r && r.f14) || '').trim()
    const ymd = String((r && r.f26) || '').trim()
    // f26 形如 20260203
    const listingDate = /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ''
    if (!code || !name || !listingDate) continue
    out.push({
      id: `A:${code}:${listingDate}`,
      market: 'A',
      code,
      name,
      exchange: '',
      issuePriceRaw: '',
      issuePrice: null,
      marketCap: '',
      subscribeStart: '',
      subscribeEnd: '',
      resultDate: '',
      listingDate,
      darkPoolDate: '',
      status: 'listed',
      source: 'em',
      updatedAt: Date.now()
    })
  }
  return out
}

/**
 * 解析从网页表格复制的文本（TSV / CSV）。
 *
 * 浏览器抓不了别的网站（CORS），但「你自己复制 + 粘贴进来」不受限制，
 * 所以这是拿完整字段（招股期、中签日、发行价）最实用的办法。
 *
 * 按**表头中文名**匹配字段而不是按列序号 —— 列序一变就全错，而中文表头相对稳定。
 * 已适配东方财富新股页表头：股票代码 / 股票简称 / 申购日期 / 中签号公布日 / 上市日期 / 发行价格
 *
 * @param {string} text 粘贴的表格文本
 * @param {'A'|'HK'|'US'} defaultMarket 表头里认不出市场时用这个
 * @param {'ipo'|'cb'} kind 新股还是可转债 —— 两者表头差别较大，各用一套别名
 * @returns {{rows:Array, headers:string[], skipped:number, matched:Object}}
 */
/**
 * 集思录的数据接口返回 {"rows":[{"cell":{...}}]} 这种结构。
 * 它的接口**不支持 CORS**，程序抓不到；但用户在浏览器里打开接口地址就能看到整段 JSON，
 * 复制进来即可 —— 比复制表格更准：不用猜表头，字段含义是确定的。
 *
 * 三个接口共用这套结构，靠字段自动区分类型（有 bond_id 就是可转债）：
 *   待发可转债 /data/cbnew/pre_list/          bond_id / bond_nm / apply_date / list_date / rating_cd / convert_price
 *   A股新股   /data/new_stock/sub/           stock_cd / stock_nm / apply_dt / list_dt / issue_price
 *   港股新股   /data/new_stock/hkipo/         stock_cd / stock_nm / apply_dt / apply_end_dt / list_dt / price_range
 *
 * @returns {null|{rows:Array, headers:Array, skipped:number, matched:Object}} 不是这个结构就返回 null
 */
export function parseJisiluJson(text, defaultMarket = 'A') {
  let j = null
  try {
    j = JSON.parse(String(text || '').trim())
  } catch {
    return null
  }
  // 整页复制是 {"page":1,"rows":[...]}；也可能只复制了其中一条 {"id":..,"cell":{..}}
  const rows = Array.isArray(j)
    ? j
    : Array.isArray(j && j.rows)
      ? j.rows
      : j && j.cell
        ? [j]
        : null
  if (!rows) return null
  const cells = rows.map((r) => (r && r.cell ? r.cell : r)).filter((c) => c && typeof c === 'object')
  // 得长得像集思录的记录（有代码字段），否则交回给表格解析处理
  if (!cells.length || !cells.some((c) => c.bond_id || c.stock_cd)) return null

  const out = []
  let skipped = 0
  for (const c of cells) {
    const isCb = !!c.bond_id
    const code = String(isCb ? c.bond_id : c.stock_cd || '').trim()
    const name = String(isCb ? c.bond_nm : c.stock_nm || '').trim()
    if (!code) {
      skipped++
      continue
    }
    let subscribeStart = toIsoDate(c.apply_date ?? c.apply_dt)
    let listingDate = toIsoDate(c.list_date ?? c.list_dt)
    // 港股日期不带年份（10-28(周三) 按当前年补），上市早于招股说明跨到次年
    if (subscribeStart && listingDate && listingDate < subscribeStart) listingDate = bumpYear(listingDate)
    out.push(
      normalizeManual({
        kind: isCb ? 'cb' : 'ipo',
        market: isCb ? 'A' : guessMarket(code, defaultMarket),
        code,
        name: name || code,
        underlyingCode: isCb ? String(c.stock_id || '') : '',
        underlyingName: isCb ? String(c.stock_nm || '') : '',
        bondRating: isCb ? String(c.rating_cd || '') : '',
        convertPrice: isCb ? String(c.convert_price || '') : '',
        issuePriceRaw: !isCb ? String(c.issue_price ?? c.price_range ?? '') : '',
        issueAmount: String((isCb ? c.cb_amount : c.amount) ?? ''),
        onlineIssue: String(c.online_amount ?? ''),
        // lucky_draw_rt 已经是百分数值，原样显示；界面上再拼 %
        winRate: pctText(c.lucky_draw_rt),
        subscribeLimit: String(c.individual_limit ?? ''),
        issuePe: !isCb ? String(c.issue_pe ?? c.pe ?? '') : '',
        sponsor: String(c.sponsor ?? c.sponsor_nm ?? ''),
        cornerstone: String(c.cornerstone ?? c.cornerstone_nm ?? ''),
        subscribeStart,
        subscribeEnd: toIsoDate(c.apply_end_dt),
        listingDate
      })
    )
  }
  return { rows: out, headers: [], skipped, matched: { source: 'jisilu-json' } }
}

export function parsePastedTable(text, defaultMarket = 'A', kind = 'ipo') {
  // 粘进来的是 JSON（从集思录接口地址复制的）就走 JSON 解析，字段更准且不用猜表头
  const t = String(text || '').trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = parseJisiluJson(t, defaultMarket)
    if (j) return j
  }
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return { rows: [], headers: [], skipped: 0, matched: {} }

  // 网页复制通常是 TSV；也兼容 CSV 与「两格以上空格」对齐的纯文本
  const splitLine = (line) =>
    line.includes('\t') ? line.split('\t') : line.includes(',') ? line.split(',') : line.split(/\s{2,}/)
  const cells = lines.map(splitLine)

  // 第一行当表头；若没有任何一个字段能匹配上，就当它是数据行（无表头的复制）。
  // 集思录的表头会为了排版插空格/换行（「代 码」「转股\n溢价率」），先去掉所有空白再比对
  const headers = cells[0].map((h) => String(h || '').replace(/\s+/g, ''))
  // 先按完整表头精确匹配，再退而求其次做包含匹配。
  // 否则「代码」会被「申购代码」抢走（'申购代码'.includes('代码') 成立），把临时申购码当成正式代码
  const findCol = (aliases) => {
    for (const a of aliases) {
      const i = headers.findIndex((h) => h === a)
      if (i >= 0) return i
    }
    for (const a of aliases) {
      const i = headers.findIndex((h) => h.includes(a))
      if (i >= 0) return i
    }
    return -1
  }
  // 别名同时覆盖东方财富与集思录两套表头。
  // 集思录港股给的是「申购起始 / 申购截止」这一对招股区间（东财只有单个申购日），
  // 集思录 A股给的是「申购日 / 缴款日 / 上市日期」，两边最终都落到同一套字段上
  // 新股与可转债的表头差别较大，各用一套别名。转债那套还认「正股代码/正股名称」——
  // 光看「莱特转债」认不出是哪家公司，得把正股带上
  const ALIASES =
    kind === 'cb'
      ? {
          code: ['转债代码', '债券代码', '代码', '申购代码'],
          name: ['转债名称', '债券简称', '债券名称', '名称', '简称'],
          underlyingCode: ['正股代码', '股票代码'],
          underlyingName: ['正股名称', '股票名称', '正股简称', '股票简称'],
          subscribeStart: ['申购日期', '申购日', '网上申购日', '申购'],
          subscribeEnd: ['申购截止', '截止日'],
          resultDate: ['中签号公布日', '中签公布日', '缴款日', '公布日'],
          listingDate: ['上市日期', '上市日', '预计上市日', '上市时间'],
          bondRating: ['债券评级', '债项评级', '评级'],
          convertPrice: ['转股价', '初始转股价'],
          premiumRate: ['转股溢价率', '溢价率'],
          issuePriceRaw: ['发行价格', '发行价', '面值']
        }
      : {
          code: ['股票代码', '证券代码', '代码', '申购代码'],
          name: ['股票简称', '证券简称', '简称', '股票名称', '名称'],
          subscribeStart: ['申购起始', '申购日期', '申购日', '招股起始日', '发售起始日', '开始申购日'],
          subscribeEnd: ['申购截止', '招股截止日', '发售截止日', '申购截止日', '截止日'],
          resultDate: ['中签号公布日', '中签号发布日', '中签公布日', '公布中签日', '缴款日', '公布日'],
          listingDate: ['上市日期', '上市日', '上市时间', '上市首日'],
          issuePriceRaw: ['发行价格', '发行价', '询价区间', '价格(元)', '认购价格']
        }
  const matched = {}
  for (const key of Object.keys(ALIASES)) matched[key] = findCol(ALIASES[key])
  const hasHeader = Object.values(matched).some((i) => i >= 0)
  const body = hasHeader ? cells.slice(1) : cells

  const pick = (row, i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '')

  const rows = []
  let skipped = 0
  for (const row of body) {
    const code = pick(row, matched.code)
    const name = pick(row, matched.name)
    const subscribeStart = toIsoDate(pick(row, matched.subscribeStart))
    let subscribeEnd = toIsoDate(pick(row, matched.subscribeEnd))
    let listingDate = toIsoDate(pick(row, matched.listingDate))
    if (!code || (!name && !listingDate)) {
      // 空行、说明行、分隔行都跳过
      skipped++
      continue
    }
    // 集思录港股日期不带年份（按当前年补）。若截止/上市反倒早于招股，说明跨到了次年
    if (subscribeStart && subscribeEnd && subscribeEnd < subscribeStart) subscribeEnd = bumpYear(subscribeEnd)
    if (subscribeStart && listingDate && listingDate < subscribeStart) listingDate = bumpYear(listingDate)

    const market = guessMarket(code, defaultMarket)
    const issuePriceRaw = pick(row, matched.issuePriceRaw)
    rows.push(
      normalizeManual({
        kind,
        market,
        code,
        name: name || code,
        // 新股这套别名里没有这些键，matched.xxx 为 undefined，pick 会返回空串
        underlyingCode: pick(row, matched.underlyingCode),
        underlyingName: pick(row, matched.underlyingName),
        bondRating: pick(row, matched.bondRating),
        convertPrice: pick(row, matched.convertPrice),
        premiumRate: pick(row, matched.premiumRate),
        issuePriceRaw,
        issuePrice: parseIssuePrice(issuePriceRaw),
        subscribeStart,
        subscribeEnd,
        resultDate: toIsoDate(pick(row, matched.resultDate)),
        listingDate
      })
    )
  }
  return { rows, headers, skipped, matched }
}

/** 日期整体往后挪一年（ISO 串可直接比较先后，用于跨年的招股/上市） */
function bumpYear(d) {
  return `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`
}

/**
 * 中签率文本。集思录的 lucky_draw_rt **本身就是百分数值** —— 0.0012 就是 0.0012%，
 * 不要再做任何换算（早先按「小数比例」乘了 100，结果虚高了一百倍）。
 * 非数字 / 非正值一律返回空串，界面按「有才显示」处理。
 */
function pctText(v) {
  const r = Number(v)
  if (!Number.isFinite(r) || r <= 0) return ''
  return String(r)
}

/**
 * 中签公布日：数据源没给就按「申购后第二个工作日」推算。
 * 只适用于 A 股（新股和可转债都是这个节奏）；港股通常上市前一天才公布，不推算。
 *
 * 关键：这个是**读取时算**，不是存库时算 —— 早先已经存进去的条目 resultDate 是空的，
 * 若只在保存时推算，那些历史数据就永远不会出现中签日，除非用户重新导入一遍。
 * 现在算出来的结果也不再写回库里（见 normalizeManual），每次都现算，历史数据自动生效。
 */
export function estimateResultDate(item) {
  if (!item || item.market !== 'A' || !item.subscribeStart) return ''
  return nthWorkday(item.subscribeStart, 2)
}

/**
 * 中签公布日：条目自带（数据源给的或手填的）优先，没有才按 T+2 推算。
 *
 * 这是**唯一的取值入口**，日历格子与卡片时间轴都走它 ——
 * 分开各写一遍的话，改了一处忘了另一处，同一只新股会显示成两个不同的中签日。
 */
export function ipoResultDate(item) {
  if (!item) return ''
  return item.resultDate || estimateResultDate(item)
}

/**
 * 从某天起往后数第 n 个**工作日**（跳过周六日）。
 * A股新股与可转债都是「申购后第二个工作日」出中签结果：21 号申购 → 23 号出。
 * 只跳周末，**节假日不处理** —— 哪天休市无法预知，宁可差一天也不装作知道。
 */
function nthWorkday(date, n = 2) {
  const t = new Date(date + 'T00:00:00Z')
  let left = n
  while (left > 0) {
    t.setUTCDate(t.getUTCDate() + 1)
    const wd = t.getUTCDay()
    if (wd !== 0 && wd !== 6) left--
  }
  return t.toISOString().slice(0, 10)
}

/**
 * 把表格里各种日期写法统一成 YYYY-MM-DD。
 * 东财表格常见「2026-10-20」；从其它站复制还可能是「20261020」「10/20」「10-20」（缺年份按当前年）。
 */
function toIsoDate(s) {
  // 集思录港股表格的日期带星期后缀，形如「10-20(周二)」，先剥掉
  const t = String(s || '').trim().replace(/\(.*?\)/g, '')
  if (!t) return ''
  let m = t.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = t.match(/\b(\d{8})\b/)
  if (m) return `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})$/)
  if (m) return `${new Date().getFullYear()}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return ''
}

/** 按代码形态猜市场：6 位数字 A 股 / 4-5 位数字港股 / 字母美股 */
function guessMarket(code, fallback) {
  const c = String(code || '').trim()
  if (/^\d{6}$/.test(c)) return 'A'
  if (/^\d{4,5}$/.test(c)) return 'HK'
  if (/^[A-Za-z]/.test(c)) return 'US'
  return fallback || 'A'
}

/** 手动录入项的默认结构 */
export function emptyIpo(market = 'A') {
  return {
    id: '',
    market,
    // ipo 新股 / cb 可转债。两者日期节点基本一致，区别在「发行价」：转债按面值 100 申购
    kind: 'ipo',
    code: '',
    name: '',
    exchange: '',
    marketCap: '',
    issuePriceRaw: '',
    issuePrice: null,
    // —— 可转债专用（新股留空） ——
    underlyingCode: '', // 正股代码
    underlyingName: '', // 正股名称：只有「莱特转债」看不出是哪家公司
    bondRating: '', //    债券评级 AAA / AA+
    convertPrice: '', //  转股价
    premiumRate: '', //   溢价率
    // —— 发行数据：用于个股详情页展示。数据源没给的保持空串，界面按「有才显示」处理 ——
    issueAmount: '', //    发行规模（亿元）
    onlineIssue: '', //    网上发行（亿元）
    winRate: '', //        网上中签率（%）
    subscribeLimit: '', // 申购上限
    issuePe: '', //        发行市盈率
    sponsor: '', //        保荐人 / 主承销商（港股常见）
    cornerstone: '', //    基石投资者（港股常见）
    subscribeStart: '',
    subscribeEnd: '',
    resultDate: '',
    listingDate: '',
    darkPoolDate: '',
    source: 'manual',
    updatedAt: 0
  }
}

/** 归一化手动录入项：补 id、按上市日推算港股暗盘 */
export function normalizeManual(item) {
  const market = item.market || 'A'
  const code = String(item.code || '').trim()
  const listingDate = item.listingDate || ''
  const kind = item.kind === 'cb' ? 'cb' : 'ipo'
  const out = {
    ...emptyIpo(market),
    ...item,
    market,
    kind,
    code,
    marketCap: item.marketCap || '',
    underlyingCode: String(item.underlyingCode || ''),
    underlyingName: String(item.underlyingName || ''),
    bondRating: String(item.bondRating || ''),
    convertPrice: String(item.convertPrice || ''),
    premiumRate: String(item.premiumRate || ''),
    issueAmount: String(item.issueAmount || ''),
    onlineIssue: String(item.onlineIssue || ''),
    winRate: String(item.winRate || ''),
    subscribeLimit: String(item.subscribeLimit || ''),
    issuePe: String(item.issuePe || ''),
    sponsor: String(item.sponsor || ''),
    cornerstone: String(item.cornerstone || ''),
    issuePriceRaw: String(item.issuePriceRaw || ''),
    // 可转债按面值 100 申购：没填发行价就按 100 计，这样「首日卖出盈亏」自动按面值算，不用改联动逻辑
    issuePrice: item.issuePriceRaw
      ? parseIssuePrice(item.issuePriceRaw)
      : Number(item.issuePrice) || (kind === 'cb' ? 100 : null),
    // 暗盘没填就按上市日推算（仅港股）
    darkPoolDate: item.darkPoolDate || (market === 'HK' ? prevWeekday(listingDate) : ''),
    // 中签公布日只存**数据源给的 / 手填的**，推算交给 ipoResultDate() 在读取时统一做。
    // 早先把推算值固化进库里，结果数据源后来给出真实日期时也改不掉了
    resultDate: item.resultDate || '',
    source: 'manual',
    updatedAt: Date.now()
  }
  out.id = `manual:${market}:${code}:${listingDate || 'na'}:${out.updatedAt}`
  return out
}
