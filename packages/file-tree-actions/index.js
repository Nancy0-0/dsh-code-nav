/**
 * dsh-file-tree-actions —— Host 半边。
 *
 * 浏览器半边（client.js）负责右键菜单与拖拽；新建/重命名/删除这类**写操作**
 * 不能只靠浏览器：宿主对客户端的 workspaceFiles 桥是只读的（list/read/changes），
 * 所以这里在 `/api/file-tree-actions` 上开一个精确的 Fetch 路由：
 *
 *   POST /api/file-tree-actions
 *   { op: 'create-file' | 'create-dir' | 'rename' | 'delete',
 *     root, parent?, path?, name? }
 *
 * 安全边界（顺序即防线）：
 *   1. 走 `ctx.connection.fetch.register`：连接层已经套上 Host/Origin 栅栏与登录态，
 *      只有 owner principal 能到达这里（见 dsh-client-connection 的共享 Fetch handler）。
 *   2. 请求体限长、字段必须是字符串、op 必须在白名单里。
 *   3. `root` 必须等于某个会话工作区，或落在它下面；再对 root/父目录/目标做 realpath，
 *      目标必须仍在真实根内——符号链接指向外面的一律拒绝。
 *   4. 名字只允许单个路径片段；新建/重命名绝不覆盖已存在目标；删除只走回收站。
 */
import { promises as fs } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isInside, samePath, validateName } from './lib/paths.js'
import { createEntry, OpError, recycleEntry, renameEntry } from './lib/ops.js'

/** Cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'dsh-file-tree-actions'

/** 路由需要的服务：连接层（Fetch 通道）、会话表（工作区根）。 */
export const inject = []

/** 精确路由路径，必须在 /api 通道下。 */
const ROUTE = '/api/file-tree-actions'
/** 请求体上限：只接受小 JSON。 */
const MAX_BODY_BYTES = 8 * 1024
/** 允许的操作白名单。 */
const OPS = ['create-file', 'create-dir', 'rename', 'delete']

/** JSON 响应。 */
function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** 失败响应。 */
function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } })
}

/** 由 OpError / 系统错误映射成 HTTP 状态与稳定 code。 */
function failure(error) {
  if (error instanceof OpError) {
    const table = { exists: 409, 'not-found': 404, denied: 403, invalid: 400, unsupported: 501 }
    const status = table[error.code] ?? 500
    return fail(status, error.code, error.message)
  }
  if (typeof error === 'object' && error !== null && typeof error.code === 'string') {
    if (error.code === 'ENOENT') return fail(404, 'not-found', '目标不存在')
    if (error.code === 'EEXIST') return fail(409, 'exists', '目标已存在')
    if (error.code === 'EACCES' || error.code === 'EPERM') return fail(403, 'denied', '没有权限修改这个路径')
    if (error.code === 'ENOTDIR') return fail(400, 'not-directory', '父路径不是目录')
  }
  return fail(500, 'internal', error instanceof Error ? error.message : String(error))
}

/**
 * 允许的工作区根：所有会话的 cwd，加上 sandbox 策略根作为兜底。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<string[]>} realpath 之后的根（不可解析的丢弃）
 */
async function allowedRoots(ctx) {
  const candidates = []
  try {
    for (const session of ctx.sessions.list()) {
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') candidates.push(cwd)
    }
  } catch {
    /* 会话表不可用时只保留兜底 */
  }
  try {
    const fallback = ctx.get('sandboxPolicy')?.workspaceRoot
    if (typeof fallback === 'string' && fallback !== '') candidates.push(fallback)
  } catch {
    /* 没有策略服务就不兜底 */
  }
  const roots = []
  for (const candidate of candidates) {
    try {
      roots.push(await realpath(candidate))
    } catch {
      /* 目录已经不在了，跳过 */
    }
  }
  return roots
}

/** 请求里的 root 必须等于某个允许根，或落在它下面。 */
function rootAllowed(roots, root) {
  return roots.some((allowed) => samePath(allowed, root) || isInside(allowed, root))
}

/** 在真实根内收敛一个已存在的路径。 */
async function resolveInside(roots, rootReal, target) {
  const absolute = resolve(target)
  if (!isAbsolute(absolute)) throw new OpError('invalid', '路径必须是绝对路径')
  const real = await realpath(absolute).catch(() => {
    throw new OpError('not-found', '目标不存在')
  })
  if (!isInside(rootReal, real)) throw new OpError('invalid', '目标不在工作区内')
  return real
}

/**
 * 处理一个操作请求。
 * @param {Request} request
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
async function handle(request, ctx) {
  if (request.method !== 'POST') return fail(405, 'method', '只支持 POST')
  try {
    // 先看 Content-Length，超限直接拒绝，不把请求体读进内存。
    const declared = Number(request.headers.get('content-length') || '0')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'too-large', '请求体过大')
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return fail(413, 'too-large', '请求体过大')
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return fail(400, 'invalid', '请求体不是合法 JSON')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return fail(400, 'invalid', '请求体必须是对象')
    }
    const { op, root, parent, path: target, name } = body
    if (typeof op !== 'string' || !OPS.includes(op)) return fail(400, 'invalid', '未知操作')
    if (typeof root !== 'string' || !isAbsolute(root)) return fail(400, 'invalid', 'root 必须是绝对路径')
    if (parent !== undefined && typeof parent !== 'string') return fail(400, 'invalid', 'parent 必须是字符串')
    if (target !== undefined && typeof target !== 'string') return fail(400, 'invalid', 'path 必须是字符串')

    const roots = await allowedRoots(ctx)
    // 先把 root 解析成真实路径再比对：Windows 短名（RUNNER~1）、大小写、符号链接
    // 都可能让"同一个目录"的两种写法不相等，按字符串比会误判成越界。
    const rootReal = await realpath(root).catch(() => {
      throw new OpError('not-found', '工作区目录不存在')
    })
    if (!roots.some((allowed) => samePath(allowed, rootReal) || isInside(allowed, rootReal))) {
      return fail(403, 'denied', '这个目录不是当前已知的工作区')
    }

    if (op === 'create-file' || op === 'create-dir') {
      const checked = validateName(name)
      if (!checked.ok) throw new OpError('invalid', checked.error)
      const parentArg = typeof parent === 'string' && parent !== '' ? parent : rootReal
      const parentReal = await resolveInside(roots, rootReal, parentArg)
      const info = await fs.stat(parentReal)
      if (!info.isDirectory()) throw new OpError('invalid', '父路径不是目录')
      const created = await createEntry(op === 'create-dir' ? 'dir' : 'file', parentReal, checked.name)
      return json(200, { ok: true, op, path: created.path, name: checked.name })
    }
    if (op === 'rename') {
      if (typeof target !== 'string') return fail(400, 'invalid', '缺少 path')
      const checked = validateName(name)
      if (!checked.ok) throw new OpError('invalid', checked.error)
      const sourceReal = await resolveInside(roots, rootReal, target)
      if (samePath(sourceReal, rootReal)) throw new OpError('invalid', '不能重命名工作区根目录')
      const renamed = await renameEntry(sourceReal, checked.name)
      return json(200, { ok: true, op, path: renamed.path, name: checked.name })
    }
    // delete
    const sourceReal = await resolveInside(roots, rootReal, target)
    if (samePath(sourceReal, rootReal)) throw new OpError('invalid', '不能删除工作区根目录')
    const recycled = await recycleEntry(sourceReal)
    return json(200, { ok: true, op, path: recycled.path })
  } catch (error) {
    return failure(error)
  }
}

/**
 * Host 侧插件体：有连接层与会话表时注册精确 Fetch 路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.inject(['connection', 'sessions'], (scope) => {
    scope.effect(
      () =>
        scope.connection.fetch.register({
          path: ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handle(request, scope),
        }),
      'dsh-file-tree-actions: file operations route',
    )
  })
}
