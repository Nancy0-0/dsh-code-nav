// Host 半边单测：路径校验 + 新建/重命名（不碰回收站，避免污染真实回收站）。
// 运行：node test/host-ops.mjs（结果 JSON 默认写系统临时目录，可用 FTA_RESULT_DIR 覆盖）
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInside, samePath, validateName } from '../lib/paths.js'
import { createEntry, OpError, renameEntry } from '../lib/ops.js'

const results = []
const OUT = join(process.env.FTA_RESULT_DIR ?? tmpdir(), 'fta-host-test.json')
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail })

// ---- validateName ----
// 平台无关的非法名：空/空白/分隔符/点/点尾空白
const badNames = ['', '   ', 'a/b', 'a\\b', '.', '..', 'trailing ', ' lead']
for (const name of badNames) check('name rejected: ' + JSON.stringify(name), validateName(name).ok === false)
// Windows 专属规则：非法字符、保留设备名。非 Windows 平台这些名字是合法的（不要假装拒绝）。
const winOnlyBad = ['a:b', 'con', 'CON.txt', 'nul', 'COM¹', 'LPT²', 'CONIN$', 'CONOUT$']
for (const name of winOnlyBad) {
  const rejected = validateName(name).ok === false
  check('name windows rule: ' + JSON.stringify(name), process.platform === 'win32' ? rejected === true : rejected === false, validateName(name))
}

// ---- isInside / samePath ----
// 用当前平台风格构造路径，避免把 C:\\ 路径喂给 POSIX 的 path 模块。
const rootPath = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const childPath = process.platform === 'win32' ? 'C:\\ws\\a\\b' : '/ws/a/b'
const siblingPath = process.platform === 'win32' ? 'C:\\ws2' : '/ws2'
const parentPath = process.platform === 'win32' ? 'C:\\' : '/'
check('inside child', isInside(rootPath, childPath) === true)
check('inside self', isInside(rootPath, rootPath) === true)
check('inside sibling prefix', isInside(rootPath, siblingPath) === false)
check('inside parent', isInside(rootPath, parentPath) === false)
check('case-insensitive same (win only)', process.platform === 'win32' ? samePath('C:\\WS', 'C:\\ws') === true : samePath('/ws', '/ws') === true)

// ---- create / rename ----
const root = await fs.mkdtemp(join(tmpdir(), 'fta-host-'))
try {
  const file = await createEntry('file', root, 'hello.md')
  check('create file', (await fs.readFile(file.path, 'utf8')) === '')
  const dir = await createEntry('dir', root, 'assets')
  check('create dir', (await fs.stat(dir.path)).isDirectory())

  let existed = null
  try {
    await createEntry('file', root, 'hello.md')
  } catch (error) {
    existed = error
  }
  check('create refuses overwrite', existed instanceof OpError && existed.code === 'exists', existed && existed.code)

  const renamed = await renameEntry(file.path, 'renamed.md')
  check('rename moves file', renamed.path === join(root, 'renamed.md') && (await fs.readFile(renamed.path, 'utf8')) === '')

  let renameClash = null
  try {
    await renameEntry(renamed.path, 'assets')
  } catch (error) {
    renameClash = error
  }
  check('rename refuses existing target', renameClash instanceof OpError && renameClash.code === 'exists', renameClash && renameClash.code)

  let missing = null
  try {
    await renameEntry(join(root, 'nope.md'), 'x.md')
  } catch (error) {
    missing = error
  }
  check('rename missing file surfaces ENOENT', missing !== null && missing.code === 'ENOENT', missing && missing.code)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

// ---- 输出 ----
const out = {
  pass: results.every((entry) => entry.pass),
  checks: results.length,
  failed: results.filter((entry) => !entry.pass).map((entry) => entry.name),
}
await fs.writeFile(OUT, JSON.stringify({ ...out, results }, null, 2), 'utf8')
console.log(out.pass ? 'PASS' : 'FAIL ' + out.failed.join(', '))
if (!out.pass) process.exitCode = 1
