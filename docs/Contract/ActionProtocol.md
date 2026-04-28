# Action 协议

## 概述

Action 协议是 extension/start_extension/UI 与 agent 之间的主控制协议。实现分布在 `agent/src/actions/*`、`agent/src/index.ts`、`extension/src/shared/action_types.ts`。

## Action envelope

请求与事件统一外层：

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

字段规则：

- `v` 固定为 `1`。
- `id` 必须是非空字符串。
- `type` 必须是注册过的 Action type。
- `replyTo` 仅用于回复消息。

## 请求类型域

- `workflow.*`
- `workspace.*`
- `tab.*`
- `record.*`
- `play.*`
- `task.run.*`

workflow 当前实现：

- `workflow.list`
- `workflow.open`
- `workflow.status`
- `workflow.record.save`
- `workflow.dsl.get`
- `workflow.dsl.save`
- `workflow.dsl.test`
- `workflow.releaseRun`

## 成功与失败响应

成功：`<action>.result`

失败：`<action>.failed`

失败体：

```json
{
  "code": "ERR_*",
  "message": "...",
  "details": {}
}
```

禁止 `type: "error"`。

## scope 与 tabToken 解析规则

目标解析优先级：

1. `action.tabToken`
2. `scope.tabToken`
3. `scope.workspaceId + scope.tabId`
4. active workspace（仅部分路径）

当 token 可解析时，`scope.workspaceId/tabId` 与映射冲突会返回参数错误。

## pageless 双标准（必须关注）

### 当前事实

1. `actions/dispatcher.ts` 的 pageless 集合较宽，包含全部 `workflow.*` 与部分 `workspace.*`、`tab.*`。
2. `agent/src/index.ts` WS 主入口的 pageless 集合较窄，仅：
   - `workspace.list`
   - `workspace.create`
   - `record.list`
   - `tab.init`

### 风险

start_extension 直接走 WS 调用 `workflow.*` 时，在 scope/tabToken 未绑定或未解析到目标页的时机，可能出现 `missing action target`。

### 处理建议（当前）

1. UI 在 `workflow.*` 请求中显式带已绑定 `scope.tabToken` 或 `scope.workspaceId`。
2. `workflow.open` 成功后立刻缓存返回的 `workspaceId/tabToken/tabId` 作为后续上下文。
3. 该问题仍是待修项：建议后续统一 WS 主入口 pageless 集与 dispatcher。

## workflow.open 绑定规则

`workflow.open` 会：

1. 读取 workflow artifact。
2. 解析 workspace binding。
3. 返回 `workspaceId=workflow:<scene>`、`tabId`、`tabToken`、`entryUrl`。

注意：`workflow.open` 不执行 DSL，仅完成上下文打开与绑定。

## tab 生命周期要点

- `tabToken` owner 是 extension background。
- `tab.init` 只能由 background 发起。
- content/start_extension 需通过 `RPA_ENSURE_BOUND_TOKEN` 获取可用 token。
- `tab.opened` 在未绑定 token 时会触发 defer-claim 逻辑。

## 广播事件

常见事件：

- `workspace.changed`
- `workspace.sync`
- `tab.bound`
- `play.started`
- `play.step.started`
- `play.step.finished`
- `play.progress`
- `play.completed`
- `play.failed`
- `play.canceled`

## start_extension 与 extension 调用注意事项

- start_extension 当前是 newtab UI，不直接读取本地 workflow 文件，而是通过 Action 请求 agent。
- extension content 发送业务 Action 前必须拿到绑定 token。
- WS reply 需按 `<action>.result/.failed` 解析。

## 错误码语义

基础错误码：

- `ERR_TIMEOUT`
- `ERR_NOT_FOUND`
- `ERR_STALE`
- `ERR_UNSUPPORTED`
- `ERR_ASSERTION_FAILED`
- `ERR_DIALOG_BLOCKED`
- `ERR_POPUP_BLOCKED`
- `ERR_BAD_ARGS`

workflow 场景还可能出现 `ERR_WORKFLOW_*`。

## 最小调用示例

```json
{
  "v": 1,
  "id": "req-1",
  "type": "workflow.open",
  "scope": { "tabToken": "token-1" },
  "payload": { "scene": "order_scene" }
}
```

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

## 禁止事项

- 禁止使用旧版 `{ok,data}` 作为 Action 外层协议。
- 禁止忽略 pageless 双标准风险并假装已统一。
