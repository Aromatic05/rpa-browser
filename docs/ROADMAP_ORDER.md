# Roadmap Order

## Principles

- 先稳定工具内核与错误结构，再推进并行/持久化与 UX。
- 统一入口（runSteps/trace）是后续所有能力的基础。
- 所有阶段以“可审计日志 + 可回放”作为前置条件。

## Phase 0A: Tool Core Pipeline & Structured Errors

- 目标：完善 runSteps/trace 的稳定性与错误结构化。
- 依赖：现有 runSteps/trace 已落地。

优先事项：
- “统一配置未覆盖全部执行路径”
  - Why first: 统一等待/超时/人类模拟，减少 flake
  - Depends on: runSteps 已接入 config
- “a11yHint 解析策略偏弱”
  - Why first: 直接影响 click/fill 成功率
  - Depends on: trace.page.snapshotA11y 可用
- “runSteps 覆盖范围有限”
  - Why first: v0 只覆盖 4 个 step，功能缺口明显
  - Depends on: step executor 结构已建立

## Phase 0B: Session/Workspace Skeleton (Parallel/Recovery/TabGroup abstractions)

- 目标：在 registry 与 DSL 中明确 session/workspace/tab/group 字段。
- 依赖：0A 内核稳定。

优先事项：
- “Session/Workspace 持久化与恢复缺失”
  - Why first: 确立边界与字段，便于后续持久化
  - Depends on: registry 与 runSteps 已稳定
- “TabGroup 多页编排能力缺失”
  - Why first: 支持跨页面读写与并行任务
  - Depends on: workspace scope 与 active tab 模型

## Phase 0C: Unified Wait/Timeout + BehaviorPolicy Entrypoint

- 目标：将行为参数与等待策略集中到配置入口。
- 依赖：0A 配置覆盖问题已解决。

优先事项：
- “统一配置未覆盖全部执行路径”
  - Why first: 统一策略是可复现的前提
  - Depends on: runSteps/trace 可注入 config

## Phase 1: Auditable Task DSL + Run Logs

- 目标：step/trace 日志形成可持久化审计链路。
- 依赖：0B 已明确 session/tab/group 字段。

## Phase 2: Demo/Extension UX + Human-in-loop

- 目标：在 UI 中引入人机协同、候选确认与调试面板。
- 依赖：0A 的结构化错误与候选输出。

## Phase 3 (Optional): Full Parallel Sessions + Recovery + TabGroup UI polish

- 目标：并行会话、恢复与 TabGroup UI 完整体验。
- 依赖：0B 的抽象边界与 P1 的审计日志。
