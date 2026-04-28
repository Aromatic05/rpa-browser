# MpcProtocol

## 概述

MPC（项目内命名为 mcp）是 HTTP JSON-RPC 工具调用层。对应 `agent/src/mcp/*` 与 `agent/src/mcp_main.ts`。

## 规范

### 1. 传输与端点

- HTTP `POST /mcp`：MCP JSON-RPC。
- HTTP `GET /health`：健康检查。
- 默认监听：`127.0.0.1:17654`。

### 2. 能力集

- `initialize`
- `tools/list`
- `tools/call`

### 3. tool 输出封装

`tools/call` 最终返回文本 JSON：

```json
{ "ok": true, "data": ... }
```

或

```json
{ "ok": false, "error": { "code": "ERR_*", "message": "..." } }
```

### 4. tool 注册域

`tool_registry.ts` 分组：

- `tab_navigation`
- `structured_inspection`
- `business_entities`
- `actions`
- `debugging`

### 5. schema 约束

`schemas.ts` 通过 zod 校验。

关键示例：

- `browser.query`：支持 snapshot 查询与 entity 查询。
- `browser.entity`：支持 `list/get/find/add/delete/rename`。
- `browser.capture_resolve`：要求至少一个定位条件。

### 6. tabToken 处理

- tool 层默认会注入 active tabToken。
- 调用者可显式传 `tabToken` 覆盖。

### 7. runtime hot reload

`mcp_main.ts` 支持 hot host：

- `McpToolHost` 读取 `src/mcp/hot_entry.ts`。
- 开发模式可 watch `src/mcp`。

## 示例

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "browser.query",
    "arguments": {
      "op": "entity",
      "businessTag": "order.list",
      "query": "table.rowCount"
    }
  }
}
```

## 限制

- HTTP transport 当前仅支持 request-response，不支持 SSE 增量流式。
- 返回体被压缩为 compact 格式，调试细节受 debug 开关控制。

## 禁止事项

- 禁止绕过 schema 直接执行未校验参数。
- 禁止把 MCP 视为第二套独立执行引擎。
