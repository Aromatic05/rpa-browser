# MpcIntegration

## 概述

MCP 集成是 agent 对外工具调用通道，负责 schema 校验、tool 映射与结果压缩。

## 规范

### 入口

- `agent/src/mcp_main.ts`：启动上下文、runner、control、MCP HTTP。
- `agent/src/mcp/server.ts`：initialize/tools/list/tools/call。
- `agent/src/mcp/tool_handlers.ts`：工具到 Step 的转换。

### 调用链

```text
MCP client -> tools/call -> schema parse -> runSingleStep -> runSteps
```

### 配置

- `mcpPolicy` 可限制工具组。
- hot 模式可 watch `src/mcp`。

## 示例

- `browser.query` entity 查询通过 `tool_handlers` 组装成 `browser.query` Step。

## 限制

- 当前 transport 为 HTTP POST，不提供 SSE 推送。
