# ControlRpcProtocol

## 概述

Control RPC 是 agent 本地控制通道，用于脚本化调用 action、dsl、browser tool。对应 `agent/src/control/*`。

## 规范

### 1. 请求协议

```ts
{
  id: string,
  method: string,
  params?: unknown
}
```

### 2. 响应协议

成功：

```ts
{ id: string, ok: true, result?: unknown }
```

失败：

```ts
{ id: string, ok: false, error: { code, message, details? } }
```

### 3. 方法集合

router 当前注册：

- `agent.ping`
- `dsl.run`
- `browser.query`
- `browser.click`
- `browser.fill`
- `browser.snapshot`
- `action.call`

### 4. 错误码

- `ERR_CONTROL_BAD_JSON`
- `ERR_CONTROL_BAD_REQUEST`
- `ERR_CONTROL_METHOD_NOT_FOUND`
- `ERR_CONTROL_INTERNAL`

### 5. 桥接规则

- `action.call`：把 params 转成 Action，再交给 control dispatcher。
- `dsl.run`：调用 `runDslSource`，返回 `scope/diagnostics`。
- `browser.*`：通过 DSL task runner 单步执行 Step。

### 6. workspace 注入

router 支持默认 `workspaceId` 注入；当 params 未提供 workspaceId 时会补入上下文值。

## 示例

```json
{"id":"1","method":"agent.ping"}
```

```json
{"id":"2","method":"action.call","params":{"type":"workflow.status","payload":{"scene":"order_scene"}}}
```

## 限制

- browser tool 仅暴露 `query/click/fill/snapshot` 四类。
- 控制层不等价于 MCP 全量工具集。

## 禁止事项

- 禁止发送非 JSON 行协议。
- 禁止在 control 层扩展未实现方法并写入文档为已实现。
