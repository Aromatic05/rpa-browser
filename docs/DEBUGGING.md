# Debugging

## Common Logs

- Extension content script: `[RPA] HELLO`, `[RPA] send command`, `[RPA] response`
- Service worker: `[RPA:sw] ws open/send/message/close`, `onMessage`
- Agent: `[RPA:agent] cmd`, `[RPA:agent] execute`

## Typical Issues

### 1) `missing cmd`
Cause: mismatched message envelope or outdated extension build.
Fix:
- `pnpm -C extension build`
- Reload extension and refresh page

### 2) `Extension context invalidated`
Cause: extension reloaded but page not refreshed.
Fix: refresh the page.

### 3) Replay timeout
Cause: brittle selector, hidden menu, or dynamic class.
Fix:
- Record semantic locators (role/label/text)
- Ensure menu open step exists

### 4) Stop recording seems ineffective
Cause: recorder still emits events but they are ignored when recording disabled.
Check only `record { ... }` logs, not raw event logs.

## Artifacts

- Replay evidence: `.artifacts/replay/<tabToken>/<ts>.png`
- A11y evidence: `.artifacts/a11y/<ts>.png`

