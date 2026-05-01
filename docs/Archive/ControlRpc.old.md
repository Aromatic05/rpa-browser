# Control RPC

Control RPC 是 agent 的本地控制面，用来连接已经运行中的 agent 进程，让 AI、CLI、测试脚本实时控制 agent，而不是每次都重启进程。

它不是 Action 协议。

- Action 协议仍然只用于 `extension ↔ agent`
- Control RPC 只是本地 request/response RPC 包装
- `action.call` 只是复用既有 Action handler，不会把 Action 协议改成 RPC

## Transport

- Linux/macOS 使用 Unix domain socket
- Windows 使用 Named Pipe

默认 endpoint：

- Windows: `\\.\pipe\rpa-browser-agent`
- Linux/macOS: 优先 `$XDG_RUNTIME_DIR/rpa-browser/agent.sock`
- fallback: `/tmp/rpa-browser-<uid>/agent.sock`

## Framing

协议使用 JSON line，一行一个请求或响应。

请求：

```json
{"id":"1","method":"agent.ping","params":{}}
```

成功响应：

```json
{"id":"1","ok":true,"result":{"ok":true,"ts":1710000000000}}
```

失败响应：

```json
{"id":"1","ok":false,"error":{"code":"ERR_CONTROL_METHOD_NOT_FOUND","message":"control method not found: x"}}
```

## Methods

- `agent.ping`
- `dsl.run`
- `browser.query`
- `browser.click`
- `browser.fill`
- `browser.snapshot`
- `action.call`

其中：

- `dsl.run` 复用 `runDslSource`
- `browser.*` 通过 DSL task runner 执行单 step
- `action.call` 复用现有 Action dispatch/handler 系统

## Examples

```json
{"id":"1","method":"agent.ping","params":{}}
```

```json
{"id":"2","method":"browser.click","params":{"workspaceName":"ws","args":{"nodeId":"xxx"}}}
```

```json
{"id":"3","method":"dsl.run","params":{"workspaceName":"ws","source":"click input.submit","input":{"submit":"submit-btn"}}}
```

## CLI

内置 control CLI：

```bash
pnpm -C agent control ping
```

```bash
pnpm -C agent control dsl \
  --workspace ws-demo \
  --source 'let buyer = query entity.target "order.form" { kind: "form.field" fieldKey: "buyer" }'
```

```bash
pnpm -C agent control dsl \
  --workspace ws-demo \
  --file ./fixtures/order.dsl \
  --input '{"user":{"name":"alice"}}'
```

```bash
pnpm -C agent control tool click \
  --workspace ws-demo \
  --args '{"nodeId":"submit-btn"}'
```

```bash
pnpm -C agent control tool browser.snapshot \
  --workspace ws-demo \
  --args '{"includeA11y":true}'
```

```bash
pnpm -C agent control action workspace.list
```

```bash
pnpm -C agent control action task.run.poll \
  --payload '{"runId":"run-1"}'
```

可选参数：

- `--endpoint <path>`: 覆盖默认 control endpoint
- `--timeout-ms <ms>`: 覆盖请求超时
