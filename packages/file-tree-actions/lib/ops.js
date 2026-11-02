/**
 * Host 侧文件操作：新建、重命名、移入 Windows 回收站。
 *
 * 这里只做「已经通过根校验之后」的动作；根校验与 realpath 收敛在 index.js 里完成，
 * 本模块保持可脱离 Cordis 单测（只用 node:fs / node:path / node:child_process）。
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

/** 带 code 的失败，供路由映射成 HTTP 状态。 */
export class OpError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'OpError'
    this.code = code
  }
}

/** execFile 的 promise 包装（保持短小，不引第三方依赖）。 */
function run(file, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error !== null) {
        error.stderr = stderr
        error.stdout = stdout
        rejectPromise(error)
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

/** 目标已存在（新建/重命名都拒绝覆盖）。 */
async function assertAbsent(path) {
  try {
    await fs.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new OpError('exists', '目标已存在')
}

/**
 * 新建文件或目录。
 * @param {'file'|'dir'} kind
 * @param {string} parent - 已 realpath 的父目录（保证在根内）
 * @param {string} name - 已校验的单个名字
 * @returns {Promise<{path: string}>}
 */
export async function createEntry(kind, parent, name) {
  const target = join(parent, name)
  await assertAbsent(target)
  if (kind === 'dir') {
    await fs.mkdir(target)
  } else {
    // wx：不存在才写，避免覆盖已有文件
    await fs.writeFile(target, '', { flag: 'wx' })
  }
  return { path: target }
}

/**
 * 重命名（同一目录内改名）。
 * @param {string} sourceReal - 已 realpath 的源路径（保证在根内）
 * @param {string} name - 已校验的新名字
 * @returns {Promise<{path: string}>}
 */
export async function renameEntry(sourceReal, name) {
  const target = join(dirname(sourceReal), name)
  if (target === sourceReal) return { path: target }
  await assertAbsent(target)
  await fs.rename(sourceReal, target)
  return { path: target }
}

/**
 * 移入 Windows 回收站。非 Windows 或调用失败时抛错——绝不静默降级成永久删除。
 * @param {string} targetReal - 已 realpath 的目标（保证在根内）
 * @returns {Promise<{path: string}>}
 */
export async function recycleEntry(targetReal) {
  if (process.platform !== 'win32') throw new OpError('unsupported', '回收站删除仅支持 Windows')
  const info = await fs.lstat(targetReal)
  const quoted = targetReal.replace(/'/g, "''")
  const call = info.isDirectory()
    ? `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${quoted}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
    : `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${quoted}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName Microsoft.VisualBasic\n${call}\n`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    // -EncodedCommand 避免中文路径/引号在命令行上被二次解释
    await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 20000, windowsHide: true })
  } catch (error) {
    const detail = typeof error.stderr === 'string' && error.stderr.trim() !== '' ? error.stderr.trim() : error.message
    throw new OpError('recycle-failed', `移入回收站失败：${detail.slice(0, 400)}`)
  }
  return { path: targetReal }
}
