# Extension-Agent Communication Flow

This document describes the runtime communication and binding flow between browser pages, extension runtime, and the agent.

## Scope

- `start_extension` newtab bootstrap and workflow entry actions
- `extension` content script and service worker action forwarding
- `agent` action routing and `page_registry` token/workspace binding
- token claim lifecycle (`tab.init` + `tab.opened` + `bindPage`)

## Components

- `start_extension/src/entry/newtab.ts`
- `extension/src/entry/content.ts`
- `extension/src/background/*`
- `agent/src/index.ts`
- `agent/src/runtime/page_registry.ts`
- `agent/src/actions/workspace.ts`

## Message Model

All business communication uses Action protocol.

- request: `type = xxx.yyy`
- success reply: `type = xxx.yyy.result`, `replyTo=<request.id>`
- failure reply: `type = xxx.yyy.failed`, `replyTo=<request.id>`

No `{ ok, data }` transport wrapper is used across extension ↔ agent action channel.

## Token and Binding Lifecycle

### 1. Token intent creation (`tab.init`)

Caller:
- content script (`token_bridge.ensureTabTokenAsync`)
- start page (`newtab.ensureTabTokenFromAgent`)

Agent handler:
- `workspaceHandlers['tab.init']`

Behavior:
- Generates `tabToken`
- Creates pending claim in `page_registry.createPendingTokenClaim(...)`
- Stores claim metadata:
  - `tabToken`
  - `workspaceId` (if provided/inferred)
  - `source`
  - `url`
  - `createdAt`

### 2. Page discovery and runtime binding (`bindPage`)

When Playwright runtime discovers or binds a page:
- `page_registry.bindPage(page, hintedToken?)`

Behavior:
- Reads token from page/session if needed
- Registers `tokenToPage`
- If pending claim exists for token:
  - resolves target workspace (`claim.workspaceId` > active workspace > new shell)
  - binds token into workspace (`bindTokenToWorkspace`)
  - deletes pending claim

### 3. Ownership confirmation (`tab.opened`)

`tab.opened` is a binding lifecycle action and is routed specially.

Agent routing:
- `handleAction` in `agent/src/index.ts` short-circuits `ACTION_TYPES.TAB_OPENED`
- It bypasses normal `resolveActionTarget` path

Binding handler:
- `bindTabOpenedAction`
  - validates token/workspaceId
  - creates/refreshes pending claim
  - actively attempts `claimPendingToken(token)`
  - retries `bindTokenToWorkspace`
  - if still no page: returns accepted/deferred result (not hard failure)

## Why `tab.opened` bypasses normal target resolver

Normal action resolver assumes token already has workspace scope.

For first-time ownership binding, that assumption is often false:
- browser UI page can exist before token scope is materialized in agent registry
- `tab.opened` itself is the event that finalizes ownership

So `tab.opened` must not be treated as a normal already-bound action.

## End-to-End Flows

### Flow A: Content script bootstrap

1. content script sends `tab.init`
2. agent returns token and writes pending claim
3. content script stores token and sends hello/report/ping via extension SW
4. when page is bound in agent runtime, pending claim is consumed and token is attached to workspace

### Flow B: Start page workflow open

1. start page already has its own token
2. user clicks workflow open
3. start page calls `workflow.open`
4. start page calls `tab.opened` with:
   - current page token
   - target `workspaceId`
5. agent runs binding lifecycle path and confirms or defers claim

## Failure and Recovery Model

### Deferred binding

If token page is not yet discoverable by agent runtime at `tab.opened` time:
- agent keeps/updates pending claim
- returns `tab.opened.result` with deferred semantics
- later `bindPage` will consume claim and complete binding

### Expected transient logs

Temporary misses can appear before final claim succeeds when page discovery lags:
- token page not yet present in registry
- pending claim still waiting for `bindPage`

These should converge without terminal `ERR_BAD_ARGS` for `tab.opened`.

## Operational Notes

- Keep `tab.init` lightweight but always create pending claim.
- Keep `tab.opened` as binding lifecycle action (special routing).
- Do not force normal action-target resolution on initial binding actions.
- Prefer deterministic ownership through pending claim + bindPage consume path.
