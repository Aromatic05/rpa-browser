# Architecture

## Overview

This demo has two major parts:

- `extension/`: MV3 Chrome extension that injects UI, generates a tabToken, and forwards commands.
- `agent/`: Node + Playwright agent that owns the browser, records, replays, and runs actions.

The extension never executes automation directly. It only sends `CMD` messages to the service worker. The agent executes every action in Playwright.

## Data Flow

1) `content.ts` generates `tabToken` and sends `RPA_HELLO` to SW.
2) UI button -> `content.ts` -> `chrome.runtime.sendMessage({ type:'CMD', cmd, tabToken, args })`.
3) `sw.ts` attaches active tab token if missing, and sends `{ cmd: { cmd, tabToken, args, requestId } }` to WS.
4) `agent/src/index.ts` parses WS, resolves page by `tabToken`, and dispatches to runner.
5) Runner executes action(s) and returns a standard result.

## Runtime

- `agent/src/runtime/context_manager.ts`: launches Chromium persistent context with extension.
- `agent/src/runtime/page_registry.ts`: maintains `tabToken -> Page` binding.
- `agent/src/runtime/target_resolver.ts`: resolves `Target` into `Locator` within a Page or Frame.

## Runner

- `agent/src/runner/execute.ts`: command router, error mapping, logging.
- `agent/src/runner/actions/*`: action implementations.
- `agent/src/runner/commands.ts`: command union type.
- `agent/src/runner/results.ts`: standard response type.

## Recording

- `agent/src/record/recorder_payload.ts`: page-injected script that captures events.
- `agent/src/record/recorder.ts`: injects payload, bridges to Node.
- `agent/src/record/recording.ts`: recording state and filtering.

## Replay

- `agent/src/play/replay.ts`: replays RecordedEvent list and uses self-heal locators.

## A11y

- `agent/src/runner/actions/a11y.ts`: `page.a11yScan` based on @axe-core/playwright.

