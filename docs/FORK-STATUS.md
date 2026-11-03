# fork 当前状态

> 盘点时间：2026-11-03。本页说明「现在实际在用的版本」和 fork 仓库里能看到的东西之间的关系，避免看仓库的人被误导。

## 先说清三件事

1. **仓库的 `main` 分支 = 上游 v1.4.0 原版**（提交 `b6ec17d`），我们一行没改。看 `main` 看到的是上游，不是我们的现行版本。
2. **实际在用的版本不在 fork 的任何分支上完整存在**：生产运行的是本机 Mac 上本地分支 `deploy/merged-20261102` 的合并版本（基线 v1.4.0 ＋ 全部已合入改动）。这条生产线从未整体推上 fork，fork 上的各功能分支只是逐个的快照留痕。
3. **现行版本未经发布**：没有 Release、没有版本标签，不称稳定版；`package.json` 中的版本号字段仍是上游的 1.4.0（待核对），不要据此认为在用的就是上游 1.4.0。

## 与上游的关系

- 本仓库经 GitHub 正式 fork 自 kevinforge/orbit，fork 后未再同步上游的新提交；上游在 2026-09-24 之后是否有新提交，未核对（待核对）。
- 上游许可证（MIT）与归属声明完整保留，见根目录 `LICENSE` 与《项目来源与归属》。

## 分支一览

### fork 上已有的分支

| 分支 | 尖端提交 | 内容 | 去向 |
| --- | --- | --- | --- |
| `main` | `b6ec17d` | 上游 v1.4.0 原样，零改动 | 基线，不直接动 |
| `feat/dsh-runtime` | `0e7fe6f` | 新增 dsh 运行时（快照提交） | 已合入生产线 |
| `feat/reasoning-effort` | `bdcb69b5` | 思考强度三项支持（快照提交） | 已合入生产线 |
| `feat/workbuddy-runtime` | `2a4bf34b` | 新增 WorkBuddy 运行时（快照提交） | 已合入生产线 |
| `feat/template-defaults` | `4f474992` | 出厂模板三席标准＋预置运行时分配修正（快照提交） | 已合入生产线 |
| `feat/codex-acp-upgrade` | `884816a4` | Codex 适配器升级（快照提交） | 已合入生产线 |
| `feat/dsh-identity-defer` | `5f8ab86a` | dsh 员工身份让位（快照提交） | 已合入生产线 |
| `feat/supervisor-default` | `079e248d` | 监工默认 Codex（快照提交） | 已合入生产线 |
| `feat/project-skeleton` | `770d06a6` | 项目骨架文档＋README 来源声明（快照提交） | 文档分支，本文档所属分支，未合入生产线 |
| `fix/session-continuity-main` | `5a26420` | ACP 会话替换后恢复有界对话历史（本机真实 git 提交，落在上游基线上） | 经手席位与后续处理待确认 |

注：「快照提交」指经 GitHub 连接器推送的分支尖端文件全量快照（一个提交），不是本地的逐个提交历史；逐个提交历史只存在于本机仓库。本表分支状态于 2026-11-03 盘点并逐一核对。

### 只在本机、尚未推到 fork 的分支

| 分支 | 状态 |
| --- | --- |
| `deploy/merged-20261102` | **生产线**（盘点时尖端 `18ec511`），全部已合入改动的合并点 |
| `feat/orbit-data-root` | 未合入、未部署（隔离配置与离线驱动，仅离线验证） |
| `fix/session-continuity-backfill` | 与 `fix/session-continuity-main` 同一改动落在生产线基线上的版本 |

## 现行生产版本的功能状态（相对上游 v1.4.0 的差异）

- 运行时：五种（Claude Code、Codex、CodeBuddy 为上游自带；DeepSeek Harness、WorkBuddy 为我们新增）。用户工作区实际只设 Codex / CodeBuddy / DeepSeek-Harness 三席。
- Codex 可选模型已扩展至 GPT-6.x 系列（适配器升级后 46 个变体）。
- 新建工作区出生即三席标准模板（本名、精简提示词、dsh 默认走 WorkBuddy 模型通道偏好）。
- 监工（复杂协作）默认由 Codex 担任，不再默认 claude-code。

## 已知缺口

- 生产线的完整历史只在本机，未在 fork 留存；fork 分支与生产线的对应关系以本文档为准。
- 截至 2026-11-03 核对，已合入生产线的各功能分支均已在 fork 留有快照；生产线本身仍未整体推送（见上条）。
- README（含中文版）仍是上游原文，未反映 fork 的现状与改动（顶部已加来源声明段，正文未动）。
