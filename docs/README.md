# 文档总览

## 概述

本目录是 `rpa-browser/dsl` 分支的唯一文档契约。所有开发、测试、UI 调用、Codex 生成都必须以本目录为准。

## 规范

文档分层如下：

- `Contract/`：协议与产物契约。
- `Architecture/`：系统结构与模块关系。
- `Runtime/`：运行时行为与执行链路。
- `Development/`：开发、测试、任务管理。
- `Archive/`：历史文档，仅用于追溯，不是当前依据。

权威优先级：

1. `Contract/*`
2. `Runtime/*`
3. `Architecture/*`
4. `Development/*`

## 示例

- 需要生成 workflow artifact：先读 `Contract/ArtifactContract.md`，再读 `Runtime/Workflow.md`。
- 需要实现 UI 调用：先读 `Contract/ActionProtocol.md`，再读 `Runtime/WorkspaceAndTab.md`。

## 限制

- `Archive/` 不可作为当前实现依据。
- 未在当前代码实现的能力，不得写入任何正文契约。
