/**
 * dsh-symbol-links — host 半。
 *
 * 职责：只读符号索引 + 同源只读路由 POST /api/symbol-links/resolve。
 * 安全：根目录 = 会话 header.cwd（不信任客户端 cwd）+ 用户在插件配置里显式声明的 extraRoots；
 * 结果逐个 realpath 边界校验；名字白名单；冷建索引与逐名解析各有预算。
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { buildIndex, IGNORE_DIRS, LANG_BY_EXT, resolveName, scanSource, KIND_OCCURRENCE } from './resolver.js'

export const name = 'dsh-symbol-links'
export const inject = ['webServer', 'sessions']
export const RESOLVE_ROUTE = '/api/symbol-links/resolve'

/** 额外索引根（例如 VMRA 仓库），与会话根一起参与解析；会话根命中优先。 */
export const Config = Schema.object({
  extraRoots: Schema.array(Schema.string()).default([]).description('额外的只读索引根目录（绝对路径）'),
})

const MAX_FILES = 50_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const INDEX_TTL_MS = 10 * 60_000
const COLD_BUILD_TIMEOUT_MS = 3_500
const LOOKUP_BUDGET_MS = 1_500
const GREP_BUDGET_MS = 250
const INDEX_LRU_CAP = 4
const BODY_LIMIT = 64 * 1024
const MAX_NAMES = 24
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_:<>~]{0,119}$/

/** root → {builtAt, building, index, files, truncated} */
const indexes = new Map()

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function isLoopback(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function sameOrigin(req) {
  const host = req.headers.host
  if (host === undefined) return false
  const hostname = host.replace(/:\d+$/, '')
  if (!isLoopback(hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).hostname !== hostname) return false
    } catch {
      return false
    }
  }
  return true
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > BODY_LIMIT) throw new Error('body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('body must be an object')
  return parsed
}

async function buildWorkspaceIndex(root) {
  const sites = []
  const files = []
  const queue = ['']
  let fileCount = 0
  let truncated = false
  while (queue.length > 0) {
    const relDir = queue.shift()
    let entries
    try {
      entries = await readdir(relDir === '' ? root : join(root, relDir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (fileCount >= MAX_FILES) { truncated = true; break }
      const rel = relDir === '' ? entry.name : relDir + '/' + entry.name
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        queue.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      const lang = LANG_BY_EXT[extname(entry.name).toLowerCase()]
      if (lang === undefined) continue
      const abs = join(root, rel)
      let st
      try { st = await stat(abs) } catch { continue }
      if (st.size > MAX_FILE_BYTES) continue
      let text
      try { text = await readFile(abs, 'utf8') } catch { continue }
      if (text.includes('\u0000')) continue
      fileCount++
      files.push({ path: rel, lang, abs })
      for (const site of scanSource(text, lang, rel)) sites.push(site)
    }
  }
  return { sites, files, truncated, fileCount }
}

async function indexFor(root) {
  const now = Date.now()
  const existing = indexes.get(root)
  if (existing !== undefined) {
    if (existing.building !== undefined) return existing.building
    if (now - existing.builtAt < INDEX_TTL_MS) return existing
  }
  const building = (async () => {
    let built
    try {
      built = await buildWorkspaceIndex(root)
    } catch (error) {
      indexes.delete(root)
      throw error
    }
    const record = {
      builtAt: Date.now(),
      root,
      ...buildIndex(built.sites),
      files: built.files,
      truncated: built.truncated,
      fileCount: built.fileCount,
    }
    indexes.set(root, record)
    if (indexes.size > INDEX_LRU_CAP) {
      const oldest = [...indexes.entries()].sort((a, b) => a[1].builtAt - b[1].builtAt)[0]
      if (oldest !== undefined) indexes.delete(oldest[0])
    }
    return record
  })()
  indexes.set(root, { builtAt: 0, building })
  return building
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ])
}

async function grepFallback(index, name, deadline) {
  const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')
  for (const file of index.files) {
    if (Date.now() > deadline) return { hit: null, exhausted: true }
    let text
    try { text = await readFile(file.abs, 'utf8') } catch { continue }
    if (Date.now() > deadline) return { hit: null, exhausted: true }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length <= 4000 && lines[i].includes(name) && re.test(lines[i])) {
        return { hit: { name, path: file.path, line: i + 1, kind: KIND_OCCURRENCE, via: KIND_OCCURRENCE }, exhausted: false }
      }
      if ((i & 1023) === 0 && Date.now() > deadline) return { hit: null, exhausted: true }
    }
  }
  return { hit: null, exhausted: false }
}

/**
 * 收集引用：先用索引里的定义/调用站点，再用有预算的逐行扫描补齐行内引用。
 * 结果去重（path:line），按路径 + 行号排序。
 */
async function collectReferences(index, name, deadline, limit, out) {
  const seen = new Set(out.map(item => item.path + ':' + item.line))
  const push = (path, line, kind) => {
    const key = path + ':' + line
    if (seen.has(key) || out.length >= limit) return
    seen.add(key)
    out.push({ name, path, line, kind })
  }
  const entry = index.byName.get(name)
  if (entry !== undefined) {
    for (const site of [...entry.defs, ...entry.calls]) push(site.path, site.line, site.kind)
  }
  if (out.length >= limit) return { exhausted: false }
  const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\export function apply(ctx, config) {') + '\\b')
  for (const file of index.files) {
    if (Date.now() > deadline) return { exhausted: true }
    let text
    try { text = await readFile(file.abs, 'utf8') } catch { continue }
    if (Date.now() > deadline) return { exhausted: true }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length <= 4000 && lines[i].includes(name) && re.test(lines[i])) {
        push(file.path, i + 1, 'occurrence')
        if (out.length >= limit) return { exhausted: false }
      }
      if ((i & 1023) === 0 && Date.now() > deadline) return { exhausted: true }
    }
  }
  return { exhausted: false }
}

/** 收集同名定义（"实现"候选）：跨根、去重、按路径 + 行号排序。 */
function collectImplementations(index, name, out) {
  const entry = index.byName.get(name)
  if (entry === undefined) return
  for (const site of entry.defs) {
    const key = site.path + ':' + site.line
    if (!out.some(item => item.path + ':' + item.line === key)) {
      out.push({ name, path: site.path, line: site.line, kind: 'implementation' })
    }
  }
}

export function apply(ctx, config) {
  const extraRoots = (config && Array.isArray(config.extraRoots) ? config.extraRoots : [])
    .filter(root => typeof root === 'string' && root !== '')
    .slice(0, 4)

  ctx.webServer.register({
    kind: 'exact',
    path: RESOLVE_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
      if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, error: 'untrusted origin' })
      let body
      try { body = await readBody(req) } catch (error) {
        return writeJson(res, 400, { ok: false, error: String(error.message || error) })
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (sessionId === '') return writeJson(res, 400, { ok: false, error: 'sessionId required' })
      const want = body.want === 'references' || body.want === 'implementation' ? body.want : 'definition'
      const names = Array.isArray(body.names)
        ? body.names.filter(n => typeof n === 'string' && NAME_RE.test(n)).slice(0, MAX_NAMES)
        : []
      if (names.length === 0) return writeJson(res, 200, { ok: true, results: [] })

      const headerCwd = ctx.sessions.get(sessionId)?.header?.cwd
      if (typeof headerCwd !== 'string' || headerCwd === '') {
        return writeJson(res, 400, { ok: false, error: 'session cwd unavailable' })
      }
      const roots = []
      try { roots.push(await realpath(headerCwd)) } catch {
        return writeJson(res, 400, { ok: false, error: 'workspace root not found' })
      }
      for (const extra of extraRoots) {
        try { roots.push(await realpath(extra)) } catch { /* 配置里的失效根忽略 */ }
      }

      const hints = Array.isArray(body.hintFiles)
        ? body.hintFiles.filter(h => typeof h === 'string').map(h => h.replace(/\\\\/g, '/').replace(/^\.\//, ''))
        : []

      let incomplete = false
      let truncatedAny = false
      const built = {}
      for (const root of roots) {
        const index = await withTimeout(indexFor(root), COLD_BUILD_TIMEOUT_MS).catch(() => null)
        if (index === null) { incomplete = true; continue }
        built[root] = index
        if (index.truncated === true) truncatedAny = true
      }

      const deadline = Date.now() + LOOKUP_BUDGET_MS
      if (want === 'references' || want === 'implementation') {
        const results = []
        const limit = want === 'references' ? 50 : 20
        for (const symbol of names) {
          if (Date.now() > deadline) { incomplete = true; break }
          for (const root of roots) {
            const index = built[root]
            if (index === undefined || results.length >= limit) continue
            if (want === 'implementation') {
              collectImplementations(index, symbol, results)
            } else {
              const scan = await collectReferences(index, symbol, Math.min(Date.now() + GREP_BUDGET_MS, deadline), limit, results)
              if (scan.exhausted) incomplete = true
            }
          }
        }
        results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
        return writeJson(res, 200, {
          ok: true,
          incomplete,
          want,
          results,
          limit,
          limitHit: results.length >= limit,
          truncated: truncatedAny,
          roots: roots.length,
        })
      }

      const results = []
      for (const symbol of names) {
        if (Date.now() > deadline) { incomplete = true; break }
        let resolved = null
        for (const root of roots) {
          const index = built[root]
          if (index === undefined) continue
          let hit = resolveName(symbol, index, hints)
          if (hit === null) {
            const grepDeadline = Math.min(Date.now() + GREP_BUDGET_MS, deadline)
            const grep = await grepFallback(index, symbol, grepDeadline)
            hit = grep.hit
            if (grep.exhausted) incomplete = true
          }
          if (hit !== null) { resolved = { root, hit }; break }
        }
        if (resolved === null) continue
        const abs = join(resolved.root, resolved.hit.path.replace(/\//g, sep))
        let real
        try { real = await realpath(abs) } catch { continue }
        if (real !== resolved.root && !real.startsWith(resolved.root + sep)) continue
        results.push({ name: resolved.hit.name, path: resolved.hit.path, line: resolved.hit.line, kind: resolved.hit.kind, via: resolved.hit.via })
      }
      return writeJson(res, 200, {
        ok: true,
        incomplete,
        want,
        results,
        truncated: truncatedAny,
        roots: roots.length,
      })
    },
  })
}
