// Host 半边单测：路径校验 + 新建/重命名（不碰回收站，避免污染真实回收站）。
// 运行：ELECTRON_RUN_AS_NODE=1 "F:\Deepseek\DeepSeek Harness.exe" --expose-internals test\host-ops.mjs
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInside, samePath, validateName } from '../lib/paths.js'
import { createEntry, OpError, renameEntry } from '../lib/ops.js'

const results = []
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail })

// ---- validateName ----
const okNames = ['a.md', 'notes', '图 1.md', '.env', 'a b']
for (const name of okNames) check('name ok: ' + name, validateName(name).ok === true, validateName(name))
const badNames = ['', '   ', 'a/b', 'a\\b', '.', '..', 'a:b', 'con', 'CON.txt', 'trailing ', ' lead', 'nul', 'COM¹', 'LPT²', 'CONIN$', 'CONOUT$']
for (const name of badNames) check('name rejected: ' + JSON.stringify(name), validateName(name).ok === false)

// ---- isInside / samePath ----
check('inside child', isInside('C:\\ws', 'C:\\ws\\a\\b') === true)
check('inside self', isInside('C:\\ws', 'C:\\ws') === true)
check('inside sibling prefix', isInside('C:\\ws', 'C:\\ws2') === false)
check('inside parent', isInside('C:\\ws', 'C:\\') === false)
check('case-insensitive same', samePath('C:\\WS', 'C:\\ws') === true)

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
await fs.writeFile('C:/Users/Administrator/Documents/deepseek-harness/default-workspace/logs/fta-host-test.json', JSON.stringify({ ...out, results }, null, 2), 'utf8')
console.log(out.pass ? 'PASS' : 'FAIL ' + out.failed.join(', '))
if (!out.pass) process.exitCode = 1
