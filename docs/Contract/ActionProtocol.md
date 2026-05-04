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

## workspaceName 协议

- `action.workspaceName` 只用于 workspace action 路由。
- `payload.workspaceName` 只用于 control action 的业务参数。
- `action.workspaceName` 与 `payload.workspaceName` 绝对不可以同时存在。
- control action 禁止携带 `action.workspaceName`。
- workspace action 禁止携带 `payload.workspaceName`。
- workspace action 必须携带 `action.workspaceName`。

## Action 分类

### Control actions（进入 control gateway）

- `workspace.list`
- `workspace.create`
- `workspace.setActive`
- `workflow.list`
- `workflow.create`
- `workflow.open`
- `workflow.rename`
- `tab.init`

### Workspace actions（进入 workspace gateway，必须携带 action.workspaceName）

- `tab.list`, `tab.create`, `tab.close`, `tab.setActive`
- `tab.opened`, `tab.report`, `tab.activated`, `tab.closed`
- `tab.ping`, `tab.reassign`
- `record.start`, `record.stop`, `record.get`, `record.save`
- `record.load`, `record.clear`, `record.list`, `record.event`
- `play.start`, `play.stop`
- `dsl.get`, `dsl.save`, `dsl.test`, `dsl.run`
- `task.run.start`, `task.run.push`, `task.run.poll`
- `task.run.checkpoint`, `task.run.halt`, `task.run.suspend`
- `task.run.continue`, `task.run.flush`, `task.run.resume`
- `checkpoint.list`, `checkpoint.get`, `checkpoint.save`, `checkpoint.delete`
- `entity_rules.list`, `entity_rules.get`, `entity_rules.save`, `entity_rules.delete`
- `mcp.start`, `mcp.stop`, `mcp.status`

### 已删除的 action

- `workspace.save` — 已删除
- `workspace.restore` — 已删除
- `workflow.status` — 已删除

## workspace.setActive 协议

- `workspace.setActive` 是 control action。
- `workspace.setActive` 使用 `payload.workspaceName` 指定目标 workspace。
- `workspace.setActive` 禁止携带顶层 `action.workspaceName`。
- `workspace.setActive` 由 `control_plane` 处理，不进入 `WorkspaceRouter`。

## 路由

- 无 `workspaceName` 的 control action：进入 control gateway → `control_plane`。
- 有 `workspaceName` 的 workspace action：进入 workspace gateway → `WorkspaceRouter`。

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

## Agent 与 Extension 一致性

- agent 和 extension 使用同一套显式 `CONTROL_ACTIONS` / `WORKSPACE_ACTIONS` 集合。
- 禁止使用"有 workspaceName 就 workspace、无 workspaceName 就 control"的隐式分类规则。

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

## 本阶段边界

本阶段只做协议入口迁移，不涉及以下深层迁移：

- record/play 执行链路
- workflow artifact 读写逻辑
- checkpoint runtime
- DSL
- browser action 执行链路
