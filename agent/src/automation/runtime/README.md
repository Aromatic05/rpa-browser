# Runtime

The **runtime** layer hosts long-lived browser-side objects: workspaces, tabs, pages,
and execution bindings. It is the boundary between the control plane (action dispatch)
and the Playwright browser.

## Naming conventions

| Term | Meaning |
|------|---------|
| `WorkspaceTabs` | Tab bookkeeping for a single workspace: create, close, activate, report, ping, reassign. Holds the real `Page` handle. |
| `WorkspaceRouter` | Per-workspace action dispatcher. Routes by action-type prefix to the correct domain control. |
| `WorkspaceRegistry` | Creates, caches, and enumerates `RuntimeWorkspace` instances. Owns the active-workspace pointer. |
| `ExecutionBindings` | Maps `(workspaceName, tabName)` → `Page` + trace tooling. Used by step executors at run time. |
| `PageRegistry` | Low-level Page binding infrastructure. Used by `WorkspaceTabs` internally. |
| `McpControl` | Thin wrapper around the MCP `WorkspaceService`, exposing `start()`, `stop()`, `status()`. |
| `ContextManager` | Lazy-initialises and caches the Playwright `BrowserContext` (CDP or extension mode). |

## Workspace aggregate

`RuntimeWorkspace` is the aggregate root for a single workflow workspace:

```
RuntimeWorkspace
├── name: string
├── workflow: Workflow
├── tabs: WorkspaceTabs
├── record: RecordControl
├── dsl: DslControl
├── checkpoint: CheckpointControl
├── runner: RunnerControl
├── mcp: McpControl
├── router: WorkspaceRouter
├── createdAt: number
└── updatedAt: number
```

Each domain control is created eagerly when the workspace is constructed
(`createRuntimeWorkspace`). The router dispatches inbound actions by prefix:

| Prefix | Domain |
|--------|--------|
| `tab.*` | Router-internal (tabs) |
| `record.*` / `play.*` | RecordControl |
| `checkpoint.*` | CheckpointControl |
| `dsl.*` | DslControl |
| `task.run.*` | RunnerControl |
| `mcp.*` | McpControl |
| `workspace.setActive` | Router-internal (registry) |

## Directory layout

```
runtime/
├── browser/           # ContextManager, PageRegistry (Playwright infrastructure)
├── execution/         # ExecutionBindings (page → tooling mapping)
├── service/           # WorkspaceService types, PortAllocator
└── workspace/         # RuntimeWorkspace, WorkspaceRouter, WorkspaceTabs, WorkspaceRegistry
```
