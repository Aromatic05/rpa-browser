# Action 协议

## 概述

Action 是 extension/start_extension/UI 与 agent 之间唯一的协议数据包，不是 RPC 返回壳。
实现入口在 `agent/src/index.ts`、`agent/src/actions/dispatcher.ts`。

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
- 禁止顶层 `tabToken`。
- 禁止顶层 `scope`。
- 禁止顶层 `workspaceId/tabId/tabToken`。
- 禁止 payload 重复地址字段（`workspaceName/workspaceId/tabId/tabToken/scope`）。
- 对外 workspace/tab 表达只允许 `workspaceName/tabName`。

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
- 协议层已删除：`workspaceId`、`tabId`、`tabToken`、`scope`。
- workspace/tab 对外 payload 不得出现 `workspaceId/tabId/tabToken`。
- extension 内部 chrome tab id、tabToken 映射仅限 adapter 本地状态，不进入 Action 协议。
- workspace.list 广播必须输出 `workspaces[].workspaceName`、`workspaces[].activeTabName`。
- extension projection 不得依赖 Action payload `tabToken` 做 scope 更新。
- `MSG.ENSURE_BOUND_TOKEN` 属于 extension 内部消息协议，不属于 Action 协议验收范围。
- `page_registry/runtime_registry` 内部仍可使用旧命名字段，但不构成对外协议承诺。

## 本阶段边界

本阶段只做协议入口迁移，不涉及以下深层迁移：

- record/play 执行链路
- workflow artifact 读写逻辑
- checkpoint runtime
- DSL
- browser action 执行链路
