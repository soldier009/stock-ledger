<script setup>
/**
 * 新股日历：月历查看 A股/港股/美股的新股发行节奏，点击日期看当天的新股详情。
 * 数据源：iTick 自动拉取（需在设置页配 API key）+ 手动录入兜底，两者合并去重。
 * 港股暗盘只有日期（按上市前一工作日推算），不显示价格 —— 没有可靠的免费数据源，不编造。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Calendar, Plus, Refresh, ArrowLeft, ArrowRight } from '@element-plus/icons-vue'
import { usePortfolioStore } from '../stores/portfolio'
import { useIpoStore } from '../stores/ipo'
import { useSettingsStore } from '../stores/settings'
import { MARKET_LABEL, emptyIpo, parsePastedTable, ipoResultDate } from '../services/ipo'
import { IPO_WIN_COLOR } from '../constants'
import { fmtMoney, guessAssetClass } from '../utils/format'
import IpoWinForm from '../components/IpoWinForm.vue'

const router = useRouter()
const ipoStore = useIpoStore()
const portfolio = usePortfolioStore()
const settings = useSettingsStore()

const today = new Date().toISOString().slice(0, 10)
const now = new Date(today + 'T00:00:00Z')
const year = ref(now.getUTCFullYear())
const month = ref(now.getUTCMonth()) // 0-based
const selected = ref(today)
const marketFilter = ref('ALL')
/** 条目类型：ALL / ipo 新股 / cb 可转债 */
const kindFilter = ref('ALL')
const dialogVisible = ref(false)
const editing = ref(null)
const form = ref(emptyIpo('A'))

/** 粘贴导入：从东方财富等网站复制表格粘进来解析，绕开浏览器跨域限制 */
const importVisible = ref(false)
const importText = ref('')
const importMarket = ref('A')
const importKind = ref('ipo')
const importPreview = computed(() =>
  parsePastedTable(importText.value, importMarket.value, importKind.value)
)
/**
 * 解析出来但一个日期都没有的条目。
 * 日历靠日期定位 —— 这种导进来是「有记录但日历上永远看不到」，必须显式说出来，不能让它静默消失。
 * 典型场景：从集思录「可转债列表」（已上市）复制，那份表只有到期时间，没有申购日/上市日。
 */
const importNoDate = computed(
  () => importPreview.value.rows.filter((r) => !r.listingDate && !r.subscribeStart && !r.resultDate).length
)

function openImport() {
  importText.value = ''
  importMarket.value = marketFilter.value === 'ALL' ? 'A' : marketFilter.value
  importKind.value = kindFilter.value === 'ALL' ? 'ipo' : kindFilter.value
  importVisible.value = true
}

async function doImport() {
  const { rows } = importPreview.value
  if (!rows.length) {
    ElMessage.warning('没识别出新股，检查是否连表头一起复制了')
    return
  }
  const { added, replaced } = await ipoStore.importPasted(rows)
  importVisible.value = false
  ElMessage.success(`已导入 ${added} 只${replaced ? `，更新 ${replaced} 只` : ''}`)
}

const pad = (n) => String(n).padStart(2, '0')
const dateKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`

/** 周一开头的月历网格，前后补 null 占位 */
const cells = computed(() => {
  const y = year.value
  const m = month.value
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const firstWeekday = new Date(Date.UTC(y, m, 1)).getUTCDay() // 0=周日
  const offset = (firstWeekday + 6) % 7 // 转成周一开头
  const out = []
  for (let i = 0; i < offset; i++) out.push(null)
  for (let d = 1; d <= daysInMonth; d++) out.push(dateKey(y, m, d))
  while (out.length % 7 !== 0) out.push(null)
  return out
})

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

const KIND_META = {
  listing: { label: '上市', color: '#dc2626' },
  // 暗盘是推算出来的日期（不是真实数据），用灰色示意，不给它一个「确定事件」的分量
  dark: { label: '暗盘', color: '#94a3b8' },
  // 中签 = 你自己中了，只由交易账本里的记录驱动（见 store 的 byDate）
  won: { label: '中签', color: IPO_WIN_COLOR },
  subscribe: { label: '招股', color: '#2563eb' }
}
/**
 * 图例这四种。
 * 注意这里没有「公布中签」—— 那是市场事件，跟中不中无关，日历上不展示。
 */
const LEGEND_KINDS = ['listing', 'dark', 'won', 'subscribe']
const MARKET_COLOR = { A: '#dc2626', HK: '#2563eb', US: '#16a34a' }
/** 可转债统一用橙色，与资产分类里可转债的颜色一致 */
const CB_COLOR = '#f59e0b'

const passFilter = (item) =>
  (kindFilter.value === 'ALL' || (item.kind || 'ipo') === kindFilter.value) &&
  (marketFilter.value === 'ALL' || item.market === marketFilter.value)

/**
 * 日历格子里的圆点颜色按「当天发生的事件」走：中签绿、上市红、招股蓝、暗盘灰。
 * 可转债不再占用颜色 —— 那会让中签那天看起来是橙的，反而盖掉了事件本身；
 * 改用**方点**形状区分，颜色和类型各管一件事。
 */
const dotColor = (e) => KIND_META[e.kinds[0]]?.color || '#94a3b8'

/**
 * 某天的事件（已过市场筛选）。
 *
 * 带缓存：模板里每个日历格子都要调一两次（算圆点、判断「+N」），一个月 42 格就是上百次
 * filter + 对象浅拷贝，全是无谓开销。
 * 失效条件用「byDate 的引用」而不是内容 —— byDate 是 computed，数据一变就是新 Map，
 * 引用比较就够，不用写脆弱的深度比对。
 */
let cachedByDate = null
let cachedFilter = ''
const eventCache = new Map()
function eventsOf(date) {
  const fk = `${marketFilter.value}|${kindFilter.value}`
  if (ipoStore.byDate !== cachedByDate || fk !== cachedFilter) {
    eventCache.clear()
    cachedByDate = ipoStore.byDate
    cachedFilter = fk
  }
  const hit = eventCache.get(date)
  if (hit) return hit
  const list = ipoStore.byDate.get(date)
  const out = list
    ? list.filter((x) => passFilter(x.item)).map((x) => ({ ...x, kinds: [...x.kinds] }))
    : []
  eventCache.set(date, out)
  return out
}

/** 单元格里显示的小圆点：按优先级取前 3 个不同新股 */
function dotsOf(date) {
  const evs = eventsOf(date)
  const seen = new Set()
  const out = []
  for (const e of evs) {
    if (seen.has(e.item.id)) continue
    seen.add(e.item.id)
    out.push(e)
    if (out.length >= 3) break
  }
  return out
}

/** 该天是否有新股处于招股期（用于整格淡蓝底） */
const subscribingOf = (date) => eventsOf(date).some((e) => e.kinds.includes('subscribe'))

const selectedEvents = computed(() => eventsOf(selected.value || ''))

const monthCount = computed(() => {
  let n = 0
  for (const d of cells.value) if (d && eventsOf(d).length) n++
  return n
})

function prevMonth() {
  if (month.value === 0) {
    month.value = 11
    year.value--
  } else month.value--
}
function nextMonth() {
  if (month.value === 11) {
    month.value = 0
    year.value++
  } else month.value++
}
function goToday() {
  year.value = now.getUTCFullYear()
  month.value = now.getUTCMonth()
  selected.value = today
}

const wonInfo = (item) => ipoStore.wonBySymbol.get(`${item.market}:${item.code}`)
/** 中签数量单位：可转债按张，新股按股 */
const shareUnit = (item) => (item.kind === 'cb' ? '张' : '股')

/**
 * 交易账里记了中签（type='win'），但日历列表里没有对应条目的标的。
 * 联动的前提是「代码得在日历列表里」—— 少了这一步，记了中签在日历上就是一片空白，
 * 而且不会有任何报错，所以这里主动把它们列出来，点一下就能补进日历。
 */
const missingFromCalendar = computed(() => {
  if (!ipoStore.all.length) return []
  const known = new Set(ipoStore.all.map((x) => `${x.market}:${x.code}`))
  const seen = new Map()
  for (const t of portfolio.trades || []) {
    if (t.type !== 'win') continue
    const key = `${t.market}:${t.code}`
    if (known.has(key) || seen.has(key)) continue
    const kind = guessAssetClass(t.market, t.code) === 'bond' ? 'cb' : 'ipo'
    seen.set(key, { market: t.market, code: t.code, name: t.name || t.code, kind })
  }
  return [...seen.values()]
})

/** 把账本里的中签标的补进日历：只填代码名称，日期留给中签那天的记账记录去定位 */
function addMissing(m) {
  editing.value = null
  form.value = emptyIpo(m.market)
  form.value.market = m.market
  form.value.code = m.code
  form.value.name = m.name
  form.value.kind = m.kind
  dialogVisible.value = true
}

/** 卡片上的时间轴节点 */
function timeline(item) {
  const nodes = []
  if (item.subscribeStart || item.subscribeEnd) {
    const s = item.subscribeStart || ''
    const e = item.subscribeEnd || ''
    // 可转债叫「申购」，新股叫「招股」（港股招股是区间，A股实际也是单日申购）
    const label = item.kind === 'cb' ? '申购' : '招股'
    nodes.push({ kind: 'subscribe', label, text: s === e ? s || e : `${s} ~ ${e}` })
  }
  // 同样只在账本里记了中签才出现。日期优先中签公布日（手填 > T+2 推算），没有才是记账那天
  const w = wonInfo(item)
  if (w && (w.wonDates || []).length) {
    const announced = ipoResultDate(item)
    const hint = announced ? (item.resultDate ? '' : 'T+2 推算') : '记账日'
    nodes.push({ kind: 'won', label: '中签', text: announced || w.wonDates[0], hint })
  }
  if (item.darkPoolDate) nodes.push({ kind: 'dark', label: '暗盘', text: item.darkPoolDate, hint: '推算' })
  if (item.listingDate) nodes.push({ kind: 'listing', label: '上市', text: item.listingDate })
  return nodes
}

/** 该新股当天触发了哪些节点（用于卡片顶部标注） */
function kindsBadge(item) {
  const ev = selectedEvents.value.find((e) => e.item.id === item.id)
  return (ev && ev.kinds) || []
}

/**
 * 拉取新股。免费套餐每分钟 5 次调用，一次拉取按 region 发 4 个请求，
 * 所以「即将上市」与「近期已上市」分两次入口，别在同分钟内连点。
 */
async function refresh(type = 'upcoming') {
  // 没配 key 就走东财兜底：不用注册、不用 key，能补 A 股已上市新股的上市日期
  if (!settings.itick.token) {
    try {
      const n = await ipoStore.fetchEm()
      ElMessage.success(`未配置 iTick key，已用东方财富补入 A 股新股 ${n} 只（仅上市日期）`)
    } catch (e) {
      ElMessage.error(e.message || '拉取失败')
    }
    return
  }
  try {
    const n = await ipoStore.fetchRemote(settings.itick.token, type)
    ElMessage.success(`${type === 'recent' ? '近期已上市' : '即将上市'}新股已更新 ${n} 只`)
  } catch (e) {
    ElMessage.error(e.message || '拉取失败')
  }
}

function openAdd() {
  editing.value = null
  form.value = emptyIpo(marketFilter.value === 'ALL' ? 'A' : marketFilter.value)
  // 当前在看「可转债」时，新增默认选可转债
  form.value.kind = kindFilter.value === 'ALL' ? 'ipo' : kindFilter.value
  dialogVisible.value = true
}
function openEdit(item) {
  editing.value = item
  form.value = { ...item }
  dialogVisible.value = true
}

async function submit() {
  const f = form.value
  if (!f.code || !f.name) {
    ElMessage.warning('请填写代码与名称')
    return
  }
  if (!f.listingDate && !f.subscribeStart && !f.subscribeEnd) {
    ElMessage.warning('至少填写上市日或招股日期')
    return
  }
  await ipoStore.addManual(f)
  dialogVisible.value = false
  ElMessage.success('已保存')
}

async function removeItem(item) {
  try {
    await ElMessageBox.confirm(`确定删除「${item.name}」？`, '删除新股', { type: 'warning' })
  } catch {
    return
  }
  await ipoStore.removeManual(item.id)
  ElMessage.success('已删除')
}

function openStock(item) {
  router.push(`/stock/${item.market}/${item.code}`)
}

// ===== 在日历里直接记中签（不跳页面、不用手输代码）=====
const winVisible = ref(false)
const winItem = ref(null)
const winTrade = ref(null)

/** 这只新股对应的中签记录：有就编辑，没有就新增 */
const winTradeOf = (item) =>
  (portfolio.trades || []).find(
    (t) => t.type === 'win' && t.market === item.market && t.code === item.code
  )

function openWin(item) {
  winItem.value = item
  winTrade.value = winTradeOf(item) || null
  winVisible.value = true
}

onMounted(async () => {
  await ipoStore.load()
})
</script>

<template>
  <div class="ipo-page">
    <div class="card">
      <div class="row between" style="margin-bottom: 12px">
        <div class="section-title">新股日历</div>
        <div class="ipo-actions">
          <el-button size="small" :icon="Plus" @click="openAdd">添加</el-button>
          <el-button size="small" :icon="Refresh" :loading="ipoStore.loading" @click="refresh('upcoming')">
            刷新
          </el-button>
          <el-button size="small" :loading="ipoStore.loading" @click="refresh('recent')">近期</el-button>
          <el-button size="small" @click="openImport">导入</el-button>
        </div>
      </div>

      <!-- 类型筛选：新股 / 可转债 -->
      <div class="ipo-filter">
        <span
          v-for="t in [
            { k: 'ALL', label: '全部' },
            { k: 'ipo', label: '新股' },
            { k: 'cb', label: '可转债' }
          ]"
          :key="t.k"
          class="ipo-chip"
          :class="{ active: kindFilter === t.k }"
          @click="kindFilter = t.k"
        >
          {{ t.label }}
        </span>
      </div>

      <!-- 市场筛选 -->
      <div class="ipo-filter">
        <span
          v-for="m in [
            { k: 'ALL', label: '全部' },
            { k: 'A', label: 'A股' },
            { k: 'HK', label: '港股' },
            { k: 'US', label: '美股' }
          ]"
          :key="m.k"
          class="ipo-chip"
          :class="{ active: marketFilter === m.k }"
          @click="marketFilter = m.k"
        >
          {{ m.label }}
        </span>
      </div>

      <!-- 月历 -->
      <div class="ipo-cal-nav">
        <div class="nav-item" @click="prevMonth">
          <el-icon :size="14"><ArrowLeft /></el-icon>
        </div>
        <div class="nav-item" @click="goToday">
          <span class="nav-year">{{ year }} 年</span>
          <span class="nav-month">{{ month + 1 }} 月</span>
          <span class="muted" style="font-size: 11px">（{{ monthCount }} 天有安排）</span>
        </div>
        <div class="nav-item" @click="nextMonth">
          <el-icon :size="14"><ArrowRight /></el-icon>
        </div>
      </div>

      <div class="ipo-week">
        <span v-for="w in WEEK" :key="w">{{ w }}</span>
      </div>
      <div class="ipo-grid">
        <div
          v-for="(d, i) in cells"
          :key="i"
          class="ipo-cell"
          :class="{
            muted: !d,
            today: d === today,
            selected: d && d === selected,
            subscribing: d && subscribingOf(d),
            clickable: d && eventsOf(d).length
          }"
          @click="d && eventsOf(d).length && (selected = d)"
        >
          <template v-if="d">
            <span class="cell-date">{{ Number(d.slice(8)) }}</span>
            <div class="cell-dots">
              <template v-for="(e, k) in dotsOf(d)" :key="k">
                <!-- 中签用绿色星星，和其它「市场事件」的圆点一眼区分开 -->
                <span v-if="e.kinds.includes('won')" class="cell-star">★</span>
                <i
                  v-else
                  class="cell-dot"
                  :class="{ 'is-cb': e.item.kind === 'cb' }"
                  :style="{ background: dotColor(e) }"
                />
              </template>
            </div>
            <span v-if="eventsOf(d).length > 3" class="cell-more">+{{ eventsOf(d).length - 3 }}</span>
          </template>
        </div>
      </div>

      <div class="ipo-legend">
        <span v-for="k in LEGEND_KINDS" :key="k" class="lg">
          <i :style="{ background: KIND_META[k].color }" />{{ KIND_META[k].label }}
        </span>
        <span class="lg"><i class="lg-sq" :style="{ background: CB_COLOR }" />可转债（方点）</span>
        <span class="lg"><i style="background: #16a34a" />★ 已中签</span>
      </div>

      <div class="ipo-note muted">
        <b>怎么关联中签</b>：中签后到「交易」里对<b>同一代码</b>记一笔，类型选「<b>中签</b>」——
        价格填发行价、数量填中签股数；可转债价格填 <b>100</b>、数量填中签<b>张数</b>，
        代码用<b>转债代码</b>（如 118077），不是正股代码。<br />
        中签是按发行价<b>扣款并计成本</b>的，不要用「送股」记（那会让现金虚高、成本归零）。<br />
        记完后日历上会在中签那天出现<b>绿色星星</b>，卡片标 ★ 已中签；卖出日期正好是上市日的那笔，
        按发行价（可转债按面值 100）算首日卖出盈亏。
      </div>

      <div v-if="missingFromCalendar.length" class="ipo-missing">
        <b>账本里中过签、但日历上没有的 {{ missingFromCalendar.length }} 个标的：</b>
        <template v-for="(m, i) in missingFromCalendar" :key="m.code">
          <span v-if="i">、</span>
          <a class="ipo-missing-link" @click="addMissing(m)">{{ m.name }}</a>
        </template>
        <div class="muted">
          联动要求代码在日历列表里 —— 不补进来，你记的那笔中签在日历上永远看不到，也不报错。<br />
          点名字即可补进日历（自动填代码与市场），日期留空也行，中签那天由账本记录定位。
        </div>
      </div>
    </div>

    <!-- 选中日期的新股列表 -->
    <div class="card">
      <div class="row between" style="margin-bottom: 10px">
        <div class="section-title">{{ selected || '请选择日期' }}</div>
        <span class="muted" style="font-size: 11px">{{ selectedEvents.length }} 只</span>
      </div>

      <div v-if="!selectedEvents.length" class="muted ipo-empty">
        这一天没有新股或可转债安排。<span v-if="!ipoStore.all.length">点击右上角「添加」手动录入，或在设置页配置 iTick API key 自动获取。</span>
      </div>

      <div v-for="e in selectedEvents" :key="e.item.id" class="ipo-item">
        <div class="ipo-item-head">
          <span class="ipo-mkt" :style="{ background: MARKET_COLOR[e.item.market] }">
            {{ MARKET_LABEL[e.item.market] }}
          </span>
          <span
            v-if="e.item.kind === 'cb'"
            class="ipo-kind"
            :style="{ color: CB_COLOR, borderColor: CB_COLOR }"
          >
            可转债
          </span>
          <b class="ipo-name">{{ e.item.name }}</b>
          <span v-if="e.item.kind === 'cb' && e.item.underlyingName" class="muted">
            正股 {{ e.item.underlyingName }}
          </span>
          <span class="muted">{{ e.item.code }}</span>
          <span
            v-for="k in kindsBadge(e.item)"
            :key="k"
            class="ipo-kind"
            :style="{ color: KIND_META[k].color, borderColor: KIND_META[k].color }"
          >
            {{ KIND_META[k].label }}
          </span>
          <span v-if="wonInfo(e.item) && wonInfo(e.item).shares > 0" class="ipo-won">★ 已中签</span>
        </div>

        <!-- 时间轴 -->
        <div class="ipo-timeline">
          <div v-for="n in timeline(e.item)" :key="n.label" class="tl-node">
            <i :style="{ background: KIND_META[n.kind].color }" />
            <span class="tl-label">{{ n.label }}<em v-if="n.hint">（{{ n.hint }}）</em></span>
            <span class="tl-date">{{ n.text }}</span>
          </div>
        </div>

        <div class="ipo-meta">
          <template v-if="e.item.kind === 'cb'">
            <span v-if="e.item.bondRating">评级 <b>{{ e.item.bondRating }}</b></span>
            <span v-if="e.item.convertPrice">转股价 <b>{{ e.item.convertPrice }}</b></span>
            <span v-if="e.item.premiumRate">溢价率 <b>{{ e.item.premiumRate }}</b></span>
            <span class="muted">面值 100 申购</span>
          </template>
          <template v-else>
            <span v-if="e.item.issuePriceRaw">发行价 <b>{{ e.item.issuePriceRaw }}</b></span>
            <span v-if="e.item.marketCap">市值 <b>{{ e.item.marketCap }}</b></span>
          </template>
          <span v-if="e.item.exchange">{{ e.item.exchange }}</span>
          <span v-if="e.item.source === 'manual'" class="muted">手动录入</span>
        </div>

        <div v-if="wonInfo(e.item) && wonInfo(e.item).shares > 0" class="ipo-won-box">
          中签 <b>{{ wonInfo(e.item).shares }}</b> {{ shareUnit(e.item) }}
          <template v-if="wonInfo(e.item).soldShares > 0">
            · 已卖出 {{ wonInfo(e.item).soldShares }} {{ shareUnit(e.item) }}
          </template>
          <template v-if="wonInfo(e.item).firstDaySell != null">
            · 首日卖出盈亏
            <b :class="wonInfo(e.item).firstDaySell >= 0 ? 'up' : 'down'">
              {{ fmtMoney(wonInfo(e.item).firstDaySell) }}
            </b>
          </template>
        </div>

        <div class="ipo-item-ops">
          <el-button size="small" text type="primary" @click="openWin(e.item)">
            {{ winTradeOf(e.item) ? '编辑中签' : '记中签' }}
          </el-button>
          <el-button size="small" text @click="openStock(e.item)">个股详情</el-button>
          <el-button size="small" text @click="openEdit(e.item)">编辑</el-button>
          <el-button v-if="e.item.source === 'manual'" size="small" text type="danger" @click="removeItem(e.item)">
            删除
          </el-button>
        </div>
      </div>
    </div>

    <!-- 手动录入 -->
    <el-dialog
      v-model="dialogVisible"
      :title="(editing ? '编辑' : '添加') + (form.kind === 'cb' ? '可转债' : '新股')"
      width="92%"
    >
      <el-form label-width="80px" size="small">
        <el-form-item label="类型">
          <el-select v-model="form.kind" style="width: 100%">
            <el-option label="新股" value="ipo" />
            <el-option label="可转债" value="cb" />
          </el-select>
        </el-form-item>
        <el-form-item label="市场">
          <el-select v-model="form.market" style="width: 100%">
            <el-option label="A股" value="A" />
            <el-option label="港股" value="HK" />
            <el-option label="美股" value="US" />
          </el-select>
        </el-form-item>
        <el-form-item label="代码">
          <el-input v-model="form.code" placeholder="如 601398 / 00700 / AAPL" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="公司简称" />
        </el-form-item>
        <el-form-item v-if="form.kind !== 'cb'" label="发行价">
          <el-input v-model="form.issuePriceRaw" placeholder="如 12.50 或 3.50-4.50" />
        </el-form-item>
        <!-- 可转债按面值 100 申购，没有发行价；改为填正股与评级等指标 -->
        <el-form-item v-else label="正股">
          <div class="ipo-range">
            <el-input v-model="form.underlyingName" placeholder="正股名称" />
            <el-input v-model="form.underlyingCode" placeholder="正股代码" />
          </div>
          <div class="muted" style="font-size: 11px; line-height: 1.5">
            可转债按面值 100 元申购，成本固定，首日卖出盈亏按面值算
          </div>
        </el-form-item>
        <el-form-item v-if="form.kind === 'cb'" label="评级/转股">
          <div class="ipo-range">
            <el-input v-model="form.bondRating" placeholder="评级" />
            <el-input v-model="form.convertPrice" placeholder="转股价" />
            <el-input v-model="form.premiumRate" placeholder="溢价率" />
          </div>
        </el-form-item>
        <el-form-item :label="form.kind === 'cb' ? '申购日' : '招股期'">
          <div class="ipo-range">
            <el-date-picker v-model="form.subscribeStart" type="date" value-format="YYYY-MM-DD" placeholder="开始" />
            <span class="muted">~</span>
            <el-date-picker v-model="form.subscribeEnd" type="date" value-format="YYYY-MM-DD" placeholder="截止" />
          </div>
        </el-form-item>
        <el-form-item label="中签公布">
          <el-date-picker v-model="form.resultDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="上市日">
          <el-date-picker v-model="form.listingDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item v-if="form.market === 'HK'" label="暗盘">
          <el-date-picker v-model="form.darkPoolDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          <div class="muted" style="font-size: 11px; line-height: 1.5">
            留空则按上市日前一个工作日自动推算
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="dialogVisible = false">取消</el-button>
        <el-button size="small" type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 粘贴导入：浏览器抓不了别的网站（CORS），但复制粘贴不受限制 -->
    <el-dialog v-model="importVisible" title="粘贴导入" width="92%">
      <!-- 新股与可转债表头差别大，先选对类型 -->
      <div class="ipo-filter" style="margin-bottom: 8px">
        <span class="ipo-chip" :class="{ active: importKind === 'ipo' }" @click="importKind = 'ipo'">
          新股
        </span>
        <span class="ipo-chip" :class="{ active: importKind === 'cb' }" @click="importKind = 'cb'">
          可转债
        </span>
      </div>

      <div class="muted ipo-tip">
        <template v-if="importKind === 'cb'">
          打开<b>集思录待发可转债页</b>（<b>jisilu.cn/data/cbnew/pre_list/</b>）全选复制表格，粘贴到下面 ——
          <b>要连表头一起复制</b>。<br />
          已适配：转债代码 / 转债名称 / <b>正股名称</b> / <b>申购日期</b> / 上市日期 / 评级 / 转股价 / 溢价率<br />
          <b>更推荐</b>：浏览器直接打开
          <b>jisilu.cn/data/cbnew/pre_list/?___jsl=LST___t=1</b>，把整段 JSON 复制进来 —— 不用猜表头，
          申购日、上市日、评级、转股价、正股一次全有
        </template>
        <template v-else>
          打开<b>集思录新股页</b>（<b>jisilu.cn/data/new_stock/</b>；A股与港股都在这页，港股点「港股新股」标签）
          全选复制表格，粘贴到下面 —— <b>要连表头一起复制</b>。<br />
          已适配的表头：
          <span v-if="importMarket === 'HK'">
            代码 / 名称 / <b>申购起始</b> / <b>申购截止</b> / 上市日 / 发行价(港元)
          </span>
          <span v-else>代码 / 名称 / <b>申购日</b> / 缴款日 / 上市日期 / 发行价</span>
          <br />
          东方财富新股页（data.eastmoney.com/xg/xg/）的格式同样支持。<br />
          <b>更推荐</b>：浏览器直接打开集思录接口把整段 JSON 复制进来 ——
          A股 <b>/data/new_stock/sub/</b>、港股 <b>/data/new_stock/hkipo/</b>（域名 www.jisilu.cn）
        </template>
      </div>

      <div v-if="importKind === 'ipo'" class="ipo-filter" style="margin: 8px 0">
        <span
          v-for="m in [
            { k: 'A', label: 'A股' },
            { k: 'HK', label: '港股' },
            { k: 'US', label: '美股' }
          ]"
          :key="m.k"
          class="ipo-chip"
          :class="{ active: importMarket === m.k }"
          @click="importMarket = m.k"
        >
          {{ m.label }}
        </span>
        <span class="muted" style="font-size: 11px">（代码形态能认出市场时以代码为准）</span>
      </div>

      <el-input
        v-model="importText"
        type="textarea"
        :rows="8"
        placeholder="在此粘贴从网站复制的表格（含表头）"
      />

      <div v-if="importText && !importPreview.rows.length" class="ipo-import-preview">
        <span style="color: #ea580c">没能识别出新股</span>
        <div class="muted">
          请确认复制时<b>连表头一起</b>选上了（要有「股票代码」「股票简称」「上市日期」这类表头行）。
          表头是判断哪一列是什么的依据 —— 没有表头就只能瞎猜，所以这里宁可不导入。
        </div>
      </div>

      <div v-else-if="importText" class="ipo-import-preview">
        识别到 <b>{{ importPreview.rows.length }}</b> 只
        <span v-if="importPreview.skipped" class="muted">（跳过 {{ importPreview.skipped }} 行）</span>
        <div v-if="importNoDate" class="ipo-import-warn">
          ⚠ 其中 {{ importNoDate }} 只没有任何日期（申购 / 中签 / 上市），导入后在<b>日历上看不到</b>。<br />
          打新日历要的是<b>待发可转债</b>（含申购日期），不是这张已上市转债列表 —— 请到集思录<br />
          <b>jisilu.cn/data/cbnew/pre_list/</b> 复制待发转债表格。
        </div>
        <div v-for="r in importPreview.rows.slice(0, 5)" :key="r.id" class="ipo-import-row">
          <span class="ipo-mkt" :style="{ background: MARKET_COLOR[r.market] }">{{ MARKET_LABEL[r.market] }}</span>
          {{ r.code }} {{ r.name }}
          <span class="muted">
            招股 {{ r.subscribeStart || '—' }} · 中签 {{ r.resultDate || '—' }} · 上市
            {{ r.listingDate || '—' }}
          </span>
        </div>
        <div v-if="importPreview.rows.length > 5" class="muted">…等共 {{ importPreview.rows.length }} 只</div>
      </div>

      <template #footer>
        <el-button size="small" @click="importVisible = false">取消</el-button>
        <el-button size="small" type="primary" :disabled="!importPreview.rows.length" @click="doImport">
          导入
        </el-button>
      </template>
    </el-dialog>

    <!-- 在日历里直接记中签：不跳页面，代码与发行价已按当前条目预填 -->
    <IpoWinForm v-model="winVisible" :item="winItem" :trade="winTrade" :default-date="selected" />
  </div>
</template>

<style scoped>
.ipo-page {
  padding-bottom: 20px;
}
.row {
  display: flex;
  align-items: center;
}
.row.between {
  justify-content: space-between;
}
.section-title {
  font-size: 15px;
  font-weight: 700;
}
.muted {
  color: var(--text-2);
}
.up {
  color: #dc2626;
}
.down {
  color: #16a34a;
}
.ipo-actions {
  display: flex;
  gap: 6px;
}
/* 市场筛选 */
.ipo-filter {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.ipo-chip {
  padding: 3px 10px;
  border-radius: 999px;
  background: #f1f5f9;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.ipo-chip.active {
  background: var(--primary);
  color: #fff;
  font-weight: 600;
}
/* 月历 */
.ipo-cal-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.nav-item .el-icon {
  color: var(--text-2);
}
.nav-year {
  font-size: 15px;
  font-weight: 700;
}
.nav-month {
  font-size: 14px;
  font-weight: 700;
  color: var(--primary);
}
.ipo-week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  color: var(--text-2);
  font-size: 11px;
  margin-bottom: 6px;
}
.ipo-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.ipo-cell {
  position: relative;
  aspect-ratio: 1 / 0.92;
  border-radius: 8px;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  padding: 2px 1px;
  overflow: hidden;
}
.ipo-cell.muted {
  background: transparent;
}
.ipo-cell.today {
  border: 1.5px solid var(--primary);
}
.ipo-cell.selected {
  outline: 2px solid var(--primary);
}
.ipo-cell.subscribing {
  background: #eff6ff;
}
.ipo-cell.clickable {
  cursor: pointer;
}
.ipo-cell.clickable:hover {
  background: #eef2f7;
}
.cell-date {
  font-size: 11px;
  line-height: 1.1;
}
.cell-dots {
  display: flex;
  gap: 2px;
  margin-top: 2px;
  min-height: 5px;
}
.cell-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  display: inline-block;
}
/* 日历格子里的中签星星：行高与圆点保持一致，别把这一行撑高 */
/* 颜色与 IPO_WIN_COLOR 一致 —— CSS 里没法直接引用 JS 常量，改色时两处都要动 */
.cell-star {
  font-size: 9px;
  line-height: 5px;
  color: #16a34a;
}
/* 可转债用方点表示类型，颜色留给「当天发生了什么」 */
.cell-dot.is-cb,
.ipo-legend i.lg-sq {
  border-radius: 1px;
}
.cell-more {
  position: absolute;
  right: 2px;
  bottom: 1px;
  font-size: 8px;
  color: var(--text-2);
}
.ipo-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-2);
}
.ipo-legend .lg {
  display: flex;
  align-items: center;
  gap: 3px;
}
.ipo-legend i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
/* 新股卡片 */
.ipo-empty {
  text-align: center;
  padding: 16px 0;
  font-size: 12px;
  line-height: 1.7;
}
.ipo-item {
  padding: 10px 0;
  border-top: 1px solid #f1f5f9;
}
.ipo-item-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.ipo-mkt {
  color: #fff;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
}
.ipo-name {
  font-size: 14px;
}
.ipo-kind {
  font-size: 10px;
  border: 1px solid;
  border-radius: 4px;
  padding: 0 4px;
}
.ipo-won {
  font-size: 10px;
  color: #f59e0b;
  font-weight: 600;
}
.ipo-timeline {
  margin: 8px 0 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tl-node {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.tl-node i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.tl-node em {
  font-style: normal;
  font-size: 10px;
  color: var(--text-2);
}
.tl-label {
  color: var(--text-2);
  min-width: 62px;
}
.tl-date {
  font-weight: 600;
}
.ipo-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: var(--text-2);
}
.ipo-won-box {
  margin-top: 6px;
  font-size: 12px;
  padding: 6px 8px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
}
.ipo-item-ops {
  display: flex;
  gap: 2px;
  margin-top: 4px;
  margin-left: -8px;
}
.ipo-range {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
}
/* 粘贴导入 */
.ipo-tip {
  font-size: 12px;
  line-height: 1.7;
  padding: 8px 10px;
  background: #f8fafc;
  border-radius: 8px;
}
.ipo-import-preview {
  margin-top: 10px;
  font-size: 12px;
  padding: 8px 10px;
  background: #f8fafc;
  border-radius: 8px;
  max-height: 180px;
  overflow: auto;
}
.ipo-note {
  font-size: 11px;
  line-height: 1.7;
  margin-top: 8px;
  padding: 6px 8px;
  background: #f8fafc;
  border-radius: 6px;
}
.ipo-missing {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #f0fdf4;
  color: #15803d;
  font-size: 11px;
  line-height: 1.7;
}
.ipo-missing-link {
  cursor: pointer;
  text-decoration: underline;
}
.ipo-import-warn {
  margin: 6px 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff7ed;
  color: #ea580c;
  line-height: 1.6;
}
.ipo-import-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  border-top: 1px solid #eef2f7;
  flex-wrap: wrap;
}
</style>
