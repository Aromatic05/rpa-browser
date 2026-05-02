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
- 禁止顶层 `tabName`。
- 禁止顶层 `scope`。
- 禁止顶层 `workspaceName/tabName/tabName`。
- 禁止 payload 重复地址字段（`workspaceName/workspaceName/tabName/tabName/scope`）。
- 对外 workspace/tab 表达只允许 `workspaceName/tabName`。
- `workspaceName` 只能出现在 Action 顶层，payload 不得出现 `workspaceName`。
- `tabName` 只在 payload 中作为 workspace 内部目标名，不是顶层地址字段。
- extension content 必须通过 `scope.workspaceName` 设置 Action 顶层地址。
- agent workspace handlers 只从 `action.workspaceName` 读取当前 workspace 地址。
- dispatcher 持续拒绝 payload 地址字段（含 `payload.workspaceName`）。

语义：

- 无 `workspaceName`：进入 control gateway（当前阶段保留为 page stub 执行，不做地址补全）。
- 有 `workspaceName`：进入 workspace gateway（仅按 `workspaceName` 查 workspace）。

## 结果消息

- 成功：`<action>.result`
- 失败：`<action>.failed`
- `replyTo` 关联请求 ID。

## 关键约束

- `workspaceName = workflowName`（协议层命名约定）。
- `activeWorkspace` 仅用于 UI selection，不参与 action dispatch。
- dispatch 入口不依赖 `resolveActionTarget`。
- 协议层已删除：`workspaceName`、`tabName`、`tabName`、`scope`。
- workspace/tab 对外 payload 不得出现 `workspaceName/tabName/tabName`。
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
