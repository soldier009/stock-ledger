import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { DEFAULT_BROKER } from '../constants'

const DB_NAME = 'stock-ledger'
const STORE = 'kv'
const FILE_KEY = 'sqlite-file'

let SQL = null
let db = null
let _initPromise = null
// 本地数据最后修改时间（毫秒时间戳），用于多端同步时判断数据新旧
let localChangedAt = 0
// 有用户操作待持久化（持久化时自动刷新 localChangedAt）
let dirtyFlag = false

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brokers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS cash_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT DEFAULT '',
  broker TEXT DEFAULT '',
  origin TEXT DEFAULT '',
  ref_id INTEGER DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT DEFAULT '',
  type TEXT NOT NULL,
  shares REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  broker TEXT DEFAULT '',
  origin TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT DEFAULT '',
  tag TEXT DEFAULT '[]',
  note TEXT DEFAULT '',
  broker TEXT DEFAULT '',
  asset_type TEXT DEFAULT '',
  purpose TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(market, code)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(date);
CREATE INDEX IF NOT EXISTS idx_trades_mkt_code ON trades(market, code);
`

/**
 * 老库迁移：补券商列、确保默认券商存在、回填空值
 * 需在 db 就绪后调用
 */
function migrate() {
  // 老库没有 broker 列时补列（新库 SCHEMA 已包含，ALTER 会报错，忽略）
  try { run('ALTER TABLE stocks ADD COLUMN broker TEXT DEFAULT ""') } catch {}
  // 资产二级分类（股票/基金/可转债），空表示按代码自动推断
  try { run('ALTER TABLE stocks ADD COLUMN asset_type TEXT DEFAULT ""') } catch {}
  // 用途标签（长期持有/打新/波段…），与资产类别标签并列，每只股票只能选一个，空表示未设置
  try { run('ALTER TABLE stocks ADD COLUMN purpose TEXT DEFAULT ""') } catch {}
  try { run('ALTER TABLE trades ADD COLUMN broker TEXT DEFAULT ""') } catch {}
  try { run('ALTER TABLE cash_flows ADD COLUMN broker TEXT DEFAULT ""') } catch {}
  // 初始建仓标记列（老库无此列时补列）
  try { run('ALTER TABLE trades ADD COLUMN origin TEXT DEFAULT ""') } catch {}
  try { run('ALTER TABLE cash_flows ADD COLUMN origin TEXT DEFAULT ""') } catch {}
  // ref_id 指向 trades.id：「新建仓」自动生成的入金记录，用这一列精确定位它对应的买入记录，
  // 使两边联动（改金额 / 改日期 / 删除）不再依赖「金额 + 日期」猜测
  try { run('ALTER TABLE cash_flows ADD COLUMN ref_id INTEGER DEFAULT NULL') } catch {}
  // 确保至少存在一个券商账户
  const cnt = get('SELECT COUNT(*) AS c FROM brokers')
  if (!cnt || cnt.c === 0) run('INSERT INTO brokers (name) VALUES (?)', [DEFAULT_BROKER])
  // 确保默认券商设置有效：指向的账户必须存在于券商列表，否则回退到默认账户/首个券商
  const names = all('SELECT name FROM brokers').map((r) => r.name)
  const saved = getSetting('defaultBroker', null)
  let def = saved
  if (!names.includes(def)) {
    def = names.includes(DEFAULT_BROKER) ? DEFAULT_BROKER : names[0] || DEFAULT_BROKER
  }
  if (def !== saved) setSetting('defaultBroker', def)
  // 老数据回填默认券商
  run("UPDATE stocks SET broker = ? WHERE broker IS NULL OR broker = ''", [def])
  run("UPDATE trades SET broker = ? WHERE broker IS NULL OR broker = ''", [def])
  run("UPDATE cash_flows SET broker = ? WHERE broker IS NULL OR broker = ''", [def])
  // 旧库回填「初始建仓」标记：新建仓会自动生成一笔 note 为
  // “初始建仓-自动入金（名称或代码）”的入金，且同券商有一笔金额相同的买入。
  // 依次按「同日精确」「日期错位兜底」两种口径匹配；仅当金额吻合且备注中的代码/名称
  // 唯一命中（或当日同券商金额唯一）时才回填，避免误标普通买入。
  const initRows = all("SELECT * FROM cash_flows WHERE origin IS NULL OR origin = ''")
  for (const c of initRows) {
    if (c.type !== 'deposit' || !c.note || !String(c.note).startsWith('初始建仓-自动入金（')) continue
    const amt = Number(c.amount) || 0
    if (amt <= 0) continue
    const open = String(c.note).indexOf('（')
    const close = String(c.note).lastIndexOf('）')
    if (open < 0 || close <= open) continue
    const token = String(c.note).slice(open + 1, close).trim()
    if (!token) continue
    // 取前后 7 天窗口内的“未标记”买入，覆盖买入日期被改而自动入金未联动的情况
    const buys = all(
      "SELECT id, date, market, code, name, shares, price FROM trades " +
        "WHERE type = 'buy' AND (origin IS NULL OR origin = '') AND broker = ? " +
        "AND date BETWEEN date(?, '-7 days') AND date(?, '+7 days') ORDER BY date, id",
      [c.broker, c.date, c.date]
    )
    // 名称可能被补录后改名/夹带空白，做宽松匹配
    const amountMatches = (t) => {
      const cost = (Number(t.price) || 0) * (Number(t.shares) || 0)
      return Math.abs(cost - amt) <= 0.011
    }
    const tokenMatches = (t) => token === t.code || token === String(t.name || '').trim()
    // 1) 同日 + 备注中的代码/名称吻合
    let hit = buys.find((t) => t.date === c.date && amountMatches(t) && tokenMatches(t))
    // 2) 备注确为“初始建仓-自动入金”时，当日同券商金额唯一的买入基本就是其对应记录
    if (!hit) {
      const cands = buys.filter((t) => t.date === c.date && amountMatches(t))
      if (cands.length === 1) hit = cands[0]
    }
    // 3) 日期错位兜底：跨前后 7 天，同券商 + 同金额 + 备注中的代码/名称吻合且唯一时才命中
    if (!hit) {
      const near = buys.filter((t) => amountMatches(t) && tokenMatches(t))
      if (near.length === 1) hit = near[0]
    }
    if (!hit) continue
    run("UPDATE trades SET origin = 'initial' WHERE id = ?", [hit.id])
    run("UPDATE cash_flows SET origin = 'initial' WHERE id = ?", [c.id])
  }

  // ===== 回填 ref_id：给历史上已配对的「新建仓入金 ↔ 买入记录」补上外键 =====
  // 新建仓时会同时生成一条买入和一笔入金，二者必须成对联动。早期数据只靠
  // 「金额吻合 + 同券商 + 日期相近 + 备注里的代码/名称」猜测配对，一旦用户改了
  // 买入金额而入金没跟上，双方金额不再相等，以后就再也配不上了。
  // 这里做一次性回填，之后所有联动都按 ref_id 精确定位；配不上对的继续保持原状，
  // 由 store 的兜底逻辑处理（不会误改数据）。
  const costOf = (t) =>
    (Number(t.price) || 0) * (Number(t.shares) || 0) + (Number(t.fee) || 0) + (Number(t.tax) || 0)
  const amountEq = (t, amt) => Math.abs(costOf(t) - amt) <= 0.011
  const noteToken = (note) => {
    const s = String(note || '')
    const open = s.indexOf('（')
    const close = s.lastIndexOf('）')
    return open >= 0 && close > open ? s.slice(open + 1, close).trim() : ''
  }
  const linked = new Set(
    all('SELECT DISTINCT ref_id AS r FROM cash_flows WHERE ref_id IS NOT NULL AND ref_id <> 0').map((x) => x.r)
  )
  const orphanFlows = all(
    "SELECT id, date, broker, note, amount FROM cash_flows " +
      "WHERE type = 'deposit' AND (origin = 'initial' OR note LIKE '初始建仓-自动入金（%') " +
      "AND (ref_id IS NULL OR ref_id = 0) ORDER BY id"
  )
  for (const c of orphanFlows) {
    const amt = Number(c.amount) || 0
    if (amt <= 0) continue
    const token = noteToken(c.note)
    // 取前后 7 天窗口内的初始建仓买入，覆盖买入改期而入金未联动的情况
    const buys = all(
      "SELECT id, date, code, name, shares, price, fee, tax FROM trades " +
        "WHERE type IN ('buy', 'rights') AND origin = 'initial' AND broker = ? " +
        "AND date BETWEEN date(?, '-7 days') AND date(?, '+7 days') ORDER BY date, id",
      [c.broker, c.date, c.date]
    ).filter((t) => !linked.has(t.id))
    if (!buys.length) continue
    const tokenMatches = (t) => token && (token === t.code || token === String(t.name || '').trim())
    const cands = buys.filter((t) => amountEq(t, amt))
    let hit = cands.find((t) => t.date === c.date && tokenMatches(t))
    if (!hit) {
      const sameDay = cands.filter((t) => t.date === c.date)
      if (sameDay.length === 1) hit = sameDay[0]
    }
    if (!hit) {
      const near = buys.filter((t) => amountEq(t, amt) && tokenMatches(t))
      if (near.length === 1) hit = near[0]
    }
    if (!hit) continue
    run('UPDATE cash_flows SET ref_id = ? WHERE id = ?', [hit.id, c.id])
    linked.add(hit.id)
  }
}

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key) {
  const idb = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key, value) {
  const idb = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function readChangedAtFromDb() {
  try {
    const row = get('SELECT value FROM settings WHERE key = ?', ['localChangedAt'])
    if (!row) return 0
    const v = JSON.parse(row.value)
    return typeof v === 'number' ? v : 0
  } catch {
    return 0
  }
}

/**
 * 标记本地数据发生用户级修改。
 * 配合 persist()：持久化时自动把 localChangedAt 更新为当前时间并写入数据库，
 * 使导出/上传的备份文件携带本设备最后修改时间，供其他设备同步判断新旧。
 */
export function markDirty() {
  dirtyFlag = true
}

export function getLocalChangedAt() {
  return localChangedAt
}

/** 读取一个备份字节流的 localChangedAt（不改变当前数据库） */
export function readBytesChangedAt(bytes) {
  let tmp = null
  try {
    tmp = new SQL.Database(bytes)
    const r = tmp.exec("SELECT value FROM settings WHERE key = 'localChangedAt'")
    if (r.length && r[0].values.length) {
      const v = JSON.parse(r[0].values[0][0])
      return typeof v === 'number' ? v : 0
    }
  } catch {
    // 忽略：老版本备份无此字段
  } finally {
    if (tmp) tmp.close()
  }
  return 0
}

export async function initDB() {
  if (!_initPromise) {
    _initPromise = (async () => {
      SQL = await initSqlJs({ locateFile: () => wasmUrl })
      const saved = await idbGet(FILE_KEY)
      db = saved && saved.bytes ? new SQL.Database(saved.bytes) : new SQL.Database()
      db.run(SCHEMA)
      // 老库结构迁移（补列/回填初始建仓标记等），需在读写业务数据前执行
      migrate()
      localChangedAt = readChangedAtFromDb()
    })()
  }
  await _initPromise
  return db
}

function normParams(params) {
  return (params || []).map((v) => (v === undefined ? null : v))
}

export function run(sql, params = []) {
  db.run(sql, normParams(params))
}

export function all(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(normParams(params))
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

export function get(sql, params = []) {
  return all(sql, params)[0] || null
}

export async function persist() {
  if (!db) return
  if (dirtyFlag) {
    dirtyFlag = false
    localChangedAt = Date.now()
    setSetting('localChangedAt', localChangedAt)
  }
  const bytes = db.export()
  await idbSet(FILE_KEY, { bytes, ts: Date.now(), changedAt: localChangedAt })
}

export function exportBytes() {
  return db ? db.export() : null
}

export function loadBytes(bytes) {
  // 校验备份文件头：内容被篡改/转码（如网络代理返回文本）时给出明确提示，而不是底层 SQLite 的晦涩报错
  if (!bytes || bytes.length < 16) {
    throw new Error('备份文件为空或已损坏，无法恢复。请检查云端备份。')
  }
  const magic = 'SQLite format 3\u0000'
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) {
      throw new Error('备份文件不是有效的数据库（可能被网络代理转码）。请在其他网络/设备上重新备份后重试。')
    }
  }
  const ndb = new SQL.Database(bytes)
  ndb.run(SCHEMA)
  if (db) db.close()
  db = ndb
  migrate()
  localChangedAt = readChangedAtFromDb()
}

/** 本地是否已有业务数据（用于同步时判断是否该保守处理，避免误覆盖） */
export function hasData() {
  if (!db) return false
  try {
    const row = get(
      'SELECT (SELECT COUNT(*) FROM stocks) + (SELECT COUNT(*) FROM trades) + (SELECT COUNT(*) FROM cash_flows) AS c'
    )
    return !!(row && row.c > 0)
  } catch {
    return false
  }
}

// ===== 券商管理 =====
export function getBrokers() {
  return all('SELECT * FROM brokers ORDER BY id')
}

export function insertBroker(name) {
  run('INSERT INTO brokers (name) VALUES (?)', [name])
}

export function renameBroker(oldName, newName) {
  run('UPDATE brokers SET name = ? WHERE name = ?', [newName, oldName])
  run('UPDATE stocks SET broker = ? WHERE broker = ?', [newName, oldName])
  run('UPDATE trades SET broker = ? WHERE broker = ?', [newName, oldName])
  run('UPDATE cash_flows SET broker = ? WHERE broker = ?', [newName, oldName])
}

export function deleteBroker(name, fallback = DEFAULT_BROKER) {
  run('DELETE FROM brokers WHERE name = ?', [name])
  // 确保兜底账户存在，避免数据指向不存在的券商
  if (!get('SELECT id FROM brokers WHERE name = ?', [fallback])) {
    run('INSERT INTO brokers (name) VALUES (?)', [fallback])
  }
  // 该券商名下的数据移入兜底账户
  run('UPDATE stocks SET broker = ? WHERE broker = ?', [fallback, name])
  run('UPDATE trades SET broker = ? WHERE broker = ?', [fallback, name])
  run('UPDATE cash_flows SET broker = ? WHERE broker = ?', [fallback, name])
}

export function getDefaultBroker() {
  return getSetting('defaultBroker', null)
}

export function setDefaultBroker(name) {
  setSetting('defaultBroker', name)
}

export async function getKv(key) {
  return idbGet(key)
}

/**
 * IndexedDB 用结构化克隆存值，而 Vue 的响应式对象是 Proxy —— 直接 put 会抛
 * DataCloneError（实测：ref 数组 / reactive 对象都克隆失败），写入被静默丢弃。
 * 这里统一先转成纯对象/数组，避免「存了但下次打开还在」这类问题。
 */
function toPlain(v) {
  if (v === null || typeof v !== 'object') return v
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return v
  }
}

export async function setKv(key, value) {
  await idbSet(key, toPlain(value))
}

// ===== 同步留底：覆盖前自动保存一份，避免误覆盖丢数据 =====
const SNAP_LIMIT = 12

function idbDel(key) {
  return openIDB().then(
    (idb) =>
      new Promise((resolve, reject) => {
        const tx = idb.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
  )
}

/** 保存一份当前本地数据库快照到 IndexedDB（自动只保留最近 SNAP_LIMIT 份），返回时间戳 */
export async function saveLocalSnapshot(note = '') {
  if (!db) return null
  const ts = Date.now()
  const bytes = db.export()
  try {
    await idbSet('snap-' + ts, { bytes })
  } catch {
    return null
  }
  const meta = (await idbGet('snap-meta')) || []
  meta.unshift({ ts, note })
  while (meta.length > SNAP_LIMIT) {
    const old = meta.pop()
    if (old) await idbDel('snap-' + old.ts)
  }
  await idbSet('snap-meta', meta)
  return ts
}

/** 本地留底列表（新的在前）：[{ ts, note }] */
export async function listLocalSnapshots() {
  return (await idbGet('snap-meta')) || []
}

/** 取某份本地留底的字节 */
export async function getLocalSnapshotBytes(ts) {
  const rec = await idbGet('snap-' + ts)
  return rec ? rec.bytes : null
}

/** 记录一份“覆盖前云端版本”已存档到仓库 backup/history/ 下（元数据只保存在本机，文件在云端） */
export async function addCloudArchive(ts, path, note = '') {
  const meta = (await idbGet('arch-meta')) || []
  meta.unshift({ ts, path, note })
  while (meta.length > SNAP_LIMIT) meta.pop()
  await idbSet('arch-meta', meta)
}

/** 云端留底列表（新的在前）：[{ ts, path, note }] */
export async function listCloudArchives() {
  return (await idbGet('arch-meta')) || []
}

export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key])
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch {
    return row.value
  }
}

export function setSetting(key, value) {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)])
}
