# Development Guide

## Install

```
pnpm install
```

## Run

- Build extension:
```
pnpm -C extension build
```

- Start agent:
```
pnpm -C agent dev
```

- Load extension from `extension/dist` in Chrome.

## Tests

```
pnpm -C agent test
pnpm -C agent test:headed
```

## Extension Build

`extension/build.mjs` copies `manifest.json` and `panel.html` into `extension/dist` after TS compile.

## Common Paths

- Extension UI: `extension/src/content.ts`
- Service worker: `extension/src/sw.ts`
- Runner actions: `agent/src/runner/actions/*`
- Replay logic: `agent/src/play/replay.ts`

