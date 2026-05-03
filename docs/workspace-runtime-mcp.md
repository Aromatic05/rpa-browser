# Workspace Runtime — MCP Service Lifecycle

## Workspace aggregate

```
workspace
├─ workflow
├─ checkpoint
├─ entityRules
├─ record
├─ dsl
├─ runner
├─ tabRegistry
├─ mcp          ← this phase
└─ agent        ← later
```

## Workspace service lifecycle

Each workspace carries a `serviceLifecycle` (see `agent/src/runtime/service.ts`).
Services expose `start()`, `stop()`, and `status()`. The lifecycle manages a flat
set of services identified by `WorkspaceServiceName`.

Service names: `mcp` (this phase), `agent` (later).

Status values: `stopped`, `starting`, `running`, `stopping`, `failed`.

## Port allocator

`agent/src/runtime/port_allocator.ts` maps `(workspaceName, serviceName)` to a
port. It detects port conflicts, auto-increments, and releases ports on `stop()`.
The allocator has no MCP or agent knowledge and does not start servers.

## workspace.mcp

`agent/src/mcp/service.ts` + `agent/src/mcp/runtime.ts` form the MCP service.
It uses the port allocator, creates a workspace-scoped MCP server, and
registers with `workspace.serviceLifecycle`.

`agent/src/mcp/control.ts` handles `mcp.start`, `mcp.stop`, `mcp.status`.
These are **workspace actions** — they require `workspaceName` in the action
envelope and reject `payload.workspaceName`.

MCP tool handlers (see `agent/src/mcp/tool_handlers.ts`) are workspace-scoped:
they depend on `RuntimeWorkspace` (for `tabRegistry`, entity rules, etc.) and
do not hold global `workspaceRegistry` or `pageRegistry` references directly.

MCP tool names (`browser.goto`, `browser.click`, …) remain unchanged.
They are not registered as action types (`mcp.*` actions are the action-level
surface; `browser.*` stays in the MCP tool namespace).

## mcp_main.ts

`agent/src/mcp_main.ts` is the standalone entry point. It creates a port
allocator, a `WorkspaceRegistry`, and a default workspace, then starts
`workspace.mcp` through the service lifecycle. It no longer assembles
a global MCP server directly.

## What is not in this phase

- `workspace.agent` is not implemented. It will reuse the same service
  lifecycle and port allocator.
