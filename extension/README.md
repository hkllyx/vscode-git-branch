# Git Branch

在 VS Code 的 Source Control 面板中增加 **Branches** 视图，提供完整的分支管理功能。

## 功能

### Branches 树

- **Local** — 本地分支列表，当前分支以 ⭐ 星标突出显示
- **Remote** — 远程分支，按远程名（origin 等）分组
- **Tags** — 标签列表

每个分支项显示：图标 + 分支名 + 短 hash（7 位）

### 右键菜单

| 命令                   | 说明                                     |
| ---------------------- | ---------------------------------------- |
| Checkout               | 切换到该分支（远程分支自动创建跟踪分支） |
| Create Branch...       | 有指定分支／标签时从它创建；没有则默认当前分支 |
| Merge into Current     | 将选中分支合并到当前分支                 |
| Rebase Current onto... | 将当前分支变基到选中分支                 |
| Compare with Current   | 比较选中分支与当前 HEAD 的提交快照差异   |
| Rename Branch...       | 重命名本地分支（含校验和二次确认）       |
| Delete Branch          | 先安全删除；未合并时可确认 Force Delete |

### Compare with Current

- 不依赖任何不存在的命令，直接调用 `git diff` 比较两个提交
- 结果直接在 **Editor Tab** 中打开，列出所有差异文件（支持重命名检测、中文路径）
- 通过命令面板 `Git Branch: Open Diff` 可选择文件打开 VS Code 内置左右 diff 视图
- 每次比较打开独立、固定提交快照的 Tab，重复比较不会复用旧内容
- 在某个 Compare Tab 中执行 Open Diff 时，使用该 Tab 对应的结果，不会串到其他比较
- 关闭 Compare 文档会释放其结果；插件重载后需要重新执行比较
- 左侧 = 选中分支的提交，右侧 = 当前 HEAD 的提交
- 工作区未提交的修改不参与比较

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
