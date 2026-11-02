/**
 * dsh-symbol-links — 浏览器半。
 *
 * 做法（与 dsh-file-mentions 同路线）：
 *  - 在 [data-conversation-scroll] 内增量装饰行内 <code>，跳过 <a>/<pre>/<button> 内的；
 *  - document 级 click 委托：点击才向 host 解析（忙态防重复）；
 *  - 会话/打开函数来自官方 conversation.chat.turnTail 槽的 props（sessionId + openFile）。
 *  - Codex 第 1 轮修订：缓存按 (会话, 名字) 键 + TTL；点击时捕获会话，切换后丢弃；观察者累积同帧根节点并监听文本变化。
 */
window.__ModuleLoader__.load({
  id: 'dsh-symbol-links',
  factory(require) {
    'use strict'

    const inject = ['slots']
    const RESOLVE_ENDPOINT = '/api/symbol-links/resolve'
    const REQUEST_TIMEOUT_MS = 4000
    const HIT_TTL_MS = 60_000
    const MISS_TTL_MS = 20_000
    const MARKER = 'data-sym-link'
    const STOP_WORDS = new Set([
      'true', 'false', 'null', 'undefined', 'none', 'self', 'this', 'return', 'import', 'from',
      'class', 'def', 'const', 'let', 'var', 'function', 'async', 'await', 'yield', 'new', 'delete',
      'void', 'int', 'float', 'double', 'char', 'bool', 'auto', 'struct', 'enum', 'union', 'template',
      'namespace', 'public', 'private', 'protected', 'static', 'inline', 'std', 'string', 'vector',
      'printf', 'cout', 'endl', 'main', 'argc', 'argv', 'if', 'else', 'for', 'while', 'switch', 'case',
      'break', 'continue', 'try', 'catch', 'throw', 'sizeof', 'nullptr', 'constexpr', 'override', 'final',
    ])

    /** 最近一次渲染的会话上下文：正文点击委托用。 */
    let sessionCtx = { sessionId: '', openFile: null }
    /** `${sessionId}|\u0000${name}` → {hit, at}；会话切换时整体清空。 */
    const cache = new Map()
    const pending = new Map()
    let ctxRef = null
    let lastIncomplete = false
    let observer = null
    let scheduled = false
    const pendingRoots = new Set()

    function getCtx() { return ctxRef }

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin="dsh-symbol-links"]') !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-symbol-links'
      style.textContent = [
        'code[data-sym-link]{cursor:pointer;text-decoration:underline;text-decoration-style:dotted;',
        'text-underline-offset:2px;text-decoration-color:var(--dsw-alias-label-tertiary);}',
        'code[data-sym-link]:hover{text-decoration-color:var(--dsw-alias-label-primary);}',
        'code[data-sym-link][data-sym-busy]{opacity:.55;}',
        'code[data-sym-link][data-sym-miss]{text-decoration:none;opacity:.7;}',
      ].join('')
      document.head.appendChild(style)
    }

    function currentSession() { return sessionCtx.sessionId }

    function setSession(sessionId, openFile) {
      if (sessionId !== '' && sessionId !== sessionCtx.sessionId) {
        cache.clear()
        pending.clear()
      }
      sessionCtx = { sessionId: sessionId !== '' ? sessionId : sessionCtx.sessionId, openFile: openFile || sessionCtx.openFile }
    }

    function isCandidate(text) {
      if (text.length < 3 || text.length > 80) return false
      if (!/^[A-Za-z_][A-Za-z0-9_:<>~]*$/.test(text)) return false
      if (STOP_WORDS.has(text)) return false
      if (!/[A-Za-z]/.test(text)) return false
      return true
    }

    function inConversation(node) {
      return node instanceof Element && node.closest('[data-conversation-scroll]') !== null
    }

    function decorateCode(code) {
      if (code.closest('a, pre, button') !== null) return
      if (code.querySelector('button') !== null) return
      const text = (code.textContent || '').trim()
      if (!isCandidate(text)) {
        code.removeAttribute(MARKER)
        return
      }
      if (code.getAttribute(MARKER) !== text) {
        code.setAttribute(MARKER, text)
        code.removeAttribute('data-sym-miss')
        code.setAttribute('title', '点击打开定义（dsh-symbol-links）')
      }
    }

    function scan(root) {
      if (root === null || root === undefined) return
      ensureStyle()
      if (root instanceof Element && root.matches('code')) decorateCode(root)
      const codes = root.querySelectorAll ? root.querySelectorAll('code') : []
      for (const code of codes) {
        if (inConversation(code)) decorateCode(code)
      }
    }

    function flushScans() {
      scheduled = false
      const roots = [...pendingRoots]
      pendingRoots.clear()
      for (const root of roots) scan(root)
    }

    function scheduleScan(root) {
      pendingRoots.add(root)
      if (scheduled) return
      scheduled = true
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushScans)
      else setTimeout(flushScans, 16)
    }

    /** 点击失败时的轻量反馈（不弹窗、不阻塞）。 */
    function flash(event, text) {
      try {
        const hint = document.createElement('div')
        hint.textContent = text
        hint.dataset.plugin = 'dsh-symbol-links-hint'
        hint.style.cssText = [
          'position:fixed', 'z-index:2147483000', 'padding:4px 8px', 'border-radius:6px',
          'font-size:12px', 'pointer-events:none', 'white-space:nowrap',
          'background:var(--dsw-alias-bg-layer-2)', 'color:var(--dsw-alias-label-secondary)',
          'border:.5px solid var(--dsw-alias-border-l2)',
        ].join(';')
        const x = event && typeof event.clientX === 'number' ? event.clientX : window.innerWidth / 2
        const y = event && typeof event.clientY === 'number' ? event.clientY : window.innerHeight / 2
        hint.style.left = Math.min(x + 8, window.innerWidth - 180) + 'px'
        hint.style.top = Math.min(y + 12, window.innerHeight - 40) + 'px'
        document.body.appendChild(hint)
        setTimeout(() => hint.remove(), 2200)
      } catch (error) { /* 提示失败不影响主流程 */ }
    }

    function requestOnce(sessionId, name, want) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = setTimeout(() => { if (controller) controller.abort() }, REQUEST_TIMEOUT_MS)
      return fetch(RESOLVE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
        body: JSON.stringify({ sessionId, names: [name], want: want || 'definition' }),
      })
        .then(async (res) => {
          if (!res.ok) return { hit: null, incomplete: false }
          const data = await res.json()
          const list = data && Array.isArray(data.results) ? data.results : []
          return { hit: list.find(r => r.name === name) || null, items: list, incomplete: data && data.incomplete === true }
        })
        .catch(() => ({ hit: null, incomplete: true }))
        .finally(() => clearTimeout(timer))
    }

    function cached(sessionId, name) {
      const entry = cache.get(sessionId + '|\u0000|' + name)
      if (entry === undefined) return undefined
      const ttl = entry.hit === null ? MISS_TTL_MS : HIT_TTL_MS
      if (Date.now() - entry.at > ttl) { cache.delete(sessionId + '|\u0000|' + name); return undefined }
      return entry.hit
    }

    function resolveViaHost(name, primarySession) {
      const known = cached(primarySession, name)
      if (known !== undefined) return Promise.resolve(known)
      const key = primarySession + '|\u0000|' + name
      if (pending.has(key)) return pending.get(key)
      if (primarySession === '') return Promise.resolve(null)
      const task = (async () => {
        const result = await requestOnce(primarySession, name)
        lastIncomplete = result.incomplete === true
        if (result.hit) {
          cache.set(key, { hit: result.hit, at: Date.now() })
          return result.hit
        }
        if (!result.incomplete) cache.set(key, { hit: null, at: Date.now() })
        return null
      })().finally(() => pending.delete(key))
      pending.set(key, task)
      return task
    }

    /** 打开文件并定位行：优先走 sidebarRight.openResource（它内部会展开右侧栏），再回退 openFile。 */
    function openResolved(openFile, path, line) {
      const encoded = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
      const attempt = () => {
        const ctx = getCtx()
        const sidebar = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
        if (sidebar !== undefined && typeof sidebar.openResource === 'function' && sessionCtx.sessionId !== '') {
          // 官方实现里 openContent 会 planSetExpanded(true)：右侧栏收起时也会展开
          sidebar.openResource('dsh-resource://file/session/' + encodeURIComponent(sessionCtx.sessionId) + '/' + encoded, { params: { line } })
          return true
        }
        if (typeof openFile === 'function') {
          openFile(path, { line })
          return true
        }
        return false
      }
      try {
        if (attempt()) return true
      } catch (error) {
        // 会话切换后侧栏可能尚未 adopt：稍后重试一次
      }
      setTimeout(() => {
        try { attempt() } catch (error) { /* 忽略 */ }
      }, 180)
      return true
    }

    /** 关闭右键菜单/结果列表。 */
    function closeFloating() {
      const old = document.querySelector('[data-plugin="dsh-symbol-links-menu"]')
      if (old !== null) old.remove()
    }

    function floatingPanel(x, y) {
      closeFloating()
      const panel = document.createElement('div')
      panel.dataset.plugin = 'dsh-symbol-links-menu'
      panel.style.cssText = [
        'position:fixed', 'z-index:2147483000', 'min-width:160px', 'max-width:420px', 'max-height:320px',
        'overflow:auto', 'padding:4px', 'border-radius:8px', 'font-size:12px', 'line-height:1.5',
        'background:var(--dsw-alias-bg-layer-2)', 'color:var(--dsw-alias-label-primary)',
        'border:.5px solid var(--dsw-alias-border-l2)', 'box-shadow:0 6px 24px rgba(0,0,0,.18)',
      ].join(';')
      panel.style.left = Math.min(x, window.innerWidth - 440) + 'px'
      panel.style.top = Math.min(y, window.innerHeight - 340) + 'px'
      document.body.appendChild(panel)
      setTimeout(() => {
        const off = (evt) => {
          if (!panel.contains(evt.target)) {
            panel.remove()
            document.removeEventListener('mousedown', off, true)
            document.removeEventListener('keydown', onKey, true)
          }
        }
        const onKey = (evt) => {
          if (evt.key === 'Escape') {
            panel.remove()
            document.removeEventListener('mousedown', off, true)
            document.removeEventListener('keydown', onKey, true)
          }
        }
        document.addEventListener('mousedown', off, true)
        document.addEventListener('keydown', onKey, true)
      }, 0)
      return panel
    }

    function menuItem(panel, label, action) {
      const row = document.createElement('div')
      row.textContent = label
      row.style.cssText = 'padding:5px 8px;border-radius:6px;cursor:pointer;white-space:nowrap'
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--dsw-alias-interactive-bg-hover)' })
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent' })
      row.addEventListener('click', (evt) => {
        evt.preventDefault()
        evt.stopPropagation()
        action()
      })
      panel.appendChild(row)
      return row
    }

    async function showList(event, name, want) {
      if (sessionCtx.sessionId === '') { flash(event, '会话未就绪，暂不能查询：' + name); return }
      const panel = floatingPanel(event.clientX, event.clientY)
      const title = document.createElement('div')
      title.textContent = (want === 'references' ? '引用候选：' : '同名定义：') + name + ' …'
      title.style.cssText = 'padding:5px 8px;color:var(--dsw-alias-label-tertiary)'
      panel.appendChild(title)
      const result = await requestOnce(sessionCtx.sessionId, name, want)
      const items = result.items || []
      title.textContent = (want === 'references' ? '引用候选：' : '同名定义：') + name + '（' + items.length + '）'
      const note = document.createElement('div')
      note.textContent = want === 'references' ? '文本匹配，不代表语义调用关系' : '同名定义候选，不保证是接口实现'
      note.style.cssText = 'padding:0 8px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px'
      panel.appendChild(note)
      if (items.length === 0) {
        const empty = document.createElement('div')
        empty.textContent = result.incomplete ? '索引构建中，请稍后再试' : '没有找到结果'
        empty.style.cssText = 'padding:5px 8px;color:var(--dsw-alias-label-secondary)'
        panel.appendChild(empty)
        return
      }
      for (const item of items) {
        menuItem(panel, item.path + ':' + item.line, () => {
          const captured = sessionCtx.openFile
          if (!openResolved(captured, item.path, item.line)) flash(event, '无法打开：' + item.path)
          panel.remove()
        })
      }
    }

    function showSymbolMenu(event, code, name) {
      const panel = floatingPanel(event.clientX, event.clientY)
      menuItem(panel, '打开定义', () => {
        resolveViaHost(name, sessionCtx.sessionId).then((hit) => {
          if (!hit) { flash(event, '未找到定义：' + name); return }
          openResolved(sessionCtx.openFile, hit.path, hit.line)
        })
        panel.remove()
      })
      menuItem(panel, '引用候选（文本匹配）', () => { panel.remove(); showList(event, name, 'references') })
      menuItem(panel, '同名定义（候选）', () => { panel.remove(); showList(event, name, 'implementation') })
      menuItem(panel, '复制名字', () => {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(name).then(() => flash(event, '已复制：' + name)).catch(() => flash(event, '复制失败'))
        }
        panel.remove()
      })
    }

    function onContextMenu(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      const code = target.closest('code[' + MARKER + ']')
      if (code === null) return
      const name = code.getAttribute(MARKER)
      if (!name) return
      event.preventDefault()
      event.stopPropagation()
      showSymbolMenu(event, code, name)
    }

    function onClick(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      const code = target.closest('code[' + MARKER + ']')
      if (code === null) return
      event.preventDefault()
      event.stopPropagation()
      const name = code.getAttribute(MARKER)
      if (!name) return
      if (code.hasAttribute('data-sym-busy')) return
      const capturedSession = sessionCtx.sessionId
      const capturedOpenFile = sessionCtx.openFile
      if (capturedSession === '') {
        flash(event, '会话未就绪，暂不能定位：' + name)
        return
      }
      code.setAttribute('data-sym-busy', '1')
      resolveViaHost(name, capturedSession)
        .then((hit) => {
          if (!hit) {
            if (lastIncomplete) {
              // 索引还在建：保持可点状态，只提示稍后再试
              flash(event, '正在建立索引，请稍后再点：' + name)
              return
            }
            // 确认没找到：去掉下划线并淡化，鼠标悬停显示"点击重试"，再点仍会重新解析
            code.setAttribute('data-sym-miss', '1')
            code.setAttribute('title', '未找到定义：' + name + '（点击重试）')
            flash(event, '未找到定义：' + name)
            return
          }
          if (currentSession() !== capturedSession) return // 会话已切走，丢弃结果
          code.removeAttribute('data-sym-miss')
          if (!openResolved(capturedOpenFile, hit.path, hit.line)) flash(event, '无法打开：' + hit.path)
        })
        .finally(() => code.removeAttribute('data-sym-busy'))
    }

    function startObserver() {
      if (typeof document === 'undefined') return
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserverOnce, { once: true })
        return
      }
      startObserverOnce()
    }

    function startObserverOnce() {
      if (observer !== null) return
      scan(document.body)
      observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'characterData') {
            const parent = record.target && record.target.parentElement
            if (parent !== null && parent !== undefined) scheduleScan(parent)
            continue
          }
          for (const node of record.addedNodes) {
            if (node instanceof Element && inConversation(node)) scheduleScan(node)
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    }

    function apply(ctx) {
      ctxRef = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) return
      ensureStyle()

      if (typeof document !== 'undefined') {
        document.addEventListener('click', onClick, true)
        document.addEventListener('contextmenu', onContextMenu, true)
        startObserver()
      }

      // 逐会话 inject：官方在渲染用户消息节点时把 sessionId 交给 inject 回调（参考 ui-reference 的用法）。
      slots.inject('conversation.user.text.node', function* () {
        yield slots.register(
          {
            name: 'conversation.user.text.node',
            key: 'dsh-symbol-links-session',
            priority: 1,
            inject: (sessionId) => {
              if (typeof sessionId === 'string' && sessionId !== '') setSession(sessionId)
              return {}
            },
          },
          () => null,
        )
      })

      slots.inject('conversation.chat.turnTail', () => slots.register(
        {
          name: 'conversation.chat.turnTail',
          id: 'dsh-symbol-links-turn-tail',
          select: () => ({}),
        },
        (props) => {
          const sessionId = props.sessionId || (props.turn && props.turn.sessionId) || ''
          setSession(sessionId, props.openFile)
          return null
        },
      ))
    }

    return { name: 'dsh-symbol-links', inject, apply }
  },
})
