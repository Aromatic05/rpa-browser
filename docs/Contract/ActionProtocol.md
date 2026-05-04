# Action 协议

## 概述

Action 是 extension/start_extension/UI 与 agent 之间唯一的协议数据包，不是 RPC 返回壳。
实现入口在 `agent/src/actions/ws_client.ts`、`agent/src/index.ts`（装配）与 `agent/src/actions/dispatcher.ts`。

## Action Envelope

```ts
{
  v: 1,
  id: string,
  type: string,
  workspaceName?: string,
  payload?: unknown,
  at?: number,
  traceId?: string,
  replyTo?: string
}
```

规则：

- 顶层运行时地址只允许 `workspaceName`。
- `tabName` 只允许出现在 payload 业务参数内。
- 禁止顶层 `tabName`、`scope`、`workspaceId`、`tabToken`、`windowId`、`chromeTabNo`。
- 禁止 payload 中出现 `scope`、`workspaceId`、`tabToken`、`tabId`。

## 路由规则

Action routing 由两层判定：

1. **action type catalog**：`classifyActionType` 判断 action type 是否为合法 request action。
2. **workspaceName 路由**：`classifyActionRoute` 根据 `action.workspaceName` 决定进入 control route 或 workspace route。

禁止使用 `CONTROL_ACTIONS` 白名单。
禁止使用 `WORKSPACE_ACTIONS` 白名单。
禁止用 action type 白名单决定 control/workspace 路由。

### 路由分流

- reply action（`*.result` / `*.failed`）→ reply route。
- event action（`*.started` / `*.progress` / `*.completed` / `*.canceled` / 固定 event type）→ event route。
- command action 带顶层 `action.workspaceName` → workspace route。
- command action 不带顶层 `action.workspaceName` → control route。
- 非法 action type → invalid。

## workspaceName 协议

- `action.workspaceName` 只用于路由分流：有则 workspace route，无则 control route。
- `payload.workspaceName` 只作为 control action 的业务参数。
- `action.workspaceName` 与 `payload.workspaceName` 绝对不可以同时存在。
- workspace route 禁止 payload 中出现 `workspaceName`。

## 路由架构

- 无 `workspaceName` 的 command action → control gateway → `control_plane`。
- 有 `workspaceName` 的 command action → workspace gateway → `WorkspaceRouter`。

## Control action

`control_plane` 处理的 control action：

- `workspace.list`
- `workspace.create`
- `workspace.setActive`
- `workflow.list`
- `workflow.create`
- `workflow.open`
- `workflow.rename`

### workspace.setActive 协议

- `workspace.setActive` 是 control route action。
- `workspace.setActive` 使用 `payload.workspaceName` 指定目标 workspace。
- `workspace.setActive` 禁止携带顶层 `action.workspaceName`。

## WorkspaceRouter 纪律

- `WorkspaceRouter` 只做前缀转发，不解析领域 payload，不构造领域业务 reply。
- `tab.*` 转发给 `TabsControl.handle`。
- `record.*` / `play.*` 转发给 `RecordControl.handle`。
- `dsl.*` 转发给 `DslControl.handle`。
- `checkpoint.*` 转发给 `CheckpointControl.handle`。
- `entity_rules.*` 转发给 `EntityRulesControl.handle`。
- `task.run.*` 转发给 `RunnerControl.handle`。
- `mcp.*` 转发给 `McpControl.handle`。

## Control 命名

- 领域 action 处理入口统一叫 Control（如 `TabsControl`、`McpControl`、`RecordControl`）。
- `TabsControl` 处理 `tab.*` action。
- `McpControl` 处理 `mcp.*` action。

## tabName 来源

`tabName` 的产生来源收束为：

- `tab.create`：workspace 内创建新 tab。
- `tab.opened`：extension 将已有 chrome tab 绑定到 workspace。
- `tab.reassign`：将 tab 重新分配到指定 workspace。
- PageRegistry binding：runtime 层面的 page 绑定。

已删除 `tab.init`。extension 不再发送 `tab.init`。extension 内部使用本地随机 token 作为 binding name，不再依赖 agent 生成 tabName。

## Agent 与 Extension 一致性

- agent 和 extension 使用同一套 `classifyActionRoute` 逻辑（workspaceName 路由）。
- agent 和 extension 使用同一套 `classifyActionType` 逻辑（action type catalog）。
- 禁止使用"有 workspaceName 就 workspace、无 workspaceName 就 control"之外的隐式分类规则。

## 结果消息

- 成功：`<action>.result`
- 失败：`<action>.failed`
- `replyTo` 关联请求 ID。

## 关键约束

- `workspaceName = workflowName`（协议层命名约定）。
- `activeWorkspace` 仅用于 UI selection，不参与 action dispatch。
- dispatch 入口不依赖 `resolveActionTarget`。
- extension 内部 chrome tab id、tabName 映射仅限 adapter 本地状态，不进入 Action 协议。
- workspace.list 广播必须输出 `workspaces[].workspaceName`、`workspaces[].activeTabName`。
- extension projection 不得依赖 Action payload `tabName` 做 scope 更新。
- `MSG.ENSURE_BOUND_TOKEN` 属于 extension 内部消息协议，不属于 Action 协议验收范围。
- `page_registry/runtime_registry` 内部仍可使用旧命名字段，但不构成对外协议承诺。

## 已删除的 action

- `tab.init` — 已删除
- `workspace.save` — 已删除
- `workspace.restore` — 已删除
- `workflow.status` — 已删除

## 本阶段边界

本阶段只做协议入口迁移，不涉及以下深层迁移：

- record/play 执行链路
- workflow artifact 读写逻辑
- checkpoint runtime
- DSL
- browser action 执行链路
