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
  broker TEXT DEFAULT ''
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
  try { run('ALTER TABLE trades ADD COLUMN broker TEXT DEFAULT ""') } catch {}
  try { run('ALTER TABLE cash_flows ADD COLUMN broker TEXT DEFAULT ""') } catch {}
  // 确保默认券商存在
  const b = get('SELECT id FROM brokers WHERE name = ?', [DEFAULT_BROKER])
  if (!b) run('INSERT INTO brokers (name) VALUES (?)', [DEFAULT_BROKER])
  // 老数据回填默认券商
  run("UPDATE stocks SET broker = ? WHERE broker IS NULL OR broker = ''", [DEFAULT_BROKER])
  run("UPDATE trades SET broker = ? WHERE broker IS NULL OR broker = ''", [DEFAULT_BROKER])
  run("UPDATE cash_flows SET broker = ? WHERE broker IS NULL OR broker = ''", [DEFAULT_BROKER])
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
      localChangedAt = readChangedAtFromDb()
    })()
  }
  await _initPromise
  return db
}

export function getDB() {
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

export function deleteBroker(name) {
  run('DELETE FROM brokers WHERE name = ?', [name])
  // 该券商名下的数据移回默认账户
  run('UPDATE stocks SET broker = ? WHERE broker = ?', [DEFAULT_BROKER, name])
  run('UPDATE trades SET broker = ? WHERE broker = ?', [DEFAULT_BROKER, name])
  run('UPDATE cash_flows SET broker = ? WHERE broker = ?', [DEFAULT_BROKER, name])
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
