# Control Eval Protocol

## Purpose

Control channel is now a development-only local JavaScript eval entry.

This endpoint is a dangerous backdoor for debugging. It executes JS in the agent main process and can directly mutate real runtime objects.

## Safety Gate

Eval is disabled by default.

You must set `RPA_CONTROL_EVAL=1` to enable execution.

When disabled, response is:

- `ok: false`
- `error.code: ERR_CONTROL_EVAL_DISABLED`

Do not enable this in production.

## Transport

Protocol remains JSON Lines over the existing local control transport.

One request JSON object per line, one response JSON object per line.

## Request Shape

```json
{
  "id": "req-1",
  "source": "ctx.log('hello'); return 1",
  "timeoutMs": 1000,
  "workspaceName": "default",
  "input": { "x": 1 }
}
```

Fields:

- `id: string`
- `source: string` (JS snippet, supports `await`)
- `timeoutMs?: number`
- `workspaceName?: string`
- `input?: unknown`

## Response Shape

```json
{
  "id": "req-1",
  "ok": true,
  "result": 1,
  "logs": []
}
```

or

```json
{
  "id": "req-1",
  "ok": false,
  "logs": ["debug line"],
  "error": {
    "code": "ERR_CONTROL_EVAL_FAILED",
    "name": "TypeError",
    "message": "boom",
    "stack": "TypeError: boom\n ..."
  }
}
```

Fields:

- `id: string`
- `ok: boolean`
- `result?: unknown` (JSON-safe normalized)
- `logs: string[]`
- `error?: { code, name, message, stack }`

## Eval Context

`source` runs with:

- `ctx.deps`
- `ctx.workspaceRegistry`
- `ctx.config`
- `ctx.dispatch`
- `ctx.resolveWorkspace`
- `ctx.runStep`
- `ctx.runDsl`
- `ctx.log`
- `ctx.sleep`
- `ctx.state`
- `ctx.input`
- `ctx.workspaceName`

Notes:

- Context contains real runtime references (no deep copy).
- `ctx.state` is in-memory process state only; not persisted to disk.
- `ctx.log(...)` appends to current eval response `logs`.

## Result and Error Normalization

- Eval return value is normalized to JSON-safe output.
- Non-serializable values are summarized as strings.
- Error responses always include `name`, `message`, `stack`.

## Timeout and Limitations

`timeoutMs` is best-effort for async flows.

Synchronous infinite loops cannot be force-interrupted by this protocol.

Because eval runs on the main process, it can block the agent or corrupt runtime state.
