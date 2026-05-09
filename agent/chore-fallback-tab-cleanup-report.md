# Replay Fallback Tab Cleanup — Acceptance Report

## Modified Files

### Core replay logic
- `src/record/replay.ts` — removed `scanUnboundCreatedTabs`, `runtimeTabNamesFromBindings`;
  tightened `switch_tab`, `close_tab`, `create_tab` binding checks;
  lifecycle steps no longer fall back to `recordedActiveTabName`.

### Execution bindings
- `src/runtime/execution/bindings.ts` — removed fallback tab resolution in `resolveBinding`;
  removed auto-selection of next tab on page close.

### Test files
- `tests/config/replay_cold.test.ts` — 18 new tests; all use canonical `{ id, name, args }` format.
- `tests/runtime/workspace_tabs_execution_bindings.test.ts` — 3 new tests for binding resolution.
- `tests/config/recording_state.test.ts` — replaced `tabRef` with `tabName` in test fixtures.

## Deleted Fallback Tab Paths

| # | Path | Location |
|---|------|----------|
| 1 | `scanUnboundCreatedTabs` — auto-discovered unbound runtime tabs for create_tab | `src/record/replay.ts` (removed) |
| 2 | `runtimeTabNamesFromBindings` — helper for scanUnboundCreatedTabs | `src/record/replay.ts` (removed) |
| 3 | `resolveBinding` first-tab fallback — returned first workspace tab when no active binding | `src/runtime/execution/bindings.ts:130-136` (removed) |
| 4 | Page close auto-select next tab — `activeTabs.set(workspaceName, nextTab)` on close | `src/runtime/execution/bindings.ts:86-91` (removed) |
| 5 | close_tab silent success for unbound recorded tab — `upsertTabBinding(... closed: true)` | `src/record/replay.ts:381-383` (removed, now returns TAB_NOT_BOUND) |
| 6 | Lifecycle step fallback to `recordedActiveTabName` when `args.tabName` missing | `src/record/replay.ts:337` (removed) |

## Deleted / Updated Invalid Tests

| Test | File | Action |
|------|------|--------|
| `resolveBinding falls back to remaining tab when active is unset` | workspace_tabs_execution_bindings.test.ts | Replaced: now expects `no active binding` error |
| close_tab with `tabRef` in args | recording_state.test.ts | Fixed: `tabRef` → `tabName` |
| switch_tab with `tabRef` in args | recording_state.test.ts | Fixed: `tabRef` removed |

## Retained Minimal Tests (replay_cold.test.ts)

| # | Test | Verified Behavior |
|---|------|-------------------|
| 1 | canonical persisted replay follows recorded tab bindings | create_tab → switch → goto → click full flow |
| 2 | canonical persisted replay fails mismatched created tab effect | URL mismatch → TAB_EFFECT_MISMATCH |
| 3 | canonical persisted replay actively creates only when no created tab effect exists | Empty effect → executor (trace.tabs.create) |
| 4 | normal click without recordedActiveTabName fails | TAB_NOT_BOUND |
| 5 | normal click with recordedActiveTabName but no binding fails | TAB_NOT_BOUND |
| 6 | create_tab does not auto-bind to unbound runtime tab present in workspace | No URL-based auto-binding |
| 7 | create_tab does not auto-bind to runtime tab with same name | No name-based auto-binding |
| 8 | create_tab does not auto-bind to active runtime tab | No active-tab fallback |
| 9 | switch_tab succeeds for bound open tab | Explicit binding works |
| 10 | switch_tab fails for unbound recorded tab | TAB_NOT_BOUND |
| 11 | switch_tab fails for closed binding | TAB_NOT_BOUND |
| 12 | switch_tab does not create a new runtime tab | No create_tab call |
| 13 | normal step uses new recordedActiveTabName after switch_tab | Active tab update |
| 14 | close_tab succeeds for closed binding (idempotent) | Idempotent close |
| 15 | close_tab fails for unbound recorded tab | TAB_NOT_BOUND |
| 16 | close_tab does not close active tab as fallback | No implicit close |
| 17 | close_tab does not implicitly switch recordedActiveTabName | Active cleared, not switched |
| 18 | create_tab fails without args.tabName | TAB_NOT_BOUND |
| 19 | create_tab successfully establishes a new binding via executor | Binding after trace.tabs.create |
| 20 | create_tab URL mismatch prevents trace.tabs.create execution | Mismatch → no executor call |
| 21 | create_tab does not change recordedActiveTabName | Active unchanged |

## Codebase Search Results

| Pattern | Result |
|---------|--------|
| `tabRef` in replay.ts | Only in manifest initialization (`recordingManifest.initialTabs[].tabRef`) — recording metadata, not step data |
| `create_tab.url` in steps types | Not found |
| `switch_tab.tabUrl` in steps types | Not found |
| `meta.tabName` in replay.ts | Not found — replay core does not read `Step.meta` |
| `meta.urlAtRecord` in replay.ts | Not found |
| `fallback tab` in src/ | Not found |
| `scanUnboundCreatedTabs` | Removed |
| `runtimeTabNamesFromBindings` | Removed |

## Verification Summary

- [x] replay does not auto-bind via URL matching
- [x] replay does not auto-bind via runtime tab name matching
- [x] replay does not guess recorded tab from active runtime tab
- [x] replay does not guess recorded tab from first runtime tab
- [x] switch_tab fails when binding is missing
- [x] switch_tab fails when binding is closed
- [x] close_tab fails when binding is missing
- [x] normal step fails when recordedActiveTabName binding is missing
- [x] create_tab is the only entry point for establishing new recorded tab bindings
- [x] URL mismatch fails and prevents trace.tabs.create
- [x] steps.yaml does not contain `meta:` (verified by recording_codec_canonical_steps test)
- [x] steps.yaml does not contain `tabRef:` (verified by recording_codec_canonical_steps test)
- [x] browser.create_tab args only contain `tabName`
- [x] replay core logic does not read `Step.meta` as tab identity source
- [x] replay no longer auto-selects alternative tabs to continue execution
