# Git Branch 全功能检查报告

## 2026-11-18：1.0.0 交互式比较增量检查

- 当前本地分支不显示 Compare；命令执行时重新核实仓库当前分支，旧节点也不能比较自己。
- 原只读摘要文档替换为独立 Webview Editor Tab，上下两组双向独有提交、右侧文件与详情、筛选、分页和分支整体文件差异。
- 新增真实仓库测试：双向分叉、已合并／相同 tip、根提交空侧、合并提交第一父提交、重命名、中文作者／路径、完整提交消息和固定快照。
- 新增模拟 UI／API 测试：CSP 与 HTML 转义、点击提交／文件、筛选、模式切换、分页参数、非法消息拒绝、不同 Tab 隔离和关闭清理。
- 本次 13/13 测试组通过；未在真实 VS Code 扩展宿主中逐项点击验证主题和布局。模拟 DOM 不是浏览器视觉验收。
- 历史比较仅读取本地已知提交，不自动 fetch，不提供完整拓扑图和 cherry-pick。合并提交按第一父提交展示变更。

以下为旧版 0.1.1 的历史检查记录，其中纯文本 Compare 的说明已被上述实现替代。

日期：2026-11-18　版本：0.1.1　作者：hkllyx

## 结论

完成源码审查、真实临时 Git 仓库测试、模拟 VS Code 命令层测试、打包内容比对和真实 VS Code CLI 隔离安装验证。9 个测试组全部通过。发现并修复了 Compare 缓存／跨 Tab 结果混用、短引用歧义、重复远程 Checkout、分支名重名校验以及旧源码打包风险。

这不是“所有环境均正确”的保证：未在真实 VS Code 扩展宿主中逐项点击验证，没有覆盖多仓库、所有 Git 版本、所有 hooks 和超大文件。

## 各功能检查

| 功能 | 检查内容 | 结果 |
| --- | --- | --- |
| Branches | Local／Remote／Tags；当前分支星标；短 hash；隐藏 origin/HEAD 符号引用；packed refs；中文名 | 通过 |
| Checkout | 实际树节点 ref；本地分支；远程创建 tracking；重复复用 tracking；同名非 tracking 分支不覆盖；多个 tracking 分支拒绝自动选择 | 通过 |
| Create Branch | 右键本地／远程／标签起点；标题栏 HEAD；同名 tag 与 branch 不歧义；创建不切换当前分支；非法名称、重名、取消 | 通过 |
| Merge | 完整引用；确认与取消；真实合并；脏工作区保护；冲突保留 Git 状态；已有 merge／rebase 拒绝继续发起 | 通过 |
| Rebase | 完整引用；确认与取消；真实重放提交；脏工作区保护；冲突及 abort 恢复；Detached HEAD 保护 | 通过 |
| Compare | 完整 commit 快照；新增／删除／修改／重命名；中文／特殊路径；未提交修改不参与；无差异；重复比较产生新文档；不同 Tab 相互隔离 | 通过 |
| Open Diff | 使用活动 Compare Tab 的结果；QuickPick 取消；左右 snapshot hash 与空侧；UTF-8 内容；二进制提示 | 通过 |
| Rename | 实际数据节点无 contextValue；本地／当前分支；远程／标签／分类不允许；重复与非法名保护 | 通过 |
| Delete | 实际数据节点；安全删除；确认与取消；当前分支拒绝；未合并拒绝；远程／标签不受影响 | 通过 |
| Refresh／生命周期 | 手动事件；实际 Git 目录及 common directory watcher；覆盖 packed-refs；关闭 Compare 释放结果；disposable 清理 | 模拟 API 测试通过；实际 watcher 触发时序未做 UI 验证 |
| 打包 | 从根目录权威源码自动同步；清单版本一致；ZIP 文件内容逐项比对；不再依赖手动复制旧 staging 文件 | 通过 |
| 安装 | 使用独立 user-data-dir 与 extensions-dir 安装，不改用户现有配置 | 通过，列表显示 hkllyx.git-branch@0.1.1 |

## 修复说明

1. Compare 结果按文档独立保存，URI 包含序号和双方 commit ID，消除同分支重复比较的旧缓存。
2. Open Diff 优先选择活动 Compare 文档，而不是全局最后一次比较。
3. Create／Merge／Rebase 使用 refs/heads、refs/remotes、refs/tags 完整引用；标签名称与分支名称可以相同而不误选。
4. 远程 Checkout 先寻找对应本地 upstream，存在时复用；多匹配时要求用户自行选择，不覆盖不相关本地分支。
5. 名称重名校验使用完整 refs/heads 引用，避免 Git 缩短引用受同名 tag 影响。
6. 激活时先获取 VS Code 配置的 Git 路径；watcher 解析真实 Git 目录，兼容 worktree 的 .git 文件及 packed refs。
7. Merge 输出中的冲突信息可能写到 stdout，现在也纳入错误提示；不自动 abort 或覆盖工作区。
8. 打包脚本从根目录源码构建，自动刷新副本；修正 Windows PowerShell 对 ZIP 程序集的显式加载。
9. 文档修正 Create 起点、Git 能力要求和 Compare Tab 的生命周期。

## 验证环境与命令

- Windows，内置 Node v22.23.2，Git 2.47.1.windows.1。
- VS Code CLI 1.146.0，x64。
- `node --check src/extension.js`、`node --check src/git-operations.js`、`node --check package-vsix.js`。
- `node --test test/*.test.js`：9/9 测试组通过。
- `node package-vsix.js`；ZIP 中 package.json、README 和两份运行源码与根目录逐项一致。
- `code --user-data-dir <隔离路径> --extensions-dir <隔离路径> --install-extension hkllyx.git-branch-0.1.1.vsix` 安装成功。

## 残留限制与人工验收

- 仍只面向第一个工作区文件夹中的仓库，不实现多仓库切换或嵌套仓库发现。
- 无仓库／无首个提交时，创建和比较无法完成，显示 Git 错误；不自动创建仓库或首个提交。
- 文本按 UTF-8 解码；二进制不做可视化 diff，Git submodule／特殊非文本对象未专门支持。
- Compare 是只读摘要 Tab，通过命令面板 Open Diff 查看单文件，不是可点击文件列表的 Webview。
- 插件重载后旧 Compare 文档需要重新比较；文档关闭释放结果。
- 命令时限 30 秒、输出限制 32 MiB；耗时 hooks／大型仓库可能失败，需检查 Git 状态。没有进行压力测试。
- 真实鼠标右键菜单、主题、编辑器布局、实际文件系统事件与远程开发环境尚需人工验收。
- 人工建议顺序：切换本地分支 → 从指定非当前分支创建 → 对比两次并切换旧 Tab 打开 diff → rename → safe delete → merge／rebase（仅测试仓库）。
