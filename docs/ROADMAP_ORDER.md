# Roadmap Order

## Principles

- 先稳定再审计：稳定性问题会放大后续 DSL 与审计成本。
- 先可审计再产品化：没有 DSL 与结构化日志，无法可靠评估工具效果。
- 模块边界先于 UI：边界清晰后 UI 才能复用与扩展。

## Phase 0 (P0) Stabilize

- 统一等待与超时策略
  - Why first: 直接影响稳定性与 flakiness
  - Depends on: 无

- 录制/回放缺少串行队列与状态机
  - Why first: 并发问题会导致回放不可预期
  - Depends on: 无

- Selector/Target 解析分裂
  - Why first: 解析不一致导致动作不可靠
  - Depends on: 无

- 工具输入校验与错误结构不一致
  - Why first: 错误不可判读阻碍上层审计
  - Depends on: 无

- 工具调用稳定性不足
  - Why first: 影响 MCP 与 Demo 的最小可用性
  - Depends on: 统一 Target 解析

## Phase 1 (P1) Auditable DSL + Logs

- 录制日志未形成可审计 Task DSL
  - Why first: DSL 是审计与回放的核心基线
  - Depends on: P0 稳定化（动作与等待可靠）

- 行为参数分散
  - Why first: 需要集中行为策略才能形成可复现日志
  - Depends on: P0 稳定化

- 工具体系缺乏层次结构
  - Why first: DSL 需要清晰 L0/L1/L2 层级映射
  - Depends on: P0 目标解析统一

- 缺少 Task DSL 运行日志
  - Why first: 可审计系统必须有结构化日志
  - Depends on: DSL 定义完成

- Prompt 约束不足
  - Why first: 直接影响模型是否按 DSL 执行
  - Depends on: DSL 与工具层级清晰

## Phase 2 (P2) Product UX + Human-in-loop

- Demo 缺少实时输出流
  - Why first: 需要基础可视化反馈与可解释性
  - Depends on: P1 结构化日志

- UI 简陋且缺乏状态面板
  - Why first: 需要可操作入口与状态反馈
  - Depends on: P1 日志与 DSL 已清晰

- 人机协同缺失
  - Why first: 解决歧义定位与纠错场景
  - Depends on: P1 DSL 与工具层级稳定

- Session/TabGroup UI 缺失
  - Why first: UX 层需要映射 Session/TabGroup
  - Depends on: P1 session/DSL 抽象

## Optional Phase 3 (P3) Session/TabGroup full evolution

- Session/Workspace 持久化
  - Why first: 支撑恢复与并行
  - Depends on: P1 DSL 与日志落地

- TabGroup 支持跨页面读取/写入
  - Why first: 真实任务需要跨页面协作
  - Depends on: Session 持久化

- 行为模式统一（fast vs humanlike）
  - Why first: 统一策略以便审计与复现
  - Depends on: BehaviorPolicy 抽象形成
