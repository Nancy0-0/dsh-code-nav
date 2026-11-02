# dsh-code-nav 架构设计

本文只描述已经落地或已在 host 侧具备代码路径的能力，不把规划写成现状。两个插件都遵循同一条原则：**不改宿主包、不 patch `app.asar`，只通过公开扩展点补能力**。

## 1. 总体结构

```text
DSH Web 前端（浏览器）
├─ conversation 区域
│  └─ dsh-symbol-links / client.js
│     ├─ MutationObserver 装饰行内 <code>
│     ├─ click 委托 → POST /api/symbol-links/resolve
│     └─ openFile(path, {line}) → 右侧预览定位
└─ 右侧栏 Files
   └─ dsh-file-tree-actions / client.js
      ├─ contextmenu 委托 → shadow DOM 菜单
      ├─ 内联输入（新建/改名）
      ├─ dragstart → @引用 文本
      └─ POST /api/file-tree-actions
                │
DSH Host（Node）│
├─ dsh-symbol-links / lib/index.js
│  ├─ 只读工作区索引（内存）
│  └─ webServer 精确路由 /api/symbol-links/resolve
└─ dsh-file-tree-actions / index.js
   ├─ connection.fetch 精确路由 /api/file-tree-actions
   └─ 新建 / 改名 / 回收站（Windows）
```

两个包互不依赖：symbol-links 只读，file-tree-actions 只写；可以只装其中一个。仓库没有构建步骤，源码即产物。

## 2. symbol-links

### 2.1 host：只读索引

入口 `lib/index.js`，声明 `inject: ['webServer', 'sessions']`。

索引以「根目录」为单位，根来自两处：

1. 请求里的 `sessionId` → `ctx.sessions.get(sessionId).header.cwd`（**唯一可信的会话根**）；
2. 插件配置 `extraRoots`（服务端配置，最多取 4 个绝对路径，只读）。

索引构建（`buildWorkspaceIndex`）：

- 广度优先遍历根目录，忽略 `.git`、`node_modules`、`build`、`dist`、`out`、`.venv`、`__pycache__`、`.pytest_cache`、编辑器目录等，以及所有以 `.` 开头的目录；
- 只收受支持扩展名：C/C++（`.c/.h/.cc/.cpp/.cxx/.hpp/.hh/.hxx`）、Python（`.py`）、JS/TS（`.js/.mjs/.cjs/.ts/.tsx/.jsx`）；
- 跳过大于 2 MB 的文件、含 NUL 的二进制、读失败的文件；
- 每文件只扫描一次，生成 `Map<name, {defs, calls}>`：定义与调用站点都按「限定名 + 裸名」入索引（`Foo::bar` 与 `bar` 都能命中）；同名定义全部保留，调用每名最多保留 50 条；
- 扫描前先用 `maskNoise` 屏蔽注释与字符串（C 风格 `//`、`/* */`，Python `#` 与三引号），避免把注释里的名字当成定义；
- 每个根记录 `builtAt`，TTL 10 分钟；进程内 LRU 最多保留 4 个根；正在构建的根用 single-flight 复用同一个 Promise，避免并发冷建。

索引是**只读**的：只调用 `readdir/stat/readFile/realpath`，不写工作区。

### 2.2 解析阶梯（确定性）

`lib/resolver.js` 是不做 I/O 的纯函数，host 和单测共用：

1. **L1 定义**：用语言定义正则匹配 `defs`；按「hint 文件优先 → 定义置信度 → 路径字典序 → 行号」排序。
2. **L2 包装函数**：没有定义或出现歧义时，从 `calls` 站点向上找包住它的函数定义，要求 `call.line ∈ [def.line, def.endLine]`；BFS 深度 ≤2、扩展节点 ≤8、访问集合按 `(path,line)` 去重，命中第一个定义即停。返回值必须标 `via: 'wrapper'`，不冒充定义。
3. **L3 顺序出现**：仍未命中时，按同一排序规则返回第一个出现站点，`via: 'occurrence'`；没有则返回 `null`。

索引里查不到时，host 还会做一次**有预算的逐行 grep 兜底**（250 ms），找到后按 `occurrence` 返回；预算耗尽会把响应的 `incomplete` 置为 `true`，让客户端不要把「未命中」长期缓存。

hint 文件来自请求的 `hintFiles`，只用于排序，不作为可信路径使用。

### 2.3 host 路由

- `POST /api/symbol-links/resolve`，通过 `ctx.webServer.register({kind:'exact'})` 注册。
- 请求体：`{ sessionId, names: string[], hintFiles?: string[], want?: 'definition'|'references'|'implementation' }`。
- 限制：body ≤ 64 KiB；名字必须匹配 `^[A-Za-z_][A-Za-z0-9_:<>~]{0,119}$`，单请求最多 24 个；`sessionId` 缺失直接 400；会话 cwd 不可用 400。
- 响应：`{ ok, incomplete, want, results:[{name,path,line,kind,via}], truncated, roots }`。
- `want='definition'`（默认）走上面的解析阶梯；`want='references'` 返回最多 50 条 `path:line` 去重结果；`want='implementation'` 返回最多 20 条同名定义。浏览器端右键菜单已有「引用候选（文本匹配）」「同名定义（候选）」入口，但结果是文本级候选，不保证语义调用关系或接口实现，仍按**开发中**对待。
- 输出校正：每个结果用 `realpath` 解析，必须仍在对应根的 realpath 边界内，否则丢弃（防符号链接/junction 越界）。

同源守卫（这条路由挂在 webServer 上，因此自己做校验）：

- `Host` 必须是 loopback（`localhost`、`127.x.x.x`、`[::1]`）；
- 有 `Origin` 时，其 hostname 必须与 Host 一致；
- `sec-fetch-site: cross-site` 直接拒绝。

### 2.4 client：装饰、会话与打开

浏览器半在 `[data-conversation-scroll]` 内工作：

- `MutationObserver` 监听 `childList` 与 `characterData`，用 `requestAnimationFrame` 合并同帧扫描；只处理行内 `<code>`，跳过 `a`、`pre`、`button` 内的代码，避免和官方文件链接、代码块、deliverables chip 抢点击；
- 候选条件是合法标识符、长度 3–80、且不在关键字/标准库停用词表里；命中候选打 `data-sym-link` 标记，样式只加虚线下划线，不改文本、不影响复制；
- **会话 id** 来自官方 per-session 钩子 `slots.inject('conversation.user.text.node', …)` 的 `inject(sessionId)` 回调；`conversation.chat.turnTail` 槽的 props 作为补充来源，同时暂存其中的 `openFile`。这是之前「拿不到 sessionId，点击无反应」问题的修复点；
- 点击走 document 级捕获委托；只有带标记的 `<code>` 才处理，且加 `data-sym-busy` 防止重复点击。点击时**捕获**当时的 `(sessionId, openFile)`，请求返回后如果会话已切走就丢弃结果；
- 右键同一条 `<code>` 会弹出轻量面板：「打开定义」「引用候选（文本匹配）」「同名定义（候选）」「复制名字」。后两项复用同一条路由，面板明确标注「文本匹配，不代表语义调用关系」「同名定义候选，不保证是接口实现」；
- 同 `(sessionId, name)` 的并发请求合并；命中缓存 60 s、未命中缓存 20 s，会话切换清空；`incomplete=true` 的未命中不缓存；
- 打开优先级：
  1. 槽 props 里的官方 `openFile(path, { line })`；
  2. 退回 `ctx.get('sidebarRight').openResource('dsh-resource://file/session/<sid>/<path>', { params: { line } })`。
- 失败只做 2.2 s 的轻提示：会话未就绪 / 正在建索引 / 未找到定义 / 无法打开，不弹窗、不打断阅读。

解析请求 4 s 超时；超时按 `incomplete` 处理，不写负缓存。

## 3. file-tree-actions

### 3.1 host：唯一写入口

宿主对浏览器暴露的 `workspaceFiles` 桥是只读的（`list/read/readBytes/changes`），所以写操作必须落在 host：

- 通过 `ctx.inject(['connection', 'sessions'])` + `connection.fetch.register` 注册精确路由 `POST /api/file-tree-actions`；
- 连接层已套 Host/Origin 栅栏与登录态，只有 owner principal 能到达；
- body ≤ 8 KiB（先看 `content-length`，再按实际 UTF-8 字节数复查）；只接受 JSON 对象；
- `op` 白名单：`create-file`、`create-dir`、`rename`、`delete`；字段必须是字符串；
- 允许根 = 所有会话的 `header.cwd` + `sandboxPolicy.workspaceRoot` 兜底，全部先 `realpath`；请求的 `root` 必须等于某个允许根或落在其下；
- 目标路径再 `realpath`，必须仍在真实根内；符号链接指向根外一律拒绝；
- 名字只允许单个路径片段：拒绝 `/`、`\`、`.`、`..`、控制字符、Windows 保留名与非法字符；新建/改名绝不覆盖已存在目标（冲突 409）；不能改名或删除工作区根目录；
- 删除只走 Windows 回收站（PowerShell `-EncodedCommand` + `Microsoft.VisualBasic.FileIO.FileSystem`）；PowerShell 失败就返回错误，不降级为永久删除；非 Windows 返回 501。

错误映射：`400` 参数/名字非法，`403` 越界或无权限，`404` 不存在，`409` 已存在，`413` 请求体过大，`501` 平台不支持，`500` 其他。

### 3.2 client：右键菜单与拖拽

- 选择器集中在 `SELECTORS`：`[data-files-state="tree"][data-files-root]`、`li[data-files-path]`、`[data-files-body]`、`[data-files-reload]`。宿主升级改 DOM 时只改这一处；
- document 级委托 `contextmenu` / `pointerdown` / `keydown` / `dragstart` / `scroll`；菜单渲染在挂在 `document.body` 的 shadow root 里，样式隔离，卸载时整体移除；
- 新建/改名使用菜单内的内联输入框：回车提交、Esc 取消；成功后触发官方 reload 按钮刷新文件树；失败把 host 的错误信息回显在菜单里；
- 拖拽：MutationObserver + rAF 给文件树行补 `draggable`，`dragstart` 写入 `text/plain`（`@相对路径 `，含空格加引号、目录补尾斜杠）以及 `application/x-dsh-file-mention`；宿主输入框（Lexical）按 `insertFromDrop` 消费纯文本；
- 复制路径优先 `navigator.clipboard.writeText`，失败回退临时 textarea + `execCommand`；
- 全部监听器、观察者、定时器、shadow host 都在 `ctx.effect` 的卸载函数里清理。

## 4. 安全边界

| 边界 | symbol-links | file-tree-actions |
|---|---|---|
| 入口鉴权 | loopback Host + 同源 Origin + `sec-fetch-site` | `connection.fetch`（登录态 + Host/Origin 栅栏） |
| 客户端输入 | `sessionId` 只用于选会话；路径与 cwd 不接受 | `root/path` 仅作候选，必须过允许根 |
| 边界收敛 | 会话 `header.cwd` + 服务端 `extraRoots` | 会话 cwd + sandbox 根 |
| 越界防护 | 结果逐条 `realpath` | 根、父目录、目标全部 `realpath` |
| 写权限 | 无（只读） | 有；名字/覆盖/根目录三重约束 |
| 失败策略 | 不装饰、不报错，轻提示 | 明确 HTTP 错误，删除失败不降级 |

关键不变式：**客户端传来的路径永远不是授权依据**。symbol-links 的根只从服务端会话表或服务端配置来；file-tree-actions 的写目标必须同时满足「在允许根内」和「realpath 后仍在真实根内」。

## 5. 冷/热索引预算

### symbol-links

| 项 | 值 | 说明 |
|---|---|---|
| 单次冷建等待 | 3.5 s | 超时返回 `incomplete`，后台继续构建 |
| 索引 TTL | 10 min | 到期后下一次请求重建 |
| 根 LRU | 4 | 超出时淘汰最旧 |
| 单文件上限 | 2 MB | 超过跳过 |
| 文件数上限 | 50,000 | 达到后标记 `truncated` |
| 单次解析总预算 | 1.5 s | 逐名循环共享 |
| grep 兜底预算 | 250 ms | 每个名字、每个根 |
| 引用结果上限 | 50 条 | `want=references` |
| 实现结果上限 | 20 条 | `want=implementation` |
| 请求体 | 64 KiB | 超过 400 |
| 单请求名字数 | 24 | 超出截断 |
| 客户端请求超时 | 4 s | 超时按 `incomplete` |
| 客户端缓存 | 命中 60 s / 未命中 20 s | 按 `(session,name)` |

**热路径**：已建好的索引只做内存查找，典型是毫秒级；索引未命中才触发 grep 兜底。`incomplete` 表示预算或冷建没走完，不是「确定不存在」。

### file-tree-actions

| 项 | 值 |
|---|---|
| 请求体 | 8 KiB |
| 路由方法 | 仅 POST |
| 单次操作 | 一次新建/改名/删除，无批量 |
| 索引 | 无（每次实时文件系统操作） |

## 6. 失败与降级

- 无命中：symbol-links 不改变正文语义，只提示；不把「未找到」渲染成链接。
- 冷建/预算耗尽：`incomplete=true`，客户端不缓存未命中，稍后重点可重试。
- 会话 / 打开函数缺失：提示「会话未就绪」，不发起请求。
- 文件操作失败：host 返回稳定错误码与消息，客户端原样回显；删除失败不会静默永久删除。
- DOM 装饰失败：`decorateCode` 的异常被隔离，不影响消息渲染。

## 7. 非目标与演进边界

- 不做完整 IDE：不提供 hover、引用面板 UI、重命名符号、诊断。
- 当前不接 LSP；语义定义与跨语言精确解析不在本版范围。
- 不解析跨仓库符号，除非在服务端配置 `extraRoots`；首版不信任客户端传入的额外根。
- 不修改宿主包或 `app.asar`；所有能力通过公开的 slots、`openFile`、`webServer`、`connection.fetch` 组合。
- 引用/实现已有 host 数据路径与右键候选入口，但仍是文本级启发式结果；后续工作主要是提升语义精度、结果展示与交互细节，在完成前 README 与本文都按「开发中」标注。
