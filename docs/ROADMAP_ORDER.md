# Roadmap Order

## Principles

- 先稳定再审计：稳定性问题会放大后续 DSL 与审计成本。
- 先可审计再产品化：没有 DSL 与结构化日志，无法可靠评估工具效果。
- 模块边界先于 UI：边界清晰后 UI 才能复用与扩展。

## Phase 0 (P0) Stabilize

### Phase 0A: Tool Core Pipeline & Structured Errors

- strict violation/歧义目标未结构化处理（需要 candidates）
  - Why first: 直接决定工具可用性与可审查性
  - Depends on: 无

- 工具输入校验与错误结构不一致
  - Why first: 没有结构化错误，后续 DSL/审计无法落地
  - Depends on: 无

- Selector/Target 解析分裂
  - Why first: 解析不一致会放大工具失败与歧义
  - Depends on: 无

- 工具调用稳定性不足
  - Why first: MCP/Demo 的最小闭环依赖稳定工具链路
  - Depends on: Selector/Target 解析统一

### Phase 0B: Session/Workspace Skeleton (Parallel/Recovery/TabGroup abstractions)

- Session/Workspace registry 缺失（并行/恢复边界）
  - Why first: 会话抽象是后续 DSL 与多 tab 的基础
  - Depends on: 0A 的工具链稳定（避免在不稳定基础上固化抽象）

> 当前仓库已具备 **workspace -> tabs** 的最小运行时模型（内存态）；后续重点转向持久化与恢复能力。

- TabGroup 模型缺失（跨页面读写）
  - Why first: 数据模型字段需尽早预留以避免后续返工
  - Depends on: Session/Workspace 抽象先确立

### Phase 0C: Unified Wait/Timeout + BehaviorPolicy Entrypoint

- 工具统一等待/超时策略入口缺失
  - Why first: 等待策略影响所有动作稳定性
  - Depends on: 0A 的工具链路与错误结构

- 行为参数分散（BehaviorPolicy/Persona 入口缺失）
  - Why first: 需要统一策略以保证可复现性
  - Depends on: 0B 的会话抽象（便于在 session 级配置）

- Idle 行为缺少集中管理与可复现控制
  - Why first: idle 行为属于 persona/behavior policy 的一部分
  - Depends on: BehaviorPolicy 入口确立

## Phase 1 (P1) Auditable Task DSL + Run Logs

- 录制日志未形成可审计 Task DSL
  - Why first: DSL 是审计与回放的核心基线
  - Depends on: P0 稳定化（0A/0C 已完成）

- 工具体系缺乏层次结构
  - Why first: DSL 需要清晰 L0/L1/L2 层级映射
  - Depends on: 0A 解析统一与错误结构

- 缺少 Task DSL 运行日志
  - Why first: 可审计系统必须有结构化日志
  - Depends on: DSL 定义完成（字段已预留 sessionId/tabId/groupId/persona）

- Prompt 约束不足
  - Why first: 直接影响模型是否按 DSL 执行
  - Depends on: DSL 与工具层级清晰

## Phase 2 (P2) Demo/Extension UX + Human-in-loop

- Demo 缺少实时输出流
  - Why first: 需要基础可视化反馈与可解释性
  - Depends on: P1 结构化日志与 candidates 可用

- Workspace Explorer UI 最小闭环已完成（继续完善）
  - Why first: 已具备基础入口，需补齐 human-in-loop 与调试能力
  - Depends on: P1 日志与 DSL 已清晰

- WS 事件通道已具备雏形（仍需重连/诊断完善）
  - Why first: 事件驱动刷新提高一致性，但需更强的可观测性
  - Depends on: 基础 WS 通道稳定

- Start Page / Sandbox 与友好命名已落地（UI 可用性提升）
  - Why first: 新建 tab 可自动化的稳定入口已建立（基于本地 mock 站点）
  - Depends on: P0 稳定工具内核

- tabGroups 分组作为增强已推进（仍需更完善的 UX 提示）
  - Why first: 视觉组织改善，但需配合更强的状态反馈
  - Depends on: workspace displayName 与基础 Workspace Explorer 已就绪

- 人机协同缺失
  - Why first: 解决歧义定位与纠错场景
  - Depends on: P1 DSL 与结构化 candidates

- Session/TabGroup UI 缺失
  - Why first: UX 层需要映射 Session/TabGroup
  - Depends on: P1 session/DSL 抽象

## Optional Phase 3 (P3) Full Parallel Sessions + Recovery + TabGroup UI polish

- Session/Workspace 持久化与恢复
  - Why first: 支撑重启后恢复与并行管理
  - Depends on: P0B 会话抽象与 P1 DSL 日志落地

- TabGroup 支持跨页面读取/写入
  - Why first: 真实任务需要跨页面协作
  - Depends on: Session 持久化与 P0 的串行队列/状态机

- 行为模式统一（fast vs humanlike）
  - Why first: 统一策略以便审计与复现
  - Depends on: 0C BehaviorPolicy 入口确立
