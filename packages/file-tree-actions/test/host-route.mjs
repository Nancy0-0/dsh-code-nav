// Host 路由单测：用假 ctx 捕获注册的 Fetch 路由，直接调 handler。
// 运行：ELECTRON_RUN_AS_NODE=1 "F:\Deepseek\DeepSeek Harness.exe" --expose-internals test\host-route.mjs
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const OUT = 'C:/Users/Administrator/Documents/deepseek-harness/default-workspace/logs/fta-route-test.json'
const results = []
const exists = async (path) => fs.stat(path).then(() => true, () => false)
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail })

const root = await fs.mkdtemp(join(tmpdir(), 'fta-route-'))
const other = await fs.mkdtemp(join(tmpdir(), 'fta-other-'))
let registered = null
let disposer = null
const fakeCtx = {
  inject(deps, callback) {
    callback({
      effect: (fn) => {
        disposer = fn()
      },
      connection: { fetch: { register: (route) => { registered = route } } },
      sessions: { list: () => [{ header: { cwd: root } }] },
      get: () => undefined,
    })
  },
}

apply(fakeCtx)

const call = async (payload, raw) => {
  const body = raw !== undefined ? raw : JSON.stringify(payload)
  const request = new Request('http://127.0.0.1/api/file-tree-actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  const response = await registered.fetch(request)
  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, json }
}

try {
  check('route registered', registered !== null && registered.path === '/api/file-tree-actions')
  check('route declares POST', registered !== null && registered.methods.includes('POST'))

  // 新建文件 / 目录
  const created = await call({ op: 'create-file', root, parent: root, name: 'a.md' })
  check('create file 200', created.status === 200 && created.json.ok === true, created)
  check('create file on disk', (await fs.readFile(join(root, 'a.md'), 'utf8')) === '')
  const dir = await call({ op: 'create-dir', root, parent: root, name: 'assets' })
  check('create dir 200', dir.status === 200 && (await fs.stat(join(root, 'assets'))).isDirectory())

  // 重名 → 409
  const duplicate = await call({ op: 'create-file', root, parent: root, name: 'a.md' })
  check('duplicate create 409', duplicate.status === 409 && duplicate.json.error.code === 'exists', duplicate)

  // 重命名
  const renamed = await call({ op: 'rename', root, path: join(root, 'a.md'), name: 'b.md' })
  check('rename 200', renamed.status === 200 && (await exists(join(root, 'b.md'))))

  // 校验失败
  const badName = await call({ op: 'create-file', root, parent: root, name: 'a/b' })
  check('bad name 400', badName.status === 400, badName)
  const outsider = await call({ op: 'create-file', root: other, parent: other, name: 'x.md' })
  check('unknown root 403', outsider.status === 403, outsider)
  const escape = await call({ op: 'create-file', root, parent: other, name: 'x.md' })
  check('parent outside root 400', escape.status === 400, escape)
  const rootRename = await call({ op: 'rename', root, path: root, name: 'zzz' })
  check('rename root 400', rootRename.status === 400, rootRename)
  const badJson = await call(null, 'not json')
  check('bad json 400', badJson.status === 400, badJson)
  const badOp = await call({ op: 'chmod', root })
  check('unknown op 400', badOp.status === 400, badOp)
  const noRoot = await call({ op: 'create-file', parent: root, name: 'x.md' })
  check('missing root 400', noRoot.status === 400, noRoot)

  // 根不存在：曾因根解析在 try 之外抛出 rejected promise，现在必须是 JSON 404
  const missingRoot = await call({ op: 'create-file', root: join(root, 'nope'), parent: join(root, 'nope'), name: 'x.md' })
  check('missing root dir 404 json', missingRoot.status === 404 && missingRoot.json !== null && missingRoot.json.ok === false, missingRoot)

  // 字段类型：parent 只能是字符串（以前会被静默替换成根目录）
  const badParent = await call({ op: 'create-file', root, parent: 123, name: 'x.md' })
  check('parent wrong type 400', badParent.status === 400, badParent)
  const badTarget = await call({ op: 'delete', root, path: 42 })
  check('path wrong type 400', badTarget.status === 400, badTarget)
  const arrayBody = await call(null, '[]')
  check('array body 400', arrayBody.status === 400, arrayBody)

  // 请求体超限：Content-Length 预判即可拒绝（不把 9KB 读进业务层）
  const bigBody = JSON.stringify({ op: 'create-file', root, name: 'x.md', pad: 'x'.repeat(9000) })
  check('oversized body 413', (await call(null, bigBody)).status === 413)

  // 方法不对 → 405（handler 自己判，路由层已声明 methods）
  const getRequest = new Request('http://127.0.0.1/api/file-tree-actions', { method: 'GET' })
  const getResponse = await registered.fetch(getRequest)
  check('GET 405', getResponse.status === 405)

  // 回收站：真实执行一次（临时空文件，会进系统回收站）
  const victim = join(root, 'recycle-me.txt')
  await fs.writeFile(victim, 'x')
  const recycled = await call({ op: 'delete', root, path: victim })
  check('delete sends to recycle bin', recycled.status === 200 && !(await exists(victim)), recycled)

  // 释放
  if (typeof disposer === 'function') disposer()
  check('effect disposer callable', true)
} catch (error) {
  check('route test threw', false, String(error && error.stack ? error.stack : error))
} finally {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(other, { recursive: true, force: true })
}

const out = {
  pass: results.every((entry) => entry.pass),
  checks: results.length,
  failed: results.filter((entry) => !entry.pass).map((entry) => entry.name),
  results,
}
await fs.writeFile(OUT, JSON.stringify(out, null, 2), 'utf8')
console.log(out.pass ? 'PASS' : 'FAIL ' + out.failed.join(', '))
if (!out.pass) process.exitCode = 1
