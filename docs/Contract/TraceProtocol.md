# Trace 协议

## 概述

Trace 层负责浏览器原子操作的观测与统一结果封装。核心代码：`agent/src/runner/trace/types.ts`、`trace_call.ts`、`index.ts`。

## Trace 与 Step 的边界

- Step：业务动作单元（`browser.click`、`browser.query`）。
- Trace：Step 内部调用的原子操作（`trace.locator.click`、`trace.page.goto`）。

Step 可以包含策略与编排；Trace 不负责策略。

## traceCall 事件时序

每次原子调用固定时序：

1. 生成 `op.start`
2. 执行原子操作
3. 生成 `op.end`
4. 将事件写入 sinks，并触发 hooks

失败时 `op.end.ok=false`，携带映射后的 `ToolError`。

## TraceOpName 主要类别

- `trace.tabs.*`
- `trace.page.*`
- `trace.a11y.*`
- `trace.locator.*`
- `trace.keyboard.*`
- `trace.mouse.*`

具体联合类型以 `types.ts` 为准。

## ToolResult 与 StepResult 边界

- `ToolResult`：Trace 层返回，`{ok,data}` 或 `{ok:false,error}`。
- `StepResult`：Step executor 返回，包含业务语义与更高层错误上下文。

Trace 不直接返回 StepResult。

## Trace cache

`TraceCache` 当前包含：

- `a11ySnapshotRaw`
- `a11yNodeMap`
- `a11yTree`
- `latestSnapshot`
- `snapshotSessionStore`
- `consoleEntries`
- `networkEntries`

缓存仅用于优化观测与查询，不承诺跨进程持久化。

## sink 与 hooks

- `TraceSink.write(event)`：事件落地。
- `TraceHooks.beforeOp/afterOp/onError`：观测扩展点。

`FileSink` 负责 JSONL 落盘（每行一个 `TraceEvent`）。

## FileSink JSONL 行格式

```json
{"type":"op.start","ts":1710000000000,"op":"trace.page.goto","tags":{"workspaceName":"ws-1"}}
```

```json
{"type":"op.end","ts":1710000000100,"op":"trace.page.goto","ok":true,"durationMs":100}
```

## Trace 错误映射

`traceCall` 内会做最小错误映射：

- 超时 -> `ERR_TIMEOUT`
- 参数/可交互性问题 -> `ERR_BAD_ARGS`
- 多目标歧义 -> `ERR_AMBIGUOUS`
- 未识别异常 -> `ERR_UNKNOWN`

## 协议边界（必须遵守）

Trace 层不负责：

- 重试策略
- DSL 语法
- checkpoint 模板流程

这些属于上层 runner/DSL/checkpoint。

## 与 Step 错误码关系

Step 可能将 Trace 错误上抛或重映射，但不能修改 Trace 事件事实。

## 禁止事项

- 禁止在 Trace 层注入业务分支逻辑。
- 禁止绕过 `traceCall` 直接调用底层操作并丢失事件。
