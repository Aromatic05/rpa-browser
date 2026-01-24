# Protocol

## Message envelope (Extension -> Agent)

Service worker sends:

```
{ cmd: { cmd, tabToken, args, requestId } }
```

Where:

- `cmd`: string
- `tabToken`: per-tab stable token
- `args`: command-specific args
- `requestId`: optional UUID

## Result

Runner returns:

```
{ ok: true, tabToken, requestId?, data }
{ ok: false, tabToken, requestId?, error: { code, message, details? } }
```

## Key Commands (recording)

- `record.start`
- `record.stop`
- `record.get`
- `record.clear`
- `record.replay`
- `record.stopReplay`

## A11y

- `page.a11yScan` (see `docs/A11Y.md`)

