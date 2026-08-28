const API = 'https://api.github.com'

export function parseRepo(repo) {
  let p = String(repo || '').trim()
  // 兼容多种填写格式：
  //   owner/name
  //   https://github.com/owner/name[.git]
  //   github.com/owner/name
  //   git@github.com:owner/name.git
  p = p.replace(/^https?:\/\//i, '')
  p = p.replace(/^git@/i, '')
  p = p.replace(/^github\.com[/:]/i, '')
  p = p.replace(/\.git$/i, '')
  p = p.replace(/\/+$/, '')
  const parts = p.split('/').filter(Boolean)
  return [parts[0] || '', parts[1] || '']
}

function base64FromBytes(bytes) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function bytesFromBase64(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json'
  }
}

async function gh(path, token, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { ...headers(token), ...(opts.headers || {}) }
  })
  if (res.status === 404) {
    let msg = ''
    try {
      const j = await res.json()
      msg = j.message || ''
    } catch {
      /* ignore */
    }
    return { notFound: true, message: msg }
  }
  if (!res.ok) {
    let msg = `GitHub API 错误 HTTP ${res.status}`
    try {
      const j = await res.json()
      msg = j.message || msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return parseJsonResponse(res)
}

/** 安全解析 JSON 响应：响应体非 JSON（如被网络代理/转码篡改）时，给出可读错误而不是晦涩的 JSON.parse 报错 */
async function parseJsonResponse(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      `GitHub 返回了无法解析的响应（HTTP ${res.status}），内容开头为「${text.slice(0, 40)}」。请检查网络代理/加速设置后重试。`
    )
  }
}

/** 判断字节流是否为有效的 SQLite 数据库文件（文件头固定为 "SQLite format 3\\0"） */
function isSqliteBytes(bytes) {
  if (!bytes || bytes.length < 16) return false
  const magic = 'SQLite format 3\u0000'
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) return false
  }
  return true
}

/** 对文件路径按段编码，保留斜杠作为目录分隔符（GitHub API 不接受整串编码） */
function encodePath(p) {
  return String(p || '')
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

export async function testConnection(token, repo, path = '') {
  const [owner, name] = parseRepo(repo)
  if (!owner || !name) throw new Error('请填写正确的仓库地址（如 myname/stock-ledger-backup）')
  const tk = String(token || '').trim()
  if (!tk) throw new Error('请填写访问令牌（PAT，ghp_ 开头）')

  // 第 1 步：验证令牌本身是否有效，并获取它属于哪个 GitHub 账号
  let login = ''
  try {
    const me = await gh('/user', tk)
    login = me.login || ''
  } catch (e) {
    if (/bad credentials/i.test(e.message || '')) {
      throw new Error(`令牌无效或已过期（401）。请确认复制完整（ghp_ 开头，无空格无换行），或到 GitHub 重新生成 PAT。`)
    }
    throw new Error(`令牌验证失败：${e.message}`)
  }

  // 第 2 步：用实际备份/同步会使用的 Contents API 验证仓库可访问
  // 根目录路径需带尾斜杠；空仓库也会返回 404（message 含 empty），仍视为可访问
  const dir = await gh(`/repos/${owner}/${name}/contents/`, tk)
  if (!dir.notFound || /empty/i.test(dir.message || '')) {
    return { owner, name, repo: `${owner}/${name}`, login, tokenTail: tk.slice(-4), via: 'contents' }
  }

  // 第 3 步：根目录失败时，再尝试读取用户设置的备份文件路径（与备份逻辑完全一致）
  // 能读到说明仓库和 Contents 权限都正常；读不到再进一步诊断
  const file = await downloadBackup(tk, owner, name, path || 'backup/stock-ledger.db')
  if (file) {
    return { owner, name, repo: `${owner}/${name}`, login, tokenTail: tk.slice(-4), via: 'file' }
  }

  // 第 4 步：Contents 和具体文件都不可访问，再确认是权限问题还是仓库不存在
  // 通过 /user/repos 列出令牌能看到的仓库，定位问题
  let diagnostic = ''
  try {
    const repos = await gh(`/user/repos?per_page=100&sort=updated`, tk)
    const found = (repos || []).find((r) => r.full_name === `${owner}/${name}`)
    if (found) {
      diagnostic = `诊断：该仓库出现在令牌的授权列表中（private=${found.private}），但 Contents 接口返回 404。可能是令牌 Contents 权限未开启，或 GitHub 账号权限异常。`
    } else {
      const total = (repos || []).length
      diagnostic = `诊断：该仓库不在令牌可访问的 ${total} 个仓库列表中，说明令牌未被授权访问此私有仓库。`
    }
  } catch (e) {
    diagnostic = `诊断：无法列出仓库列表（${e.message}），请手动检查令牌权限。`
  }

  const meta = await gh(`/repos/${owner}/${name}`, tk)
  if (!meta.notFound) {
    throw new Error(
      `仓库 ${owner}/${name} 存在（令牌账号：${login}），但令牌没有 Contents 权限。\n` +
        'classic 令牌需勾选 repo；fine-grained 令牌需在 Repository access 中授权此仓库并开启 Contents 读写。'
    )
  }
  throw new Error(
    `未找到仓库：${owner}/${name}（令牌账号：${login}，尾号 ${tk.slice(-4)}，检测方式：Contents API）\n` +
      `GitHub 返回：${dir.message || 'Not Found'}（HTTP 404）\n` +
      `${diagnostic}\n\n` +
      '请逐一检查：\n' +
      `1. 仓库地址是否与 GitHub 完全一致（当前解析为 ${owner}/${name}，区分大小写）；\n` +
      '2. 令牌对该私有仓库是否有权限：classic 令牌需勾选 repo；fine-grained 令牌需在 Repository access 中授权此仓库并开启 Contents 读写；\n' +
      `3. 仓库是否属于账号「${login}」本人；\n` +
      '4. 仓库是否被删除或改名。'
  )
}

export async function uploadBackup(token, owner, repo, path, bytes, message) {
  const content = base64FromBytes(bytes)
  const existing = await gh(`/repos/${owner}/${repo}/contents/${encodePath(path)}`, token)
  const body = {
    message: message || `备份 ${new Date().toISOString()}`,
    content
  }
  if (!existing.notFound && existing.sha) body.sha = existing.sha
  await gh(`/repos/${owner}/${repo}/contents/${encodePath(path)}`, token, {
    method: 'PUT',
    body: JSON.stringify(body)
  })
  return new Date().toISOString()
}

export async function downloadBackup(token, owner, repo, path) {
  // 用 raw 格式直接获取文件二进制，避免 contents API 对大文件不返回 content 的问题
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json'
    }
  })
  if (res.status === 404) return null
  if (!res.ok) {
    let msg = `GitHub API 错误 HTTP ${res.status}`
    try {
      const j = await res.json()
      msg = j.message || msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const committedAt = new Date(res.headers.get('last-modified') || Date.now()).getTime()
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (isSqliteBytes(bytes)) {
    return { bytes, committedAt }
  }
  // raw 内容不是有效数据库：部分安卓网络环境（运营商/代理/流量转码）会把二进制响应
  // 转码成文本（如 "SQLite for wasm…"），此时回退到 Contents API 的 base64 字段重新获取
  let fallbackErr = ''
  try {
    const j = await gh(`/repos/${owner}/${repo}/contents/${encodePath(path)}`, token)
    const b64 = String(j.content || '').replace(/\s/g, '')
    const fb = bytesFromBase64(b64)
    if (fb.length && isSqliteBytes(fb)) {
      return { bytes: fb, committedAt }
    }
    if (!fb.length) fallbackErr = 'Contents API 返回的 content 为空'
  } catch (e) {
    fallbackErr = e.message || String(e)
  }
  throw new Error(
    `云端备份文件已损坏或不是有效的数据库（可能被网络代理转码）${fallbackErr ? `；base64 回退也失败：${fallbackErr}` : ''}。请在其他网络/设备上执行一次「立即备份」覆盖云端文件后重试。`
  )
}
