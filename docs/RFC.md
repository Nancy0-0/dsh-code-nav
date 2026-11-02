# RFC：dsh-code-nav —— 把「聊天里点代码、文件树里动文件」做成一个可发布的小项目

- 状态：草案（待 Kimi 审核）
- 日期：2026-11-02
- 作者：DeepSeek（与用户共同打磨）
- 现有代码：`plugins/dsh-symbol-links`（聊天内符号导航，已上机可用）、`plugins/dsh-file-tree-actions`（Files 侧栏右键新建/改名/回收站/复制路径/拖拽 @ 引用，已上机可用）

## 1. 一句话

一个 DSH 插件小仓库：**聊天里的函数名可点、可查引用/实现；文件树右键能新建文件夹/文件、改名、删到回收站**。两个能力互补，都是"让代码在对话里可操作"。

## 2. 为什么值得单独开仓库

- 现有两个插件都已在 desktop profile 里用 link 安装、日常可用，但散落在 workspace/plugins，没有版本、没有发布、没有 CI；
- 社区市场里没有"聊天行内符号 → 定义/引用"的现成插件（2026-10-28 用 7406 条 registry 核对过）；
- 两个插件共享同一套 DSH 客户端插件经验（DOM 装饰、per-session inject、同源路由、reopen 定位），放一起维护成本更低、示例价值更高。

## 3. 仓库结构（monorepo）

```
dsh-code-nav/
├── packages/
│   ├── symbol-links/          # 聊天内符号导航（host + client）
│   │   ├── lib/resolver.js    # 纯解析逻辑（可单测）
│   │   ├── lib/index.js       # host：只读索引 + POST /api/symbol-links/resolve
│   │   ├── lib/client.js      # client：行内 code 装饰、点击/右键菜单
│   │   └── test/              # node --test 单测 + host 路由 e2e
│   └── file-tree-actions/     # Files 侧栏右键（host + client）
├── docs/                      # 设计、兼容性、排障
├── .github/workflows/ci.yml   # node --test + node --check
├── LICENSE (MIT)
└── README.md                  # 安装、截图、能力矩阵、已知限制
```

安装方式（发布后）：`dsh plugin --profile <name> add dsh-symbol-links` / `dsh-file-tree-actions`；仓库同时发布两个 npm 包。

## 4. 功能路线

### 4.1 symbol-links（本次新增）

| 能力 | 交互 | 实现思路 | 精度 |
|---|---|---|---|
| 定义 | 左键点击 | 现有索引：定义 → 包住调用点的函数 → 首次出现 | 正则级（C/C++/Py/JS-TS），LSP 可选增强 |
| **引用候选** | 右键 → 引用候选（文本匹配） | host 返回该名字的文本命中（定义 + 调用 + 普通出现），去重排序，上限 50，返回 `limitHit` | 文本匹配，**不声称**语义调用关系 |
| **同名定义候选** | 右键 → 同名定义（候选） | host 返回同名定义集合，上限 20 | 同名搜索，**不声称**是接口实现 |
| **复制名字** | 右键 → 复制 | navigator.clipboard | 精确 |

LSP 预留：若 `ctx.lsp` seam 在后续 DSH 版本可用（本机 0.2.1-rc.3 没有），host 内可切到 `textDocument/references|definition`；在此之前正则索引是唯一可用路径，UI 上不谎称"语义级"。

### 4.2 file-tree-actions（已有，收编进仓库）

右键目录/文件：新建文件、新建文件夹（内联输入）、重命名、移到回收站、复制绝对/相对路径与 @ 引用；拖拽进对话栏插入 `@相对路径`。已有 70 项测试（host 28 + harness 42）。

### 4.3 后续候选（不在本期）

- 符号 hover 摘要、多结果选择器（同名重载）；
- 引用结果按文件分组、折叠；
- LSP 语义模式开关（需要 dsh-lsp-actions 或 ctx.lsp provider）。

## 5. 关键技术约束（来自前两轮上机）

1. turnTail 槽**不传 sessionId**，会话 id 必须从 `conversation.user.text.node` 的 per-session `inject` 拿；
2. 打开预览用 `openFile(path,{line})`，回退 `ctx.sidebarRight.openResource(dsh-resource://file/session/<sid>/<path>, {params:{line}})`；
3. 客户端插件改动必须重启应用，不能指望热重载；
4. host 索引按会话根 + `extraRoots` 配置，结果 realpath 边界校验；
5. 冷建索引 >3.5s 返回 `incomplete`，客户端不缓存 miss。

## 6. 验收

- symbol-links：定义命中 ≥22/30（人工真值），引用列表 ≤50 条且按路径+行号稳定排序；右键菜单四项可用；单测 ≥15。
- file-tree-actions：现有 70 项测试全绿。
- CI：`node --check` + 两包 `node --test` 在 Windows/Ubuntu 上通过。
- 发布：两个包版本 0.1.0 / 0.2.x，README 带安装命令与兼容矩阵。

## 7. 迁移方案（可执行、可回滚）

1. 备份：`profiles/desktop/package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` → `_backup_code-nav_<时间戳>`；
2. 移动：`plugins/dsh-symbol-links` → `repos/dsh-code-nav/packages/symbol-links`，`plugins/dsh-file-tree-actions` → `packages/file-tree-actions`；
3. 更新 link：profile `package.json` 里两条 `link:` 指向新路径（包名、bundle id、路由都不变，**不允许新旧两套同时启用**）；
4. 刷新依赖：profile 内用运行时 pnpm 重新 install，确认 `node_modules/<包名>` 的 junction 指向新路径；
5. 重启应用，冒烟：symbol-links 路由 200、行内点击、右键菜单；file-tree-actions 菜单新建文件夹；两插件各只出现一次；
6. 回滚：删新备份前把旧目录搬回、profile 两个 JSON 还原、pnpm install、重启。

迁移完成并验收后才发布；发布前按 §8 清单检查。

## 8. 公开发布前清单

- [ ] `.gitignore` 覆盖 node_modules / 日志 / 截图；`npm files` 白名单只含 lib、test、README、cordis.patch.yml；
- [ ] `npm pack` 产物检查：无本机绝对路径、无测试记录、无 profile 配置；
- [ ] 敏感信息扫描（路径、token、邮箱、内网 IP）；
- [ ] 仓库名 / 可见性 / LICENSE 由用户确认；
- [ ] 两个包版本策略：symbol-links 0.1.0、file-tree-actions 0.2.x，各自独立发版，README 标注兼容 DSH 0.2.1-rc.3；
- [ ] CI 在 windows-latest + ubuntu-latest 跑两个包的 `node --check` 与 `node --test`。

## 9. 风险

- 文本引用不区分同名重载/宏，且被 50 条上限截断 → UI 标注"文本匹配"并显示是否截断；
- monorepo 移动目录会改变 profile 的 link 路径 → 按 §7 步骤执行并保留备份；
- 公开发布前需确认仓库名/可见性/许可证（MIT 默认）。

## 10. Kimi 审核（2026-11-02）：REVISE → 已按意见修订

- P1-1 迁移缺可执行步骤 → 补 §7（备份/移动/更新 link/刷新/冒烟/回滚）；
- P1-2 "查找引用"表述超出能力 → 改名"引用候选（文本匹配）"，返回 limitHit，UI 加免责声明；
- P1-3 "查找实现"实为同名定义 → 改名"同名定义（候选）"，不进"实现"菜单；
- P1-4 兼容验收不全 → 固定包名/ID/路由不变，禁止新旧并存，重启后冒烟两插件各只出现一次；
- P1-5 发布前检查不足 → 补 §8 清单。
