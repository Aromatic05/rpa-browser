# MCP 协议

## 概述

MCP 是面向外部程序与 AI 工具调用的 HTTP JSON-RPC 协议层，对应实现在 `agent/src/mcp/server.ts`、`agent/src/mcp_main.ts`、`agent/src/mcp/tool_registry.ts`。MCP 的职责是把工具调用转换成受控的 browser Step 执行，不直接替代 Action 协议或 Control RPC。

## 协议入口

- 默认地址：`http://127.0.0.1:17654`
- 健康检查：`GET /health`
- MCP 请求入口：`POST /mcp`
- 环境变量：
  - `RPA_MCP_HOST`
  - `RPA_MCP_PORT`
  - `RPA_MCP_PATH`
  - `RPA_MCP_HEALTH_PATH`

最小健康响应示例：

```json
{
  "ok": true,
  "transport": "http",
  "mcpPath": "/mcp"
}
```

## 请求与响应

MCP 使用 JSON-RPC 消息体，核心请求包括：

1. `initialize`
2. `tools/list`
3. `tools/call`

`tools/call` 响应由 MCP SDK封装为 `content[].text`，其中 `text` 为项目内部统一结果：

```json
{"ok":true,"data":{}}
```

失败示例：

```json
{"ok":false,"error":{"code":"ERR_BAD_ARGS","message":"..."}}
```

## 工具注册与分组

工具清单来自 `tool_registry.ts`，运行时通过 `resolveEnabledToolNames` 与 `mcpPolicy` 过滤：

- `enabledToolGroups`
- `enableTools`
- `disableTools`

默认禁用项在 `defaultRunnerConfig.mcpPolicy.disableTools` 中定义。

## tool schema 来源

工具输入 schema 由 MCP 层显式定义并暴露，不从文档推断。新增工具必须同步：

1. `mcp/schemas.ts`
2. `mcp/tool_handlers.ts`
3. `mcp/tool_registry.ts`

## tabToken 与 workspace 注入规则

MCP handler 侧会把工具请求转换为 Step，并通过 runtime 解析目标页面。目标解析顺序遵循 runner/runtime 当前实现：

1. 显式 `workspaceId`
2. scope 已绑定 token
3. active workspace

未命中目标时返回错误，不自动创建 workspace。

## MCP 到 Step 的映射

MCP 是“工具协议”，不是浏览器直接 RPC。典型映射：

- `browser.snapshot` -> `StepName: browser.snapshot`
- `browser.query` -> `StepName: browser.query`
- `browser.capture_resolve` -> `StepName: browser.capture_resolve`
- `browser.entity` -> `StepName: browser.entity`

执行主链是 `runSteps`，不是 MCP 自己实现一套执行器。

## 关键工具用途

- `browser.snapshot`：构建 DOM/A11y/overlay 统一快照。
- `browser.query`：在 snapshot 或节点集合上执行查询表达式。
- `browser.capture_resolve`：采集目标解析草稿，不直接修改 artifact。
- `browser.entity`：查询/维护实体视图（受当前实现能力限制）。

## MCP 在 AI 探索页面中的角色

AI 侧通过 MCP 获取“可观察事实”：

1. snapshot 结构
2. query 结果
3. capture_resolve 提示

AI 不能绕过 MCP 直接调用内部运行时对象。

## 与 ActionProtocol 的区别

- Action：extension/start_extension/UI 与 agent 的会话协议，强调 `scope/tabToken/replyTo`。
- MCP：面向外部工具调用，强调 schema 与工具可发现。

两者共享同一执行内核，但协议层完全不同。

## 与 Control RPC 的区别

- MCP：HTTP JSON-RPC + tools/list + tools/call。
- Control RPC：本地控制通道，方法集合固定（`dsl.run`、`browser.query` 等）。

Control RPC 不提供 MCP 的工具发现能力。

## 当前限制

- 当前是 HTTP POST 模式，不是 SSE 推送模型。
- MCP 返回内容在 SDK `content` 文本中，调用方需做一次 JSON 反序列化。
- 工具可见性受 `mcpPolicy` 影响，文档示例不代表一定启用。

## 禁止事项

- 禁止把 MCP 写成 Action 协议别名。
- 禁止假设所有 Step 都自动对外暴露为 MCP 工具。
- 禁止把 Control RPC 方法写进 MCP `tools/list`。
