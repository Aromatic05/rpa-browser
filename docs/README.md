# 文档总览

## 概述

`docs/` 是 `rpa-browser/dsl` 分支的唯一可信文档体系，供开发、测试、UI 调用与 Codex 生成统一参考。

## 权威文档顺序

1. `Contract/*`：协议与契约（最高优先级）
2. `Runtime/*`：运行时行为与边界
3. `Architecture/*`：模块关系与集成链路
4. `Development/*`：开发命令、测试与任务治理

`Archive/*` 仅用于历史追溯，不是当前契约。

## 目录索引

### Contract

- `Contract/ArtifactContract.md`
- `Contract/ActionProtocol.md`
- `Contract/StepProtocol.md`
- `Contract/TraceProtocol.md`
- `Contract/MCPProtocol.md`
- `Contract/ControlRPCProtocol.md`

### Runtime

- `Runtime/Workflow.md`
- `Runtime/WorkspaceAndTab.md`
- `Runtime/Recording.md`
- `Runtime/Replay.md`
- `Runtime/Dsl.md`
- `Runtime/Checkpoint.md`
- `Runtime/Snapshot.md`
- `Runtime/EntityRules.md`
- `Runtime/TargetResolve.md`
- `Runtime/Config.md`
- `Runtime/Logging.md`

### Architecture

- `Architecture/Overview.md`
- `Architecture/WorkflowLifecycle.md`
- `Architecture/TypicalFlow.md`
- `Architecture/Extension.md`
- `Architecture/StartExtension.md`
- `Architecture/MockApps.md`
- `Architecture/MCPIntegration.md`

### Development

- `Development/DevelopmentGuide.md`
- `Development/TestGuide.md`
- `Development/TaskBoard.md`

## 使用建议

- 需要定义 artifact：先读 `ArtifactContract`，再读 `Runtime/Workflow`。
- 需要接 UI/扩展 Action：先读 `ActionProtocol`，再读 `Runtime/WorkspaceAndTab` 与 `Architecture/Extension`。
- 需要排障：优先看 `Runtime/Logging`、`Runtime/Snapshot`、`Contract/TraceProtocol`。
