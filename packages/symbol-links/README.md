# dsh-symbol-links

聊天里的行内代码（函数名、类型名）可直接点开，在右侧预览中定位到源码行——不用让模型再贴一遍代码。

## 能力

- 助手消息中的行内 `<code>` 标识符可点（悬停有虚线提示）；
- 左键：打开定义；**右键菜单**：打开定义 / 引用候选（文本匹配）/ 同名定义（候选）/ 复制名字；
  引用候选与同名定义都按文本/同名匹配返回，UI 明确标注"不代表语义调用关系或接口实现"，结果上限 50/20 条；
- 解析阶梯（确定性，见 `lib/resolver.js`）：
  1. **definition**：语言定义正则 + 注释/字符串屏蔽，唯一命中直接返回；
  2. **wrapper**：无定义或多候选时，找调用点并回退到包住它的函数定义（深度 ≤2、节点 ≤8）；
  3. **occurrence**：仍未命中时按「路径字典序 + 行号」确定性回退到首次出现；
- 点击后通过官方 `openFile(path, { line })`（或 `ctx.sidebarRight.openResource`）在右侧预览打开并滚动到行；
- 无命中不装饰；复制行为不变；与官方 deliverables / dsh-file-mentions / dsh-code-pill 共存（跳过 `<a>`、`<pre>`、`<button>`）。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/resolver.js` | 纯解析逻辑（无 I/O，可单测） |
| `lib/index.js` | host 半：只读工作区索引 + 同源路由 `POST /api/symbol-links/resolve` |
| `lib/client.js` | 浏览器半：装饰 + 点击委托 + 调路由 + 打开预览 |
| `test/resolve.test.mjs` | 单测（定义/包装/确定性排序/屏蔽注释） |

## 安全与预算

- 根目录只取会话 `header.cwd`（不信任客户端 cwd），结果 `realpath` 边界校验；
- 符号名白名单 `^[A-Za-z_][A-Za-z0-9_:<>~]{0,119}$`，单请求 ≤24 个名字；
- 索引忽略 `.git/node_modules/build/dist/...`、二进制、>2MB 文件，上限 5 万文件；
- 索引 TTL 60s，LRU 保留 3 个工作区。

## 安装

```
# 已在本机 desktop profile 以 link 方式安装（开发期改源码即时生效）
pnpm add "link:<repo>/packages/symbol-links"
```

bundle 行由 `cordis.patch.yml` 提供，profile 的 `dsh.profile.bundles` 需包含 `dsh-symbol-links`。客户端半需要重启应用加载。

## 已知限制

- 首版只识别 C/C++、Python、JS/TS 的函数/类定义；
- 正则索引非编译器级：宏、模板元编程、同名重载可能判错，靠 L3 回退兜底；
- 无 LSP 依赖；装了 LSP 后可在 `lib/index.js` 接入语义定义（见 issue §4.1 的 P2）。
