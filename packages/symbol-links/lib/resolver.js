/**
 * dsh-symbol-links — 纯解析逻辑（无 I/O，便于单测）。
 *
 * 依据 ISSUE §4.1 与 Codex 第 1 轮复核修订：
 *  - 注释/字符串（含 Python 三引号）词法屏蔽；
 *  - 定义带 endLine（花括号/缩进包含判定），wrapper 必须是"包住调用点"的定义；
 *  - 每个名字的定义站点全部保留，调用站点上限 50 不影响 definition；
 *  - C++ 限定名（Foo::bar）同时索引完整名与末段名。
 */

export const KIND_DEFINITION = 'definition'
export const KIND_WRAPPER = 'wrapper'
export const KIND_OCCURRENCE = 'occurrence'

export const LANG_BY_EXT = Object.freeze({
  '.c': 'cpp', '.h': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.py': 'python',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.jsx': 'js',
})

export const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'build', 'dist', 'out', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.cache', '.idea', '.vs', 'cmake-build-debug', 'cmake-build-release',
])

const MAX_CALLS_PER_NAME = 50

/**
 * 注释与字符串 → 空格，保留偏移。state: {block, triple}
 */
export function maskNoise(line, state, lang) {
  const out = line.split('')
  const python = lang === 'python'
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    const next = line[i + 1]
    if (state.triple) {
      if (line.startsWith(state.triple, i)) {
        out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '
        state.triple = ''
        i += 2
        continue
      }
      out[i] = ' '
      continue
    }
    if (state.block) {
      out[i] = ' '
      if (c === '*' && next === '/') { out[i + 1] = ' '; state.block = false; i++ }
      continue
    }
    if (!python && c === '/' && next === '/') {
      for (let j = i; j < line.length; j++) out[j] = ' '
      break
    }
    if (!python && c === '/' && next === '*') {
      out[i] = ' '; out[i + 1] = ' '; state.block = true; i++
      continue
    }
    if (python && c === '#') {
      for (let j = i; j < line.length; j++) out[j] = ' '
      break
    }
    if (python && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
      state.triple = line.slice(i, i + 3)
      out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '
      i += 2
      continue
    }
    if (c === '"' || c === "'" || (c === '\u0060' && !python)) {
      const quote = c
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') { out[j] = ' '; j += 2; continue }
        if (line[j] === quote) break
        out[j] = ' '
        j++
      }
      if (j < line.length) { out[j] = ' '; i = j }
      else i = line.length
    }
  }
  return out.join('')
}

function definitionName(masked, lang) {
  if (lang === 'python') {
    let m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(masked)
    if (m) return m[1]
    m = /^\s*class\s+([A-Za-z_]\w*)\s*[(:]/.exec(masked)
    return m ? m[1] : null
  }
  if (lang === 'js') {
    let m = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/.exec(masked)
    if (m) return m[1]
    m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/.exec(masked)
    if (m) return m[1]
    m = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(masked)
    return m ? m[1] : null
  }
  const m = /^\s*(?:template\s*<[^>]*>\s*)?(?:[A-Za-z_][\w:<>,\s*&]*?[\s*&>])([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/.exec(masked)
  if (!m) return null
  const head = masked.slice(0, m.index + m[0].indexOf(m[1]))
  if (/\b(?:return|else|new|delete|throw|if|for|while|switch|catch)\b/.test(head)) return null
  if (/;\s*$/.test(masked)) return null
  if (/\.\s*$|->\s*$|=\s*$/.test(head)) return null
  return m[1]
}

/** 预计算每行的花括号累计深度（C/JS）与缩进（Python），使 endLine 计算为 O(n) 总代价。 */
function precomputeDepths(maskedLines, lines, lang) {
  if (lang === 'python') {
    return { kinds: 'indent', indent: lines.map(line => line.length - line.trimStart().length) }
  }
  const depthAtStart = new Array(maskedLines.length)
  const afterDepth = new Array(maskedLines.length)
  let depth = 0
  for (let i = 0; i < maskedLines.length; i++) {
    depthAtStart[i] = depth
    for (const ch of maskedLines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    afterDepth[i] = depth
  }
  return { kinds: 'brace', depthAtStart, afterDepth }
}

/** 计算定义体结束行。 */
function findEndLine(pre, lines, maskedLines, startIndex, lang) {
  if (lang === 'python') {
    const defIndent = pre.indent[startIndex]
    // 多行签名：括号未配平时不结束
    let balance = 0
    for (const ch of maskedLines[startIndex]) {
      if (ch === '(' || ch === '[') balance++
      else if (ch === ')' || ch === ']') balance--
    }
    let i = startIndex + 1
    for (; i < lines.length; i++) {
      const masked = maskedLines[i]
      if (masked.trim() === '') continue // 空行/纯注释（已被屏蔽）不结束
      if (balance > 0) {
        for (const ch of masked) {
          if (ch === '(' || ch === '[') balance++
          else if (ch === ')' || ch === ']') balance--
        }
        continue
      }
      if (pre.indent[i] <= defIndent) return i
    }
    return lines.length
  }
  const base = pre.depthAtStart[startIndex]
  const after = pre.afterDepth[startIndex]
  const hasOpen = maskedLines[startIndex].includes('{')
  // 同一行就闭合的函数体（如 `function f() {}`）：endLine 就是定义行
  if (after <= base) {
    if (!hasOpen) {
      // Allman：'{' 在后面的行
      let opened = -1
      for (let i = startIndex + 1; i < pre.depthAtStart.length; i++) {
        if (pre.afterDepth[i] > base) { opened = i; break }
      }
      if (opened < 0) return startIndex + 1
      for (let i = opened + 1; i < pre.depthAtStart.length; i++) {
        if (pre.afterDepth[i] <= base) return i + 1
      }
      return lines.length
    }
    return startIndex + 1
  }
  for (let i = startIndex + 1; i < pre.afterDepth.length; i++) {
    if (pre.afterDepth[i] <= base) return i + 1
  }
  return lines.length
}

/**
 * 扫描一个文件。返回站点：定义带 endLine；调用用于 wrapper/L3。
 */
export function scanSource(text, lang, relPath) {
  const lines = text.split('\n')
  const maskedLines = []
  const state = { block: false, triple: '' }
  for (const line of lines) maskedLines.push(maskNoise(line, state, lang))

  const pre = precomputeDepths(maskedLines, lines, lang)
  const sites = []
  for (let i = 0; i < lines.length; i++) {
    // 压缩/生成文件（超长行）跳过：正则开销大且符号无意义
    if (lines[i].length > 4000) continue
    const masked = maskedLines[i]
    const def = definitionName(masked, lang)
    if (lang === 'cpp') {
      const macro = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(lines[i])
      if (macro) sites.push({ name: macro[1], path: relPath, line: i + 1, endLine: i + 1, kind: KIND_DEFINITION })
    }
    if (def) {
      const endLine = findEndLine(pre, lines, maskedLines, i, lang)
      sites.push({ name: def, path: relPath, line: i + 1, endLine, kind: KIND_DEFINITION })
      const shortName = def.includes('::') ? def.split('::').pop() : def
      if (shortName !== def) sites.push({ name: shortName, path: relPath, line: i + 1, endLine, kind: KIND_DEFINITION })
    }
    const re = /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/g
    let m
    while ((m = re.exec(masked)) !== null) {
      const qualified = m[1]
      if (qualified === def) continue
      sites.push({ name: qualified, path: relPath, line: i + 1, kind: 'call' })
      const shortName = qualified.includes('::') ? qualified.split('::').pop() : qualified
      if (shortName !== qualified) sites.push({ name: shortName, path: relPath, line: i + 1, kind: 'call' })
    }
  }
  return sites
}

export function rankSites(sites, hintFiles) {
  const hints = new Set((hintFiles || []).map(p => p.replace(/\\/g, '/')))
  const hintDirs = new Set([...hints].map(p => p.slice(0, Math.max(0, p.lastIndexOf('/')))))
  const score = (s) => {
    if (hints.has(s.path)) return 0
    const dir = s.path.slice(0, Math.max(0, s.path.lastIndexOf('/')))
    if (hintDirs.has(dir)) return 1
    return 2
  }
  return [...sites].sort((a, b) => score(a) - score(b)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || a.line - b.line)
}

/** 包住该站点的定义（要求 line ∈ [def.line, def.endLine]）。 */
export function enclosingDefinition(sites, target) {
  let best = null
  for (const s of sites) {
    if (s.kind !== KIND_DEFINITION) continue
    if (s.path !== target.path) continue
    if (s.line > target.line) continue
    if (s.endLine !== undefined && target.line > s.endLine) continue
    if (best === null || s.line > best.line) best = s
  }
  return best
}

export function resolveName(name, index, hintFiles) {
  const entry = index.byName.get(name)
  if (entry === undefined) return null
  const defs = rankSites(entry.defs, hintFiles)
  if (defs.length > 0) {
    const first = defs[0]
    const second = defs[1]
    if (second === undefined || second.path !== first.path) {
      return { name, path: first.path, line: first.line, kind: KIND_DEFINITION, via: KIND_DEFINITION }
    }
  }
  const calls = rankSites(entry.calls, hintFiles)
  for (const call of calls) {
    const def = enclosingDefinition(index.sites, call)
    if (def !== null && def.name !== name) {
      return { name, path: def.path, line: def.line, kind: KIND_DEFINITION, via: KIND_WRAPPER }
    }
  }
  if (calls.length > 0) {
    const first = calls[0]
    return { name, path: first.path, line: first.line, kind: KIND_OCCURRENCE, via: KIND_OCCURRENCE }
  }
  if (defs.length > 0) {
    const first = defs[0]
    return { name, path: first.path, line: first.line, kind: KIND_DEFINITION, via: KIND_DEFINITION }
  }
  return null
}

export function buildIndex(sites) {
  const byName = new Map()
  for (const s of sites) {
    let entry = byName.get(s.name)
    if (entry === undefined) { entry = { defs: [], calls: [] }; byName.set(s.name, entry) }
    if (s.kind === KIND_DEFINITION) entry.defs.push(s)
    else if (entry.calls.length < MAX_CALLS_PER_NAME) entry.calls.push(s)
  }
  return { sites, byName }
}
