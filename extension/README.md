# Git Branch

在 VS Code 的 Source Control 面板中增加 **Branches** 视图，提供完整的分支管理功能。

## 功能

### Branches 树

- **Local** — 本地分支列表，当前分支以 ⭐ 星标突出显示
- **Remote** — 远程分支，按远程名（origin 等）分组
- **Tags** — 标签列表

每个分支／标签项只显示图标和名称，不在名称后显示 hash。
悬浮提示显示名称、完整 hash、最后提交时间（含时区偏移）和追踪分支；未配置追踪时明确标注。远程分支／标签的追踪项显示不适用，附注标签的 hash 和时间取其对应提交。

### 右键菜单

| 命令                        | 说明                                                   |
| --------------------------- | ------------------------------------------------------ |
| Checkout                    | 切换到该分支（远程分支自动创建跟踪分支）               |
| Create                      | 有指定分支／标签时从它创建；没有则默认当前分支，不切换 |
| Create and Checkout         | 使用相同起点创建新分支，并检出新分支                   |
| Merge into Current          | 将选中分支合并到当前分支                               |
| Rebase Current onto Target  | 将当前分支变基到选中分支                               |
| Compare with Current        | 比较选中分支与当前 HEAD 的提交快照差异                 |
| Show Diff with Working Tree | 比较选中分支与当前工作区文件（包含未提交修改）         |
| Rename                      | 重命名本地分支（含校验和二次确认）                     |
| Delete                      | 先安全删除；未合并时可确认 Force Delete                |

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
- 直接在左侧 **Branches** 栏展开选中分支的差异文件列表，不再打开文件列表 Editor Tab；使用原生紧凑树行，左侧显示文件图标、名称和目录，最右侧像 Changes 一样显示彩色状态标识（M 修改、A 新增、D 删除、R 重命名等），不混入路径文字；状态以选中分支与工作区的比较结果为准
- 正在比较的分支名后显示 `Working Tree Diff · N files`，明确这是与工作区比较的差异文件数量；分支行右侧提供刷新和关闭图标，悬浮分别显示 Refresh Working Tree Diff、Close Working Tree Diff；列表不再放置操作行。支持多个本地／远程分支同时展开差异列表，各分支独立刷新和关闭，不替换其他分支的列表或关闭其他分支的 Diff Tab
- 左侧为选中分支的提交快照，右侧为当前工作区实际文件；已暂存、未暂存和未忽略的新文件都纳入比较
- 已打开且未保存的文件缓冲区也参与列表计算；列表需点击 Refresh 更新
- 点击文件打开非预览 Diff Tab，右侧使用真实文件 URI，可显示编辑器中未保存的内容；新增／删除文件的缺失侧为空
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

## 要求

- VS Code 1.85+
- Git（需支持 `git switch` 和 `git rev-parse --end-of-options`；本次回归验证版本为 2.47.1.windows.1）
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
- 已存在本地跟踪分支时，远程 Checkout 会复用；多个本地分支跟踪同一远程时要求在 Local 中自行选择
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
