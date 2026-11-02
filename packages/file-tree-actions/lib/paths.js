/**
 * 路径与名字的纯函数校验（Host 半边用，也可脱离 Cordis 单测）。
 *
 * 安全边界：客户端只传 workspace 根、父目录、目标路径和一个「名字」，
 * 一切判断都在这里做完——名字必须是单个路径片段，目标必须落在根内。
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 规范化成绝对路径（不做 realpath，符号链接由调用方用 realpath 处理）。 */
export function canonical(path) {
  return resolve(path)
}

/** 比较用的键：Windows 大小写不敏感。 */
export function compareKey(path) {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** 同一个路径（含大小写折叠）。 */
export function samePath(left, right) {
  return compareKey(left) === compareKey(right)
}

/**
 * `target` 是否就是 `root` 或在它下面。两者都必须已经是绝对路径。
 * 用 `path.relative` 判断，避免前缀字符串误判（如 C:\a 与 C:\ab）。
 */
export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * Windows 保留设备名（大小写不敏感，含带扩展名的形式）。
 * 除常见的 CON/PRN/AUX/NUL/COM1-9/LPT1-9 外，Windows 也把上标数字（¹²³）当数字用，
 * CONIN$/CONOUT$ 同样是设备别名。
 */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i

/**
 * 校验一个新建/重命名用的名字。
 * @param {string} name
 * @returns {{ok: true, name: string} | {ok: false, error: string}}
 */
export function validateName(name) {
  if (typeof name !== 'string') return { ok: false, error: '名字必须是字符串' }
  const trimmed = name.trim()
  if (trimmed === '') return { ok: false, error: '名字不能为空' }
  if (trimmed !== name) return { ok: false, error: '名字首尾不能有空白' }
  if (name === '.' || name === '..') return { ok: false, error: '名字不能是 . 或 ..' }
  if (/[/\\]/.test(name)) return { ok: false, error: '名字不能包含路径分隔符' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return { ok: false, error: '名字包含控制字符' }
  if (Buffer.byteLength(name, 'utf8') > 255) return { ok: false, error: '名字过长（超过 255 字节）' }
  if (process.platform === 'win32') {
    if (/[<>:"|?*]/.test(name)) return { ok: false, error: '名字不能包含 < > : " | ? *' }
    if (/[. ]$/.test(name)) return { ok: false, error: '名字不能以空格或点结尾' }
    if (RESERVED.test(name)) return { ok: false, error: '这是 Windows 保留名' }
  }
  return { ok: true, name }
}
