# 协议文档

本文档定义仓库当前有效的协议合同。

## 1. 协议层次

当前协议分为 6 层：

1. WS Action 协议（extension <-> agent）
2. 内部 Step IR 协议（`runSteps` 输入输出）
3. Step 事件协议（`step.start` / `step.end`）
4. Trace 事件协议（`op.start` / `op.end`）
5. MCP stdio tool-call 协议（外部程序 <-> agent）
6. Script DSL 协议（`run_script.ts`，内部辅助层）

## 2. WS Action 协议

### 2.1 请求结构

```ts
{
  v: 1,
  id: string,
  type: string,
  tabToken?: string,
  scope?: {
    workspaceId?: string,
    tabId?: string,
    tabToken?: string
  },
  payload?: unknown,
  at?: number,
  traceId?: string
}
```

校验约束：

- `v` 必须为 `1`
- `id` 必须为非空字符串
- `type` 必须为非空字符串

代码来源：`agent/src/actions/action_protocol.ts`、`agent/src/index.ts`。

### 2.2 响应结构

成功：

```json
{ "type": "<action>.result", "replyTo": "<id>", "payload": { "ok": true, "data": {} } }
```

失败：

```json
{ "type": "error", "replyTo": "<id>", "payload": { "ok": false, "error": { "code": "ERR_*", "message": "...", "details": {} } } }
```

### 2.3 广播事件

当前 `agent/src/index.ts` 会广播：

- `workspace.changed`
- `page.bound`

示例：

```json
{ "type": "event", "event": "workspace.changed", "data": { "workspaceId": "...", "tabId": "...", "type": "tab.create" } }
```

### 2.4 支持的 action types

当前 action handler 来自：

- workspace：`workspace.list`、`workspace.create`、`workspace.setActive`
- tab：`tab.list`、`tab.create`、`tab.close`、`tab.setActive`
- record：`record.start`、`record.stop`、`record.get`、`record.clear`、`record.event`
- play：`play.start`、`play.stop`

代码来源：`agent/src/actions/workspace.ts`、`agent/src/actions/recording.ts`。

### 2.5 Action 错误码

```text
ERR_TIMEOUT
ERR_NOT_FOUND
ERR_STALE
ERR_UNSUPPORTED
ERR_ASSERTION_FAILED
ERR_DIALOG_BLOCKED
ERR_POPUP_BLOCKED
ERR_BAD_ARGS
```

代码来源：`agent/src/actions/error_codes.ts`。

## 3. Step IR 协议（内部）

`Step` 是 `runSteps` 使用的内部执行中间表示。

### 3.1 Step 结构

```ts
{
  id: string,
  name: StepName,
  args: StepArgs,
  meta?: {
    requestId?: string,
    source: 'mcp' | 'play' | 'script' | 'record',
    ts?: number
  }
}
```

当前 `StepName`：

- `browser.goto`
- `browser.go_back`
- `browser.reload`
- `browser.create_tab`
- `browser.switch_tab`
- `browser.close_tab`
- `browser.get_page_info`
- `browser.snapshot`
- `browser.take_screenshot`
- `browser.click`
- `browser.fill`
- `browser.type`
- `browser.select_option`
- `browser.hover`
- `browser.scroll`
- `browser.press_key`
- `browser.drag_and_drop`
- `browser.mouse`

完整参数定义见：`agent/src/runner/steps/types.ts`。

### 3.2 runSteps 请求/结果

请求：

```ts
{
  workspaceId: string,
  steps: StepUnion[],
  options?: {
    dryRun?: boolean,
    stopOnError?: boolean,
    maxConcurrency?: number
  }
}
```

结果：

```ts
{
  ok: boolean,
  results: Array<{
    stepId: string,
    ok: boolean,
    data?: unknown,
    error?: { code: string, message: string, details?: unknown }
  }>,
  trace?: { count?: number, lastEvents?: unknown[] }
}
```

## 4. Step 事件协议

`runSteps` 可通过 sink 输出 step 事件。

`step.start`：

```ts
{
  type: 'step.start',
  ts: number,
  workspaceId: string,
  stepId: string,
  name: StepName,
  argsSummary?: unknown
}
```

`step.end`：

```ts
{
  type: 'step.end',
  ts: number,
  workspaceId: string,
  stepId: string,
  name: StepName,
  ok: boolean,
  durationMs: number,
  error?: { code: string, message: string, details?: unknown }
}
```

来源：`agent/src/runner/run_steps.ts`。

## 5. Trace 协议

Trace 协议负责原子执行与观测。

### 5.1 Trace op 名称

`TraceOpName` 覆盖 tabs/page/a11y/locator/keyboard/mouse 等命名空间，例如：

- `trace.page.goto`
- `trace.page.snapshotA11y`
- `trace.locator.click`
- `trace.keyboard.press`
- `trace.mouse.action`

完整定义见：`agent/src/runner/trace/types.ts`。

### 5.2 ToolResult 结构

成功：

```ts
{ ok: true, data?: T }
```

失败：

```ts
{
  ok: false,
  error: {
    code: 'ERR_TIMEOUT' | 'ERR_NOT_FOUND' | 'ERR_AMBIGUOUS' | 'ERR_NOT_INTERACTABLE' | 'ERR_UNKNOWN',
    message: string,
    phase: 'trace',
    details?: unknown
  }
}
```

### 5.3 Trace 事件

`op.start`：

```ts
{ type: 'op.start', ts: number, op: TraceOpName, tags?: TraceTags, args?: unknown }
```

`op.end`：

```ts
{
  type: 'op.end',
  ts: number,
  op: TraceOpName,
  ok: boolean,
  durationMs: number,
  tags?: TraceTags,
  args?: unknown,
  result?: unknown,
  error?: ToolError
}
```

来源：`agent/src/runner/trace/types.ts`、`agent/src/runner/trace/tools.ts`。

## 6. MCP stdio tool-call 协议

### 6.1 运行方式

- 传输：stdio（`@modelcontextprotocol/sdk`）
- 服务入口：`agent/src/mcp_main.ts`
- 协议处理：`agent/src/mcp/server.ts`
- tool -> step 翻译：`agent/src/mcp/tool_handlers.ts`

### 6.2 Tool 参数合同

MCP tools 使用 `browser.*` 命名，且每个 tool 输入都要求 `tabToken`（用于 scope 解析）。

示例（`browser.goto`）：

```json
{ "tabToken": "tab-1", "url": "https://example.com", "timeout": 5000 }
```

完整 schema：`agent/src/mcp/schemas.ts`。

### 6.3 Tool 返回合同

handler 会返回 `runSteps` 风格结果，并序列化到 MCP `content[].text`：

```json
{
  "ok": true,
  "results": [
    { "stepId": "...", "ok": true, "data": {} }
  ]
}
```

失败时同结构返回 `ok: false` + `results/error`。

## 7. Script DSL 协议（内部）

`agent/src/script/run_script.ts` 当前支持：

- 直接传 `StepUnion[]`
- 行式 DSL：
  - `goto <url>`
  - `snapshot`
  - `click <a11yNodeId>`
  - `fill <a11yNodeId> <value>`

说明：

- DSL 会被编译为 `StepUnion[]`，并设置 `meta.source = 'script'`
- 未识别命令当前会降级为 `browser.snapshot`（v0 行为）

## 8. 兼容性与变更规则

协议变更时必须同步做三件事：

1. 更新本文档（`docs/PROTOCOL.md`）
2. 更新代码中的类型/Schema（`action_protocol.ts`、`steps/types.ts`、`trace/types.ts`、`mcp/schemas.ts`）
3. 更新相关测试：
   - `agent/tests/trace/*`
   - `agent/tests/runner/*`
   - `agent/tests/specs/*`
   - `agent/tests/config/*`
