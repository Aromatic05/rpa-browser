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

The MCP implementation belongs entirely to `workspace.mcp` — there is no
standalone global MCP server. The legacy global MCP server (`agent/src/mcp/server.ts`)
has been deleted.

`agent/src/mcp/service.ts` + `agent/src/mcp/runtime.ts` form the MCP service.
It uses the port allocator, creates a workspace-scoped MCP server via
`agent/src/mcp/server_runtime.ts`, and registers with `workspace.serviceLifecycle`.

`agent/src/mcp/control.ts` handles `mcp.start`, `mcp.stop`, `mcp.status`.
These are **workspace actions** — they require `workspaceName` in the action
envelope and reject `payload.workspaceName`.

### Tool handlers

MCP tool handlers are defined in `agent/src/mcp/tool_handlers.ts`.
They are workspace-scoped:

- The only deps type is `WorkspaceMcpToolDeps`, with `workspace: RuntimeWorkspace`
  as the core dependency.
- `createWorkspaceToolHandlers(deps)` is the only handler factory.
- Handlers do **not** hold `workspaceRegistry` or `pageRegistry` references.
- Tab resolution uses `workspace.tabRegistry` only.
- `McpToolDeps` and `createToolHandlers` have been removed.

### Tab bootstrap

MCP tool handlers bootstrap tabs on demand when a tool is invoked and no
matching tab exists. The bootstrap boundary is:

- `RuntimeWorkspace.getPage(tabName, startUrl?)` — workspace-scoped page
  acquisition, bound at workspace creation time from `pageRegistry.getPage`.
- `WorkspaceMcpToolDeps.getPage` — optional field that carries the workspace
  `getPage` into tool handlers. When absent, tab bootstrap throws
  `"cannot bootstrap tab: getPage not provided"`.
- `createWorkspaceMcpRuntime` (in `agent/src/mcp/runtime.ts`) passes
  `deps.workspace.getPage` to `createWorkspaceToolHandlers`, wiring the
  workspace-scoped page acquisition into MCP tool handlers.

Bootstrap flow (`resolveOrBootstrapScopeWs` in `agent/src/mcp/tool_handlers.ts`):

1. If `tabName` is given and the tab exists in `workspace.tabRegistry`, set
   it as active and return.
2. If `tabName` is absent, resolve from the active tab — throw
   `"active tab not found"` if there is no active tab.
3. If `allowBootstrap` is disabled, throw `"tab not found"`.
4. If `deps.getPage` is not provided, throw
   `"cannot bootstrap tab: getPage not provided"`.
5. Call `deps.getPage(tabName)` to acquire a real `Page`.
6. If the tab was registered concurrently, bind the `Page`; otherwise create
   the tab entry in `workspace.tabRegistry`.
7. Set the tab as active in `workspace.tabRegistry`.

Key invariants:

- Bootstrap never falls back to a global registry. If `getPage` is missing,
  the error is explicit and the call fails.
- `tool_handlers.ts` does not import `PageRegistry` or `WorkspaceRegistry`.
- `getPage` is provided by the caller (MCP runtime or test), never resolved
  internally.
- `browser.create_tab` and `browser.goto` both use the same bootstrap path.

### Tool names

MCP tool names (`browser.goto`, `browser.click`, …) remain unchanged.
`browser.*` StepNames are unchanged. `browser.*` are not registered as
action types — only `mcp.*` actions are the action-level surface;
`browser.*` stays in the MCP tool namespace.

### Tool registry

`agent/src/mcp/tool_registry.ts` uses `createWorkspaceToolHandlers` and
`WorkspaceMcpToolDeps`. The `browser.*` tool specs are unchanged.

## mcp_main.ts

`agent/src/mcp_main.ts` is the standalone entry point for workspace.mcp.
It creates a port allocator, a `WorkspaceRegistry`, and a default workspace,
then starts `workspace.mcp` through `workspace.serviceLifecycle.start('mcp')`.

## What is not in this phase

- `workspace.agent` is not implemented. It will reuse the same service
  lifecycle and port allocator.
