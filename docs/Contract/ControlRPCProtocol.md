# Control RPC 协议

## 概述

Control RPC 是 agent 内置控制通道，定位是“受限管理接口”，对应实现在 `agent/src/control/*`。它用于本地调试、受控脚本运行与 Action 桥接，不是 MCP 的替代品。

## 协议格式

请求：

```json
{
  "id": "req-1",
  "method": "dsl.run",
  "params": {}
}
```

响应成功：

```json
{
  "id": "req-1",
  "ok": true,
  "result": {}
}
```

响应失败：

```json
{
  "id": "req-1",
  "ok": false,
  "error": {
    "code": "ERR_CONTROL_BAD_REQUEST",
    "message": "...",
    "details": {}
  }
}
```

## 方法集合（当前实现）

`createControlRouter` 当前只注册以下方法：

1. `agent.ping`
2. `dsl.run`
3. `browser.query`
4. `browser.click`
5. `browser.fill`
6. `browser.snapshot`
7. `action.call`

文档不得扩写未注册方法。

## workspaceId 默认注入

当 Control server 启动时注入了 `workspaceId` 上下文，router 会在请求缺失 `params.workspaceId` 时自动补入。若仍无法确定 workspace，方法会返回 `ERR_CONTROL_BAD_REQUEST`。

## dsl.run 语义

- 需要 `workspaceId` 与 `source`。
- 调用 `runDslSource`。
- 返回 `scope` 与 `diagnostics`。

Control RPC 不返回 Action envelope。

## browser.* 语义

`browser.query/click/fill/snapshot` 通过 `tool_bridge.ts` 转换为单步 Step，交给 DSL task runner 执行。每次调用是受控单步任务，不维持 MCP 会话语义。

## action.call 桥接

`action.call` 输入 Action 片段：

- `type` 必填
- `workspaceName` 可选
- `payload` 可选

禁止：`scope/tabToken/workspaceId/tabId`。

路由层会补齐 `v/id/at`，再交给 Action dispatcher。

## 与 MCP 的区别

- Control RPC 无 `tools/list`。
- Control RPC 方法集合固定。
- Control RPC 更偏内部控制，MCP 更偏对外工具生态。

## 与 Action 协议的关系

Control RPC 的 `action.call` 是桥接入口，不等于完整 Action 通道。Action 的广播、replyTo、WS 生命周期不由 Control RPC 承担。

## 错误码

常见控制层错误码：

- `ERR_CONTROL_BAD_JSON`
- `ERR_CONTROL_BAD_REQUEST`
- `ERR_CONTROL_METHOD_NOT_FOUND`
- `ERR_CONTROL_INTERNAL`

桥接到 Action/Step 时，内部错误码会透传到 `error.code`。

## 当前限制

- 不是通用浏览器自动化 API，仅开放少量白名单方法。
- 不提供任务列表、工作区列表等高阶查询。
- 不具备 MCP tool schema 自描述能力。

## 禁止事项

- 禁止把 Control RPC 写成“全量 MCP 替代”。
- 禁止假设所有 Action type 都可无条件通过 `action.call` 成功执行。
