# Branches 右键菜单（合并清单）

> 版本 1.0.0　整理日期 2026-11-20　作者 hkllyx

每个节点一张表，**已有菜单和建议菜单合并在一起**，按真实显示顺序排列（先 group 字典序，再 @order）。

- `状态`：`已有` 现在已经能用；`新增` 建议增加；`待定` 需要你先定规则；`已有(行内)` 现在只在右侧图标按钮里；`已有(标题栏)` 现在在视图标题栏。
- `行内`：右侧悬浮图标按钮。`建议` 是我推荐加的，`—` 表示不放在行内。图标全部用 VS Code 内置 Codicon，不写自定义 SVG。
- `决策点`：指向文末决策表，`—` 表示无争议。
- `选择`：你填 `要` / `不要` / `改名：xxx` 即可；空白按「建议」执行。

## 本轮调整（2026-11-20）

1. **删除分组里的 Refresh**：`Local` / `Remote` / 远程名分组（origin 等）不再提供 Refresh。分组刷新改为由根节点统一触发。
2. **「重绘」放到根节点 Branches**：树重绘（重新 `for-each-ref` 读本地 ref，不 fetch、不联网、不动工作区）作为根节点菜单项。
3. **根节点 Branches 新增右键菜单**：见第 0 节。
4. `Comparisons` 分组的 `Refresh All` **保留**，语义是重算所有对比会话（纯本地重算），不是树重绘。
5. **新增 `行内` 列**，见第 19 节汇总与规则。
6. **提交节点的 contextValue 由 `gb-compare-commit` 改为 `gb-commit`**（第 10 节）。理由：分支历史和 Compare 共用该节点，名字里带 `compare-` 会误导；`kind: 'compare-commit'` 是内部实现，保持不变。此改动已在 `src/extension.js:301` 落地。

> 实现前提：现在 `getRootNodes()` 返回的是 `[Local, Remote, Tags, Comparisons]` **数组**，没有「Branches 根」这一层 TreeItem，VS Code 无法给数组弹菜单。要支持根节点右键，必须新增真实顶层节点 `kind: 'root'` / `contextValue: 'gb-root'`，把现有四个分组挂到它下面。影响：树层级多一层，`test/*.test.js` 里 `roots[0].children`、`roots.map(r => r.label)` 等断言需同步改为 `roots[0].children[0]…`。详见 D16。

## 分组顺序约定

| group         | 含义                                              | 位置   |
| ------------- | ------------------------------------------------- | ------ |
| `0_open`    | 打开/跳转：Open on Remote、Open File              | 最上   |
| `1_actions` | 日常动作：Refresh、Checkout、Create、Update、Push | 第二段 |
| `2_merge`   | 合并类：Merge、Rebase、Cherry-Pick、Revert、Reset | 第三段 |
| `3_compare` | 比较类：Compare、Show Diff                        | 第四段 |
| `4_branch`  | 维护类：Tracking、Rename、Delete、Sort            | 第五段 |
| `5_copy`    | 复制子菜单                                        | 最后   |

---

## 0. 根节点 `Branches` `gb-root`

> 新增顶层节点后才有这一节。节点 label 建议用仓库文件夹名（如 `mcsp-fulfillment-center-main`），与 VS Code 内置 Git 视图一致；若你希望固定显示 `Branches`，在「选择」列写 `label：Branches`。
>
> 该节点默认展开，展开后依次是 `Local` / `Remote` / `Tags` / `Comparisons`。

| 顺序        | 菜单项                                    | 出现条件   | 状态         | 行内                               | 决策点 | 选择 |
| ----------- | ----------------------------------------- | ---------- | ------------ | ---------------------------------- | ------ | ---- |
| 0_open@1    | Open Repository on Remote                 | 有远程     | 新增         | —                                 | D11    | 要   |
| 1_actions@1 | Refresh（重绘树）                         | 根节点右键 | 已有(标题栏) | 建议：`refresh`                    | D16    | 要   |
| 1_actions@2 | Create                                    | 根节点右键 | 新增         | 建议：`add`                        | D7     | 不要 |
| 1_actions@3 | Update All                                | 根节点右键 | 新增         | —                                 | D4     | 不要 |
| 1_actions@4 | Fetch All                                 | 根节点右键 | 新增         | 建议：`cloud-download`             | D4、D5 | 要   |
| 1_actions@5 | Expand All / Collapse All                 | 根节点右键 | 新增         | —                                 | —     |      |
| 5_copy      | Copy ▸ Repository Name / Repository Path | 根节点右键 | 新增         | —                                 | D10    | 要   |

说明：

- `Refresh` 复用现有 `git-branch.refresh` 命令（`branchTree.refresh()`），行为不变：只重读 `refs/heads`、`refs/remotes`、`refs/tags`、`HEAD`，**不发网络请求**。要拉远程请用 `Update` / `Fetch All`。
- 根节点折叠时看不见分组，标题栏 `Refresh` 建议保留（见 D16），根节点行内再加一个，两者同源同命令。
- 根节点只有 3 个以内行内按钮，`Refresh`、`Fetch All` 就够；`Create` 已被你标为不要，行内也不放。

---

## 1. Local 分组

> 现在 `Local` / `Remote` / `Tags` 共用 `contextValue = gb-category`，要分开配菜单需先拆成 `gb-category-local`、`gb-category-remote`、`gb-category-tags`。
>
> 分组不再有 Refresh（重绘已上移到根节点，见第 0 节）。

| 顺序        | 菜单项                     | 出现条件 | 状态 | 行内 | 决策点 | 选择                     |
| ----------- | -------------------------- | -------- | ---- | ---- | ------ | ------------------------ |
| 1_actions@1 | Create                     | 分组右键 | 新增 | —   | D7     | 要，创建的时候选创建来源 |
| 1_actions@2 | Update All                 | 分组右键 | 新增 | —   | D4     | 要                       |
| 1_actions@3 | Expand All / Collapse All  | 分组右键 | 新增 | —   | —     |                          |
| 4_branch@1  | Sort ▸ Name / Last Commit | 分组右键 | 新增 | —   | D13    | 要                       |
| 5_copy      | Copy Branch List（多行）   | 分组右键 | 新增 | —   | —     |                          |

> 你选的「创建的时候选创建来源」→ D7 取 B：Create 弹 QuickPick 选起点（当前分支 / 指定本地分支 / 远程分支 / 标签），不再默认静默用 HEAD。

## 2. Remote 分组

| 顺序        | 菜单项                    | 出现条件 | 状态 | 行内 | 决策点 | 选择 |
| ----------- | ------------------------- | -------- | ---- | ---- | ------ | ---- |
| 1_actions@1 | Fetch All                 | 分组右键 | 新增 | —   | D4、D5 | 要   |
| 1_actions@2 | Expand All / Collapse All | 分组右键 | 新增 | —   | —     |      |
| 4_branch@1  | Sort ▸ Name              | 分组右键 | 新增 | —   | D13    | 要   |
| 5_copy      | Copy Branch List（多行）  | 分组右键 | 新增 | —   | —     |      |

## 3. Tags 分组

> Tags 也没有 `Refresh`（重绘已上移到根节点）。`Fetch Tags` 是网络操作，不等于重绘。

| 顺序        | 菜单项                    | 出现条件 | 状态 | 行内 | 决策点 | 选择                       |
| ----------- | ------------------------- | -------- | ---- | ---- | ------ | -------------------------- |
| 1_actions@1 | Create Tag                | 分组右键 | 新增 | —   | —     | 要，创建的时候选中创建来源 |
| 1_actions@2 | Fetch Tags                | 分组右键 | 新增 | —   | —     |                            |
| 1_actions@3 | Expand All / Collapse All | 分组右键 | 新增 | —   | —     |                            |
| 4_branch@1  | Push All Tags             | 分组右键 | 待定 | —   | D4     | 要                         |
| 4_branch@2  | Sort ▸ Name / Date       | 分组右键 | 新增 | —   | D13    | 要                         |
| 5_copy      | Copy Tag List（多行）     | 分组右键 | 新增 | —   | —     |                            |

> `Create Tag` 的「创建来源」与 Local 的 Create 同规则：弹 QuickPick 选提交，默认 HEAD。

## 4. Comparisons 分组

> 这里的 `Refresh All` **保留**：它是重算对比会话（`git-branch.refreshCompare` 系列逻辑，纯本地重读），不是树重绘，与根节点 Refresh 语义不同。

| 顺序        | 菜单项                       | 出现条件 | 状态 | 行内 | 决策点 | 选择 |
| ----------- | ---------------------------- | -------- | ---- | ---- | ------ | ---- |
| 1_actions@1 | Refresh All                  | 分组右键 | 新增 | —   | —     |      |
| 1_actions@2 | Close All（同时关 Diff Tab） | 分组右键 | 新增 | —   | —     |      |
| 1_actions@3 | Expand All / Collapse All    | 分组右键 | 新增 | —   | —     |      |
| 4_branch@1  | Sort ▸ Opened Order / Name  | 分组右键 | 新增 | —   | D13    | 要   |

## 5. 远程名分组（origin 等）

> 该分组也不再有 `Refresh`。`Fetch` 是拉远程，`Prune` 是清理远程已删分支的引用。

| 顺序        | 菜单项                 | 出现条件              | 状态 | 行内 | 决策点 | 选择 |
| ----------- | ---------------------- | --------------------- | ---- | ---- | ------ | ---- |
| 0_open@1    | Open Remote in Browser | 该远程含 http/ssh URL | 新增 | —   | D11    | 要   |
| 1_actions@1 | Fetch                  | 分组右键              | 新增 | —   | —     |      |
| 1_actions@2 | Prune Deleted Branches | 分组右键              | 新增 | —   | D5     | 要   |
| 4_branch@1  | Remove Remote          | 分组右键              | 待定 | —   | D14    | 要   |
| 5_copy      | Copy Remote URL        | 分组右键              | 新增 | —   | —     |      |

---

## 6. 本地分支 `gb-local`

| 顺序        | 菜单项                                            | 出现条件         | 状态 | 行内                       | 决策点 | 选择 |
| ----------- | ------------------------------------------------- | ---------------- | ---- | -------------------------- | ------ | ---- |
| 0_open@1    | Open on Remote                                    | 有 origin 等远程 | 新增 | —                         | D11    | 要   |
| 1_actions@1 | Checkout                                          | 单选             | 已有 | —                         | —     |      |
| 1_actions@2 | Create                                            | 单选             | 已有 | 建议：`add`               | —     |      |
| 1_actions@3 | Create and Checkout                               | 单选             | 已有 | —                         | —     |      |
| 1_actions@4 | Update                                            | 单选 / 多选      | 已有 | 建议：`sync`              | —     |      |
| 1_actions@5 | Push                                              | 单选             | 已有 | 建议：`cloud-upload`      | —     |      |
| 1_actions@6 | Pull (Fast-Forward Only)                          | 有 upstream      | 待定 | —                         | D6     | 要   |
| 2_merge@1   | Merge into Current                                | 单选             | 已有 | —                         | —     |      |
| 2_merge@2   | Rebase Current onto Target                        | 单选             | 已有 | —                         | —     |      |
| 2_merge@3   | Rebase This onto Current                          | 单选             | 新增 | —                         | —     |      |
| 2_merge@4   | Cherry-Pick Tip to Current                        | 单选             | 新增 | —                         | —     |      |
| 3_compare@0 | Compare with Upstream                             | 有 upstream      | 新增 | —                         | —     |      |
| 3_compare@1 | Compare with Current                              | 单选             | 已有 | —                         | —     |      |
| 3_compare@2 | Show Diff with Working Tree                       | 单选             | 已有 | 建议：`diff`              | —     |      |
| 3_compare@3 | Show Incoming Changes                             | 有 upstream      | 新增 | —                         | —     |      |
| 4_branch@0  | Set Tracking                                      | 单选             | 已有 | —                         | —     |      |
| 4_branch@1  | Rename                                            | 单选，F2 同效    | 已有 | —                         | —     |      |
| 4_branch@2  | Delete                                            | 单选             | 已有 | 建议：`trash`             | —     |      |
| 4_branch@3  | Delete Remote Branch                              | upstream 为远程  | 新增 | —                         | —     |      |
| 4_branch@4  | Force Push (with Lease)                           | 有 upstream      | 待定 | —                         | —     |      |
| 5_copy      | Copy ▸ Branch Name / Full Ref / Last Commit Hash | 单选             | 新增 | —                         | D10    | 要   |

> 行内最多 5 个（`add` / `sync` / `cloud-upload` / `diff` / `trash`），VS Code 会把超出的折叠进 `⋯`，默认按 order 保留前 3，所以这 5 个属于「可以给，但通常只显示前 3」。若嫌挤，可只留 `sync` + `trash`。

## 7. 当前分支 `gb-current`

| 顺序        | 菜单项                                            | 出现条件      | 状态 | 行内                  | 决策点 | 选择 |
| ----------- | ------------------------------------------------- | ------------- | ---- | --------------------- | ------ | ---- |
| 0_open@1    | Open on Remote                                    | 有远程        | 新增 | —                    | D11    | 要   |
| 1_actions@2 | Create                                            | 单选          | 已有 | 建议：`add`          | —     |      |
| 1_actions@3 | Create and Checkout                               | 单选          | 已有 | —                    | —     |      |
| 1_actions@4 | Update                                            | 单选 / 多选   | 已有 | 建议：`sync`         | —     |      |
| 1_actions@5 | Push                                              | 单选          | 已有 | 建议：`cloud-upload` | —     |      |
| 1_actions@6 | Pull (Fast-Forward Only)                          | 有 upstream   | 待定 | —                    | D6     | 要   |
| 3_compare@0 | Compare with Upstream                             | 有 upstream   | 新增 | —                    | —     |      |
| 3_compare@2 | Show Diff with Working Tree                       | 单选          | 已有 | 建议：`diff`         | —     |      |
| 4_branch@0  | Set Tracking                                      | 单选          | 已有 | —                    | —     |      |
| 4_branch@1  | Rename                                            | 单选，F2 同效 | 已有 | —                    | —     |      |
| 4_branch@2  | Delete                                            | 单选          | 待定 | —                    | D8     | 不要 |
| 5_copy      | Copy ▸ Branch Name / Full Ref / Last Commit Hash | 单选          | 新增 | —                    | D10    | 要   |

> 现状：当前分支单选不显示 Delete（多选含当前分支时显示，执行时跳过）。你选了 D8 = 不要，保持不变。

## 8. 远程分支 `gb-remote`

| 顺序        | 菜单项                                   | 出现条件         | 状态                            | 行内                    | 决策点 | 选择 |
| ----------- | ---------------------------------------- | ---------------- | ------------------------------- | ----------------------- | ------ | ---- |
| 0_open@1    | Open on Remote                           | 有远程           | 新增                            | 建议：`link-external`   | D11    | 要   |
| 1_actions@1 | Checkout                                 | 单选             | 已有                            | —                      | —     |      |
| 1_actions@2 | Create                                   | 单选             | 已有                            | —                      | —     |      |
| 1_actions@3 | Create and Checkout                      | 单选             | 已有                            | —                      | —     |      |
| 1_actions@4 | Update                                   | 单选 / 多选      | 已有                            | 建议：`sync`           | —     |      |
| 1_actions@5 | Fetch This Branch                        | 单选             | 待定                            | —                      | D9     | 不要 |
| 2_merge@1   | Merge into Current                       | 单选             | 已有                            | —                      | —     |      |
| 2_merge@2   | Rebase Current onto Target               | 单选             | 已有                            | —                      | —     |      |
| 3_compare@1 | Compare with Current                     | 单选             | 已有                            | —                      | —     |      |
| 3_compare@2 | Show Diff with Working Tree              | 单选             | 已有                            | 建议：`diff`           | —     |      |
| 3_compare@3 | Compare with Local Branch…              | 单选             | 新增                            | —                      | —     |      |
| 4_branch@2  | Delete                                   | 单选             | 已有（删除远程 + 询问对应本地） | 建议：`trash`          | —     |      |
| 4_branch@3  | Reset Local Branch to Remote             | 存在同名本地分支 | 待定                            | —                      | —     |      |
| 5_copy      | Copy ▸ origin/x / Full Ref / Remote URL | 单选             | 新增                            | —                      | D10    | 要   |

## 9. 标签 `gb-tag`

| 顺序        | 菜单项                       | 出现条件 | 状态 | 行内         | 决策点 | 选择 |
| ----------- | ---------------------------- | -------- | ---- | ------------ | ------ | ---- |
| 0_open@1    | Open on Remote               | 有远程   | 新增 | —           | D11    | 要   |
| 1_actions@1 | Checkout Tag (Detached HEAD) | 单选     | 新增 | —           | —     |      |
| 1_actions@2 | Create                       | 单选     | 已有 | —           | —     |      |
| 1_actions@3 | Create and Checkout          | 单选     | 已有 | —           | —     |      |
| 1_actions@4 | Push Tag                     | 单选     | 新增 | 建议：`cloud-upload` | — |      |
| 3_compare@1 | Compare with Current         | 单选     | 新增 | —           | D12    | 要   |
| 3_compare@2 | Show Diff with Working Tree  | 单选     | 新增 | 建议：`diff` | D12    | 要   |
| 4_branch@2  | Delete Tag                   | 单选     | 新增 | 建议：`trash` | —    |      |
| 4_branch@3  | Delete Remote Tag…          | 单选     | 新增 | —           | D15    | 要   |
| 5_copy      | Copy ▸ Tag Name / Hash      | 单选     | 新增 | —           | D10    | 要   |

---

## 10. 提交 `gb-commit`

> contextValue 由 `gb-compare-commit` 改为 `gb-commit`（已改代码 `src/extension.js:301`）。分支历史和 Compare 共用这个节点，`kind: 'compare-commit'` 属内部实现，保持不变。
>
> 多选时只保留 Copy、Compare Selected Commits、Cherry-Pick、Revert、Open on Remote。

| 顺序        | 菜单项                                   | 出现条件         | 状态 | 行内             | 决策点     | 选择 |
| ----------- | ---------------------------------------- | ---------------- | ---- | ---------------- | ---------- | ---- |
| 0_open@1    | Open on Remote                           | 有远程           | 新增 | —               | D11        | 要   |
| 1_actions@1 | Show Changed Files                       | 单选（等价展开） | 新增 | —               | —         |      |
| 1_actions@2 | Create Branch Here                       | 单选             | 新增 | 建议：`git-branch` | —       |      |
| 1_actions@3 | Create Tag Here                          | 单选             | 新增 | —               | —         |      |
| 1_actions@4 | Checkout Commit (Detached)               | 单选             | 待定 | —               | —         |      |
| 2_merge@1   | Cherry-Pick to Current                   | 单选 / 多选      | 新增 | —               | —         |      |
| 2_merge@2   | Revert Commit                            | 单选             | 待定 | —               | —         |      |
| 2_merge@3   | Reset Current Branch to Commit…         | 单选             | 待定 | —               | —         |      |
| 3_compare@1 | Compare Selected Commits                 | 选中 2 个及以上  | 新增 | —               | D1、D2、D3 |      |
| 3_compare@2 | Compare with Working Tree                | 单选             | 新增 | —               | —         |      |
| 5_copy      | Copy ▸ Short Hash / Full Hash / Message | 单选 / 多选      | 新增 | 建议：`copy`     | D10        | 要   |

> 行内 `copy` 沿用现有悬浮框里的 `git-branch.copyCommitHash`，只复制 7 位短 hash；右键 Copy 子菜单再提供全量与消息。

## 11. 对比文件 `gb-compare-file` / `gb-compare-file-openable`

| 顺序        | 菜单项                                | 出现条件                          | 状态       | 行内                        | 决策点 | 选择 |
| ----------- | ------------------------------------- | --------------------------------- | ---------- | --------------------------- | ------ | ---- |
| 0_open@1    | Open File at Left Revision            | 两侧均非空                        | 新增       | —                          | —     |      |
| 0_open@2    | Open File at Right Revision           | 两侧均非空                        | 新增       | —                          | —     |      |
| 0_open@3    | Open Working Tree File                | 工作树存在该文件（`-openable`） | 已有(行内) | 已有：`go-to-file`         | —     |      |
| 1_actions@1 | Open Diff                             | 单选                              | 新增       | 建议：`diff`               | —     |      |
| 5_copy      | Copy ▸ Relative Path / Absolute Path | 单选                              | 新增       | —                          | D10    | 要   |

## 12. 工作树文件 `gb-worktree-file`

| 顺序        | 菜单项                                | 出现条件 | 状态 | 行内                      | 决策点 | 选择 |
| ----------- | ------------------------------------- | -------- | ---- | ------------------------- | ------ | ---- |
| 0_open@1    | Open File                             | 单选     | 新增 | 建议：`go-to-file`        | —     |      |
| 0_open@2    | Reveal in Explorer                    | 单选     | 新增 | —                        | —     |      |
| 1_actions@1 | Open Diff                             | 单选     | 新增 | 建议：`diff`              | —     |      |
| 5_copy      | Copy ▸ Relative Path / Absolute Path | 单选     | 新增 | —                        | D10    | 要   |

## 13. 对比目录 `gb-comparison-folder`

| 顺序        | 菜单项                   | 出现条件                   | 状态 | 行内 | 决策点 | 选择 |
| ----------- | ------------------------ | -------------------------- | ---- | ---- | ------ | ---- |
| 1_actions@1 | Open All Diffs in Folder | 单选，超过 10 个文件先确认 | 新增 | —   | —     |      |
| 1_actions@2 | Collapse This Folder     | 单选                       | 新增 | —   | —     |      |
| 5_copy      | Copy Folder Path         | 单选                       | 新增 | —   | D10    | 要   |

## 14. Compare 会话 / Diff 会话

| 顺序        | 菜单项                                         | 出现条件       | 状态       | 行内                                              | 决策点 | 选择 |
| ----------- | ---------------------------------------------- | -------------- | ---------- | ------------------------------------------------- | ------ | ---- |
| 1_actions@1 | Refresh                                        | 会话行右键     | 已有(行内) | 已有：`refresh`                                   | —     |      |
| 1_actions@2 | Swap Comparison                                | 会话行右键     | 已有(行内) | 已有：`arrow-swap`                                | —     |      |
| 1_actions@3 | Close（同时关 Diff Tab）                       | 会话行右键     | 已有(行内) | 已有：`close`                                     | —     |      |
| 1_actions@4 | Open All Diffs                                 | 文件数 > 0     | 新增       | —                                                | —     |      |
| 1_actions@5 | Re-run with Fetch                              | 分支侧为远程时 | 新增       | —                                                | —     |      |
| 4_branch@1  | Export as Patch                                | 会话行右键     | 待定       | —                                                | —     |      |
| 5_copy      | Copy ▸ Comparison Name / Left Ref / Right Ref | 会话行右键     | 新增       | —                                                | D10    | 要   |
| inline@4    | More Actions（View、Sort）                     | 行内           | 已有       | 已有：`ellipsis`                                  | —     |      |

> 行内固定顺序 `refresh` → `arrow-swap` → `close` → `ellipsis`，与现有实现一致，不调整大小/颜色，全部用内置 Codicon。

## 15. Compare 来源分组 `gb-compare-side`

| 顺序        | 菜单项              | 出现条件 | 状态 | 行内 | 决策点 | 选择 |
| ----------- | ------------------- | -------- | ---- | ---- | ------ | ---- |
| 1_actions@1 | Collapse This Group | 单选     | 新增 | —   | —     |      |
| 5_copy      | Copy Branch Name    | 单选     | 新增 | —   | D10    | 要   |

## 16. Load more / 空状态

| 节点              | 菜单项                 | 状态     | 行内 | 选择 |
| ----------------- | ---------------------- | -------- | ---- | ---- |
| Load more commits | 不加（本身是命令入口） | 建议不加 | —   |      |
| No differences    | 不加                   | 建议不加 | —   |      |

---

## 17. 多选专用（2 个及以上）

| 顺序        | 菜单项                        | 出现条件                    | 状态 | 行内          | 决策点 | 选择 |
| ----------- | ----------------------------- | --------------------------- | ---- | ------------- | ------ | ---- |
| 1_actions@4 | Update                        | 全部为 Local/Current/Remote | 已有 | 沿用单项 `sync` | —   |      |
| 3_compare@1 | Compare                       | 恰好 2 个分支               | 已有 | —             | —     |      |
| 3_compare@2 | Show Diff                     | 恰好 2 个分支               | 已有 | —             | —     |      |
| 4_branch@2  | Delete                        | 全部为 Local/Current/Remote | 已有 | 沿用单项 `trash` | —   |      |
| 5_copy      | Copy Branch Names（每行一个） | 2 个及以上分支              | 新增 | —             | D10    |      |

> 行内按钮对多选同样生效（VS Code 按每个选中项的 `contextValue` 判定）。为免误点，`trash` 与 `sync` 在多选时维持现状即可；`add`、`cloud-upload`、`diff` 已由 `!git-branch.multiSelection` 收在右键里，不出现在行内。

---

## 18. Copy 子菜单内容

| 节点                  | 子项                                               |
| --------------------- | -------------------------------------------------- |
| 本地分支 / 当前分支   | Branch Name、Full Ref、Last Commit Short Hash      |
| 远程分支              | `origin/x`、Full Ref、Remote URL                 |
| 标签                  | Tag Name、Hash                                     |
| 提交                  | Short Hash、Full Hash、Message                     |
| 对比文件 / 工作树文件 | Relative Path、Absolute Path                       |
| 对比目录              | Folder Path                                        |
| 会话                  | Comparison Name（`A ↔ B`）、Left Ref、Right Ref |
| 分组                  | Branch List / Tag List（多行文本）                 |

---

## 19. 行内按钮（inline）汇总

全部使用 VS Code 内置 Codicon，图标大小与颜色交给编辑器，不写自定义 SVG、不改 `iconPath` 尺寸。

| 节点                       | 行内按钮（左→右）                                          | 说明                                              |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| 根节点 `gb-root`         | `refresh`（Refresh）→ `cloud-download`（Fetch All）      | 建议 2 个，够用                                  |
| 本地分支 `gb-local`      | `add` → `sync` → `cloud-upload` → `diff` → `trash`      | 超过 3 个会被 VS Code 收进 `⋯`，可只留 `sync`、`trash` |
| 当前分支 `gb-current`    | `add` → `sync` → `cloud-upload` → `diff`                | 不给 `trash`（D8 = 不要）                        |
| 远程分支 `gb-remote`     | `link-external` → `sync` → `diff` → `trash`             | `sync` 在远程分支上等于 Fetch                    |
| 标签 `gb-tag`            | `cloud-upload`（Push Tag）→ `diff`（Show Diff）→ `trash` | 推送和删除是最常用的两项                          |
| 提交 `gb-commit`         | `copy`（复制 7 位短 hash）                                | 复用 `git-branch.copyCommitHash`                |
| 对比文件 `gb-compare-file` | `diff`（Open Diff）→ `go-to-file`（仅 `-openable`）    | 沿用现有 `go-to-file`，再加 `diff`               |
| 工作树文件 `gb-worktree-file` | `go-to-file`（Open File）→ `diff`（Open Diff）        | —                                                |
| 对比目录 `gb-comparison-folder` | 不加                                                | 目录行保持干净                                    |
| Compare / Diff 会话        | `refresh` → `arrow-swap` → `close` → `ellipsis`         | 现状，保持不变                                    |
| Compare 来源分组 `gb-compare-side` | 不加                                            | —                                                |

规则：

1. 行内只放「高频、无破坏或可逆」的动作；删除放在行内必须确认弹窗（现有行为已是先确认）。
2. 会话类节点的 4 个按钮已经占满，不再增加。
3. 行内按钮的 `when` 复用同一份 `viewItem` 判定，避免出现右键没有、行内却有的错位。
4. 菜单 `group` 用 `inline@N` 控制顺序，数字小的在左边。

---

## 20. 决策点

| 编号 | 问题                             | 选项                                                                                                | 建议 | 你的选择 |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------- | ---- | -------- |
| D1   | 多选 commit 的合并变更范围       | A 最旧提交的父 → 最新提交<br>B 只合并所选 patch                                                    | A    |          |
| D2   | 所选 commit 不连续               | A 允许，按 D1 计算<br>B 禁止并提示                                                                  | A    |          |
| D3   | 范围内含 Merge commit            | A 按首父计算<br>B 展开两侧父提交                                                                    | A    |          |
| D4   | 分组右键是否放执行型操作         | A 只放折叠/复制<br>B 也放 Update All / Fetch All / Push All Tags                                    | B    | B        |
| D5   | Fetch All 是否带 --prune         | A 不带，Prune 单独一项<br>B 带                                                                      | A    | A        |
| D6   | 本地分支/当前分支是否新增 Pull   | A 不加（Update 已覆盖）<br>B 加                                                                     | A    | B        |
| D7   | Local 分组 Create 的起点         | A 当前分支<br>B 弹框选择分支                                                                        | A    | B        |
| D8   | 当前分支是否显示 Delete          | A 隐藏<br>B 显示并提示先切走                                                                        | A    | A        |
| D9   | 远程分支是否加 Fetch This Branch | A 不加（Update 已覆盖）<br>B 加                                                                     | A    | A        |
| D10  | Copy 菜单形式                    | A 子菜单<br>B 平铺                                                                                  | A    | A        |
| D11  | 是否提供 Open on Remote          | A 提供（ssh→https 解析）<br>B 不提供                                                               | A    | A        |
| D12  | 标签是否放开 Compare / Show Diff | A 放开<br>B 保持不允许                                                                              | A    | A        |
| D13  | 分组排序是否持久化               | A 存工作区设置<br>B 仅本次会话                                                                      | A    | 待填     |
| D14  | 是否提供 Remove Remote           | A 不提供<br>B 提供（强确认）                                                                        | A    | B        |
| D15  | 删除远程 tag 是否询问本地 tag    | A 询问<br>B 不询问                                                                                  | A    | A        |
| D16  | 根节点 Branches 如何实现         | A 新增 `kind:'root'` 顶层节点（可右键，树多一层，需改测试）<br>B 不新增根节点，保留标题栏 Refresh | A    | A        |

> D13 你只勾了「要有 Sort 菜单」，没勾持久化方式，默认按 A（存工作区设置，和 Diff 会话的设置同机制）。

### D16 补充说明

- **方案 A（新增根节点）**：`getRootNodes()` 返回 `[{ kind:'root', contextValue:'gb-root', label: <仓库名>, children: [Local, Remote, Tags, Comparisons] }]`；`getChildren` 增加 `kind === 'root'` 分支；`getParent` 需能回指到 root（供 `tree.reveal`）。菜单用 `viewItem == gb-root`。
  - 影响面：`src/extension.js`（`getRootNodes` / `getChildren` / `getParent`，以及 `comparisonsGroup` 的两处 `getRootNodes().find(...)` 调用，需改为在 root.children 里找）、`package.json`（新增 `gb-root` 菜单项）、`test/*.test.js`（`roots[0].children` → `roots[0].children[0].children`，`roots.map(r => r.label)` 等断言）。
  - 视觉：默认展开 root，用户看到的层级与现在几乎一致，只是多一行仓库名。
- **方案 B（不加根节点）**：重绘仍只在标题栏 `view/title`（现状），无法右键。优点零改动、零测试风险；缺点与你的要求不符。

已选定 A。标题栏 Refresh 保留（成本为零，且 root 折叠时也能刷）。

---

## 21. 修改记录

| 日期       | 调整内容                                          | 说明                                                      |
| ---------- | ------------------------------------------------- | --------------------------------------------------------- |
| 2026-11-20 | 新增第 0 节根节点 `Branches`（`gb-root`）菜单 | 重绘（Refresh）从分组上移到这里；需新增真实顶层节点       |
| 2026-11-20 | 删除 Local / Remote / 远程名分组 的 `Refresh`   | 分组不再提供重绘；`Comparisons` 的 `Refresh All` 保留 |
| 2026-11-20 | 新增决策点 D16（根节点实现方式）                  | A 新增根节点（推荐）/ B 保留标题栏，不改树                |
| 2026-11-20 | 新增 `行内` 列与第 19 节行内按钮汇总              | 全部使用内置 Codicon，按节点给出建议按钮与 order          |
| 2026-11-20 | 提交节点 contextValue 改为 `gb-commit`          | 代码已改 `src/extension.js:301`，文档第 10 节同步         |
