---
name: rpa-browser-mcp
description: use for browsing and operating pages through the rpa-browser mcp. trigger when chatgpt needs to navigate tabs, inspect structured page state, operate stable nodes, inspect business entities, or complete browser workflows with low token cost. prefer snapshot and entity tools over screenshots, console, network, mouse, or javascript evaluation. follow the standard workflow: create tab, navigate, inspect with shallow snapshot, narrow with contain, act by nodeId first, then verify with snapshot or diff.
---

# RPA Browser MCP

Use structured tools first. Prefer stable node-based interaction over raw debugging or visual tools.

## Tool groups

### Tab and navigation

Use these to enter and manage the browsing session:

- `browser.create_tab`
- `browser.switch_tab`
- `browser.close_tab`
- `browser.goto`
- `browser.go_back`
- `browser.reload`
- `browser.get_page_info`

Default start:

1. `browser.goto` directly; when the workspace has no tab, it starts the browser and claims the existing startup tab.
2. `browser.snapshot` with a small depth.

Use `browser.create_tab` only when an additional tab is required. If no tab exists, `browser.create_tab` also claims the startup tab instead of opening a redundant second tab.

Do not begin with debugging tools.

### Structured inspection

Primary inspection tools:

- `browser.snapshot`
- `browser.get_content`

`browser.snapshot` is the default way to inspect a page.

Important options:

- `mode`: choose `overview`, `interaction`, `annotation`, `debug`, or `full`
- `depth`: start shallow; use `-1` only when exhaustive descendants are required
- `contain`: narrow to one canonical subtree instead of expanding the whole page
- `filter`: narrow by `role`, `text`, or `interactive`
- `diff`: compare against the previous snapshot with the same mode and scope
- `refresh`: force a fresh PageSession capture only when current facts may be stale

Mode guidance:

- `overview`: first inspection; compact structural and FeatureCover view
- `interaction`: retain actionable controls for acting on the page
- `annotation`: inspect components, semantic bindings, and geometry
- `debug`: inspect scope, completeness, evidence, and diagnostics
- `full`: exhaustive canonical detail; use only when narrower modes are insufficient

Rules:

- the first snapshot should usually use `mode: 'overview'` with a shallow `depth`
- use `mode: 'interaction'` before a form or control workflow
- use `contain` for detail, not global deep expansion
- use `diff` after actions to verify what changed
- use `get_content` only when snapshot returns a content ref instead of inline text

### What `diff` is for

Use `browser.snapshot({ diff: true })` after meaningful actions when checking local UI changes, such as:

- checkbox or radio changes
- form validation after fill or submit
- dialog open or close
- row expansion
- button-triggered local changes

`diff` returns the minimal changed subtree since the last snapshot. For small local changes, it is often cheaper and clearer than another broad snapshot.

### Business entity tools

Use these on tables, forms, dialogs, cards, lists, and other business-heavy pages:

- `browser.entity`
- `browser.query` with `op: 'entity'`
- `browser.query` with `op: 'entity.target'`

Rules:

- on large business pages, prefer `browser.entity` with `op: 'list'` before reading raw tree details
- use `browser.entity` with `op: 'find'` when searching by name, kind, or business tag
- use `browser.entity` with `op: 'get'` when you already have a `nodeId`
- use `browser.entity` with `op: 'add'|'delete'|'rename'` only when entity interpretation itself needs correction

Entity kinds include:

- `form`
- `table`
- `dialog`
- `list`
- `panel`
- `toolbar`
- `kv`

For forms and tables, entity tools are often the fastest path.

### Action tools

Normal interaction tools:

- `browser.click`
- `browser.fill`
- `browser.type`
- `browser.select_option`
- `browser.batch`
- `browser.hover`
- `browser.scroll`
- `browser.press_key`
- `browser.drag_and_drop`

Low-level fallback:

- `browser.mouse`

## Targeting priority

When a tool supports multiple targeting styles, use this order:

1. `nodeId`
2. `selector`
3. coordinates through the tool that explicitly owns a coordinate field

Rules:

- prefer `nodeId` whenever available; it is the canonical and more stable target
- fall back to `selector` only when `nodeId` is unavailable or unusable
- direct `browser.click`, `browser.fill`, `browser.type`, `browser.select_option`, `browser.hover`, and targeted `browser.press_key` use `nodeId` or `selector`
- use `browser.mouse` for direct coordinate-level mouse operations
- `browser.drag_and_drop` uses `sourceNodeId` or `sourceSelector`, then `destNodeId`, `destSelector`, or `destCoord`
- a `browser.batch` click may use its batch-specific `coord` field, but node-based targeting remains preferred
- avoid coordinate operations unless a higher-level canonical action cannot express the interaction

Interaction preferences:

- prefer `click` over `mouse`
- prefer `fill` over `type` when direct assignment is enough
- use `type` only when key-by-key typing matters
- prefer `select_option` for native selects
- when applying many form actions in one view, prefer `browser.batch` to reduce round trips
- use `hover` only when hover state is required
- use `scroll` only to reveal relevant content
- use `press_key` for Enter, Tab, Escape, shortcuts, or focused control interaction

### Debugging and escape hatches

Avoid these unless structured tools are insufficient:

- `browser.evaluate`
- `browser.read_console`
- `browser.read_network`
- `browser.take_screenshot`
- `browser.mouse`

Use them only for:

- testing MCP behavior
- diagnosing unexpected runtime or framework issues
- checking console or network failures after normal interaction fails
- cases where visual evidence is required and snapshot cannot explain the state
- true last-resort interaction

Extra rules:

- `browser.evaluate` is not a normal browsing tool
- `browser.take_screenshot` should also be rare; prefer structured snapshot first
- console and network reads are diagnostic tools, not default observation tools

If `browser.evaluate` must be used:

- keep the expression minimal
- avoid page mutation unless necessary
- when mutating, set `mutatesPage` appropriately

## Default workflow

Follow this sequence unless there is a strong reason not to:

1. `browser.goto` (automatically claims the startup tab when the workspace is empty)
2. `browser.snapshot` with `mode: 'overview'` and small `depth`
3. `browser.snapshot` with `contain` for the relevant subtree
4. optionally use entity tools if the page is business-heavy
5. act with `click`, `fill`, `select_option`, or `press_key`
6. verify with `browser.snapshot`, often with `diff: true`

Call `browser.create_tab` only for an additional independent tab.

Do not jump straight to evaluate, screenshot, console, or network.

## Recommended workflows

### Open and inspect a page

1. `browser.goto` directly
2. shallow `browser.snapshot` with `mode: 'overview'`
3. focused `browser.snapshot` with `contain`

Use the sequence: overview first, subtree second, action third.

### Work on a form

1. open page
2. locate the form via `snapshot` or `browser.entity(op='list')`
3. narrow using `contain`
4. act with `fill`, `select_option`, `press_key`, or `click`
5. verify with `snapshot`
6. if checking local changes, prefer `snapshot({ diff: true })`

### Work on a large business page

1. open page
2. take a shallow `snapshot` with `mode: 'overview'`
3. call `browser.entity` with `op: 'list'`
4. use `browser.entity` with `op: 'find'` or `op: 'get'`
5. inspect only the relevant subtree
6. act by `nodeId` first when possible

### Verify a small UI change

Use:

1. snapshot before action
2. perform action
3. `browser.snapshot({ diff: true })`

This is well suited for checkboxes, expansion panels, inline validation, and other local state changes.

### Diagnose only when normal tools fail

Only then use:

1. `browser.read_console`
2. `browser.read_network`
3. `browser.evaluate`
4. `browser.take_screenshot`

Keep this path rare.

## Core rules

### Prefer structure over pixels

Prefer:

- `browser.snapshot`
- `browser.get_content`
- entity tools

Avoid relying on:

- screenshots
- console logs
- network logs
- arbitrary JavaScript evaluation

### Keep snapshots cheap

Always reduce scope:

- set `depth`
- use `contain`
- use `filter` when helpful
- avoid repeated deep full-page snapshots

Bad pattern:

- full-page deep snapshot first
- repeated full-page snapshots for every small question

Good pattern:

- shallow overview
- focused subtree
- action
- focused verification
- use `diff` for small changes

### Inspect before acting

Before click, fill, type, or select:

- identify the correct subtree
- prefer entity tools for business structures
- prefer `nodeId`
- fall back to selector only when needed

### Verify after meaningful actions

After actions that may change page state, verify again:

- click
- fill
- type
- select
- press_key
- drag_and_drop

Prefer `diff` for localized changes and a normal snapshot for broader changes.

## Decision ladder

Use this order:

1. tab and navigation tools
2. `browser.snapshot` with `mode: 'overview'` and small `depth`
3. `browser.snapshot` with the appropriate mode and `contain`
4. entity tools
5. action tools with `nodeId` first
6. `browser.get_content`
7. debugging tools as a last resort

Targeting ladder:

1. `nodeId`
2. `selector`
3. `browser.mouse` coordinates, or `destCoord` for a drag destination

## `ERR_AMBIGUOUS` handling

When an action returns `ERR_AMBIGUOUS`, do not jump to `evaluate` immediately.

Use this recovery sequence:

1. take or refresh a shallow `snapshot` and locate the nearest stable container
2. narrow with `contain` and use `mode: 'interaction'` for actionable targets
3. retry with the `nodeId` from the narrowed snapshot
4. if still ambiguous, use `browser.entity` with `op: 'list'` or `op: 'find'` to lock onto the correct form/table/dialog region
5. only then fall back to `selector`, preferably scoped under that container
6. after success, verify with `snapshot({ diff: true })` when the change is local

Heuristics:

- dynamic form pages often reorder wrappers between steps; refresh snapshot before reusing old ids
- avoid broad selectors like global `select`, `input`, `button`
- if multiple similar controls exist, prefer selectors constrained by nearby label text or container scope
- keep one stable `contain` root for the whole mini-workflow to reduce index drift

## Low-token mode

When the goal is throughput and low token usage:

1. one shallow snapshot with `mode: 'overview'`
2. one focused snapshot with `mode: 'interaction'`, `contain`, and `filter.interactive=true`
3. one `browser.batch` call for all fill/select/click actions in that view
4. one verification snapshot (or `diff` if local)

Avoid per-field snapshot loops unless there is a failure.

## Anti-patterns

Do not:

- start with `browser.evaluate`
- start with `browser.take_screenshot`
- use `browser.mouse` when `browser.click` works
- ignore `depth`
- inspect the whole page deeply when one subtree is enough
- use selector when a good `nodeId` is already available
- use coordinates unless both `nodeId` and `selector` are not viable
- use console or network reads as the main browsing workflow
- forget to verify with snapshot or diff after changing state
- retry the same ambiguous selector repeatedly without re-snapshot + contain narrowing

## Goal

Use rpa-browser MCP in a way that is:

- structured
- low-token
- node-first
- stable
- business-oriented
- easy to verify
