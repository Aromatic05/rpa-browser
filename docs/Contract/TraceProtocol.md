# TraceProtocol

## 概述

Trace 是原子操作与观测协议层，屏蔽 Playwright 异常并输出统一事件。对应 `agent/src/runner/trace/*`。

## 规范

### 1. TraceOpName

当前实现原子操作前缀：

- `trace.tabs.*`
- `trace.page.*`
- `trace.a11y.*`
- `trace.locator.*`
- `trace.keyboard.*`
- `trace.mouse.*`

### 2. ToolResult

```ts
{ ok: true, data?: T } | { ok: false, error: ToolError }
```

`ToolError`：

- `code`: `ERR_TIMEOUT | ERR_NOT_FOUND | ERR_AMBIGUOUS | ERR_BAD_ARGS | ERR_NOT_INTERACTABLE | ERR_UNKNOWN`
- `phase`: 固定 `trace`

### 3. 事件协议

- `op.start`：开始事件。
- `op.end`：结束事件。

`op.end` 字段包含：`ok/durationMs/result?/error?`。

### 4. traceCall 行为

- 统一写 start/end 到 sinks。
- 不抛异常，统一映射到 `ToolError`。
- 触发 hooks：`beforeOp/afterOp/onError`。

### 5. TraceContext

- `sinks`
- `hooks`
- `cache`
- `tags`（`workspaceId/tabToken`）

### 6. Sink 协议

- `MemorySink`：内存缓存事件。
- `ConsoleSink`：控制台输出。
- `FileSink`：JSONL 文件落盘。

## 示例

```ts
const result = await traceCall(ctx, { op: 'trace.page.goto', args: { url } }, async () => {
  await page.goto(url);
});
```

## 限制

- Trace 层不做高阶重试与策略决策。
- 错误映射只做最小语义归类。

## 禁止事项

- 禁止在 Trace 层塞入 workflow/DSL 业务逻辑。
