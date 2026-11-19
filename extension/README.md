# Git Branch

在 VS Code 的 Source Control 面板中增加 **Branches** 视图，提供完整的分支管理功能。

## 功能

### Branches 树

- **Local** — 本地分支列表，默认主分支用黄色实心小星星，当前检出分支用黄色空心标签；两者重合时使用标签＋星星组合标记。名称使用普通颜色，不加 `*` 或整段高亮
- **Remote** — 远程分支，按远程名（origin 等）分组
- **Tags** — 标签列表
- **Diff** — 工作区比较会话，与 Local、Remote、Tags 同级；各比较分支可独立展开文件

仅默认主分支与当前检出分支显示身份标记，其余分支、标签、远程名分组和 Diff 比较会话不显示前置图标；保留名称、必要的展开箭头和右侧操作按钮；名称后不显示 hash。Diff 文件列表仍保留文件／目录图标及状态标识。
默认主分支优先使用本地保存的远程 `HEAD` 符号引用（如 `origin/HEAD → origin/main`），每个远程独立判断；缺少远程 HEAD 时依次选择该远程存在的 main、master。Local 优先匹配 origin 默认分支的同名分支或唯一跟踪分支；没有 origin 时使用无歧义的远程默认名称；没有默认信息时依次选择实际存在的 main、master。不会自动 fetch 或联网更新默认信息。当前分支由本地 HEAD 判断，detached HEAD 不标记当前分支。
Branches 标题栏只保留刷新和折叠全部（Collapse All），不再显示创建按钮和「…」更多菜单；Create / Create and Checkout 通过分支右键或命令面板使用。
悬浮提示显示名称、完整 hash、最后提交时间（含时区偏移）和追踪分支；未配置追踪时明确标注。远程分支／标签的追踪项显示不适用，附注标签的 hash 和时间取其对应提交。不再显示 Current branch／Default branch；Tracking status 仅显示 ahead／behind 数量，不重复跟踪分支名和说明。分支、标签与 Diff 会话使用原生 Markdown 悬浮框，各字段紧凑换行，不使用段落间距。仅 Branch name 和已配置的 Tracking branch 行尾显示复制图标，各自只复制对应分支名，不复制字段标签或整段信息；不适用／未配置的跟踪项不显示复制图标，也没有底部 Copy 行。带复制链接的悬浮框支持鼠标移入；仓库文字经过转义，仅授权内部复制命令，不使用 WebView。
本地分支名后显示与其配置的跟踪分支之间的提交差异，例如 `1↓ 2↑` 表示落后 1 个、领先 2 个提交，使用普通描述文字，不加颜色。仅显示非零方向；同步、无跟踪配置时隐藏数字。跟踪引用在本地缺失时不伪装为同步，悬浮提示计数不可用。计算依据本地保存的引用（也支持跟踪本地分支），不自动 fetch；fetch／pull／push 后可刷新查看。远程分支、标签和 Diff 会话不显示该计数。

### 右键菜单

远程 Checkout 先 fetch 所选分支（失败则直接报错，不使用旧引用）。优先使用远程分支的同名本地分支，并更新其跟踪配置；不会改动其他名称的跟踪分支。本地分支若含有远程没有的提交，弹窗显示 **Drop Local Commits**／**Cancel**：前者丢弃这些本地提交、重置到刚 fetch 的远程提交并检出；后者或关闭弹窗则不改动本地分支、不检出。仅落后或已经同步时无需确认。存在未提交的工作区修改时要求先提交或 stash，不会强制丢弃文件修改；其他 worktree 占用目标分支时直接报错。

| 命令                        | 说明                                                   |
| --------------------------- | ------------------------------------------------------ |
| Checkout                    | 本地直接切换；远程先 fetch，再更新或创建同名本地跟踪分支 |
| Create                      | 有指定分支／标签时从它创建；没有则默认当前分支，不切换 |
| Create and Checkout         | 使用相同起点创建新分支，并检出新分支                   |
| Set Tracking                | 设置本地分支的跟踪分支，或选择 No Tracking 取消跟踪    |
| Merge into Current          | 将选中分支合并到当前分支                               |
| Rebase Current onto Target  | 将当前分支变基到选中分支                               |
| Compare with Current        | 比较选中分支与当前 HEAD 的提交快照差异                 |
| Show Diff with Working Tree | 比较选中分支与当前工作区文件（包含未提交修改）         |
| Rename                      | 重命名本地分支（含校验和二次确认）                     |
| Delete                      | 先安全删除；未合并时可确认 Force Delete                |

### 创建与跟踪分支

Create 和 Create and Checkout 共用创建逻辑，自动配置跟踪关系：

- 从远程分支创建：新分支直接跟踪选中的远程分支，例如从 origin/main 创建 topic，跟踪 origin/main。
- 从本地分支创建：继承来源分支的跟踪配置，不是跟踪来源本地分支本身；来源没有跟踪配置时，新分支也不配置跟踪。
- 没有指定来源（命令面板或分组参数）：默认从当前分支创建，继承当前分支的跟踪配置。
- 从标签、commit 或 detached HEAD 创建：这些起点没有跟踪配置，不按名称或相同 hash 猜测；创建后可以使用 Set Tracking。
- 创建使用本地现有引用，不自动 fetch；与远程 Checkout 的先 fetch 行为不同。

本地分支（含当前分支）右键可用 Set Tracking，选择已有本地／远程分支，或 No Tracking 取消跟踪。列表标注当前跟踪对象，排除自身、标签和符号引用；取消选择不修改配置。操作只修改 upstream，不移动提交、不检出、不 push，也不丢弃工作区修改。刷新后悬浮信息和提交差异计数反映新的跟踪关系。

### Compare with Current

- 当前本地分支不显示 Compare；执行命令时也重新核实当前分支，避免旧树节点误操作
- 在 **Editor Tab** 内打开交互式比较界面，不再使用纯文本摘要
- 上下两组提交列表：选中分支独有的提交、当前分支独有的提交，分别显示消息、作者、日期和 hash
- 各列表可按消息／hash／作者／日期筛选已加载提交；每页 200 条，可点击 Load more
- 点击提交，在右侧查看完整提交消息、父提交和变更文件；点击文件在同一编辑器组新开固定（非预览）的左右 Diff Tab，不分屏、不覆盖其他文件的 Diff Tab，比较页保留
- 合并提交的文件变化按第一个父提交比较；根提交的左侧为空
- **Branch file differences** 可切换到两个分支 tip 之间的全部文件差异（支持新增／删除／重命名、中文路径）
- 通过命令面板 `Git Branch: Open Diff` 也可选择分支差异文件
- 每个比较 Tab 固定双方 commit ID；切换旧 Tab 后使用旧快照，不随分支后续移动而改变
- 关闭 Tab 释放结果；插件重载后需重新比较
- 分支整体文件差异的左侧 = 选中分支，右侧 = 比较时的当前分支；单提交 Diff 为父提交 → 该提交
- 工作区未提交的修改不参与比较；不修改仓库，不自动 fetch
- 参考 IDEA 双向历史比较布局，但不包含其完整提交拓扑图、cherry-pick 等操作

### Show Diff with Working Tree

- 本地分支、当前分支和远程分支均可右键使用；不创建或切换 Git worktree
- 文件列表位于 **Branches → Diff → 比较分支**，Diff 与 Local、Remote、Tags 同级，不新增 Source Control 视图或底部面板。执行 Show Diff with Working Tree 自动显示 Branches 并展开对应比较。使用原生紧凑树行，左侧显示文件图标、名称和目录，最右侧像 Changes 一样显示彩色状态标识（M 修改、A 新增、D 删除、R 重命名等），不混入路径文字；状态以选中分支与工作区的比较结果为准
- Diff 分组行右侧有 **⋯（View & Sort）** 按钮，点击在**按钮正下方弹出锚定的原生下拉菜单**（与 Changes 的 ⋯ 溢出菜单同样式，不再是屏幕顶部的快速选择）：View as List / View as Tree、Sort Changes by Name / Path / Status，当前项行首带 ✓，其余项行首用等宽空白占位（figure space），选项文字左对齐。扩展菜单无法使用原生勾选槽，故以等宽文本占位近似对齐。默认列表、按路径排序；选择保存在当前工作区。树形模式按目录展开、目录优先，文件使用所选排序；仅改变展示，不修改 Git 文件。这些选项只在 ⋯ 菜单中，右键菜单不重复
- 没有任何比较时 Diff 分组自动隐藏；打开第一个比较时出现，全部关闭后消失
- 比较会话行显示为 `分支名 ↔ Working Tree`（与 Compare with Current 的对比标题同格式，工作区侧不是分支，直接显示 Working Tree），后面跟差异文件数 `N files`，不显示前置图标。会话行是专门的比较节点，右键不弹出 Checkout／Merge／Rebase／Compare／Rename／Delete 等分支操作；行右侧提供刷新和关闭图标，悬浮分别显示 Refresh Working Tree Diff、Close Working Tree Diff；列表不再放置操作行。支持多个本地／远程分支同时展开差异列表，各分支独立刷新和关闭，不替换其他分支的列表或关闭其他分支的 Diff Tab
- 左侧为选中分支的提交快照，右侧为当前工作区实际文件；已暂存、未暂存和未忽略的新文件都纳入比较
- 已打开且未保存的文件缓冲区也参与列表计算；列表需点击 Refresh 更新
- 点击文件仍在主编辑区打开非预览的原生 Diff Tab，Diff 分组只展示文件列表；右侧使用真实文件 URI，可显示编辑器中未保存的内容；新增／删除文件的缺失侧为空
- Refresh 会重新读取所选分支的 tip 和文件列表；已打开的 Diff 左侧仍保持其原来的提交快照
- 关闭工作区差异列表时，同时关闭该分支本次比较打开的 Diff Tab（含刷新前的快照、其他编辑器组中的标签）；不关闭普通文件、其他分支或 Compare with Current 的标签。未保存修改仍由 VS Code 提示确认，不强制丢弃
- 原 Compare with Current 仍只比较提交历史，两者相互独立
- 不修改 index、不自动 stash、fetch 或保存文件；不支持完整子模块／特殊非文本对象比较

### Rename Branch

- 仅支持本地分支（含当前分支）
- 校验 Git 分支名合法性、重名检测
- 二次确认弹窗，不强制覆盖
- 不修改远程分支

## 安装

```
code --install-extension hkllyx.git-branch-1.0.0.vsix
```

或在 VS Code 中：`Ctrl+Shift+P` → `Install from VSIX...`

覆盖安装后执行 **Developer: Reload Window**。工作区差异已移到 Branches 内的 Diff 分组，旧底部 Branch Diff 面板不再注册；此前打开的比较需要重新执行。

## 要求

- VS Code 1.85+
- Git（需支持 `git switch`、`git rev-parse --end-of-options` 和 `git branch --track=inherit`；本次回归验证版本为 2.47.1.windows.1）
- 依赖内置 `vscode.git` 扩展（用于获取 Git 可执行路径）

## 安全

- 所有 Git 命令通过 `execFile` 执行，无 shell 拼接
- 不在不可信工作区运行
- 删除先使用安全模式（`-d`）；只有未合并拒绝才提供风险弹窗，明确确认 **Force Delete** 后执行 `-D`，取消则保留分支
- 当前分支、其他 worktree 中正在使用的分支和远程分支不会被此流程强制删除
- 重命名不强制覆盖、不操作远程

## 局限

- 使用第一个工作区文件夹作为 Git 仓库根目录
- 二进制文件显示提示文本，不支持图片 diff
- 文本按 UTF-8 显示
- 远程 Checkout 使用同名本地分支；其他名称的跟踪分支不会被自动改动
- 不提供远程分支删除、自动推送、自动 stash 或冲突自动解决
- Merge／Rebase 要求本地分支、干净工作区且没有正在进行的合并／变基；冲突时保留 Git 状态，需手动解决并继续或中止
- Git 命令 30 秒超时，单次输出上限 32 MiB；Git hooks 或超大仓库可能超出限制

## 开发与检查

```powershell
npm test
npm run check
node package-vsix.js
```

无第三方构建依赖。打包脚本使用 Windows PowerShell／.NET ZIP，每次从根目录源码同步生成 `extension/` 和 VSIX，避免打入旧副本。检查范围与未覆盖项见 `AUDIT.md`。
