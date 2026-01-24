# Recording & Replay

## Recording

Recording is handled by injected script in `agent/src/record/recorder_payload.ts`.

Captured events (subset):
- click
- input/change (except select/checkbox/radio)
- check (checkbox/radio)
- select
- date
- paste/copy
- keydown
- scroll
- navigate (from page navigation)

Each event stores:
- `locatorCandidates`: ordered list of semantic locators + css fallback
- `scopeHint`: `aside` | `header` | `main`

## Replay

Replay uses self-heal locator resolution:

1) Try each candidate in order (testid > role > label > placeholder > text > css)
2) Skip candidates with count 0 or count > 1 (ambiguous)
3) On success: wait visible -> scrollIntoView -> perform action
4) On failure: write screenshot to `.artifacts/replay/<tabToken>/<ts>.png` and include evidence

## Common Failure Modes

- Dynamic classes (`.active`, nth-of-type): avoid in CSS; use semantic locators.
- Hidden menus: record should include the action opening menus.
- Select elements: handled via `select` events only (input events are ignored).

