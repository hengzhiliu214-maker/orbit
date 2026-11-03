# 项目来源与归属

> 本文档如实记录这个仓库的来历：哪些成果来自上游，哪些是我们改的。
> 原则：别人的成果写别人的名字，我们的改动单独列清，不混淆、不冒领。

## 一句话来源

本仓库是开源项目 **Orbit** 的 fork。原项目由 **Kevin Forge**（GitHub：kevinforge）开发，
本仓库在其 **v1.4.0** 版本的基础上，由仓库主人继续维护和二次开发。

## 上游信息

| 项 | 内容 |
| --- | --- |
| 上游仓库 | https://github.com/kevinforge/orbit |
| 上游作者 | Kevin Forge（GitHub 账号 kevinforge） |
| 上游许可证 | MIT License（见仓库根目录 `LICENSE`，Copyright (c) 2026 Kevin Forge） |
| fork 基线版本 | v1.4.0（发布于 2026-09-14） |
| fork 基线提交 | `b6ec17d091b107db5a34789e778249c620c8304c` |
| fork 时间 | 2026-11-01（由仓库主人在 GitHub 网页手动 fork） |
| 本仓库 | https://github.com/hengzhiliu214-maker/orbit |

## 许可证与归属声明

- 本仓库完整保留上游的 MIT License 原文与原作者版权声明（根目录 `LICENSE`），不修改、不替换。
- 上游代码与文档的著作权归原作者及上游贡献者所有；本仓库的二次开发是在 MIT 许可证授权范围内进行的。
- 本仓库新增与修改的部分，同样在 MIT 许可证下提供；这不改变上游部分的归属。
- 引用或介绍本项目时，应同时说明其上游来源，不得将上游成果表述为本仓库的原创。

## 边界：什么是上游的，什么是我们的

### 上游的（v1.4.0 基线 `b6ec17d` 的全部内容，未经我们改动的部分）

- 全部核心架构：本地优先的多 Agent 工作台、Web UI（localhost:4317）、工作区/会话/队列/审批机制
- 内置运行时适配：Claude Code、Codex、CodeBuddy（经 ACP v1）
- 三种交互模式（普通对话 / 简单协作 / 复杂协作）与监工机制
- 上游自带的全部文档（README、docs/、CONTRIBUTING、SECURITY 等）与测试

说明：本仓库 `main` 分支至今与上游基线逐字一致、零改动；上游内容以 `main` 为准。

### 我们的（fork 之后的改动，均在各自分支上留痕）

| 改动方向 | 分支 | 状态 |
| --- | --- | --- |
| 新增 DeepSeek Harness（dsh）运行时接入 | `feat/dsh-runtime` | 已合入本地生产线 |
| 思考强度支持（CodeBuddy 思考档位、dsh 推理强度、Codex 模型变体选择） | `feat/reasoning-effort` | 已合入本地生产线 |
| 新增 WorkBuddy 运行时 | `feat/workbuddy-runtime` | 已合入本地生产线（运行时保留；用户工作区已不设该席位） |
| 出厂模板改为三席标准（员工本名、提示词精简、dsh 默认模型偏好） | `feat/template-defaults` | 已合入本地生产线 |
| Codex 适配器升级（codex-acp 2.5.0，可选模型扩展到 GPT-6.x 系列） | 分支 `feat/codex-acp-upgrade` | 已合入本地生产线，已推到 fork（快照 `884816a4`） |
| dsh 员工身份让位（身份以其自身系统配置为准） | 分支 `feat/dsh-identity-defer` | 已合入本地生产线，已推到 fork（快照 `5f8ab86a`） |
| 监工默认改挂 Codex（隐式运行时选择顺序调整） | 分支 `feat/supervisor-default` | 已合入本地生产线，已推到 fork（快照 `079e248d`） |
| 可配置数据根与离线验收驱动 | 本地分支 `feat/orbit-data-root` | 未合入、未部署（离线成果） |
| ACP 会话替换后恢复有界对话历史 | `fix/session-continuity-main` | 2026-11-03 在本机产生并推入 fork；经手席位待确认 |

### 不进仓库的东西（配置层，不属于源码改动）

以下属于使用层配置，存在本机运行数据（`~/.orbit`）里，不在本仓库内，不要与源码改动混淆：

- 各工作区的员工改名（改为运行时本名）、删席（去掉 Claude-Code、WorkBuddy 员工）
- 员工提示词的删句调整、dsh 员工的模型偏好切换（经本机 dsh 插件走 WorkBuddy 模型通道；凭据由 dsh 自身管理，本项目未读取、未复制任何凭据）
- 各会话的监工配置改挂 Codex

## 维护约定

- 改动先开分支、留提交记录，可审查、可回滚；不直接改上游基线分支 `main`。
- 适宜回馈上游的通用改进，可考虑向上游提 PR；涉及本地使用环境的改动留在本仓库分支上并注明。
- 本文档与《fork 当前状态》如与仓库实际不一致，以仓库实际为准并及时修订文档。
