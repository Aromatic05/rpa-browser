# Agent Product UI Specification

Status: Design (DESIGN FIRST). Product-side deliverable UI for the task-centric browser agent. The interaction contract authority is [AgentProductInteraction.md](./AgentProductInteraction.md) — this document consumes it and never overrides it. Where a lifecycle/action/interaction semantics is needed, this spec cites the section of that contract rather than restating it. Design only: no production code, tests, or UI implementation.

## 1. Product identity

- Agent execution is Task-centric: a **Task** with opaque `taskId` is the unit of autonomous execution (AgentProductInteraction §1).
- **Teach** (human recording) and **Annotate** (human semantic labeling) are first-class product authoring flows, not Developer Mode. Primary Structured Teach produces Procedure/Recovery Checkpoints; secondary basic recording produces Demonstrations; Annotate produces Page Knowledge (Entity Rules).
- Product Library groups Automations, Procedures/Recoveries, Demonstrations, and Page Knowledge without exposing raw artifact formats by default.
- The product UI is **not** the existing floating developer panel restyled. It is a new surface that hides session/run/continuation ids, provider/model, execution mode, raw reports, traces, and internal action names by default. Those live in an explicit Developer Mode (§10).
- No chat bubbles, no assistant message threads, no open-ended input while a task is active. Structured surfaces only: composer, current task, interaction card, result, history.
- A single active workspace activity reservation: one autonomous Task or one standalone Teach/Annotate/playback activity. Linked Teach/Annotate occurs under the waiting Task's reservation. Queueing is not offered or faked (AgentProductInteraction §10).

## 2. Form factor

| Decision | Value |
|---|---|
| Product form | Browser extension in-page surface, injected into the current tab (consistent with the existing content-script panel) |
| Primary surface | Right-side **docked panel**, full viewport height |
| Collapsed state | Compact **launcher** (circular button), right edge, vertically centered |
| Blocking | Panel overlays the page (fixed); it never pushes/reflows page layout. It blocks the page only in one optional case: the opted-in critical-approval focus mode (§11), default off |
| Center modal | Never used for normal flow. The only allowed modal-adjacent construct is an inline two-step confirmation (see Stop, §6/§7) — no true dialog, so no focus trap is required (§13) |

Rationale: a docked right panel can stay open while the user keeps seeing and (during takeover) operating the page, which is the central product requirement. The existing panel is already a right-anchored floating surface; the product panel keeps that anchoring but becomes full-height and product-scoped.

## 3. Launcher

```
            viewport (page)
 ┌──────────────────────────────────────────────┐
 │                                              │
 │                                  ┌────────┐  │
 │                                  │   A    │  │  44px circle, right:12px, top:50%
 │                                  │        │  │  translateY(-50%)
 │                                  └────────┘  │
 │                                              │
 └──────────────────────────────────────────────┘
```

- Label: initial "A" (product wordmark). Tooltip: "Open Agent".
- Always visible while the content script is live, regardless of panel state.
- **Status dot** on the launcher (color + shape, see §13 status conventions):
  - idle — neutral, static;
  - task running — blue, gentle pulse;
  - waiting_for_user — amber, pulse, **+ count badge** (1) — attention required;
  - Teach recording active — red recording dot + `REC` accessible label;
  - Annotate active — distinct annotation/pen icon + `Annotating` accessible label;
  - disconnected — gray with diagonal bar; hover tooltip states last-known state.
  - developer mode enabled — hatched/outlined ring (separate from task status).
- Click toggles the panel. While the panel is open, the launcher is hidden (the panel header carries the collapse control).
- The launcher is a real `<button>`; focusable; Enter/Space toggles.

## 4. Panel shell

### 4.1 Geometry

| Property | Value |
|---|---|
| Dock | right edge, `position: fixed; top:0; right:0; height:100vh` |
| Width — default | **400px** |
| Width — min / max | **320px / 520px** |
| Resize | drag handle on the panel's left edge; width persists per-workspace via `chrome.storage` |
| Collapse | chevron button in header collapses to launcher (§3). Collapsing never changes task state |
| Viewport height | full height of the tab viewport; internal body scrolls, header/footer fixed |
| Overlay vs push | always overlay; the page is never resized or reflowed by the panel |

### 4.2 Host and shadow

- Host element: `<div id="rpa-product-panel">` appended to `document.documentElement`, matching the existing injection pattern (floating_ui.ts:114-123).
- `position: fixed`, `top:0; right:0; height:100vh`, `z-index: 2147483647` (matches the existing max; coexistence rule below).
- Shadow DOM: `attachShadow({mode:'open'})`, `:host { all: initial }`, every style scoped inside the shadow root. Inherits the existing convention (floating_ui.ts:124-128).
- **Snapshot-ignore**: host and all interactive surfaces carry `data-rpa-snapshot-ignore="true"` (existing convention, floating_ui.ts:117) so the agent's snapshot pipeline never treats the product panel as page content. Same attribute set on any toast/badge the panel renders into the page.
- Coexistence with annotator overlays: both use the same max z-index; the DOM-mount-later element wins. Rule: while the annotator is in an active capture/interaction overlay, the product panel does not auto-open, does not emit attention notifications, and does not claim keyboard focus; if already open it stays open and remains usable, but no product CTA may overlap the annotator's active pick surface.

### 4.3 Shell layout

```
┌──────────────────────────────────────────────┐
│ ║ header                                    │ ← drag? no. 48px
│ ║ [Home][Task][Library][History] ⚙  ─       │    product navigation · dev · collapse
│ ║───────────────────────────────────────────│
│ ║  [ConnectionBanner]      (when stale)     │
│ ║                                           │
│ ║   body = active surface                   │ ← scrolls; composer/current/interaction/
│ ║                                           │    result/history/dev (§5-§10)
│ ║                                           │
│ ║───────────────────────────────────────────│
│ ║ footer: DeveloperDisclosure               │ ← "Developer mode: off [Enable]"
│ └───────────────────────────────────────────┘
 │←─ resize handle (left edge, 6px hit target)
```

- Header: compact product navigation **Home · Task · Library · History** (not the old debug tab bar; Task is disabled/hidden when idle). Right side: developer disclosure (⚙), collapse (─). During Teach/Annotate, the header is replaced by the active authoring title + Exit/Collapse controls so the page gets visual priority. No raw ids anywhere.
- Body renders exactly one surface at a time; the controller routes automatically on state change (below) but the user can always navigate to Home/History.

### 4.4 Surface routing

| Product state | Default surface | User can navigate to |
|---|---|---|
| idle (draft) | Home/Composer | Library, History, Teach, Annotate |
| standalone Teach active | Teach | product navigation is read-only except collapse/exit |
| standalone Annotate active | Annotator Canvas | product panel collapses/defers; Library/Home after exit |
| running | Task (Current Task) | Home*, Library(read-only), History |
| waiting_for_user | Task (InteractionCard / linked guidance) | Home*, Library(read-only), History |
| completed/failed/cancelled/interrupted | Task (Result) | Home, Library, History |
| library item selected | Library | Home, Task, History |
| history entry selected | History (Result of entry) | Home, Task, Library |

\* Home while a Task is active shows its activity guard instead of enabling a second Task/Teach/Annotate. No queued next activity is promised.

### 4.5 Focus policy

- Opening via launcher click (explicit intent): focus moves into the panel; the composer textarea receives focus if the Home surface is shown.
- **Never steal focus** on: task started, phase/activity events, interaction requested, task terminated, connection change, completion toast. Focus stays where the user put it; the panel only updates visually. If the panel is closed, the launcher badge carries the attention state (§11).
- Auto-open (opted-in critical approval, §11) opens the panel but **does not** move focus; the card is keyboard-reachable from the launcher.
- During takeover (§8), the agent's own commands must not move focus while the user operates the page.
- Tab order: header controls → body surface → footer → (loop). Natural DOM order; no traps (§13).

## 5. Home / Composer (idle)

```
┌──────────────────────────────────────────────┐
│ New task                                     │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ Describe what the agent should do…       │ │ ← textarea, min 96px, max 240px
│ │ e.g. "Fill the order form on this page   │ │    Enter=start, Shift+Enter=newline
│ │  and submit the delivery address I       │ │
│ │  entered."                               │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ Examples: [Order form] [Sync contacts] […]   │ ← suggestion chips insert into textarea
│                                              │
│                              [ Start Task ]  │ ← primary
│ ──────────────────────────────────────────── │
│ Help the agent learn this workspace          │
│ [ Teach a workflow ]  [ Annotate this page ] │ ← first-class secondary paths
└──────────────────────────────────────────────┘
```

- One primary textarea; **no** provider/model/executionMode fields (AgentProductInteraction §14). Model/provider are the product defaults unless dev override (§10).
- **Title derivation**: auto-derived at Start from the prompt — first non-empty line, truncated to 64 chars, appended with "…" if longer. No separate title input. The derived title is stored in the task projection and used by the Task header and History. Not editable post-start (out of scope).
- Suggestion chips are static copy shipped with the UI (do not invent or call any suggestion API today); selecting one replaces/pre-fills the textarea.
- Start disabled while: prompt empty (trimmed), another workspace activity is reserved (§5.2 / AgentProductInteraction §10), disconnected (§12), auth/service failure, workspace unavailable.
- **Teach a workflow** enters §5.3; **Annotate this page** enters §5.4. These are normal product CTAs, not developer disclosures.

### 5.1 Start failures — inline error region

| Failure | Product rendering | Recovery |
|---|---|---|
| Empty prompt | Start disabled; helper text "Describe the task first." | — |
| Service unavailable | Error strip in composer: "Agent service is not reachable." Start disabled | auto-retry on reconnect; or Retry button |
| Auth failure | Error strip: "Could not authenticate the agent session. See Developer mode for details." (no secret material) | Retry; detail in dev mode only |
| Workspace unavailable | Error strip: "No active workspace for this tab." | reload/re-attach hint |
| Active-task conflict | §5.2 | — |

### 5.2 Active workspace activity conflict

Never queue (AgentProductInteraction §10). If the user attempts to start a Task, Teach, Annotate, or playback while another workspace activity owns the product reservation:

```
┌──────────────────────────────────────────────┐
│ This workspace is already in use.            │
│   "Order form fill" — ● Running              │
│                                              │
│        [ Open current activity ] [ Stop… ]   │
└──────────────────────────────────────────────┘
```

- **Open current activity** returns to Task/Teach/Annotate.
- **Stop…** exists only for a stoppable active Task/Teach; it uses the activity's own explicit stop/discard semantics. Annotate exit follows its unsaved-draft confirmation, not Task cancellation semantics.
- The backend already blocks overlap while coarse workspace state is `recording`, `playing`, or `executing`. The missing BLOCKER is the higher product reservation across Task waiting/paused states, generic recording review (which is back at `idle`), and standalone Annotate orchestration. A second activity must still be rejected even when that lower-level state is temporarily `idle`.

### 5.3 Teach a workflow (structured procedure / recovery recording)

Teach primarily reuses the existing `checkpoint_recorder_ui` instead of creating a parallel generic-recorder editor. The existing flow already has `idle/setup/recording/review/saving/success`, business-entity selection, procedure/recovery modes, human-readable recorded-step summaries, semantic mappings, and explicit save/cancel.

Teach setup:

```
┌──────────────────────────────────────────────┐
│ Teach the agent                              │
│ What are you teaching?                       │
│ (•) Reusable business procedure              │
│ ( ) Error recovery                           │
│                                              │
│ Business area: [ Orders table ▾ ]            │ ← from Page Knowledge
│                                              │
│ [ Start Teaching ]                           │
│ No business area? [ Annotate this page ]     │
└──────────────────────────────────────────────┘
```

- Procedure/recovery setup adapts the current checkpoint recorder and its actual Entity Rule choices; do not duplicate the mapping logic in the Agent panel.
- If no applicable Page Knowledge is available, **Annotate this page** launches §5.4 and, after a successful save, returns to the previous Teach setup with refreshed choices. In linked Teach this is a subflow under the same Task reservation, not a second standalone activity.
- Start maps to `checkpoint.record.start`. While recording, collapse the full product panel and keep the existing recorder-style compact status dock/launcher so the page stays usable.

```
                 [ ● Teaching · 6 actions ] [ Stop & Review ]
```

- Stop maps to `checkpoint.record.stop`; review reuses the returned `checkpointStepSummary`, selected Entity Rule context, procedure input/action/row-action mappings, output selection, or recovery operation fields already supported by the checkpoint recorder.
- Review CTAs remain **Save Procedure / Save Recovery** and **Discard** (`checkpoint.record.save/cancel`). Nothing auto-saves.
- A saved structured Teach asset is a Workflow Checkpoint with validated `body.dsl`: Procedure is callable from DSL; Recovery participates in the existing runner recovery mechanism.

**Basic Demonstration** is a secondary option (for raw human examples/replay, not the default structured Teach path):

- Uses generic `record.start/stop/get/save/clear`.
- Generic `record.get` currently exposes raw Steps/manifest/enrichments; therefore product review needs a new **server-side sanitized step-summary projection** (reusing the checkpoint summary/enrichment logic where appropriate). Do not reuse the developer JSON view and do not claim the generic recorder already has structured checkpoint review.
- After generic `record.stop`, the coarse workspace becomes `idle` while the unsaved bundle remains under review. A new `record.start` would reset that bundle, and `record.save` does not clear it. Product reservation protects this review window. **Discard -> `record.clear`; successful Save Demonstration -> `record.save` then `record.clear`** so the saved review cannot be duplicated accidentally.
- Saved Demonstrations may be Replay/Tested via the existing playback runtime. `record.load` is explicitly unsupported; Agent learning from Demonstrations therefore requires the new bounded Guidance Catalog/load seam.

### 5.4 Annotate this page (standalone Page Knowledge authoring)

- Launch the existing Annotator Canvas; do **not** rebuild its editor inside the Agent panel. Its authoritative derived stages are `scope | recognize | review | edit`; `check` and `save` are explicit gated operations layered on those stages.
- The Agent product panel collapses and suppresses attention/focus stealing while Annotator picking/canvas interaction is active. Launcher indicates `Annotating`.
- Existing `apply` remains draft-only; **Save Page Knowledge** is explicit and uses artifact revision CAS.
- Exit with unsaved edits uses the Annotator's existing draft/exit confirmation and recovery/session behavior.
- On successful save, return to Home or Library/Page Knowledge with a concise summary (profile/page applicability + confirmed object counts). Raw YAML/QueryPlan remains Developer Mode.

## 6. Current Task (running)

```
┌──────────────────────────────────────────────┐
│ Order form fill                              │ ← title (auto-derived)
│                                              │
│ ● Running · Observing                        │ ← status + phase (only if emitted)
│ ──────────────────────────────────────────── │
│ Timeline                                     │ ← ActivityTimeline
│  ✓ Task started · 14:02                      │
│  ● Observing the page…                       │
│  ~ Filled field "Delivery address"           │
│  ~ Clicked "Continue"                        │
│ ────────── (indeterminate progress) ──────── │ ← no % unless backend emits real progress
│                                              │
│                     [ Stop ]  [ History ]    │
└──────────────────────────────────────────────┘
```

- Status/phase: lifecycle `running` always shown. Phase label (Planning/Observing/Executing/Recovering) rendered **only** when the backend emitted a `phase_changed` event with that value; otherwise the status line is exactly "Running" (truthfulness rule, AgentProductInteraction §2.2). No inferred steps, no timers, no percentages.
- **Progress is indeterminate** unless the backend exposes a real progress value; today nothing does, so always indeterminate (animated bar/indeterminate dots, reduced-motion aware §13).
- **Activity timeline**: sanitized observable events only (AgentProductInteraction §12.2): task started, phase changes, sanitized `activity` summaries, interaction requested/resolved, effect applied (name + status, no tool names), world conflict evidence, terminated. No raw tool names, no internal ids, no chain-of-thought, no Program source, no JSON blocks.
- **Stop**: present, secondary and destructive-styled, never the primary control. Two-step inline: click → button re-labels "Confirm stop" (armed) with a 3s disarm; Escape or clicking elsewhere disarms. Confirm → `stopTask()` → task → `cancelled`. Stop retains the task in history (AgentProductInteraction §3.1).
- Read-only while running: the user cannot edit the prompt, cannot issue agent RPCs, and (by default) cannot send any free-form message to the running task.

## 7. InteractionCard (waiting_for_user)

Rendered as the body of the Task surface whenever the projection's `interaction` is present (AgentProductInteraction §12.1). One card per pending interaction; when a decision lands, the card is frozen with the resolution and moves into the timeline, and the task surface resumes to Running (or, if more than one interaction, shows the next). All cards share:

- Evidence hierarchy: **question/effect first** (headline), then explanation, then optional evidence/summary, then secondary details collapsible ("Details"). Raw ids/traces never appear.
- A single **primary** action, one neutral secondary, and a separate **Stop Task** (destructive) — stop is never merged with a card's resolution and is never labeled "Cancel" (AgentProductInteraction I2).
- While a decision is in flight, the card's CTAs are disabled and the label shows progress ("Sending…"). On the product stale/concurrency response (`ERR_STALE` through control RPC; HTTP may expose `ERR_INTERACTION_CONCURRENCY`) the card reloads from the latest projection and shows "This request changed — review the updated one." without auto-retrying the decision (AgentProductInteraction §5).

Per-kind layouts:

### 7.1 ApprovalCard (`approval`)

```
┌──────────────────────────────────────────────┐
│ ⚠ Approval needed · irreversible effect     │
│                                              │
│ The agent will: Publish order to ERP         │ ← effectName headline
│                                              │
│ This action cannot be undone. It was         │ ← risk explanation (irreversible)
│ prepared from the current page state.        │
│                                              │
│  Evidence: expected vendor + line items      │ ← sanitized summary; Details collapsible
│                                              │
│     [ Approve ]      [ Deny… ]               │ ← Approve primary · Deny secondary
│                                              │
│                        [ Stop Task ]         │ ← destructive, separate
└──────────────────────────────────────────────┘
```

- **Approve** (primary) → `approve(interactionToken)`. Same retained run resumes; never a new run/task (AgentProductInteraction §5).
- **Deny** (secondary) → expands inline fields: `reason` (required, validated) + optional `requestedAlternative` (free text). Submit → `deny(interactionToken, reason, requestedAlternative?)`. Deny does **not** cancel the task and never ends the run; the same run resumes with the denial as structured feedback (AgentProductInteraction §4). Label is exactly "Deny", never "Cancel".
- **Stop Task** (destructive) → two-step inline confirm → `stopTask()` → `cancelled`. Separated by spacing and by hierarchy from the resolution actions.

### 7.2 ClarificationCard (`clarification`)

```
┌──────────────────────────────────────────────┐
│ ❓ Question                                  │
│  Which delivery date should we target?       │ ← question
│                                              │
│  [ date input            ]  (schema-driven)  │ ← field/type/allowed/default
│  ⚠ Invalid date — must be within 90 days.    │ ← inline validation
│                                              │
│           [ Submit Answer ]                  │ ← primary
│                        [ Stop Task ]         │
└──────────────────────────────────────────────┘
```

- Control is rendered from the request schema: `field`, `type` (text/number/date/select), `allowed` values (select/radio), `maxLength`, `default` (AgentProductInteraction §6).
- Validation is inline and client-side per schema; an invalid answer never resolves the interaction — the task stays `waiting_for_user`, the error shows inline.
- **Submit Answer** (primary) → `answerClarification(interactionToken, value)`. Same task resumes with the bounded answer.
- Sequential clarifications render as fresh cards, each with its own id/revision.

### 7.3 RecoveryCard (`recovery_decision`)

```
┌──────────────────────────────────────────────┐
│ ↻ Recovery decision                         │
│                                              │
│ A step failed. Summary:                      │ ← sanitized failure summary
│  "Confirm order" could not be verified.      │
│  Evidence: expected order id ≠ actual.       │ ← sanitized evidence; Details collapsible
│                                              │
│  Options                                     │ ← only backend-provided options
│   (•) Retry                                  │
│   ( ) Repair                                 │
│   ( ) Rollback   — blocked: irreversible…    │ ← backend block reason
│   ( ) Rewind                                 │
│   ( ) End task as failed                     │ ← backend `terminate`
│                                              │
│                        [ Stop Task ]         │
└──────────────────────────────────────────────┘
```

- Options are rendered **only** from the backend assessment. Current kinds are `retry | repair | rollback | rewind | terminate`; UI labels are user-facing and never expose debugger command names. A non-eligible retry/repair/rollback/rewind is disabled and shows its sanitized block reason.
- The UI does not invent `recompute` or `abort`. If a future backend adds an option, it appears only through the typed projection.
- Selecting an eligible option emits `chooseRecovery(optionId)`. Backend `terminate` is labeled **End task as failed** and leads to `failed`, not `cancelled`. **Stop Task** remains a separate user cancellation.
- A primary/recommended styling appears only if the backend projection explicitly marks a recommendation; otherwise options are neutral.

### 7.4 TakeoverCard (`takeover`)

```
┌──────────────────────────────────────────────┐
│ ✋ Manual control needed                     │
│  Reason: the checkout flow requires 2FA      │ ← reason, scope (workspace/tab)
│  that only a human can complete.             │
│                                              │
│ [ Take Over ] [ Teach by example ]          │
│ [ Annotate page ]      [ Stop Task ]         │
└──────────────────────────────────────────────┘
```

- The card renders only backend-approved guidance modes from the takeover request: `manual`, `teach`, `annotate`. It never invents Teach/Annotate just because those product features exist.
- **Take Over** enters manual human control. **Teach by example** enters linked Recording. **Annotate page** launches the existing Annotator Canvas linked to this Task.
- The Task keeps its workspace reservation while Agent mutation is suspended; another Task/standalone authoring flow cannot start.
- Any chosen mode moves takeover to `active`; it is not resolved until Return Control.

## 8. Takeover active state

```
┌──────────────────────────────────────────────┐
│ ⚑ You are in control                        │ ← persistent banner, colored (attention)
│  The agent has paused its actions. Agent     │
│  mutations are disabled until you return.    │
│                                              │
│              [ Return Control ]              │ ← primary
│                        [ Stop Task ]         │
└──────────────────────────────────────────────┘
```

- While human guidance is active, Agent mutation is suspended. Manual mode shows the banner above; Teach mode shows the recording status pill from §5.3; Annotate mode delegates to the existing Annotator Canvas from §5.4.
- **Return Control** states: "The agent will re-observe the page and plan again from what is here now." It returns a typed guidance result (including an opaque saved Demonstration/Page Knowledge reference only if the user saved one), forces fresh World observation, refreshes applicable SemanticBindings, then re-enters the same Task's Agent control continuation.
- Old pending effects are never replayed after human control. Routine revision drift created by the human is expected and handled by refresh/replan, not surfaced as an unnecessary error card.

## 9. Result and History

### 9.1 TaskResult (terminal)

| Outcome | Header | Primary copy |
|---|---|---|
| completed | ✓ Task completed | user-facing output summary (result.text, truncated) |
| failed | ✗ Task failed | user-facing error message; **no internal error payload/stack/report dump** — "See Developer mode for the full report." |
| cancelled | ⊘ Task stopped | "You stopped this task." |
| interrupted | ⏸ Task interrupted | "The agent service restarted. This task is **not resumable**." — never a misleading Resume (AgentProductInteraction §11) |

Shared block:

```
┌──────────────────────────────────────────────┐
│ ✓ Task completed                             │
│ Order form fill                              │
│                                              │
│ Output: Order #A-102 placed with vendor.     │
│ Effects applied: 3 · Report available        │
│                                              │
│ [ New Task ]  [ Retry ]  [ Save Automation ] │
│ [ View Details ]                             │
└──────────────────────────────────────────────┘
```

- **New Task** → composer with a new taskId (draft). **Retry** → new draft pre-filled with the same prompt; history entry for the old task is preserved. Both are new tasks, never re-open the old run (AgentProductInteraction §9.2).
- **Save Automation** — shown **only** when the task is `completed` with a successful program (backend marks eligibility); never automatic (AgentProductInteraction §9.1 / I6). Action → explicit `saveAutomation(taskId)`; on success a non-intrusive toast confirms; failure shows inline error.
- **View Details** → sanitized result detail (outcome, effect count, recovery-history summary, report availability). It never opens the raw report; raw report/trace is Developer mode only.
- Interruption explicitly states non-resumability (today). When durable continuation lands, an eligible `Resume` appears — until then, never.

### 9.2 TaskHistory

```
┌──────────────────────────────────────────────┐
│ History                                      │
│                                              │
│ ▣ Active (pinned)                            │ ← current active task, always on top
│   Order form fill · ● Running                │
│ ──────────────────────────────────────────── │
│ ✓ completed · "Place order" · 2h ago         │ ← terminal cards only
│ ✗ failed    · "Book meeting"  · 1d ago       │
│ ⊘ cancelled · "Sync contacts" · 2d ago       │
│ ⏸ interrupted · "Fill form" · 3d ago         │
└──────────────────────────────────────────────┘
```

- Lists terminal tasks (completed/failed/cancelled/interrupted) newest first; the active task is pinned separately and excluded from the terminal list.
- Each card: outcome icon + status label, title/prompt summary, relative ended time. `taskId` not shown (opaque internal id, AgentProductInteraction §9.2 — the projection's taskId is the only id the product may hold; it is never displayed).
- Select a card → Result view of that entry (report loads on demand). No lifecycle change.
- **Retention/prune is not a user action here.** No prune/delete control in product mode; pruning follows the existing retention policy and is left to settings/developer mode. History is auditable; cancelled tasks remain listed.
- Empty state: "No completed tasks yet." plus a New Task CTA.

### 9.3 Workspace Library

Library is product-facing durable knowledge, separate from Task history:

```
┌──────────────────────────────────────────────┐
│ Library                                      │
│ Automations                                  │
│  • Submit weekly report                      │
│ Procedures & Recovery                        │
│  • Ensure login · procedure                  │
│  • Renew session · recovery                  │
│ Demonstrations                               │
│  • New vendor onboarding · 12 actions        │
│                              [Replay/Test]   │
│ Page Knowledge                               │
│  • Orders page · form · 1 entity             │
│                              [Annotate/Edit] │
└──────────────────────────────────────────────┘
```

- **Automations** = explicitly saved Program/DSL. Product surface shows name and user-facing description/status, not source by default. A generic product Run/Edit action is shown only after an executable input/editor contract exists; this spec does not fake one from raw `dsl.run`.
- **Procedures & Recovery** = Workflow Checkpoints created manually or by Structured Teach. Procedure bodies are callable from DSL; recovery checkpoints participate in runner recovery. Library supplies sanitized names/kind/meaning and can offer Teach/Edit only when backed by the real checkpoint authoring flow; raw body/policy stays Developer Mode.
- **Demonstrations** = saved generic Recording artifacts. Current `record.list` supplies name/step count; playback already exists. Product target additionally exposes a compact Guidance Catalog so Agent planning can explicitly select/load a relevant Demonstration. Until that lands, do not claim Demonstrations automatically teach every Task.
- **Page Knowledge** = Entity Rules profiles. `entity_rules.list` directly supplies profile label, page kind/url pattern and **entity count**; field/action counts require loading `entity_rules.get` for that profile and are not fabricated from list metadata. Annotator edit flow backs editing. Runtime already consumes applicable SemanticBindings.
- Library mutations obey the workspace activity reservation. Replay and editing cannot begin while another autonomous/standalone activity owns the workspace; read-only browsing remains available.
- Raw artifact paths, YAML/DSL, revisions, QueryPlan, selectors and step JSON stay in Developer Mode.

## 10. Developer Mode

- Entry: `DeveloperDisclosure` in the panel footer — always visible, explicit: "Developer mode: off · [Enable]". Enabling requires a confirmable toggle (one click, labeled "I know what I'm doing" is unnecessary; a plain confirm toggle suffices) and swaps the body to the **developer surface**, replacing the product surface until disabled.
- The developer surface exposes, **and only there**: provider/model/executionMode; session/run/continuation/revision ids; raw report and trace; internal action names and control-RPC actions. It is a re-homed, developer-styled surface (the current Agent tab content migrates here; see gap §19).
- **Override rule**: developer settings never silently alter product defaults (AgentProductInteraction §14 / I5). Overrides apply only when the user explicitly applies them: per new task (provider/model/executionMode for the *next* Start) or applied to the current task.
- **Dev-override banner**: when a dev override changes the executionMode or model for a task (current or just-started), a visible banner in the panel header/body states it in plain copy, e.g. `⚙ Dev override: model=claude-3.5 · mode=program` and is dismissible but re-appears per task while the override is applied.
- Disabling developer mode restores the product surface with product defaults; the override banner disappears and any applied override stops applying to new tasks (the running task keeps what it was given).
- Developer mode is never shown to the user as part of the happy path; it is reachable but off by default.

## 11. Notifications and attention

| Situation | Product behavior |
|---|---|
| Panel open, state changes | No notifications; surfaces update in place |
| Panel collapsed, task needs interaction (waiting_for_user) | Launcher badge (count 1) + amber pulse + ARIA live announce. Optional browser notification if the user has opted in (requires adding the `notifications` permission — manifest gap, §19) |
| Panel collapsed, task completed | Non-intrusive launcher badge (no pulse) + optional toast on next open; **no** auto-open |
| Critical approval (irreversible) | **Auto-open** only if the user explicitly opted into the critical-approval alert (default **off**). Even then, auto-open does not steal focus (§4.5) |
| Any auto-open | Focus stays on the page; panel is display-only until the user clicks in |

- Badges/toasts carry `data-rpa-snapshot-ignore`; toasts auto-dismiss after ~5s, reduced-motion aware, and never stack more than one.
- Badge counts are capped at "1+" (one active interaction at most per workspace).

## 12. Reconnect / offline

```
┌──────────────────────────────────────────────┐
│ ● Disconnected                               │
│ Showing last known state. Nothing changed    │
│ while offline.            [ Retry ]          │
└──────────────────────────────────────────────┘
```

- Connection state = derived from WS/poll health (existing bridge). On loss: keep the last-known snapshot in place; show the `ConnectionBanner` at the top of the panel body; **no spinner-forever** — reattach attempts are bounded (e.g. 3 automatic attempts with backoff, then a static banner + manual Retry).
- **While disconnected**: all mutating CTAs are disabled and visually marked (Start, Approve, Deny, Submit, Recovery options, Take Over, Return Control, Save Automation, Stop). Non-mutating reads (History, View Details) stay enabled. The banner text above is shown verbatim.
- **Reattach Task**: when the backend reports a continuation exists for a running/waiting Task, the UI reattaches automatically and the banner clears.
- **Extension reload during active Teach** is different: server recording state can survive in the same process but page recorder capture is not automatically re-armed. Render `Teaching interrupted` and offer **Stop & Review / Discard**; never resume the REC indicator as if actions were still being captured. A checkpoint `review` state can be re-read safely.
- Annotator unsaved drafts may be restored from extension session storage when page identity matches; that is not equivalent to a persisted Page Knowledge save.
- **Service restart**: active/waiting Task continuation and active structured Teach/checkpoint recording are not durable today → interrupted/non-resumable. Annotator may offer its page-identity-validated extension-session draft recovery if the browser session still has it, but must re-establish backend state before save; do not treat local draft as persisted Page Knowledge.
- During takeover while disconnected: the persistent banner adds "offline" severity styling; Return Control is disabled until reconnect.

## 13. Accessibility

- **Keyboard order**: launcher → header controls → body surface → footer → back. Natural DOM order.
- **Escape semantics**: Escape collapses the panel to the launcher (never cancels the task, never resets a card); if a two-step Stop is armed, Escape disarms it; if a composer has text, Escape first blurs then collapses on second press.
- **Focus trap**: product defines **no modal dialogs** (two-step inline confirms only), therefore no focus trap. If a true modal is ever added, it must implement a standard trap + return focus to the invoking control.
- **Focus steal**: prohibited on state changes (§4.5). During takeover, agent commands must not move focus.
- **ARIA live**: a single visually-hidden live region (`aria-live="polite"`) announces only: task started, interaction requested (kind + headline), task terminated (outcome), connection-state change, dev-override applied. The activity timeline itself is `role="list"` with `aria-live="off"` — no per-entry announcements (noisy-spam rule).
- **Color-independent status**: every status is conveyed by icon + text, not color alone (§14 status conventions).
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` disables pulsing dots, indeterminate-bar animation (replaced by a static "Working…" label), and toast slide-in.
- Contrast: semantic token pairs must meet WCAG AA for text on surface.

## 14. Responsive / viewport

| Property | Value |
|---|---|
| Target desktop | browser width ≥ 1024px; panel default 400px on a 1440px viewport leaves ~1040px of page visible |
| Min supported browser width | 480px (product remains functional; narrower degrades gracefully) |
| Narrow viewport (< 640px) | panel width = `min(default, 100vw)` full-height overlay; the page is never shrunk or reflowed (overlay policy holds) |
| Mobile browsers | not a target; no separate responsive layout — the overlay behavior is the only accommodation |

## 15. Visual language

Product-grade, restrained; explicitly not a debug console. No dense tab bars, no monospace/JSON `pre` blocks in product surfaces (developer surface may use them).

| Token | Value (semantic, not brand) |
|---|---|
| `--rpa-surface` / `--rpa-surface-raised` | panel background, card background |
| `--rpa-border` | hairline dividers |
| `--rpa-text` / `--rpa-text-muted` | body / secondary text |
| `--rpa-accent` | primary CTAs, active segmented control |
| `--rpa-danger` | Stop / End-as-failed / destructive only |
| `--rpa-success` / `--rpa-warning` / `--rpa-error` / `--rpa-info` | status accents (always with an icon) |
| `--rpa-focus-ring` | 2px keyboard focus ring, visible on all interactive elements |

- Typography scale (system font stack, matching existing UI): 11px labels/hints, 13px body, 15px card/question headlines, 17px panel/section titles, 20px result outcome. One mono face reserved for the developer surface.
- Spacing scale: 4/8/12/16/20/24 (4px base). Cards: 12px padding, 8px internal gaps.
- Buttons hierarchy: one primary (accent, filled) per surface/card; secondary (ghost/outline); destructive (danger-styled) separated and never primary. Disabled: 45% opacity + `cursor:not-allowed`.
- Status conventions (icon + text, color-independent):

| Status | Icon | Text |
|---|---|---|
| running | ● (pulse when reduced-motion off) | Running / planning / observing / executing / recovering |
| waiting — approval | ⚠ | Approval needed |
| waiting — clarification | ❓ | Question |
| waiting — recovery | ↻ | Recovery decision |
| waiting — takeover | ✋ | Manual control needed |
| completed | ✓ | Task completed |
| failed | ✗ | Task failed |
| cancelled | ⊘ | Task stopped |
| interrupted | ⏸ | Task interrupted |
| disconnected | ● (bar) | Disconnected |

## 16. Component inventory

Contract: components are thin views over the `AgentTaskView` projection (AgentProductInteraction §12.1) and the sanitized event stream (§12.2). "Projection-only" components render and never mutate; "trigger" components emit commands the controller dispatches to the agent backend.

| Component | Props (projection-derived) | Local state | Emits (commands) | Class |
|---|---|---|---|---|
| AgentLauncher | hasActiveTask, waitingKind?, disconnected, devEnabled | open/closed | `open` | trigger (open only) |
| AgentPanelShell | activeSurface, width, connection, devEnabled, activeTaskSummary, activeAuthoring? | width, collapsed | `collapse`, `resize(width)`, `setSurface(surface)`, `openDev` | trigger |
| TaskComposer | prompt, activeActivity?, startError?, disconnected, workspaceOk, authOk | prompt, armed | `startTask(prompt)`, `openTeach`, `openAnnotate`, `openCurrentActivity` | trigger |
| TeachRecorderSurface | teachKind(procedure/recovery/demonstration), phase, stepCount, Page Knowledge choices, checkpoint review summaries/mappings or sanitized demonstration review | setup choices, discardArmed | `startTeach`, `stopTeach`, `saveTeach`, `cancelTeach`, `openAnnotate` | trigger; structured path adapts existing checkpoint recorder |
| AnnotateBridge | annotatorStatus, savedSummary?, dirty? | — | `openAnnotator`, `closeAnnotator`, `showLibraryItem` | trigger/bridge; editing stays in existing Annotator |
| WorkspaceLibrary | automations[], procedures[], recoveries[], demonstrations[], pageKnowledge[], reservation | selection | `replayDemonstration`, `editPageKnowledge`, `newTeach`, `newAnnotate` plus only backend-supported asset actions | trigger/read |
| ActiveTaskHeader | title, status, phase?, interactionKind?, devOverrideBanner? | — | `setSurface('history')` | trigger (nav) |
| TaskStatus/Phase | status, phase?, disconnected | — | — | projection-only |
| ActivityTimeline | events[] (sanitized), running | — | — | projection-only |
| InteractionCard (union) | interaction (kind union), disabled, decisionPending, stale | — | dispatches to kind card | trigger |
| ApprovalCard | actionSummary, risk, evidence?, interactionToken, disabled | denyOpen, denyReason, requestedAlternative | `approve`, `deny{reason,requestedAlternative?}`, `stopTask` | trigger |
| ClarificationCard | question, schema, interactionToken, disabled, validationError | value, touched | `answerClarification(value)`, `stopTask` | trigger |
| RecoveryCard | failureSummary, evidence, options[{id,kind,label,eligible?,block?}], recommendedOptionId?, concurrencyToken, disabled | selectedOptionId | `chooseRecovery(optionId)`, `stopTask` | trigger |
| TakeoverCard | reason, scope, guidanceModes[], concurrencyToken, activeMode?, disabled | — | `beginHumanGuidance(mode)`, `returnControl`, `stopTask` | trigger |
| TaskResult | outcome, output, errorMessage, effectsCount, reportAvailable, saveEligible, resumable | — | `newTask`, `retry`, `saveAutomation`, `viewDetails` | trigger |
| TaskHistory | terminalTasks[], activeTask?, selectedTaskId | — | `select(taskId)`, `newTask` | trigger |
| ConnectionBanner | connection, lastKnownAt, backoff | — | `reconnect` | trigger |
| DeveloperDisclosure | devEnabled, appliedOverride | confirmOpen | `enableDev`, `disableDev`, `applyDevOverride{provider?,model?,executionMode?}` | trigger |

Command contract (controller -> backend): every trigger above maps 1:1 to the interaction/action contracts of AgentProductInteraction §13; the controller is the only component that knows raw RPC names (which therefore never appear in product components).

## 17. State-by-state rendering matrix

Rows: lifecycle × connection × interaction subtype. Columns: surface, body, primary CTA, secondary, mutating disabled?.

| Lifecycle | Connection | Interaction | Body renders | Primary CTA | Secondary | Mutating disabled? |
|---|---|---|---|---|---|---|
| (idle) draft | ok | — | Composer | Start Task | — | no |
| (idle) draft | off | — | Composer + banner | (Start/Teach/Annotate disabled) | Retry | yes |
| standalone Teach | ok | — | structured Teaching dock / review (or Basic Demonstration dock) | Stop & Review | Discard in review | Task/Annotate disabled |
| standalone Annotate | ok | — | existing Annotator Canvas | Save in Annotator | Exit/discard per Annotator | Task/Teach disabled |
| running | ok | — | Header + Timeline | — (no primary) | Stop (two-step) | no |
| running | off | — | Header + Timeline (last known) + banner | — | Stop disabled | yes (Stop too) |
| waiting_for_user | ok | approval | ApprovalCard | Approve | Deny, Stop | no |
| waiting_for_user | off | approval | Card frozen + banner | — | — | yes (all) |
| waiting_for_user | ok | clarification | ClarificationCard | Submit Answer | Stop | no |
| waiting_for_user | ok | recovery | RecoveryCard | recommended option (if marked) else option selection | End-as-failed option (if supplied), Stop | no |
| waiting_for_user | ok | takeover offered | TakeoverCard with backend guidanceModes | selected mode | Stop | no |
| waiting_for_user | ok | takeover active(manual) | persistent human-control banner | Return Control | Stop | Agent mutations disabled |
| waiting_for_user | ok | takeover active(teach) | REC pill / linked review | Return Control after review | Stop | Agent mutations disabled |
| waiting_for_user | ok | takeover active(annotate) | existing Annotator Canvas | Return Control after exit/save | Stop | Agent mutations disabled |
| completed | any | — | Result | New Task | Retry, Save Automation*, View Details | *eligibility |
| failed | any | — | Result | New Task | Retry, View Details | — |
| cancelled | any | — | Result | New Task | View Details | — |
| interrupted | any | — | Result (non-resumable) | New Task | View Details | — |

**Impossible / transient combinations and how the UI handles them:**

| Combination | Why impossible | Handling |
|---|---|---|
| waiting_for_user with no `interaction` payload | backend never emitted `interaction_requested` (incomplete wait) | transient "Preparing…" body, no card, no CTAs; must not persist as a stable state (AgentProductInteraction §2.1) |
| interrupted with `resumable=true` | contract defines interrupted as non-resumable today | never render a Resume; if a backend change makes it resumable, a new explicit "Resume" appears only then |
| running while an old resolved interaction is still rendered | resolution moves the card to the timeline | card freezes with resolution, timeline entry `interaction_resolved`, surface resumes running |
| denial submitted but lifecycle still waiting | stale/mid-transition | card shows "Decision sent…" then resolves; on stale/concurrency response reload projection (§7) |
| `draft` + waiting / `draft` + running | draft is local-only | composer never shows any task state |
| two active workspace activities | target WorkspaceActivityReservation forbids it; current backend does not fully enforce across paused Tasks | conflict guard §5.2; treat occurrence as backend correctness defect, not a UI state to merge |
| take-over while disconnected | mutating | Take Over disabled; banner |
| recovery option that is not backend-provided | I7 | never rendered, even if a stale projection would include it |

**Stale events/revisions:** the stream is monotonic by `(taskId, seq)`; UI drops any event ≤ last applied seq (idempotent, AgentProductInteraction §12.2). Cards carry an opaque interaction concurrency token/version (not rendered); a resolution for an interaction that is no longer pending is ignored. A new `interaction_requested` for the same task supersedes the previous card (previous goes to timeline). No stale approval/takeover replay (I8).

## 18. End-to-end UX flows

1. **Ordinary successful Task.** Home → prompt → Start → truthful Running/activity → completed Result. No provider/model/session ids.
2. **Irreversible approve.** ApprovalCard → Approve → exact retained execution barrier continues → Task completes.
3. **Deny then alternative.** ApprovalCard → Deny + reason → denied effect never runs → Agent control continuation replans/asks/ultimately fails if no compliant route; Task is not cancelled.
4. **Clarification.** Schema-driven answer validates → same Task control continuation resumes.
5. **Recovery.** RecoveryCard renders exact backend options (`retry/repair/rollback/rewind/terminate` as supplied) with block reasons → choice executes; `terminate` means failed, Stop means cancelled.
6. **Manual takeover.** TakeoverCard → manual → user changes page → Return Control → fresh observe + semantic refresh + replan; no stale effect replay.
7. **Standalone Structured Teach.** Home → Teach → choose Procedure/Recovery + Page Knowledge → checkpoint recording → human actions → Stop & Review → semantic mappings → explicit Save → Library Procedure/Recovery. If Page Knowledge is missing, Annotate first then return to setup. A separate Basic Demonstration flow covers generic Recording + Replay/Test.
8. **Standalone Annotate.** Home → Annotate → existing Canvas `scope/recognize/review/edit/check/save` → explicit save → Library/Page Knowledge summary.
9. **Task asks for Teach.** Waiting takeover request includes `teach` + teachKind → linked structured checkpoint recording (or explicit demonstration kind) → user reviews/saves or discards → Return Control → same Task receives opaque guidance result, refreshes World/semantics, replans.
10. **Task asks for Annotate.** Waiting takeover request includes `annotate` → existing Annotator → save/exit → Return Control → same Task refreshes PageSession/SemanticBindings and replans.
11. **Workspace conflict.** Active Task/Teach/Annotate prevents a second standalone activity; UI opens current activity or offers correct stop/exit semantics; no queue.
12. **User stop.** Explicit Stop during Task running/waiting → `cancelled`; history retained. Teach uses Stop & Review/Discard instead, Annotate uses its own exit semantics.
13. **Service restart.** Active Task becomes interrupted/non-resumable until durable continuation lands; active human authoring rehydrates only if its own subsystem can prove state, otherwise shows interrupted authoring recovery rather than pretending.
14. **Extension reload.** Projection/event snapshot reattaches to current Task. Active Teach recording becomes `Teaching interrupted` unless capture is explicitly re-armed (v1 chooses Stop & Review/Discard); checkpoint review may restore from backend. Annotator may recover its page-identity-validated session draft.
15. **Completed → Save Automation.** Explicit save only; Library/Automations receives entry.
16. **Failed → Retry.** New Task draft with same prompt; old history preserved.

## 19. Current-vs-target gap table (verified against source)

Severity: **BLOCKER** product correctness/deliverability; **HIGH** missing end-to-end product capability; **MEDIUM** UX/projection gap.

| # | Current implementation | Target | Severity |
|---|---|---|---|
| 1 | Existing 420px `Conn/WS/Tabs/Rec/Play/Flow/ER/Agent/Log` panel is a developer surface; Agent tab exposes provider/model/executionMode/internal actions | New product shell; old surface moves behind Developer Mode | BLOCKER |
| 2 | Coarse `recording/playing/executing` workspace exclusivity already exists, but no Task-level reservation spans paused/waiting, generic review, or standalone Annotate orchestration | WorkspaceActivityReservation composes above existing states/leases and covers Task + authoring/replay lifecycle; linked guidance stays under Task reservation | BLOCKER |
| 3 | Current continuation is deterministic DSL/debug continuation; no retained Agent control continuation for denial/clarification/guidance input | Split execution vs Agent-control continuation | BLOCKER |
| 4 | Deny cancels session today | Deny returns structured feedback before denied effect and never cancels | BLOCKER |
| 5 | Only irreversible approval is end-to-end; other interaction kinds mostly type-level | Clarification/recovery/takeover human-guidance end-to-end | HIGH |
| 6 | `paused` can exist with no pending interaction/control path; no truthful phase/event projection | Stable product waits always have a resolvable interaction/control path; event phases are explicit | HIGH |
| 7 | `checkpoint_recorder_ui` already implements structured procedure/recovery setup, recording, review, Entity Rule mappings, save/cancel | Make it the primary Teach flow and integrate with Task/Library instead of rewriting it | HIGH |
| 8 | Generic Recording is durable/replayable, but `record.get` is raw, `record.load` is unsupported, stop-review returns workspace to idle, and save leaves unsaved buffer populated | Secondary Demonstration flow with sanitized review, protected review reservation, save/clear discipline, and bounded Agent Guidance Catalog/load | HIGH |
| 9 | Entity Rules Annotator is substantial and runtime SemanticBindings are consumed by execution | Promote to first-class Annotate/Page Knowledge + Library + linked Task return-control refresh | HIGH |
| 10 | No unified product Library for saved Program/Checkpoint/Recording/Entity Rules | Library presents Automations/Procedures-Recovery/Demonstrations/Page Knowledge | HIGH |
| 11 | UI polls session list every 2.5s; no product snapshot+seq event projection | Sanitized Task/workspace projection/event stream with reconnect/gap recovery | HIGH |
| 12 | Interaction deadlines have no timer-driven expiry/control feedback | Product expiry scheduler + typed timeout input | MEDIUM |
| 13 | Restart continuation is in-memory only | Durable Task/control/execution/interaction continuation image | BLOCKER |
| 14 | Program save is already explicit (`agent.save_program`); completion does not auto-save | Preserve invariant; expose product-level Save Automation command | MEDIUM |
| 15 | Reports/history persist but product view exposes/internalizes report fields in developer panel | Sanitized Result/History; raw report Developer Mode | MEDIUM |
| 16 | No optional browser notification permission/badge integration | Optional attention notification; launcher status is sufficient baseline | MEDIUM |

## 20. Implementation slices (after this spec; no implementation now)

1. **Backend product correctness:** WorkspaceActivityReservation, Agent-control continuation, denial-before-effect semantics, no stable orphan pause.
2. **Projection/commands/events:** `AgentTaskView`, task commands, interaction aliases/tokens, sanitized sequence stream and reconnect.
3. **Product shell + existing human authoring integration:** launcher/Home/Task/Library/History; make existing checkpoint recorder the primary Structured Teach surface, retain generic Recording as Demonstration, and reuse existing Annotator without rewriting these specialized editors.
4. **Interaction cards + linked human guidance:** approval, clarification, exact recovery options, takeover modes manual/teach/annotate and Return Control refresh/replan.
5. **Guidance reuse:** Library projections and bounded Procedure/Recovery/Demonstration Guidance Catalog/load seam; Page Knowledge refresh/application; explicit Save Automation.
6. **Attention/reconnect + Developer Mode migration:** old dev panel content behind disclosure, optional notifications, truthful interrupted state.
7. **Durable continuation + browser visual E2E:** restart rehydration and all flows in §18 against real backend/browser.

## 21. Acceptance checklist — "deliverable" product UI

A normal user with no developer knowledge can:

1. Install/open the extension and see one product launcher, not the old debug tab matrix.
2. Run one natural-language Task without provider/model/execution-mode fields.
3. Observe truthful Running/activity with no chain-of-thought, raw tool names, ids, or fake progress.
4. Approve or deny an irreversible effect; denial does not execute the effect and does not cancel the Task.
5. Answer clarification and choose only real backend recovery options.
6. Take over manually and return control with fresh observe/replan.
7. From Home, **Teach a workflow** using existing structured Procedure/Recovery recording, semantic review/mapping and explicit save; if business semantics are missing, flow into Annotate and return. A secondary Basic Demonstration path can save/replay generic Recording.
8. From Home, **Annotate this page** using the existing annotator, check/save Page Knowledge, and find it in Library.
9. Complete a Task-linked Teach request and return its Demonstration result to the same Task; complete a Task-linked Annotate request and resume with refreshed SemanticBindings.
10. Browse Library sections for Automations, Procedures/Recovery, Demonstrations, and Page Knowledge without seeing raw DSL/YAML/selectors/step JSON unless Developer Mode is enabled.
11. Stop a Task explicitly and distinguish that from ending/discarding Teach or exiting Annotate.
12. Browse terminal Task history/results and explicitly Save Automation only when eligible.
13. Reconnect safely after extension/network interruption and see truthful non-resumable interruption after service restart until durable continuation exists.
14. Never start a second Task/Teach/Annotate/playback over an active workspace reservation; no fake queue.
15. Never see provider/model/executionMode, session/run/continuation ids, raw report/trace, internal action names, Recording step JSON, or Entity Rules raw artifacts unless Developer Mode is explicitly enabled.

## 22. Cross-references

- Interaction contract authority: [AgentProductInteraction.md](./AgentProductInteraction.md) (§2 lifecycle/phase, §3 actions, §4 denial, §5 approval, §6 clarification, §7 recovery, §8 takeover/human guidance, §9 result/history, §10 workspace activity reservation, §11 connectivity, §12 projection/stream, §13 interaction union, §14 developer mode, §16 gap table, §17 implementation order, §18 invariants).
- Backend sources cited for gap table §19: `extension/src/content/floating_ui.ts`, `extension/src/content/agent_session_ui.ts`, `agent/src/agent/service/session/{types,store,manager}.ts`, `agent/src/agent/interaction/contracts.ts`, `agent/src/agent/execution/types.ts`, `extension/manifest.json`.