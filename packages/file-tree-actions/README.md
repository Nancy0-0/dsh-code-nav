# dsh-file-tree-actions

给 DSH Web/Desktop 的**文件侧栏（右侧栏 Files 标签页）**补上官方暂缺的鼠标手势：

1. **右键文件 / 文件夹** → 复制绝对路径、相对路径、名称、`@` 引用；
2. **目录行右键** → 新建文件、新建文件夹（菜单里直接输入名字）；
3. **任意行右键** → 重命名（输入框预填原名）；
4. **任意行右键** → 删除（二次确认后**移到 Windows 回收站**，可从回收站还原）；
5. **把文件 / 文件夹拖进对话输入框** → 落成一条 `@相对路径` 引用。

## 为什么需要它

宿主这一版的实现里（`@deepseek-ai/dsh-client-ui-sidebar-files`），文件树每行是一个朴素的 `<button>`：

- 没有 `onContextMenu`，没有剪贴板动作 ⇒ 右键点文件夹没有任何菜单，也复制不到地址；
- 没有 `draggable`，行本身不带拖拽数据 ⇒ 拖到对话栏不触发任何事（对话栏只接受操作系统拖进来的真实文件，`dataTransfer.types` 含 `Files`）；
- 客户端拿到的 `workspaceFiles` 桥是**只读**的（`list` / `read` / `readBytes` / `changes`），没有任何新建/改名/删除通道。

所以这不是"坏了"，是能力还没做。本插件用「浏览器端 DOM 增强 + 一个宿主写路由」补上，不改宿主包、不 patch `app.asar`。

## 两个半边怎么分工

| 半边 | 文件 | 干什么 |
|---|---|---|
| 浏览器 | [`client.js`](client.js) | 委托监听文件树、渲染 shadow DOM 右键菜单、内联输入框、调宿主写路由、拖拽载荷 |
| 宿主 | [`index.js`](index.js) | 注册精确 Fetch 路由 `POST /api/file-tree-actions`，做路径校验并执行新建/改名/移入回收站 |
| 纯函数 | [`lib/paths.js`](lib/paths.js) · [`lib/ops.js`](lib/ops.js) | 名字校验、根内收敛、文件系统动作（可脱离 Cordis 单测） |

**安全边界**（按顺序即防线）：

1. 路由走 `ctx.connection.fetch.register`：连接层已经套了 Host/Origin 栅栏与登录态，只有 owner principal 能到；
2. 请求体限长 8 KiB，字段必须字符串，`op` 在白名单；
3. `root` 必须是**某个会话的工作区**（或它下面的路径）；root / 父目录 / 目标全部 `realpath` 之后仍在真实根内——符号链接指向外面一律拒绝；
4. 名字只允许单个路径片段（拒绝 `/`、`\`、`.`、`..`、控制字符、Windows 保留名与非法字符）；新建/改名**绝不覆盖**已存在目标；删除只走回收站，PowerShell 失败就报错，**不会静默降级成永久删除**。

## 安装

```powershell
dsh plugin --profile desktop add C:\Users\Administrator\Documents\deepseek-harness\default-workspace\plugins\dsh-file-tree-actions
```

## 生效方式（重要）

- **只改 `client.js`**：刷新页面即可（link 安装，宿主直接从磁盘读 bundle）。
- **改了 `index.js` / `lib/*`（宿主半边）**：**重启应用**。不要用 `dsh_hot_reload`——实测它会把 loader entry 置为 `disabled`，还会把整棵合成树写进 `~/.dsh/profiles/desktop/cordis.yml`（里面固化了 `disabled: true` 行）。恢复办法：把该文件写回 `[]`，再重启应用。
- 装完第一次也要**刷新页面**（客户端插件在页面启动时装载）。

## 使用

- **右键文件 / 文件夹**：菜单在鼠标处弹出。
  - 绝对路径 = `C:/Users/.../workspace/notes/a.md`（正斜杠，便于粘进终端/代码）；
  - 相对路径 = 相对会话工作区根的路径；
  - `@` 引用 = 可直接粘进输入框的 `@notes/a.md`（含空格的路径自动加引号）。
- **右键目录行 / header 路径标签**：新建文件、新建文件夹（内联输入，回车提交、Esc 取消）。
- **右键任意行**：重命名（预填原名）。
- **右键任意行 → 移到回收站…**：菜单变成确认面板，再点「移到回收站」才执行。
- **按住某一行拖到对话输入框松开**：插入 `@相对路径 `。

## 测试

三套离线测试，跑之前不需要启动应用：

```powershell
powershell -NoProfile -File C:\Users\Administrator\Documents\deepseek-harness\default-workspace\tools\run-fta-test.ps1
```

| 套件 | 覆盖 | 结果 |
|---|---|---|
| [`test/host-ops.mjs`](test/host-ops.mjs) | 名字校验（含 `COM¹`、`CONIN$`）、`isInside` 前缀误判、新建/改名/拒绝覆盖 | 32 项 |
| [`test/host-route.mjs`](test/host-route.mjs) | 用假 ctx 捕获注册的路由，覆盖 200/400/403/404/405/409/413、坏 JSON、数组请求体、字段类型、根外路径，并真实执行一次回收站删除 | 22 项 |
| [`test/harness.html`](test/harness.html) | 同构 DOM + 真实 Chromium：菜单项、复制文本、新建/改名/删除流程与请求载荷、错误回显、拖拽载荷、陈旧异步完成、卸载清理 | 47 项 |

菜单外观预览：`<workspace>/screenshots/fta-menu-preview.png`（`tools/preview-menu.js` 生成）。

## 外部审核（Kimi）与处理结果

审核输出在 `<workspace>/logs/kimi-review2.txt`，结论 `FAIL`（P0：realpath 与写操作之间的 TOCTOU）。逐条核实后的处理：

| 级别 | 问题 | 处理 |
|---|---|---|
| P1 | 工作区根 `realpath` 在 try/catch 之外，失败时抛出 rejected promise（无 JSON 响应） | 已修：整段进 try，`not-found` 映射 404，并有测试 |
| P1 | Windows 保留名未覆盖上标数字（`COM¹`/`LPT²`）与 `CONIN$`/`CONOUT$` | 已修：正则补齐，测试覆盖 |
| P2 | 8 KiB 上限在 `request.text()` 之后才检查；`parent` 非字符串被静默替换为根 | 已修：先查 `Content-Length`；字段类型显式 400；数组请求体 400 |
| P2 | 异步完成会关掉新打开的菜单；卸载后仍有刷新定时器触发 | 已修：菜单视图 generation 守卫 + 定时器统一 `schedule()` 并在 dispose 清理，harness 增加两条回归测试 |
| P0 | realpath 校验与写操作之间的 TOCTOU（本地并发进程把已校验目录换成 junction/符号链接） | **接受风险**：Node 没有 `openat`/目录句柄相对操作，纯 JS 无法彻底消除；预置的 junction/symlink 已被 `realpath` + 根内校验挡住，只剩"校验后毫秒级内被本机同权限进程替换"的竞态。要关闭它需要原生 addon 或改用 Windows Shell API，收益与成本不匹配——若未来要上多用户/共享机器再补 |
| P1 | 重命名的"不覆盖"是预检 + `fs.rename`，非原子 | **接受风险**：同上，需要本机同权限进程在预检后插入同名文件才会触发；`fs.rename` 是 Node 唯一跨平台改名原语。若要紧可改成 PowerShell `[IO.File]::Move(src,dst)`（存在即抛错），代价是每次改名多一次进程启动 |
| P2 | 内部错误 / PowerShell stderr 会返回给客户端 | **接受**：调用者是本机已登录 owner，错误文本（含路径）对他不是秘密，且排障需要；不放宽到未认证请求 |

## 排查

- 控制台：`__dshFileTreeActions.version` / `.rows()` / `.marked()` 确认挂载与行标记数。
- 右键无反应：确认右侧栏在 **Files** 标签页（不是 Browser / Terminal）。
- 新建/改名/删除报 `HTTP 401`：宿主半边没加载（改完 `index.js` 没重启，或被热重载禁用），重启应用。
- 删除报 PowerShell 错误：宿主会原样回显 stderr 前 400 字符，文件不会被删。
- 拖拽落不进输入框：宿主输入框是 Lexical，外部纯文本走 `beforeinput insertFromDrop` → `insertRawText`（已核对 0.2.1-rc.3）。兜底：右键 →「复制为 @ 引用」→ Ctrl+V。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-file-tree-actions
```

安装前的 profile 备份在 `~/.dsh/profiles/desktop/_backup_fta_<时间戳>`。

## 边界与风险

- 依赖宿主 DOM 约定（集中在 `client.js` 的 `SELECTORS`）：`[data-files-state="tree"][data-files-root]` / `li[data-files-path]` / `[data-files-body]`。宿主升级改这些属性时只改 `SELECTORS`。
- 官方 UI 插件规范建议"只渲染 slot 组件、不在组件外写 DOM"。文件树没有行级菜单 slot，因此这里用委托监听 + body 上的 shadow DOM 菜单；样式隔离在 shadow 内，卸载时整体移除。
- 写路由是**新增**的宿主入口：虽然挂了连接层栅栏，但它拥有本机文件写权限，改这段代码时要保持"根内 + realpath + 不覆盖"三条不变式。
- 回收站删除走 `powershell.exe -EncodedCommand` + `Microsoft.VisualBasic.FileIO.FileSystem`，非 Windows 会明确返回 501。
