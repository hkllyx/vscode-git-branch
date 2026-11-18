# Git Branch

在 VS Code 的 Source Control 面板中增加 **Branches** 视图，提供完整的分支管理功能。

## 功能

### Branches 树
- **Local** — 本地分支列表，当前分支以 ⭐ 星标突出显示
- **Remote** — 远程分支，按远程名（origin 等）分组
- **Tags** — 标签列表

每个分支项显示：图标 + 分支名 + 短 hash（7 位）

### 右键菜单
| 命令 | 说明 |
|------|------|
| Checkout | 切换到该分支（远程分支自动创建跟踪分支） |
| Create Branch... | 从 HEAD 创建新分支 |
| Merge into Current | 将选中分支合并到当前分支 |
| Rebase Current onto... | 将当前分支变基到选中分支 |
| Compare with Current | 比较选中分支与当前 HEAD 的提交快照差异 |
| Rename Branch... | 重命名本地分支（含校验和二次确认） |
| Delete Branch | 安全删除本地分支（未合并时拒绝） |

### Compare with Current
- 不依赖任何不存在的命令，直接调用 `git diff` 比较两个提交
- 在 **Branch Comparison** 视图中列出所有差异文件（支持重命名检测、中文路径）
- 点击文件即可打开 VS Code 内置左右 diff 视图
- 左侧 = 选中分支的提交，右侧 = 当前 HEAD 的提交
- 工作区未提交的修改不参与比较

### Rename Branch
- 仅支持本地分支（含当前分支）
- 校验 Git 分支名合法性、重名检测
- 二次确认弹窗，不强制覆盖
- 不修改远程分支

## 安装

```
code --install-extension hkllyx.git-branch-0.1.0.vsix
```

或在 VS Code 中：`Ctrl+Shift+P` → `Install from VSIX...`

## 要求

- VS Code 1.85+
- Git 2.0+（需在 PATH 中可用）
- 依赖内置 `vscode.git` 扩展（用于获取 Git 可执行路径）

## 安全

- 所有 Git 命令通过 `execFile` 执行，无 shell 拼接
- 不在不可信工作区运行
- 删除使用安全模式（`-d`），未合并分支拒绝删除
- 重命名不强制覆盖、不操作远程

## 局限

- 使用第一个工作区文件夹作为 Git 仓库根目录
- 二进制文件显示提示文本，不支持图片 diff
- 文本按 UTF-8 显示
- Git 命令 30 秒超时，单次输出上限 32 MiB
