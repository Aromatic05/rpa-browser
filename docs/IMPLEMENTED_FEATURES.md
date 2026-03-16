# 已实现功能（对照 Roadmap）

本文档只记录“已经在代码中落地”的能力，并与 `docs/ROADMAP_ORDER.md` 对照。

状态说明：

- `已实现`：主链路可用，且在代码中有明确入口
- `部分实现`：有基础能力，但未达到 roadmap 完整目标
- `未实现`：当前仓库未看到可用实现

## 已落地基础能力（Roadmap 前置能力）

- 统一执行内核：`runSteps + trace + executor` 已落地  
  代码：`agent/src/runner/run_steps.ts`、`agent/src/runner/trace/*`、`agent/src/runner/steps/executors/*`
- 多入口复用同一内核：WS action、MCP、script 都汇聚到 Step 执行  
  代码：`agent/src/index.ts`、`agent/src/mcp/tool_handlers.ts`、`agent/src/script/run_script.ts`
- Workspace/Tab 基础管理与作用域解析可用  
  代码：`agent/src/actions/workspace.ts`、`agent/src/runtime/page_registry.ts`
- 录制与回放主链路可用（录制事件 -> Step，回放走 runSteps）  
  代码：`agent/src/record/recording.ts`、`agent/src/record/recorder.ts`、`agent/src/actions/recording.ts`
- 结构化观测事件可用（`step.start/end`、`op.start/end`），并支持文件落盘  
  代码：`agent/src/runner/run_steps.ts`、`agent/src/runner/trace/trace_call.ts`、`agent/src/runner/trace/sink.ts`

## 与 Roadmap 对照

### A. 必做任务

| 任务 | 状态 | 现状说明 |
|---|---|---|
| A1 会话/工作区恢复能力 | 部分实现 | 已支持录制与 workspace 快照持久化（`recordings.state.json`），并可 `workspace.restore` 恢复 tab URL + 录制内容；`task checkpoint/断点续跑` 尚未完成。 |
| A2 任务审计视图 | 部分实现 | 已有 step/trace/action 日志与文件输出；未见统一 TaskRun 查询视图。 |
| A3 A11y 树剪枝与预处理 | 部分实现 | 已有 snapshotA11y 与 a11y cache；未见系统化剪枝/预处理策略。 |
| A4 选择器多重定位与置信度融合 | 部分实现 | 已有 selector + a11yHint + confidence 校验；高级模糊匹配与多候选融合未完整。 |
| A5 面板与扩展可用化 | 部分实现 | 面板可做 workspace/tab/record/play 基础操作；仍偏 demo，未形成正式控制台能力。 |
| A6 DSL 最小可用版 | 部分实现 | 已有行式 DSL（goto/snapshot/click/fill）与 Step 编译执行；语法与错误模型仍较简。 |
| A7 Excel/CSV 数据驱动执行 | 未实现 | 当前未见 Excel/CSV 读取与映射到 Step 的实现。 |

### B. 可选增强任务

| 任务 | 状态 | 现状说明 |
|---|---|---|
| B1 文件操作与执行沙盒完善 | 未实现 | 当前未见受限执行器、路径白名单与安全策略实现。 |
| B2 数据源生态扩展 | 未实现 | 当前未见 Google Sheets/API/DB 适配器。 |
| B3 DSL 工程化高级能力 | 未实现 | 当前未见 AST/IR、调试器、模块化等高级能力。 |

### C. 持续治理任务

| 任务 | 状态 | 现状说明 |
|---|---|---|
| C1 协议文档同步 | 部分实现 | 有协议文档，但个别条目与代码仍需持续对齐。 |
| C2 开发文档同步 | 部分实现 | 有开发文档，需随脚本和入口持续更新。 |
| C3 架构文档同步 | 部分实现 | 架构主链路已写明，新增层级时需同步维护。 |
| C4 测试覆盖治理 | 部分实现 | 已有 unit/trace/runner/e2e 分层测试，仍需按新能力补齐回归。 |

## 备注

- 本文档是“实现状态快照”，不替代协议/架构/开发文档。
- roadmap 变更后，应同步更新本文件的状态表。
