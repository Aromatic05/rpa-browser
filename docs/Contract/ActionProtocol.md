# ActionProtocol

## 概述

本文档定义 extension/start_extension/UI 与 agent 的统一 Action 协议。对应实现文件为 `agent/src/actions/*`、`agent/src/index.ts`、`extension/src/shared/action_types.ts`。

## 规范

### 1. Action envelope

```ts
{
  v: 1,
  id: string,
  type: string,
  tabToken?: string,
  scope?: {
    workspaceId?: string,
    tabId?: string,
    tabToken?: string
  },
  payload?: unknown,
  at?: number,
  traceId?: string,
  replyTo?: string
}
```

字段语义：

- `id`：请求 ID。
- `type`：动作类型。
- `tabToken`：tab 生命周期主锚点。
- `scope`：workspace/tab 定位信息。
- `replyTo`：仅回复动作使用。

### 2. 请求类型集合

请求动作域：

- `workflow.*`
- `workspace.*`
- `tab.*`
- `record.*`
- `play.*`
- `task.run.*`

详表：

- workflow: `workflow.list/open/status/record.save/dsl.get/dsl.save/dsl.test/releaseRun`
- workspace: `workspace.list/create/setActive/save/restore`
- tab: `tab.init/list/create/close/setActive/opened/report/activated/closed/ping/reassign`
- record/play: `record.start/stop/get/clear/list/event`、`play.start/stop`
- task: `task.run.start/push/poll/checkpoint/halt/suspend/continue/flush/resume`

### 3. 响应类型规则

- 成功：`<request>.result`
- 失败：`<request>.failed`
- `replyTo` 必须回指原请求 `id`

失败 payload：

```ts
{
  code: string,
  message: string,
  details?: unknown
}
```

### 4. 目标解析规则

- 优先使用 `tabToken`（`action.tabToken` 或 `scope.tabToken`）。
- 当 token 可解析时，`scope.workspaceId/tabId` 必须与解析结果一致。
- 仅有 scope 时，按 `workspaceId/tabId` 反查 token。
- 无 token 且无 scope 时，只有 pageless action 可执行。

### 5. pageless action

在 `actions/dispatcher.ts` 中，以下请求可在无目标页时执行：

- 全部 `workflow.*`
- `workspace.list/create/setActive/save`
- `tab.init/list/create/close/setActive/reassign`

在 `index.ts` 的 WS 主入口另有最小 pageless 集：

- `workspace.list`
- `workspace.create`
- `record.list`
- `tab.init`

### 6. workflow action 协议

- `workflow.list`：返回 workflows 列表与 manifest 诊断。
- `workflow.open`：返回 `workflowRoot/workspaceId/tabId/tabToken/entryUrl`。
- `workflow.status`：返回 `exists/active`。
- `workflow.record.save`：要求当前 scope.workspaceId 与 `workflow:<scene>` 一致。
- `workflow.dsl.get/save/test`：读写 DSL 与测试运行。
- `workflow.releaseRun`：正式运行，返回 output/diagnostics/workspace 绑定。

### 7. tab 生命周期约束

- `tabToken` 生命周期 owner 是 extension background。
- `tab.init` 用于 token 初始化握手。
- `tab.opened` 在 token 尚未绑定时必须提供 `workspaceId`。
- `tab.ping` 用于存活与同步，超时由 watchdog 处理。

### 8. 广播事件

固定事件：

- `workspace.changed`
- `workspace.sync`
- `tab.bound`
- `play.started/step.started/step.finished/progress/completed/failed/canceled`

广播同样使用 Action envelope。

### 9. 错误码

基础错误码：

- `ERR_TIMEOUT`
- `ERR_NOT_FOUND`
- `ERR_STALE`
- `ERR_UNSUPPORTED`
- `ERR_ASSERTION_FAILED`
- `ERR_DIALOG_BLOCKED`
- `ERR_POPUP_BLOCKED`
- `ERR_BAD_ARGS`
- `ERR_WORKFLOW_BAD_ARGS`
- `ERR_WORKSPACE_SNAPSHOT_NOT_FOUND`
- `ERR_WORKSPACE_RESTORE_FAILED`

workflow 运行时还会抛出：`ERR_WORKFLOW_*` 系列（manifest、path escape、checkpoint not found 等）。

### 10. extension/start_extension 调用约束

- 内容页与 start_extension 必须通过 `RPA_ENSURE_BOUND_TOKEN` 获取已绑定 token。
- 发送 action 时，若未显式 scope，则默认带 `scope.tabToken`。
- `workflow.open` 返回的 `workspaceId/tabId/tabToken` 应成为后续 UI 调用上下文。

## 示例

### 请求

```json
{
  "v": 1,
  "id": "req-1",
  "type": "workflow.open",
  "scope": { "tabToken": "token-1" },
  "payload": { "scene": "order_scene" }
}
```

### 成功回复

```json
{
  "v": 1,
  "id": "resp-1",
  "type": "workflow.open.result",
  "replyTo": "req-1",
  "payload": {
    "scene": "order_scene",
    "workspaceId": "workflow:order_scene",
    "tabId": "tab-1",
    "tabToken": "token-1"
  }
}
```

### 失败回复

```json
{
  "v": 1,
  "id": "resp-2",
  "type": "workflow.open.failed",
  "replyTo": "req-1",
  "payload": {
    "code": "ERR_WORKFLOW_BAD_ARGS",
    "message": "workflow.open requires scene"
  }
}
```

## 限制

- WS 主入口与 control dispatcher 的 pageless 范围不完全一致。
- `tab.ping` stale 语义依赖 pageRegistry token 映射状态。

## 禁止事项

- 禁止使用 `type: "error"`。
- 禁止将 `{ok,data}` 作为协议外层。
- 禁止发送不在 `REQUEST_ACTION_TYPES` 中的请求类型。
