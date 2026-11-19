# Git Branch

在 VS Code 的 Source Control 面板中增加 **Branches** 视图，提供完整的分支管理功能。

## 功能

### Branches 树

- **Local** — 本地分支均用分支图标，当前检出分支的同款图标高亮为主题黄色；名称保持普通颜色，不加 `*` 或整段高亮。默认主分支不再单独用星星／标签图标
- **Remote** — 远程分支，按远程名（origin 等）分组
- **Tags** — 标签列表
- **Comparisons** — 文件与提交比较统一分组，Diff 和 Compare 按首次打开的先后顺序混排，先打开的在前；刷新、重复打开现有比较或交换方向不改变位置，关闭后重新打开排到末尾。比较名后显示 `N files` 或 `N commits`（数量为 1 时用单数），项目名称与描述之间不加 `·`，独立展开，没有会话时隐藏。只合并外层，不添加 Files／Commits 中间层

本地／远程分支统一用 `git-branch` 图标；Tag 用普通、不高亮的 `tag` 标签图标；文件 Diff 比较项用 16px「文本行＋双向箭头」SVG 图标，提交历史 Branch Compare 项用 `git-compare`，不展开也可区分两种比较；提交用 `git-commit`。父级分组与子项采用同类图形、细节区分：Local 用 `repo`；Remote 分组用叠放云朵，origin 等远程名用原生 `cloud` 单云朵；Tags 分组用叠放标签，标签项用 `tag` 单标签；Comparisons 分组用「两侧面板＋双向箭头」，突出对比含义。自定义 SVG 均为 16px 无底色线条，提供浅色／深色主题版本；其余使用原生 ThemeIcon。文件／目录保留原有图标和状态标识。只高亮当前分支图标，不高亮名称。保留展开箭头及右侧按钮，分支／标签名后不显示 hash。
当前分支由本地 HEAD 判断；detached HEAD 不标记当前分支。默认主分支不再使用独立的星星或组合标记。
Branches 标题栏只保留刷新和折叠全部（Collapse All），不再显示创建按钮和「…」更多菜单；Create / Create and Checkout 通过分支右键或命令面板使用。
分支悬浮提示显示名称、最后提交和追踪分支；Last commit 同一行显示 `提交人 · 提交时间 · 7 位短 hash`，时间含时区偏移，短 hash 后显示复制图标，点击仅复制短 hash，不单独显示 Hash 行。本地分支未配置追踪时明确标注，远程分支／标签不显示 Tracking branch 行。标签保持显示完整 hash 和时间，附注标签的 hash 和时间取其对应提交。不再显示 Current branch／Default branch；Tracking status 仅显示 ahead／behind 数量，不重复跟踪分支名和说明。分支、标签与 Diff 会话使用原生 Markdown 悬浮框，各字段紧凑换行，不使用段落间距。分支名称和已配置的跟踪分支名称行尾也显示复制图标，各自只复制对应分支名，不复制字段标签或整段信息；不适用／未配置的跟踪项不显示复制图标，也没有底部 Copy 行。带复制链接的悬浮框支持鼠标移入；仓库文字经过转义，仅授权内部复制命令，不使用 WebView。
本地分支名后显示与其配置的跟踪分支之间的提交差异，例如 `1↓ 2↑` 表示落后 1 个、领先 2 个提交，使用普通描述文字，不加颜色。仅显示非零方向；同步、无跟踪配置时隐藏数字。跟踪引用在本地缺失时不伪装为同步，悬浮提示计数不可用。计算依据本地保存的引用（也支持跟踪本地分支），不自动 fetch；fetch／pull／push 后可刷新查看。远程分支、标签和 Diff 会话不显示该计数。

### 右键菜单

远程 Checkout 先 fetch 所选分支（失败则直接报错，不使用旧引用）。优先使用远程分支的同名本地分支，并更新其跟踪配置；不会改动其他名称的跟踪分支。本地分支若含有远程没有的提交，弹窗显示 **Drop Local Commits**／**Cancel**：前者丢弃这些本地提交、重置到刚 fetch 的远程提交并检出；后者或关闭弹窗则不改动本地分支、不检出。仅落后或已经同步时无需确认。存在未提交的工作区修改时要求先提交或 stash，不会强制丢弃文件修改；其他 worktree 占用目标分支时直接报错。

| 命令                        | 说明                                                   |
| --------------------------- | ------------------------------------------------------ |
| Update (Fetch & Pull)       | 单选／多选更新：本地按跟踪分支 Fetch 后仅快进，远程分支仅 Fetch |
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

### Compare / 双分支 Show Diff

- Compare 结果在 **Branches → Comparisons** 原生树中显示，不打开 WebView；与文件比较共用外层分组，各会话独立。
- 默认方案 A：每个会话下有 `Left only`、`Right only` 两组，描述显示 `N commits`，名称与描述之间不加分隔点，分别显示左／右独有提交；悬浮显示完整来源分支名和数量。共同提交不显示，独有提交为零的一侧不显示；两侧均为零时仅显示 `No differences`，与文件比较一致。两组用主题绿色／主题修改色分支图标辅助区分，不依赖颜色辨认。来源行保留短名称，避免长分支名挤占提交数量。
- 提交行用 Commit 图标，右侧简要信息为 `提交人 · 提交时间`（保持 ISO 时间及原时区），不显示短 hash。原生悬浮依次显示：提交人及时间、完整 Commit 消息（保留正文换行）、`N files changed, X insertions(+), Y deletions(-)`、普通文本短 hash 及其后方的复制图标。行距与分支悬浮一致，Commit 消息前后各保留一行空白，统计与 hash 紧凑换行，不使用 Markdown 段落外边距。点击复制图标仅复制短 hash；仓库文字经过 Markdown 转义，仅授权内部复制命令。悬浮及展开文件共享按需加载的详情缓存；失败明确显示详情不可用，不伪造统计。
- 展开提交按需读取文件列表，文件后显示 M／A／D／R 等状态；点击打开固定（非预览）的原生文件 Diff Tab。
- 单提交文件 Diff 固定为 **第一个父提交 → 当前提交**；根提交缺失侧为空。交换比较分支只交换来源分组、两侧历史和会话标签，不反转提交自身的变更含义，已打开的单提交 Tab 也保持父 → 提交。
- 每侧初始加载最多 200 个提交，更多时显示 Load more commits；展开文件时才读取提交详情。
- 会话后依次为 **刷新 → 关闭 → ⋯**；交换和 View／Sort 收进 ⋯ 锚定原生菜单。刷新保留方向及会话设置。关闭同时关闭该会话打开的提交 Diff Tab，包括刷新前的快照，不影响其他会话或普通文件。
- Compare 的 View／Sort 仅调整每个提交展开的文件列表／目录树及文件排序，不改变两侧分组或提交历史顺序；每个会话独立设置。
- 单选 Compare with Current 比较所选分支与当前 HEAD；当前本地分支不显示该项，执行时重新核实，避免旧树节点误操作。
- 使用 Ctrl／Shift 选择恰好两个 Local／Remote 分支（可混合选择），右键提供 **Compare** 和 **Show Diff**；当前分支允许参与双选比较。分组、标签和比较会话不能混入分支选择。
- 双选 Compare 比较两侧独有提交；双选 Show Diff 比较两分支 tip 之间的全部文件差异，并显示在 **Branches → Comparisons**，不是与 Working Tree 比较。会话名称明确显示左右；初始方向取视图传入的选择列表顺序，不承诺 Ctrl 点击先后，可用 ⋯ 中的交换调整。
- 双分支 Show Diff 复用 Diff 的文件排序、目录模式、刷新、交换和关闭逻辑；交换同时反转 A／D、重命名路径及已打开原生 Diff Tab 的左右内容。工作区比较与双分支比较会话可同时存在，互不覆盖。
- 每次结果固定双方 commit ID；已打开文件 Tab 不随后续分支移动或刷新改变快照。
- 命令面板 Git Branch: Open Diff 可选择最近一次 Compare 的分支 tip 文件差异。
- 比较只读，不自动 fetch，不修改 index 或工作区；插件重载后需重新比较。

### Update (Fetch & Pull)

- 支持单选和多选 Local／Remote 分支。多选菜单只保留 Delete、Update；恰好两个分支时再显示 Compare、Show Diff。Rename、Checkout、Create、Merge、Rebase、Set Tracking 等只在单选时显示。Delete 仍仅支持本地分支，当前分支不可删除。
- 本地分支按当前配置的跟踪分支 Fetch，再进行 **fast-forward only** 更新；同步或仅本地领先时保留现状，双方分叉时报告失败，不自动合并／变基、reset 或丢弃提交。
- 当前分支更新前检查磁盘未提交修改、未保存编辑器内容及正在进行的 merge／rebase；有风险时拒绝更新。Fetch 可能已经刷新远程跟踪引用，但不会丢弃本地文件。
- 未检出的本地分支只更新引用，不切换当前分支、不修改当前工作区或 index；其他 worktree 正检出的目标分支由 Git 拒绝更新。跟踪本地分支时不联网，仍只允许快进。
- Remote 分支执行 Fetch，只刷新该远程跟踪引用，不创建、切换或覆盖同名本地分支。
- 没有配置跟踪分支、Fetch 失败或无法快进时，该分支独立失败，后续分支继续；最后汇总成功／失败数量，Details 展示逐分支结果。不允许重复启动并行 Update。

### 多选删除与 F2

- 在 Branches 中只选中一个 Local 分支（含当前分支），按 F2 执行重命名；使用 `focusedView` 限定实际获得焦点的 Branches 列表，输入框聚焦时不触发，不影响文件资源管理器。
- Ctrl／Shift 多选本地分支后 Delete：统一确认待删除列表，内部逐个循环删除。每个分支独立成功、失败或跳过，不阻断后续分支。
- 先安全删除；未合并分支分别询问 Force Delete，取消仅跳过该分支。确认期间提交发生变化时拒绝强制删除，要求重新检查。
- 当前分支跳过；其他 worktree 正使用的分支由 Git 拒绝，不强制删除。选择包含远程分支或非分支节点时拒绝整次删除。
- 最后显示成功／失败／跳过数量，点击 Details 查看各分支结果。

### Show Diff with Working Tree

- 本地分支、当前分支和远程分支均可右键使用；不创建或切换 Git worktree
- 文件列表位于 **Branches → Comparisons → 比较项**，Comparisons 与 Local、Remote、Tags 同级，不新增 Source Control 视图或底部面板。执行比较自动显示 Branches 并展开对应会话。原生紧凑树显示文件图标、名称和目录，最右侧像 Changes 一样显示彩色 M／A／D／R 状态。
- 分组行没有按钮；每个比较项后依次显示 **刷新 → 关闭 → ⋯（More Actions）**。⋯ 在按钮处弹出原生锚定菜单：Swap Comparison；View as List／View as Tree；Sort by Name／Path／Status，三组以分隔线区分，不添加 View & Sort 中间层，也不在右键重复展示。
- 当前选项用行首 `✓ `，对勾当作标题文本的一部分；所有菜单标题直接左对齐，未选中项不加占位空格。扩展菜单不能使用内置勾选槽，仍受原生菜单边距限制。默认列表、按路径排序；每个 Files／Commits 会话独立保存设置到工作区，刷新、交换、关闭后重新比较保留设置。只调整文件展示，不修改 Git。Diff／Compare 关闭按钮使用居中的小号细线叉号，保持原生按钮点击区域及悬浮提示。
- 没有任何文件或提交比较时 Comparisons 自动隐藏；最后一个会话关闭后消失。
- 会话默认显示 `分支名 ↔ Working Tree · N files`，交换后显示 `Working Tree ↔ 分支名 · N files`，数量为 1 时用 `1 file`，前置对比图标。会话不是分支节点，右键不弹出分支操作。支持多个工作区／双分支文件比较及提交比较同时存在，各会话独立刷新、关闭及设置。
- 默认左侧为选中分支的提交快照，右侧为当前工作区实际文件；交换后左右反转。已暂存、未暂存和未忽略的新文件都纳入比较。Diff 会话悬浮显示 Left、Right 和 `N files changed, X insertions(+), Y deletions(-)`，随方向更新；交换时增删行数量互换。不展示分支 hash、提交时间或跟踪配置；分支侧名称保留复制图标。Working Tree 不是当前分支的提交快照。
- 双分支及 Commit 增删行由 Git numstat 计算；Working Tree 统计针对列表中的同一组文件快照，包含未跟踪文件及未保存文本，使用系统临时目录中的只读比较，不修改仓库 index 或工作区。临时快照比较不套用仓库路径的自定义 diff driver／属性；大文件或大量文件会增加刷新开销。二进制文件计入文件总数，另行提示行数不可用，不按零行伪装成文本统计。
- Swap Comparison 完整交换会话名称、悬浮左右信息、文件列表与目录路径、状态（A／D 互换、M 不变、重命名来源／目标互换）及原生文件 Diff 的左右内容，差异文件总数不变；再次交换恢复原方向，刷新后保留方向。已打开的该会话 Diff Tab 也会在原编辑器组重新打开为反向内容，保留各 Tab 原有的分支提交快照，不影响其他会话或普通文件。交换会等待正在打开的 Tab；关闭旧 Tab 时仍由 VS Code 提示未保存修改，取消则不提交方向变化。编辑器打开失败时尝试恢复旧 Tab，并明确报错；恢复失败也不会静默忽略。
- 已打开且未保存的文件缓冲区也参与列表计算；列表需点击 Refresh 更新
- 点击文件仍在主编辑区打开非预览的原生 Diff Tab，Comparisons 只展示比较树；工作区侧使用真实文件 URI，可显示编辑器中未保存的内容；新增／删除文件的缺失侧为空。交换后工作区在左侧时按原生 Diff 原始侧的只读行为查看，不强制保存或丢弃文件。
- Refresh 会重新读取所选分支的 tip 和文件列表，保留会话方向；已打开的 Diff 分支侧仍保持其原来的提交快照
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

覆盖安装后执行 **Developer: Reload Window**。文件与提交比较统一放入 Branches 的 Comparisons 分组，旧底部面板不再注册；此前打开的比较需要重新执行。

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
