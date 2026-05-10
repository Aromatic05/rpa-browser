# Record Architecture

Current goal: convert user interactions into replayable `Step` data.

Pipeline overview:
`capture/payload -> capture/recorder -> pipeline/input -> pipeline/step -> enhancement/queue -> enhancement/build -> pipeline/order -> control save/play`

## capture

- Page-side event capture layer.
- `capture/payload/*` captures browser events and emits raw `RecorderEvent`.
- `capture/recorder.ts` handles page injection, binding, `setRecorderRuntimeEnabled`, and `installRecorder`.
- This layer only produces `RecorderEvent` and does not interpret component semantics such as `custom_select`, `datepicker`, or `upload`.

## pipeline

- Node-side recording main pipeline.
- `pipeline/input.ts` ingests raw `RecorderEvent` and `StepUnion` payloads.
- `pipeline/state.ts` manages recording start/stop state and workspace unsaved token state.
- `pipeline/manifest.ts` manages recording/tab manifest and workspace unsaved snapshot bundle state.
- `pipeline/pending.ts` manages `pendingFillEvents` flow.
- `pipeline/step.ts` maps event-to-step and appends steps/events.
- `pipeline/order.ts` normalizes final step order.
- `pipeline/replay_state.ts` controls replay status markers (`beginReplay`, `endReplay`, `cancelReplay`).

## normalizer

- Boundary only for future normalizer work.
- `normalizer/types.ts`, `normalizer/index.ts`, `normalizer/select_option.ts` are placeholders.
- This task does not implement select_option normalizer and does not connect normalizer to main flow.

## enhancement

- Step enhancement sidecar layer.
- `enhancement/queue.ts` handles async scheduling and pending enhancement lifecycle.
- `enhancement/build.ts` builds `RecordedStepEnhancement` from snapshot, target fingerprint, resolve hint, and entity bindings.

## Boundaries

- `RecorderEvent` is the capture output boundary; `Step` is the pipeline output boundary.
- Enrichment runs as a sidecar process and must not change main recording control flow.
- `recording.ts` is the stable facade and public entry for record pipeline APIs.

## Explicit non-goals in this refactor

- Do not implement `select_option` normalizer.
- Do not introduce a full plugin system.
- Do not modify `StepArgsMap`.
- Follow-up task 3 can connect normalizer inside `pipeline/step.ts`.
- `kind`, `controlRef`, `searchText`, and `timeout` must not enter `browser.select_option` args.
