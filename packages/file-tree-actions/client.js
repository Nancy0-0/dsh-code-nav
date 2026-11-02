/**
 * dsh-file-tree-actions —— Files 侧栏增强（浏览器半边）
 *
 * 提供四类手势：
 *   1. 文件树行右键：复制绝对路径 / 相对路径 / 名称 / @ 引用；
 *   2. 目录行右键：新建文件、新建文件夹（菜单内联输入名字）；
 *   3. 任意行右键：重命名（内联输入，预填原名）；
 *   4. 任意行右键：删除（二次确认后移到 Windows 回收站）；
 *   5. 把文件/文件夹行拖进对话栏：以 @ 引用形式落进输入框。
 *
 * 实现边界（重要）：
 *   - 官方 UI 插件的常规路径是往 slot 里注册 React 组件；文件树的行级菜单
 *     没有对应 slot（只有 sidebar.right.tab.files.actions 这个「根路径」动作位），
 *     所以这里走 DOM 增强：委托监听 + 一个挂在 body 上的 shadow DOM 菜单。
 *     不 require 任何 @deepseek-ai/dsh-client-* 包，卸载由 ctx.effect 统一清理。
 *   - 写操作（新建/重命名/删除）走宿主半边的精确 Fetch 路由
 *     `POST /api/file-tree-actions`（见 index.js）：客户端拿不到宿主 fs 服务，
 *     而 workspaceFiles 桥是只读的。连接层已套 Host/Origin 栅栏与登录态。
 *   - 拖拽只写 dataTransfer 的 text/plain（@ 引用文本）。对话输入框是 Lexical，
 *     外部纯文本落进 contenteditable 时会走 beforeinput insertFromDrop → 插入文本。
 *   - 依赖宿主实现细节选择器（见 SELECTORS）。宿主改 DOM 时只需改这一处。
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-tree-actions',
  factory(require) {
    'use strict'

    const PLUGIN_SOURCE = 'dsh-file-tree-actions'
    const VERSION = '0.2.1'
    const ROUTE = '/api/file-tree-actions'

    /* ---------------------------------------------------------------- 选择器 */
    /** 宿主文件树的结构约定，集中在这里，宿主升级改 DOM 时只改这几行。 */
    const SELECTORS = {
      /** 文件树根容器：带 workspace 绝对根路径。 */
      tree: '[data-files-state="tree"][data-files-root]',
      /** 一行文件/文件夹：属性值是该条目的绝对路径。 */
      row: 'li[data-files-path]',
      /** 文件树可滚动的 body（header 不在里面）。 */
      body: '[data-files-body]',
      /** header 里的刷新按钮，写操作后用它让树重新列目录。 */
      reload: '[data-files-reload]',
    }

    const HOST_ID = 'dsh-file-tree-actions-root'
    const ROW_FLAG = 'data-dsh-fta-drag'

    /* ------------------------------------------------------------------ 文案 */
    const DICT = {
      zh: {
        copyAbsolute: '复制绝对路径',
        copyRelative: '复制相对路径',
        copyName: '复制名称',
        copyMention: '复制为 @ 引用',
        newFile: '新建文件',
        newFolder: '新建文件夹',
        rename: '重命名',
        remove: '移到回收站…',
        cancel: '取消',
        create: '创建',
        renameConfirm: '重命名',
        removeConfirm: '移到回收站',
        working: '处理中…',
        copied: '已复制',
        copyFailed: '复制失败',
        createdFile: '已新建文件',
        createdDir: '已新建文件夹',
        renamed: '已重命名',
        recycled: '已移到回收站',
        removeTitle: '删除“{name}”？',
        removeDetail: '文件会移到 Windows 回收站，可从回收站还原。',
        filePlaceholder: '例如 notes.md',
        folderPlaceholder: '例如 assets',
        renamePlaceholder: '输入新名称',
        emptyName: '名字不能为空',
        badName: '名字不能包含 / 或 \\',
        targetHint: '位置：{path}',
      },
      en: {
        copyAbsolute: 'Copy absolute path',
        copyRelative: 'Copy relative path',
        copyName: 'Copy name',
        copyMention: 'Copy as @ reference',
        newFile: 'New file',
        newFolder: 'New folder',
        rename: 'Rename',
        remove: 'Move to Recycle Bin…',
        cancel: 'Cancel',
        create: 'Create',
        renameConfirm: 'Rename',
        removeConfirm: 'Move to Recycle Bin',
        working: 'Working…',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        createdFile: 'File created',
        createdDir: 'Folder created',
        renamed: 'Renamed',
        recycled: 'Moved to Recycle Bin',
        removeTitle: 'Delete “{name}”?',
        removeDetail: 'The item moves to the Windows Recycle Bin and can be restored from there.',
        filePlaceholder: 'e.g. notes.md',
        folderPlaceholder: 'e.g. assets',
        renamePlaceholder: 'New name',
        emptyName: 'Name cannot be empty',
        badName: 'Name cannot contain / or \\',
        targetHint: 'In: {path}',
      },
    }

    function isEnglish() {
      const lang = (document.documentElement.getAttribute('lang') || navigator.language || '').toLowerCase()
      return lang.indexOf('en') === 0
    }

    function t(key, vars) {
      const dict = isEnglish() ? DICT.en : DICT.zh
      let text = dict[key] || key
      if (vars !== undefined) {
        for (const [name, value] of Object.entries(vars)) text = text.split('{' + name + '}').join(String(value))
      }
      return text
    }

    /* -------------------------------------------------------------- 路径处理 */
    function normalizePath(value) {
      return String(value || '').replace(/\\/g, '/')
    }

    function trimRoot(value) {
      const normalized = normalizePath(value)
      return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
    }

    /** 绝对路径 → 相对 workspace 根的路径；不在根下时返回 null。 */
    function relativePath(root, absolute) {
      const base = trimRoot(root)
      const target = normalizePath(absolute)
      if (base === '' || target === '') return null
      if (target === base) return ''
      if (target.indexOf(base + '/') === 0) return target.slice(base.length + 1)
      return null
    }

    function baseName(path) {
      const normalized = normalizePath(path)
      const slash = normalized.lastIndexOf('/')
      return slash < 0 ? normalized : normalized.slice(slash + 1)
    }

    function parentPath(path) {
      const normalized = normalizePath(path)
      const slash = normalized.lastIndexOf('/')
      return slash <= 0 ? normalized : normalized.slice(0, slash)
    }

    /** 相对路径 → @ 引用文本。目录引用以 `/` 结尾（宿主 @file 语法）。 */
    function mentionOf(relative, directory) {
      if (relative === null || relative === undefined) return null
      const body = directory && relative !== '' ? relative.replace(/\/+$/, '') + '/' : relative
      if (body === '' || body === '/') return null
      return /[\s]/.test(body) ? '@"' + body + '"' : '@' + body
    }

    /* ---------------------------------------------------------------- 剪贴板 */
    function legacyCopy(value) {
      let area
      try {
        area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.left = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        return ok === true
      } catch (error) {
        return false
      } finally {
        if (area !== undefined) area.remove()
      }
    }

    function copyText(value) {
      return new Promise((resolve) => {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(value).then(
              () => resolve(true),
              () => resolve(legacyCopy(value)),
            )
            return
          }
        } catch (error) {
          /* 走兜底 */
        }
        resolve(legacyCopy(value))
      })
    }

    /* --------------------------------------------------------------- 宿主请求 */
    /** 调用宿主写路由；失败时抛出带 code 的 Error。 */
    async function callHost(payload) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        body = null
      }
      if (body !== null && body.ok === true) return body
      const message = body && body.error && typeof body.error.message === 'string' ? body.error.message : 'HTTP ' + response.status
      const failure = new Error(message)
      failure.code = body && body.error && typeof body.error.code === 'string' ? body.error.code : 'http'
      throw failure
    }

    /* ------------------------------------------------------------- 菜单与样式 */
    const STYLE = `
      :host { all: initial; }
      .layer { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
      .menu {
        position: fixed;
        pointer-events: auto;
        min-width: 196px;
        max-width: 340px;
        padding: 4px;
        box-sizing: border-box;
        border-radius: var(--dsw-radius-md, 8px);
        border: 1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.22));
        background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base, #232527));
        color: var(--dsw-alias-label-primary, #e8e8e8);
        box-shadow: var(--dsw-shadow-l2, 0 10px 30px rgba(0, 0, 0, 0.32));
        font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
        font-size: 13px;
        line-height: 1.4;
        user-select: none;
      }
      .item {
        display: flex; align-items: center; gap: 8px;
        width: 100%; box-sizing: border-box;
        padding: 6px 10px;
        border: 0;
        border-radius: calc(var(--dsw-radius-md, 8px) - 3px);
        background: transparent; color: inherit; font: inherit;
        text-align: left; cursor: pointer; white-space: nowrap;
      }
      .item:hover:not(:disabled), .item:focus-visible {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
        outline: none;
      }
      .item:disabled { opacity: 0.42; cursor: default; }
      .item[data-danger] { color: var(--dsw-alias-label-danger, #ff6b6b); }
      .item[data-danger]:hover:not(:disabled) { background: var(--dsw-alias-bg-danger, rgba(255, 107, 107, 0.14)); }
      .item .label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
      .item .hint {
        flex: none; max-width: 170px; overflow: hidden; text-overflow: ellipsis;
        color: var(--dsw-alias-label-tertiary, #9aa0a6); font-size: 12px;
      }
      .sep { height: 1px; margin: 4px 8px; background: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.22)); }
      .panel { padding: 8px 10px 6px; min-width: 240px; }
      .title { font-weight: 600; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; }
      .detail { color: var(--dsw-alias-label-tertiary, #9aa0a6); font-size: 12px; margin-bottom: 8px; }
      .input {
        width: 100%; box-sizing: border-box;
        margin-bottom: 6px;
        padding: 5px 8px;
        border-radius: var(--dsw-radius-sm, 6px);
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35));
        background: var(--dsw-alias-bg-base, #1b1d1f);
        color: var(--dsw-alias-label-primary, #f0f0f0);
        font: inherit;
      }
      .input:focus { outline: none; border-color: var(--dsw-alias-border-primary, #4a8cff); }
      .error { color: var(--dsw-alias-label-danger, #ff6b6b); font-size: 12px; min-height: 16px; margin-bottom: 4px; }
      .actions { display: flex; justify-content: flex-end; gap: 6px; }
      .button {
        padding: 5px 12px;
        border-radius: var(--dsw-radius-sm, 6px);
        border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35));
        background: transparent; color: inherit; font: inherit; cursor: pointer;
      }
      .button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16)); }
      .button:disabled { opacity: 0.5; cursor: default; }
      .button[data-primary] {
        border-color: transparent;
        background: var(--dsw-alias-interactive-bg-selected, #3b6fe0);
        color: var(--dsw-alias-label-inverse, #ffffff);
      }
      .button[data-danger] {
        border-color: transparent;
        background: var(--dsw-alias-bg-danger, #c0392b);
        color: var(--dsw-alias-label-inverse, #ffffff);
      }
      .toast {
        position: fixed; pointer-events: none;
        padding: 5px 10px; border-radius: 999px;
        background: var(--dsw-alias-bg-overlay, #2b2d30);
        color: var(--dsw-alias-label-primary, #f2f2f2);
        border: 1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.22));
        box-shadow: var(--dsw-shadow-l2, 0 8px 20px rgba(0, 0, 0, 0.28));
        font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
        font-size: 12px; line-height: 1.3;
        opacity: 0; transform: translateY(-2px);
        transition: opacity 140ms ease, transform 140ms ease;
      }
      .toast.show { opacity: 1; transform: translateY(0); }
    `

    /* ---------------------------------------------------------------- 安装体 */
    function install() {
      const listeners = []
      let host = null
      let shadow = null
      let layer = null
      let menu = null
      let toast = null
      let toastTimer = 0
      let observer = null
      let frame = 0
      /** 当前菜单视图的代号：异步完成时只有代号未变才允许更新 UI。 */
      let viewGeneration = 0
      /** 由本插件排下的定时器（聚焦、刷新、toast），卸载时统一清掉。 */
      const timers = new Set()

      function on(target, type, handler, options) {
        target.addEventListener(type, handler, options)
        listeners.push(() => target.removeEventListener(type, handler, options))
      }

      /** 记录一个定时器，dispose 时统一清理。 */
      function schedule(fn, ms) {
        const id = window.setTimeout(() => {
          timers.delete(id)
          fn()
        }, ms)
        timers.add(id)
        return id
      }

      /* ------------------------------------------------------------ 菜单外壳 */
      function ensureHost() {
        if (host !== null && host.isConnected) return
        host = document.getElementById(HOST_ID)
        if (host === null) {
          host = document.createElement('div')
          host.id = HOST_ID
          host.setAttribute('data-plugin', PLUGIN_SOURCE)
          document.body.appendChild(host)
        }
        shadow = host.shadowRoot || host.attachShadow({ mode: 'open' })
        shadow.textContent = ''
        const style = document.createElement('style')
        style.textContent = STYLE
        shadow.appendChild(style)
        layer = document.createElement('div')
        layer.className = 'layer'
        shadow.appendChild(layer)
        menu = document.createElement('div')
        menu.className = 'menu'
        menu.setAttribute('role', 'menu')
        menu.hidden = true
        menu.addEventListener('contextmenu', (event) => event.preventDefault())
        layer.appendChild(menu)
        toast = document.createElement('div')
        toast.className = 'toast'
        layer.appendChild(toast)
      }

      function hideMenu() {
        // 递增代号：已经在路上的异步完成回调会被判为过期，不再动 UI。
        viewGeneration += 1
        if (menu !== null) menu.hidden = true
      }

      function showToast(message, x, y) {
        if (toast === null) return
        toast.textContent = message
        toast.classList.add('show')
        const rect = toast.getBoundingClientRect()
        const left = Math.min(Math.max(8, x - rect.width / 2), window.innerWidth - rect.width - 8)
        const top = Math.min(Math.max(8, y + 14), window.innerHeight - rect.height - 8)
        toast.style.left = left + 'px'
        toast.style.top = top + 'px'
        window.clearTimeout(toastTimer)
        toastTimer = window.setTimeout(() => {
          if (toast !== null) toast.classList.remove('show')
        }, 1100)
      }

      function positionMenu(x, y) {
        menu.hidden = false
        menu.style.left = '0px'
        menu.style.top = '0px'
        const rect = menu.getBoundingClientRect()
        const left = Math.min(x, window.innerWidth - rect.width - 8)
        const top = Math.min(y, window.innerHeight - rect.height - 8)
        menu.style.left = Math.max(8, left) + 'px'
        menu.style.top = Math.max(8, top) + 'px'
      }

      /* ------------------------------------------------------------ 菜单视图 */
      function pushSeparator() {
        const line = document.createElement('div')
        line.className = 'sep'
        menu.appendChild(line)
      }

      function pushItem(item) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'item'
        button.setAttribute('role', 'menuitem')
        if (item.disabled === true) button.disabled = true
        if (item.danger === true) button.setAttribute('data-danger', '')
        const label = document.createElement('span')
        label.className = 'label'
        label.textContent = item.label
        button.appendChild(label)
        if (item.hint) {
          const hint = document.createElement('span')
          hint.className = 'hint'
          hint.textContent = item.hint
          button.appendChild(hint)
        }
        button.addEventListener('click', () => {
          if (button.disabled) return
          if (typeof item.copy === 'function') {
            hideMenu()
            Promise.resolve(item.copy()).then((ok) => showToast(ok === false ? t('copyFailed') : t('copied'), item.x, item.y))
            return
          }
          if (typeof item.action === 'function') item.action()
        })
        menu.appendChild(button)
      }

      function renderMenu(items, x, y) {
        menu.textContent = ''
        for (const item of items) {
          if (item.separator === true) {
            pushSeparator()
            continue
          }
          pushItem({ ...item, x, y })
        }
        positionMenu(x, y)
      }

      /**
       * 菜单内的表单视图（新建 / 重命名共用）。
       * @param {object} options
       * @param {string} options.title
       * @param {string} [options.detail]
       * @param {string} [options.value]
       * @param {string} [options.placeholder]
       * @param {string} options.confirmText
       * @param {(name: string) => Promise<void>} options.onSubmit
       */
      function renderForm(options, x, y) {
        menu.textContent = ''
        const panel = document.createElement('div')
        panel.className = 'panel'

        const title = document.createElement('div')
        title.className = 'title'
        title.textContent = options.title
        panel.appendChild(title)

        if (options.detail) {
          const detail = document.createElement('div')
          detail.className = 'detail'
          detail.textContent = options.detail
          panel.appendChild(detail)
        }

        const input = document.createElement('input')
        input.className = 'input'
        input.type = 'text'
        input.value = options.value || ''
        input.placeholder = options.placeholder || ''
        input.spellcheck = false
        panel.appendChild(input)

        const errorLine = document.createElement('div')
        errorLine.className = 'error'
        panel.appendChild(errorLine)

        const actions = document.createElement('div')
        actions.className = 'actions'
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.className = 'button'
        cancel.textContent = t('cancel')
        const confirm = document.createElement('button')
        confirm.type = 'button'
        confirm.className = 'button'
        confirm.setAttribute('data-primary', '')
        confirm.textContent = options.confirmText
        actions.appendChild(cancel)
        actions.appendChild(confirm)
        panel.appendChild(actions)
        menu.appendChild(panel)
        positionMenu(x, y)

        // 本视图的代号：请求在途时若菜单被关掉/换成别的视图，完成回调不再动 UI。
        const generation = ++viewGeneration

        let busy = false
        const setBusy = (next) => {
          busy = next
          input.disabled = next
          cancel.disabled = next
          confirm.disabled = next
          confirm.textContent = next ? t('working') : options.confirmText
        }
        const submit = async () => {
          if (busy) return
          const value = input.value
          if (value.trim() === '') {
            errorLine.textContent = t('emptyName')
            return
          }
          if (/[/\\]/.test(value)) {
            errorLine.textContent = t('badName')
            return
          }
          errorLine.textContent = ''
          setBusy(true)
          try {
            const result = (await options.onSubmit(value)) || {}
            if (generation !== viewGeneration) return
            hideMenu()
            if (typeof result.message === 'string' && result.message !== '') showToast(result.message, x, y)
            if (result.scope !== undefined) reloadTree(result.scope)
          } catch (error) {
            if (generation !== viewGeneration) return
            errorLine.textContent = error instanceof Error ? error.message : String(error)
            setBusy(false)
          }
        }

        cancel.addEventListener('click', () => hideMenu())
        confirm.addEventListener('click', () => {
          submit()
        })
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        })
        schedule(() => {
          try {
            input.focus()
            input.select()
          } catch (error) {
            /* 忽略 */
          }
        }, 0)
      }

      /** 菜单内的确认视图（删除二次确认）。 */
      function renderConfirm(options, x, y) {
        menu.textContent = ''
        const panel = document.createElement('div')
        panel.className = 'panel'
        const title = document.createElement('div')
        title.className = 'title'
        title.textContent = options.title
        panel.appendChild(title)
        const detail = document.createElement('div')
        detail.className = 'detail'
        detail.textContent = options.detail
        panel.appendChild(detail)
        const errorLine = document.createElement('div')
        errorLine.className = 'error'
        panel.appendChild(errorLine)
        const actions = document.createElement('div')
        actions.className = 'actions'
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.className = 'button'
        cancel.textContent = t('cancel')
        const confirm = document.createElement('button')
        confirm.type = 'button'
        confirm.className = 'button'
        confirm.setAttribute('data-danger', '')
        confirm.textContent = options.confirmText
        actions.appendChild(cancel)
        actions.appendChild(confirm)
        panel.appendChild(actions)
        menu.appendChild(panel)
        positionMenu(x, y)

        const generation = ++viewGeneration
        let busy = false
        const setBusy = (next) => {
          busy = next
          cancel.disabled = next
          confirm.disabled = next
          confirm.textContent = next ? t('working') : options.confirmText
        }
        cancel.addEventListener('click', () => hideMenu())
        confirm.addEventListener('click', async () => {
          if (busy) return
          setBusy(true)
          try {
            const result = (await options.onConfirm()) || {}
            if (generation !== viewGeneration) return
            hideMenu()
            if (typeof result.message === 'string' && result.message !== '') showToast(result.message, x, y)
            if (result.scope !== undefined) reloadTree(result.scope)
          } catch (error) {
            if (generation !== viewGeneration) return
            errorLine.textContent = error instanceof Error ? error.message : String(error)
            setBusy(false)
          }
        })
      }

      /* ------------------------------------------------------------ 写操作流程 */
      /** 写操作后让树重新列目录：点宿主自己的刷新按钮，不碰它的状态。 */
      function reloadTree(scope) {
        const button = scope.querySelector(SELECTORS.reload)
        if (button !== null) {
          schedule(() => {
            try {
              button.click()
            } catch (error) {
              /* 忽略 */
            }
          }, 120)
        }
      }

      function createFlow(scope, root, parent, kind, x, y) {
        renderForm(
          {
            title: kind === 'dir' ? t('newFolder') : t('newFile'),
            detail: t('targetHint', { path: normalizePath(parent) }),
            placeholder: kind === 'dir' ? t('folderPlaceholder') : t('filePlaceholder'),
            confirmText: t('create'),
            onSubmit: async (name) => {
              await callHost({ op: kind === 'dir' ? 'create-dir' : 'create-file', root, parent, name })
              return { message: kind === 'dir' ? t('createdDir') : t('createdFile'), scope }
            },
          },
          x,
          y,
        )
      }

      function renameFlow(scope, root, path, currentName, x, y) {
        renderForm(
          {
            title: t('rename'),
            detail: t('targetHint', { path: normalizePath(parentPath(path)) }),
            value: currentName,
            placeholder: t('renamePlaceholder'),
            confirmText: t('renameConfirm'),
            onSubmit: async (name) => {
              if (name === currentName) return { message: '' }
              await callHost({ op: 'rename', root, path, name })
              return { message: t('renamed'), scope }
            },
          },
          x,
          y,
        )
      }

      function deleteFlow(scope, root, path, name, x, y) {
        renderConfirm(
          {
            title: t('removeTitle', { name }),
            detail: t('removeDetail'),
            confirmText: t('removeConfirm'),
            onConfirm: async () => {
              await callHost({ op: 'delete', root, path })
              return { message: t('recycled'), scope }
            },
          },
          x,
          y,
        )
      }

      /* ------------------------------------------------------------ 菜单内容 */
      function copyItems(absolute, root, directory, x, y) {
        const relative = relativePath(root, absolute)
        const mention = mentionOf(relative, directory)
        return [
          { label: t('copyAbsolute'), hint: shortTail(absolute), copy: () => copyText(normalizePath(absolute)), x, y },
          {
            label: t('copyRelative'),
            hint: relative === null ? '' : shortTail(relative),
            disabled: relative === null,
            copy: () => copyText(normalizePath(relative)),
            x,
            y,
          },
          { label: t('copyName'), hint: baseName(absolute), copy: () => copyText(baseName(absolute)), x, y },
          { separator: true },
          {
            label: t('copyMention'),
            hint: mention !== null && mention.length <= 34 ? mention : '',
            disabled: mention === null,
            copy: () => copyText(mention),
            x,
            y,
          },
        ]
      }

      function openRowMenu(x, y, row, scope, root) {
        ensureHost()
        const absolute = row.getAttribute('data-files-path') || ''
        const directory = row.getAttribute('data-files-entry') === 'directory'
        const name = baseName(absolute)
        const items = copyItems(absolute, root, directory, x, y)
        if (directory) {
          items.push({ separator: true })
          items.push({ label: t('newFile'), action: () => createFlow(scope, root, absolute, 'file', x, y), x, y })
          items.push({ label: t('newFolder'), action: () => createFlow(scope, root, absolute, 'dir', x, y), x, y })
        }
        items.push({ separator: true })
        items.push({ label: t('rename'), action: () => renameFlow(scope, root, absolute, name, x, y), x, y })
        items.push({ label: t('remove'), danger: true, action: () => deleteFlow(scope, root, absolute, name, x, y), x, y })
        renderMenu(items, x, y)
      }

      function openRootMenu(x, y, scope, root) {
        ensureHost()
        const items = [
          { label: t('copyAbsolute'), hint: shortTail(root), copy: () => copyText(normalizePath(root)), x, y },
          { separator: true },
          { label: t('newFile'), action: () => createFlow(scope, root, root, 'file', x, y), x, y },
          { label: t('newFolder'), action: () => createFlow(scope, root, root, 'dir', x, y), x, y },
        ]
        renderMenu(items, x, y)
      }

      /** 路径提示保留尾部，避免长路径撑开菜单。 */
      function shortTail(path) {
        const normalized = normalizePath(path)
        if (normalized.length <= 44) return normalized
        return '…' + normalized.slice(-43)
      }

      /* ------------------------------------------------------------ 事件绑定 */
      function onContextMenu(event) {
        const target = event.target instanceof Element ? event.target : event.target && event.target.parentElement
        if (target === null || target === undefined) return
        const scope = target.closest(SELECTORS.tree)
        if (scope === null) return
        const root = scope.getAttribute('data-files-root') || ''
        if (root === '') return

        const row = target.closest(SELECTORS.row)
        if (row !== null && scope.contains(row)) {
          event.preventDefault()
          event.stopPropagation()
          openRowMenu(event.clientX, event.clientY, row, scope, root)
          return
        }
        // header 里的路径标签（PathLabel）也用同一套手势：复制根地址 / 在根下新建
        const body = target.closest(SELECTORS.body)
        if (body === null) {
          const header = scope.firstElementChild
          if (header !== null && header.contains(target)) {
            event.preventDefault()
            event.stopPropagation()
            openRootMenu(event.clientX, event.clientY, scope, root)
          }
        }
      }

      function onPointerDown(event) {
        if (menu === null || menu.hidden) return
        const path = typeof event.composedPath === 'function' ? event.composedPath() : []
        if (path.indexOf(host) >= 0) return
        hideMenu()
      }

      function onKeyDown(event) {
        if (event.key === 'Escape' && menu !== null && !menu.hidden) {
          hideMenu()
          event.stopPropagation()
        }
      }

      /** 给文件树里的行打上 draggable，并记住已经处理过。 */
      function markRows() {
        const rows = document.querySelectorAll(SELECTORS.tree + ' ' + SELECTORS.row)
        for (const row of rows) {
          if (row.getAttribute(ROW_FLAG) === '') continue
          row.setAttribute('draggable', 'true')
          row.setAttribute(ROW_FLAG, '')
        }
      }

      function scheduleMark() {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          markRows()
        })
      }

      function onDragStart(event) {
        const target = event.target
        if (!(target instanceof Element)) return
        const row = target.closest(SELECTORS.row)
        if (row === null) return
        const scope = row.closest(SELECTORS.tree)
        if (scope === null) return
        const root = scope.getAttribute('data-files-root') || ''
        const absolute = row.getAttribute('data-files-path') || ''
        const directory = row.getAttribute('data-files-entry') === 'directory'
        const mention = mentionOf(relativePath(root, absolute), directory)
        if (mention === null || event.dataTransfer === null) return
        event.dataTransfer.effectAllowed = 'copy'
        try {
          event.dataTransfer.setData('text/plain', mention + ' ')
        } catch (error) {
          /* 某些环境拒绝自定义类型，但 text/plain 一定存在 */
        }
        try {
          event.dataTransfer.setData('application/x-dsh-file-mention', mention)
        } catch (error) {
          /* 忽略 */
        }
      }

      on(document, 'contextmenu', onContextMenu, true)
      on(document, 'pointerdown', onPointerDown, true)
      on(document, 'keydown', onKeyDown, true)
      on(window, 'resize', hideMenu)
      on(window, 'blur', hideMenu)
      on(document, 'dragstart', onDragStart, true)
      on(document, 'scroll', hideMenu, true)

      markRows()
      observer = new MutationObserver(scheduleMark)
      observer.observe(document.body, { childList: true, subtree: true })

      try {
        console.info('[dsh-file-tree-actions] ready v' + VERSION)
      } catch (error) {
        /* 忽略 */
      }

      window.__dshFileTreeActions = {
        version: VERSION,
        rows: () => document.querySelectorAll(SELECTORS.tree + ' ' + SELECTORS.row).length,
        marked: () => document.querySelectorAll(SELECTORS.tree + ' ' + SELECTORS.row + '[' + ROW_FLAG + ']').length,
      }

      /* ---------------------------------------------------------------- 卸载 */
      return function dispose() {
        for (const off of listeners) {
          try {
            off()
          } catch (error) {
            /* 忽略 */
          }
        }
        listeners.length = 0
        if (observer !== null) {
          observer.disconnect()
          observer = null
        }
        if (frame !== 0) {
          window.cancelAnimationFrame(frame)
          frame = 0
        }
        window.clearTimeout(toastTimer)
        for (const id of timers) window.clearTimeout(id)
        timers.clear()
        try {
          delete window.__dshFileTreeActions
        } catch (error) {
          /* 忽略 */
        }
        const rows = document.querySelectorAll('[' + ROW_FLAG + ']')
        for (const row of rows) {
          row.removeAttribute(ROW_FLAG)
          row.removeAttribute('draggable')
        }
        if (host !== null) host.remove()
        host = null
        shadow = null
        layer = null
        menu = null
        toast = null
      }
    }

    return {
      inject: [],
      apply(ctx) {
        if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
          ctx.effect(() => install(), PLUGIN_SOURCE + ': files context menu + drag')
          return
        }
        return install()
      },
    }
  },
})
