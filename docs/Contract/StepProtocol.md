# StepProtocol

## 概述

Step 是 agent 内部统一执行单元，服务于 MCP、DSL、record/play、control-rpc。对应 `agent/src/runner/steps/types.ts` 与 `agent/src/runner/run_steps*.ts`。

## 规范

### 1. Step 结构

```ts
{
  id: string,
  name: StepName,
  args: StepArgsMap[StepName],
  meta?: StepMeta,
  resolve?: StepResolve
}
```

### 2. StepName

当前实现包含：

- 导航/页签：`browser.goto/go_back/reload/create_tab/switch_tab/close_tab/get_page_info/list_tabs`
- 采集/调试：`browser.snapshot/capture_resolve/get_content/read_console/read_network/evaluate/take_screenshot`
- 交互：`browser.click/fill/type/select_option/hover/scroll/press_key/drag_and_drop/mouse`
- 业务：`browser.entity/query/assert/compute/checkpoint`

### 3. StepMeta

`meta.source` 允许值：

- `mcp`
- `play`
- `script`
- `record`
- `control-rpc`
- `dsl`

其他字段：`ts/workspaceId/tabId/tabToken/tabRef/urlAtRecord`。

### 4. StepResolve

```ts
{
  hint?: ResolveHint,
  policy?: ResolvePolicy
}
```

- `resolve` 是 runtime-only。
- 持久化应写在 `step_resolve.yaml`，通过 `resolveId` 注入。

### 5. runSteps 请求协议

`run_steps_types.ts` 请求：

- `runId`
- `workspaceId`
- `stepsQueue`
- `resultPipe`
- `signalChannel`
- `stepResolves?`
- `stopOnError?`
- `onCheckpoint?`

### 6. 步骤事件协议

- `step.start`
- `step.end`

字段包含 `workspaceId/stepId/name/ok/durationMs/error`。

### 7. 结果协议

- 单步结果：`StepResult { stepId, ok, data?, error? }`
- 运行结果：`RunStepsResult { ok, results[], trace? }`
- streaming 结果：`ResultPipe` + `cursor`

### 8. 信号协议

`RunSignal`：

- `halt`
- `suspend`
- `continue`
- `flush`
- `checkpoint`

### 9. checkpoint 交互

- step 失败时进入 checkpoint 流程。
- 折叠结果后再写回 pipe。
- `stopOnError=true` 时失败终止 run。

## 示例

```ts
const step = {
  id: 's1',
  name: 'browser.click',
  args: { selector: '#submit' },
  meta: { source: 'dsl', workspaceId: 'workflow:order_scene' }
};
```

## 限制

- 并非所有 StepName 支持 `resolveId` 注入。
- `resolve + resolveId` 同时存在会报 `ERR_BAD_ARGS`。

## 禁止事项

- 禁止把 Step 当作跨端协议直接传给 extension。
- 禁止将 `meta/resolve` 直接写入 core `steps.yaml`。
