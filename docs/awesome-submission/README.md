# awesome-dsh-plugin 投稿材料

给 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的收录 PR 准备的两个条目文件。**不要直接改动对方 README**；投稿只加 `data/plugins/` 下的一个（这里是两个）YAML 文件。

## 现在能不能投

| 门槛 | 现状 |
|---|---|
| 仓库至少 1 天 | ❌ 仓库刚建，需等满 24 小时（CI 会自动检查） |
| 仓库有 `dsh.bundle` manifest | ✅ 两个子包各自声明（`package.json` 的 `dsh.bundle.patch`） |
| 真实可用代码 | ✅ 三套测试 + CI |
| 仓库加 `dsh-plugin` topic | ⏳ 仓库创建后用 `gh repo edit --add-topic dsh-plugin` |
| 一个 PR 最多 3 条 | ✅ 本仓库 2 条，一次提交即可 |
| npm 包（可选） | ⏳ 未发布；不影响收录，只影响市场里的下载量显示 |

## 提交步骤

1. 等仓库创建满 24 小时。
2. fork `awesome-dsh-plugin/awesome-dsh-plugin`，把下面两个文件放进 `data/plugins/`：
   - `Nancy0-0__dsh-code-nav--packages-file-tree-actions.yml`
   - `Nancy0-0__dsh-code-nav--packages-symbol-links.yml`
3. 开 PR，标题示例：`Add Nancy0-0/dsh-code-nav (file-tree-actions, symbol-links)`；正文说明每个插件做什么、测试怎么跑。
4. CI 会校验 manifest、仓库年龄、YAML 格式与 README 重生成；通过后由维护者阅读源码合并。
5. 不要手改对方仓库生成的 README。

## 分类选择

- `file-tree-actions` → `ui`（Files 侧栏的交互增强）。
- `symbol-links` → `docs`（聊天里代码的渲染与跳转）。若维护者认为更贴近 `ui`，按他们的调整即可，规则写明分类不准不会被打回。

## 描述口径

描述会被维护者逐句对着代码核对，所以只写已经实现的行为：

- `symbol-links` 的「引用候选 / 同名定义」是文本匹配，不声称语义调用关系或接口实现；条目描述里不提这两项开发中的能力。
- `file-tree-actions` 的删除是「移到 Windows 回收站」，不写「永久删除」。
