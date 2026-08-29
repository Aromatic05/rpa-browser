# Agent Product Interaction Architecture

Status: Design (DESIGN FIRST). Codifies the product interaction architecture for the task-centric agent surface. Defines target contracts; the Gap table (section 16) records the delta from today's implementation, verified against the current source.

## 1. Product identity

- **Task-centric execution.** A Task with opaque `taskId` is the unit of Agent execution: everything the user asks the Agent to run, watches, answers, and reviews stays in one Task.
- **Human authoring remains first-class.** The product also exposes two deliberate workspace authoring activities: **Teach** (human recording -> Demonstration) and **Annotate** (human semantic labeling -> Page Knowledge / Entity Rules). They are not debug tools and are not modeled as fake Agent Tasks.
- **Durable workspace assets.** Product terminology is: Automation = saved Program/DSL; Procedure / Recovery = Workflow Checkpoint; Demonstration = generic Recording; Page Knowledge = Entity Rules. Internal artifact names remain available in Developer Mode.
- **Hidden by default** (never rendered in the product surface): `sessionId`, `runId`, `continuationId`, `revision`, Program internals, debug/trace, provider, model.
- **Not a chat clone.** No free-form assistant thread. User <-> agent exchanges are structured, bounded, per-interaction; there is no open-ended message conversation.
- **Not a session debugger.** Session lists, reports, raw trace, and control-RPC actions are developer-mode surfaces, not the product.
- **No arbitrary live chat in v1.** While a Task is active the user may Stop it or answer a structured interaction; there is no free-form "send another instruction" box. A future Task Amendment must pause at a safe boundary, refresh World state, and replan rather than inject chat text into an executing transaction.
- **Public identity boundary.** `taskId` is the only stable resource identity in the product contract. Transport may carry opaque interaction/version tokens solely for concurrency, but the UI never renders them and business logic never treats `sessionId`/`runId`/`continuationId` as product identity. `taskId` may be backed by an internal session identifier today, but the product contract must not depend on that mapping.

## 2. State model

Two layers:

- Persisted **lifecycle state** — the authoritative task machine, stored with the session.
- Transient **presentation phase** — what the agent is currently doing; derived from sanitized events, never authoritative lifecycle state and never timer-inferred. A bounded event log may persist it for rehydration.

### 2.1 Lifecycle states

| State | Meaning | Terminal? |
|---|---|---|
| `draft` | Composed in the composer; no server record. Local only. | no |
| `running` | Runner active; presentation phase one of planning/observing/executing/recovering. | no |
| `waiting_for_user` | Runner suspended on exactly one pending interaction (approval / clarification / recovery_decision / takeover). | no |
| `completed` | Goal reached. | yes |
| `failed` | Runner threw, program failed, recovery exhausted, or model/world/auth failure. | yes |
| `cancelled` | User explicitly stopped. | yes |
| `interrupted` | Active/waiting task killed by service restart with no durable continuation. Observable today as `failed` + `ERR_SESSION_INTERRUPTED`. | yes (derived) |

Today's backend exposes `running | paused | completed | failed | cancelled` (agent/src/agent/service/session/types.ts:31). Mapping:

- `paused` with >= 1 valid pending interaction => `waiting_for_user`.
- `paused` with 0 pending interactions is **not** a valid stable product state. Today it can occur for failure/non-approval pauses and become stuck; the product adapter must not present it as a healthy wait. Target behavior is: automatic recovery/control-loop continuation, a concrete interaction request, or terminal failure/interruption. This is a HIGH gap.

### 2.2 Presentation phases (transient)

| Phase | Meaning | Backend emits today? |
|---|---|---|
| `planning` | Designing/normalizing the program or plan | no |
| `observing` | Snapshotting the world / resolving targets | no |
| `executing` | Applying effects / running steps | no |
| `recovering` | Compensating, rewinding, recomputing after failure | no |
| `interacting` | Suspended; mode set by the pending interaction kind | implied by `paused` |

**Truthfulness rule (invariant):** a phase is rendered only if the backend emitted a phase event with that value. If the backend cannot emit phases, the UI shows generic `running`. Phases are never inferred from timers or step counts.

### 2.3 Lifecycle transition table

| From | Action | Guard | To |
|---|---|---|---|
| `draft` | user starts task | no active task in workspace (owner guard) | `running` |
| `running` | runner settles success | — | `completed` |
| `running` | recoverable failure / world conflict | deterministic safe recovery exists and budget permits | `running` (phase `recovering`) |
| `running` | recovery needs human judgment/input | backend produced a real interaction request | `waiting_for_user` (mode recovery_decision / clarification / takeover) |
| `running` | unrecoverable failure / recovery exhausted | — | `failed` |
| `running` | runner throws outside a recoverable boundary | — | `failed` |
| `running` | user stop | — | `cancelled` |
| `running` | program pauses on irreversible effect | pause reason `barrier` + risk `irreversible` | `waiting_for_user` (mode approval) |
| `running` | loop posts clarification | bounded input needed | `waiting_for_user` (mode clarification) |
| `running` | loop posts recovery request | failure assessment produced options | `waiting_for_user` (mode recovery_decision) |
| `running` | loop posts takeover request | user should operate manually | `waiting_for_user` (mode takeover) |
| `waiting_for_user` | interaction resolved (any mode) | same retained run | `running` |
| `waiting_for_user` | user stop | — | `cancelled` |
| `waiting_for_user` | current interaction expires | no resolution | **target:** timeout resolution is fed to the same Agent control lineage; agent may re-ask, choose an explicitly safe fallback, or fail |
| any non-terminal | service restart, no durable continuation | — | `interrupted` |
| `completed`/`failed`/`cancelled` | user retry or new task | — | `draft` (new taskId) |

## 3. User actions and transition semantics

| User action | Valid when | Effect (exact) |
|---|---|---|
| Start task | `draft` | `draft`->`running`; backend creates session; taskId issued. |
| Stop | `running`, `waiting_for_user` | lifecycle -> `cancelled`; pending interactions cancelled; agent ownership released. |
| Approve | `waiting_for_user`(approval) | interaction -> approved; the exact retained execution barrier may advance under the same Task/run lineage; no new Task/run. |
| Deny | `waiting_for_user`(approval) | interaction -> denied with reason; **task NOT cancelled**; same run resumes with denial as structured feedback; lifecycle -> `running`. See section 4. |
| Answer clarification | `waiting_for_user`(clarification) | input validated against schema; interaction -> answered; same task resumes with bounded answer. Invalid answer keeps the interaction pending with a validation error. |
| Choose recovery | `waiting_for_user`(recovery_decision) | exact current backend option executes if eligible; lifecycle returns to `running`, or -> `failed` for backend `terminate` / terminal recovery failure. |
| Take over | `waiting_for_user`(takeover) | agent releases mutation ownership; lifecycle stays `waiting_for_user`, mode takeover; user may operate manually. |
| Return control | takeover active | world refresh + replan from fresh observation; agent reacquires ownership; MUST NOT replay stale effect assumptions; lifecycle -> `running`. |
| Select history | terminal | opens result/history view. No lifecycle change. |
| Retry / New task | terminal | new `draft` (new taskId) from same or edited prompt; history entry preserved. |
| Save Automation | `completed`, successful program | explicit user push persists the program. Never auto. See section 9. |

### 3.1 Stop semantics

- Stop is the only user action that cancels a task. Deny is never a stop (blocker, section 4).
- Stop during `running` aborts the run -> `cancelled` with `ERR_SESSION_CANCELLED`.
- Stop during `waiting_for_user` cancels all pending interactions, then -> `cancelled`.
- Stop is not "stop and discard history": history of a cancelled task is retained (auditable), consistent with today's store.

### 3.2 Running-time steering

- Product v1 has no arbitrary chat-style steering while `running`. The user can Stop, or respond when the backend creates a structured interaction.
- This is deliberate transaction semantics, not a UI omission: unbounded text injected while an effect is in flight has no safe ordering with `transact/commit/rollback`.
- A future **Task Amendment** is a separate command: request pause at the next safe statement/effect boundary, refresh/pin World state, record the amendment, then replan. It must never mutate the current Program underneath an executing effect.

### 3.3 Automatic recovery before interruption

- `recovering` is normally autonomous. World conflicts, stale targets, and reversible failures should be refreshed/recomputed/rolled back automatically when the recovery policy proves a safe deterministic action and governance budget permits it.
- `waiting_for_user(recovery_decision)` is reserved for a real choice, semantic ambiguity, irreversible consequence, exhausted/blocked automatic recovery, or missing user information.
- Invariant: the UI must not turn routine DOM drift into repeated user confirmations.

### 3.4 Two continuation layers

Product interactions need two different continuations; they must not be conflated:

| Continuation | Purpose | May consume user resolution? | Current state |
|---|---|---|---|
| **Execution continuation** | Advance a retained DSL/debug execution across a known barrier | approval only, because approval authorizes the exact blocked effect | exists today as `AgentRunContinuation.resume()` -> `execution.continuePaused()` |
| **Agent control continuation** | Re-enter the same Task's Agent control loop with retained execution/debug context and a typed external input | denial, clarification answer, recovery choice/result, takeover return, Teach/Annotate result | **missing** |

- Approval may take the deterministic execution-continuation fast path when the exact irreversible effect is still valid.
- Denial MUST return to Agent control before the denied effect; crossing the barrier and then telling the model is incorrect.
- Clarification, recovery choices that require repair/replanning, and human guidance results enter through the Agent control continuation.
- The control continuation retains the same Task/run lineage and execution journal, but it is allowed to invoke the model again. It does not start a second Task.
- Current `continuation.resume()` accepts no input and is not a retained React-loop continuation. Therefore the desired interaction contract requires a new control-continuation seam, not merely an extra argument on the current DSL `resume()`.

## 4. Denial semantics (product-critical)

**Decision:** denying one irreversible effect is structured feedback to the same Agent control loop. It does not cancel the task and does not end the run.

Contract:

1. Deny carries a required `reason` and an optional `requestedAlternative`.
2. The run is resumed with the denial injected as a control input: "effect E denied by user (reason R). Choose an alternative, ask for missing information, or conclude that the task cannot be completed."
3. The agent may then:
   - pick an alternative effect (re-plan) — no new interaction;
   - post a clarification if user information is genuinely required;
   - terminate as `failed` with a user-facing explanation if no compliant path exists.
4. Invariants:
   - Deny never transitions the lifecycle to `cancelled`.
   - Deny never closes the retained run merely because the effect was rejected.
   - Deny is followed by resumed planning/execution, a new supported interaction, or an explicit failed result.

**Current behavior (BLOCKER):** `denyInteraction` cancels the session and all pending interactions, terminating state to `cancelled` with `ERR_SESSION_INTERACTION_DENIED` (agent/src/agent/service/session/manager.ts:371-386). This is a product blocker: it makes a single denied effect indistinguishable from an abort. The UI mirrors it (approve/deny buttons on the paused card, extension/src/content/agent_session_ui.ts:473-505).

## 5. Approval semantics

- Approval resumes the **same retained execution/transaction lineage**: same Task, session, run, effect journal, and retained world/debug state; only the blocked irreversible effect may proceed. An internal continuation token may rotate after advancing and is not part of the product contract. Invariant: approve never starts a new run or a new task.
- Approval is gated by the interaction version/revision (concurrency). The interaction layer raises `ERR_INTERACTION_CONCURRENCY`; control RPC maps it to product-facing `ERR_STALE`, while HTTP may expose the interaction code. Product rule: refresh the authoritative Task/interaction and never retry the old decision blindly.
- Deadline target: approval past `deadlineAt` expires and an irreversible effect MUST NOT execute without a fresh approval. **Today expiry is lazy**: it is detected only when a late approve/deny arrives; there is no deadline timer or timeout input back into the Agent. Timer-driven expiry/control feedback is a product gap.

Today approve -> resume is already wired end-to-end for the irreversible approval path (manager.ts:362-370, resumePaused 252-266). This is the baseline to extend.

## 6. Clarification semantics

- Mode: `user-input-clarification`. The request carries a **bounded input schema**: question, field, type, allowed values (or free text with max length), default.
- The answer is validated; invalid -> the interaction stays pending, the UI shows a validation error; the task stays `waiting_for_user`.
- A valid answer resumes the **same Agent task and retained run** with the bounded answer. Internal continuation ids are implementation details and may rotate after advancement. Invariant: clarification never creates a new chat/task/run.
- Clarifications may occur sequentially; each is a distinct interaction with its own id/deadline/revision.
- Today only the kind name exists (`INTERACTION_KINDS`, agent/src/agent/interaction/contracts.ts:7-14); no producer, no schema, no resume-input. Gap section 16.

## 7. Recovery decision semantics

- Mode: `recovery-confirmation`. The request carries a sanitized failure summary, evidence, and the **actual options** from `assessFailureRecovery` (agent/src/agent/debug/recovery/options.ts).
- Current backend option kinds are `retry | repair | rollback | rewind | terminate`. The product projection keeps the backend kind for command identity but supplies a user-facing label/explanation; it does not expose debugger command names.
- `retry`, `repair`, `rollback`, and `rewind` carry `eligible` plus an optional block reason. `terminate` is the explicit terminal path. The UI never invents `recompute`, `abort`, or any other option unless the backend recovery contract actually emits it.
- A non-eligible option is rendered disabled **with its sanitized block reason** (`no_recovery_point`, `effects_not_verified`, `irreversible_effects`, `already_compensated`, `budget_exhausted`).
- Choosing an eligible option executes exactly that option against the same retained run. Choosing `terminate` ends the task as `failed` with its terminal recovery reason; it is not represented as a user cancellation.
- Recovery may recur with updated options; eligibility and budget are re-read from each new assessment rather than cached in the UI.

## 8. Takeover and human guidance semantics

- Mode: `takeover`. The request carries reason, scope (workspace/tab), current observed World revision, and backend-approved guidance modes. Product guidance modes are `manual | teach | annotate`; the UI renders only modes present in the request.
- A takeover interaction has two product stages: `offered` and `active`. Accepting a mode does **not** resolve the interaction; it moves it to `active` while the Task remains `waiting_for_user`. The offer may expire, but active human control MUST NOT auto-expire into Agent resumption; only Return Control or Stop ends it.
- `manual`: user directly operates the page.
- `teach`: linked human recording starts while Agent mutation is suspended. Preferred `teachKind` is `procedure` or `recovery`, backed by the existing checkpoint recorder and Page Knowledge; `demonstration` is the lower-level generic Recording path. On review the user explicitly saves the produced asset or returns without saving.
- `annotate`: the Entity Rules annotator opens for the current page. On completion it may explicitly save Page Knowledge or return without saving.
- Manual/Teach/Annotate page changes invalidate the prior observation. They are expected, not treated as an error.
- **Return control:** resolves the takeover interaction with a typed guidance result, re-establishes Agent mutation authority, forces a fresh World observation, refreshes applicable semantic bindings, and **replans from that observation**. It MUST NOT replay effects assumed under the pre-guidance World revision.
- For linked `teach`, the result may carry an opaque saved Procedure/Recovery Checkpoint or Demonstration reference; for linked `annotate`, it may carry an opaque Page Knowledge reference/revision. These are control inputs, not raw artifact payloads.
- Ownership invariant: the Agent never performs browser mutation while human guidance is `active`. Correctness is enforced by Task-level reservation + suspension + World invalidation/revalidation on return, not by pretending ordinary mouse/keyboard input can be locked.
- Today only the bare `takeover` kind exists at type level; Teach/Annotate linkage to a Task is not implemented.

### 8.1 Standalone Teach (structured human recording)

Teach is a first-class authoring activity. Its **primary** product path is the existing structured checkpoint recorder, because it turns a human demonstration into a semantic procedure or recovery program instead of leaving only raw steps.

```text
Page Knowledge (Entity Rules)
        |
        v
Teach setup: procedure | recovery
        |
checkpoint.record.start
        v
human performs actions
        |
checkpoint.record.stop
        v
review + semantic mappings
        |
checkpoint.record.save
        v
Procedure / Recovery Checkpoint + body.dsl
```

- Existing `checkpoint.record.get` already exposes `idle|recording|review`, step count, human-oriented step summaries, available Entity Rule choices, selected kind and entity context. Product state should project this rather than inventing a second recorder state machine.
- **Procedure Teach** requires an annotated business entity. Review maps recorded steps to Page Knowledge fields/actions/row actions and can define outputs. If no applicable Page Knowledge exists, the product offers **Annotate this page first**, then returns to Teach setup after a successful save. During Task-linked Teach this Annotate detour remains inside the same active human-guidance takeover/reservation; it does not create a second Task/activity reservation.
- **Recovery Teach** records how a known business/error state is repaired and saves a recovery checkpoint with its actual trigger/policy contract.
- Save is explicit. Cancel/discard uses `checkpoint.record.cancel`; recording/review is never silently persisted as a checkpoint.
- Procedure checkpoints are reusable from DSL through `use checkpoint`; recovery checkpoints already participate in runner recovery selection. The product must expose only sanitized names/meaning, not raw checkpoint YAML/body unless Developer Mode is open.

**Basic Demonstration** remains a secondary Teach asset:

```text
record.start -> human actions -> record.stop -> record.get -> explicit record.save
```

- Generic Recording is workspace-wide across bound pages and remains replayable through existing playback.
- Today generic `record.get` returns raw steps/manifest/enrichments and the old floating panel is a developer surface; a product Demonstration review needs a sanitized server-side step-summary projection (the human-oriented `checkpointStepSummary` logic currently exists only for `checkpoint.record.*`).
- The generic unsaved review buffer has important current semantics: after `record.stop` the workspace returns to `idle`; a new `record.start` resets the unsaved bundle; `record.save` does **not** clear it. Product flow therefore reserves the review window and maps **Discard -> `record.clear`** and **successful Save -> `record.clear`** after persistence, preventing accidental reset or duplicate save.
- `record.load` is explicitly unsupported today; saved Recording is loaded only through playback. Therefore Agent use requires a new bounded Guidance Catalog/load seam rather than reusing a nonexistent load RPC.
- Product target: Agent planning gets a compact **Guidance Catalog** for relevant Procedures/Recoveries/Demonstrations and explicitly loads only selected assets. Raw bodies/step lists are never dumped into every model turn.

### 8.2 Standalone Annotate (human semantic labeling)

Annotate is a first-class authoring activity outside a Task. It reuses the existing annotator product stages rather than rebuilding them in the Agent panel:

```text
scope -> recognize -> review/edit
                         |
                         +-> check operation -> save operation
                         ^        |
                         +-- fix -+
```

- Existing derived product stages are `scope | recognize | review | edit`; `check` and `save` are explicit gated operations, not extra stages. The implementation path is `open -> pick/recognize -> local edit -> apply -> check -> save`.
- `apply` edits only the draft; `save` explicitly persists Page Knowledge (Entity Rules) with artifact revision CAS.
- Entity Rules already feed runtime SemanticBindings and are the preferred business-level interface for DSL/Query. This is already part of execution architecture, not future-only metadata.
- After linked or standalone annotation saves, any Agent resumption must refresh the PageSession so new SemanticBindings are visible before planning/execution continues.

### 8.3 Workspace assets and reuse

```text
Workspace assets
  Automation       = saved Program / DSL
  Procedure        = procedure Workflow Checkpoint / body.dsl
  Recovery         = recovery Workflow Checkpoint / body.dsl
  Demonstration    = generic Recording
  Page Knowledge   = Entity Rules profile
```

- These assets are user-owned workflow state, not Task history. Standalone authoring appears in Library; linked authoring contributes only sanitized guidance events/result references to the Task timeline.
- Product UI may present them in a Library, while Developer Mode may expose raw artifact names/source.
- A Task may consume existing Page Knowledge through the runtime SemanticBindings/query path.
- Recovery Checkpoints already participate in runner recovery candidate selection. Procedure Checkpoints are callable from DSL, but Agent discovery/selection still needs a bounded catalog seam rather than assuming the model knows every checkpoint id.
- Generic Demonstrations require an explicit guidance-selection/load seam; because that seam is missing today, the product must not claim that raw recordings already teach the Agent automatically.
- The Agent may suggest **Teach this workflow** or **Annotate this page** only when it can explain why current knowledge is insufficient. It must not force human authoring for routine recoverable DOM drift.

## 9. Result view and history semantics

### 9.1 Result view

- Task title, outcome (completed/failed/cancelled + error code/message), output summary, effect count, report availability.
- **Save Automation** (explicit action) appears only when a successful Program result is eligible to be saved; pushed by the user only. Never auto-persist.
  - Current runner behavior already enforces this invariant: `agent.save_program` is explicit and `Program source is never persisted automatically` (program/runner.ts). `savedPrograms` means an explicit save occurred; it is not automatic completion persistence.
  - Product gap: the end-user Save Automation button needs a product command that names/saves the eligible completed Program without exposing the internal save tool or Program source.
- Failed/cancelled result view shows the terminal error, the recovery-history summary (if available), and a pointer to developer mode for the raw report.

### 9.2 History

- Task history = list of terminal tasks (completed/failed/cancelled/interrupted), newest first, each with taskId, outcome, prompt summary, endedAt.
- Selecting a history entry opens the result view (report loads on demand; report files already persist, agent/src/agent/service/session/storage.ts).
- Retry/New from history creates a **new** taskId; it never reopens the old run.
- Pruning follows the retention policy (exists today, store.ts `prune`). Pruned tasks disappear from history; no undelete.

## 10. Workspace activity reservation and mutation ownership

The backend already has a coarse exclusive workspace state machine (`idle | recording | playing | executing`) plus execution leases. Active generic/checkpoint recording and playback are therefore mutually exclusive with DSL/Agent/Annotator mutations today. What is missing is a **product activity reservation** that spans a Task's `running` + `waiting_for_user`, the post-recording unsaved review window, and standalone Annotate/Teach orchestration. A paused Task currently releases the narrower execution lease, so another Task can otherwise start and mutate the World before the first Task resumes.

Target model:

```text
WorkspaceActivityReservation
  owner = task(taskId) | standalone_teach | standalone_annotate | playback | none
  humanControl = none | manual | teach | annotate     # only when owner is a Task
```

- Task start acquires a **Task-level workspace reservation** before runner/model work and holds it across `running` and `waiting_for_user`; terminal settle releases it.
- Existing `recording/playing/executing` workspace states and execution leases remain lower-level correctness guards around active operations. The product reservation composes with them; it does not replace them or keep a browser step lock held while waiting.
- While linked takeover/Teach/Annotate is active, the Task keeps the reservation but marks human control active. This prevents a second Task/playback/standalone authoring activity from stealing the workspace while the first Task waits for the human.
- Standalone Teach and standalone Annotate acquire the same product activity reservation and therefore cannot start while a Task is active.
- User mouse/keyboard input is not lockable by the backend; linked human guidance is safe because Agent mutation is suspended and Return Control forces World refresh/replan.
- Starting another Task while one is active offers **Stop current task**; no queue is offered until queue semantics exist.
- **Current gap:** Agent service `start()` does not acquire a Task reservation; standalone recording review returns the coarse workspace state to `idle`; Annotator has request-scoped execution only. The existing coarse state/lease therefore does not enforce the product invariant across Task waits or authoring review. This is a BLOCKER.

## 11. Environment, connectivity, and failure modes

| Situation | Behavior (desired) | Today |
|---|---|---|
| Navigation (same workspace) | Task continues; world observations refresh; running/waiting preserved. | URL change bridge exists; sessions keyed to workspace persist. |
| Reconnect (WS/panel) | Reattach to running/waiting tasks while backend continuation exists. Poll only as fallback; truth from the event stream. | Polls `agent.sessions.list` every 2.5s only while any session is `running` (extension/src/content/floating_ui.ts:279-286). |
| Extension reload | Rebuild product projection. If Teach was actively recording, backend state may still say recording but per-page recorder capture is not automatically re-armed: show **Teaching interrupted — Stop & Review / Discard**, never a fake continuing REC. A checkpoint review state can still be queried from the same backend. Annotator may recover its extension-session draft when page identity matches. | Product workspace projection/re-arm contract is missing. |
| Service restart | Active/waiting Task and active checkpoint Teach are non-resumable today. Show interrupted authoring unless state can be proven. Annotator `chrome.storage.session` draft is an extension-session recovery aid, not durable backend save state and does not survive a full browser session restart. | retained Agent continuation/checkpoint recording session are in memory. |
| Model failure | Task -> `failed` with provider/model error in report; recovery request if world effects may be mid-flight. | Failure recorded via result.error / report. |
| World conflict | First enter `recovering`: refresh/recompute automatically when policy proves it safe. Only ask the user when ambiguity/risk remains; otherwise continue. If exhausted/blocked, fail with concise conflict evidence. | Conflict raised as a step error into retained debug recovery; no product recovery projection yet. |
| Auth failure | Task -> `failed` with an auth code; no secret / materialized-credential leakage; redaction applied. | Auth/redaction layers exist (security/auth, security/redaction). |
| Offline | Polling errors surface as a connectivity state; UI keeps the last known snapshot and shows a stale banner; no destructive actions taken. | Poll failure renders a status error. |

Reattach rule (invariant): the UI reattaches to a running/waiting task **only while the backend continuation exists**. After restart it does not exist today => `interrupted`, non-resumable, and the user is told so explicitly rather than shown a misleading "resume".

## 12. Event / projection contract (backend -> UI)

### 12.1 WorkspaceProductView and AgentTaskView

The product shell reads one authoritative workspace projection before rendering Task/Home/Teach/Annotate/Library state:

```text
WorkspaceProductView
  workspace
  reservation: idle | task | teach | annotate | playback
  activeTask?: AgentTaskView
  authoring?: TeachView | AnnotateView
  librarySummary: {automations, procedures, recoveries, demonstrations, pageKnowledge}
```

- `reservation` is product activity ownership, not the lower-level execution lease.
- `TeachView` exposes `teachKind: procedure|recovery|demonstration`, product state such as `setup|recording|review|saving`, step count, selected Page Knowledge context (when structured), and whether an unsaved asset exists; it does not expose raw Steps/selectors/DSL. For structured Teach it should adapt existing `checkpoint.record.get`.
- `AnnotateView` bridges the existing Annotator product stage/session state and exposes only enough for launcher/routing/recovery; the detailed editor remains owned by the Annotator Canvas.
- A linked Teach/Annotate activity remains represented inside `activeTask.interaction` because the Task still owns the workspace reservation.

`AgentTaskView` is one object per Task, derived from session + interactions + report, sanitized:

| Field | Notes |
|---|---|
| `taskId` | opaque public product identifier; normally not rendered, and no contract-level dependence on `sessionId` |
| `status` | lifecycle: draft/running/waiting_for_user/completed/failed/cancelled/interrupted |
| `phase` | planning/observing/executing/recovering/interacting, or absent (=> generic running) |
| `interaction` | current pending interaction card, if `waiting_for_user` (section 13) |
| `title` / `promptSummary` | user-authored + truncated |
| `result` | outcome summary when terminal (section 9.1) |
| `error` | terminal code + message |
| `reportAvailable`, `resumable` | booleans |

### 12.2 Sanitized event stream (activity)

Ordered, monotonic `seq`; idempotent by `(taskId, seq)`.

| Category | Payload (sanitized) | Truthfully renders |
|---|---|---|
| `task_created` | prompt summary, startedAt | task started |
| `phase_changed` | phase | Planning / Observing / Executing / Recovering |
| `activity` | observable summary (no chain-of-thought) | timeline entry |
| `interaction_requested` | per-kind card payload | interaction card |
| `interaction_resolved` | decision summary | card resolution in timeline |
| `human_guidance_started` | mode manual/teach/annotate, sanitized purpose | user took control / started teaching / started annotation |
| `human_guidance_completed` | mode, savedAssetKind? (no raw artifact body/id) | guidance returned to Agent; timeline may say Procedure/Page Knowledge updated |
| `effect_applied` | user-facing action summary, status (no raw tool name/args) | observable execution activity |
| `world_conflict` | expected vs actual | recovery evidence |
| `task_terminated` | outcome | result |
| `report_ready` | — | report available |

Rules:

- The Task stream is the only source for the Task activity timeline; standalone Teach/Annotate lifecycle belongs to `WorkspaceProductView`/authoring projection and Library, not Task history. No hidden reasoning is projected.
- If a phase category is absent, the UI shows generic `running` (truthfulness rule, section 2.2).
- Raw internal ids (`sessionId`, `runId`, `continuationId`, revision counters, tool names) appear only in developer mode (section 14).
- Reconnect protocol is snapshot + sequence: fetch `AgentTaskView` with `lastSeq`, then subscribe/request events strictly after `lastSeq`. Events are deduplicated by `(taskId, seq)`; a detected sequence gap causes a projection refresh instead of guessing missing state. Polling may implement this as a fallback transport, but the semantics stay identical.

### 12.3 Product command boundary

The product surface is task-centric even if it is initially adapted onto existing `agent.sessions.*` internals. Required command semantics:

| Command intent | Input visible to product logic | Result / rule |
|---|---|---|
| start | prompt | creates one Task if workspace has no active Task |
| get/list | taskId / workspace | returns `AgentTaskView`; history list contains terminal tasks plus separately pinned active Task |
| stop | taskId | explicit user cancellation; idempotent once terminal |
| events | taskId + `afterSeq` | ordered sanitized events; gap -> projection refresh |
| approve/deny | taskId + opaque interaction token/version + resolution | validates kind/version; approve may advance exact execution barrier; deny resumes same Task through Agent control continuation |
| answer clarification | taskId + opaque interaction token/version + typed answer | validates answer; same Task control lineage resumes through Agent control continuation |
| choose recovery | taskId + opaque interaction token/version + backend option id | rejects stale/ineligible option; same retained run executes choice |
| take over / return control | taskId + opaque interaction token/version | two-stage takeover semantics from section 8 |
| save automation | taskId + user-selected name | explicit persistence of an eligible completed Program; never implicit |
| start/stop Teach | workspace + teachKind + selected Page Knowledge (when structured) | acquires Teach reservation; procedure/recovery drive `checkpoint.record.start/stop`; demonstration drives generic `record.start/stop` |
| review/save/cancel Teach | workspace + current Teach token/context | structured review adapts `checkpoint.record.get` summaries/mappings and saves/cancels through checkpoint recorder; generic demonstration uses sanitized `record.get` projection + `record.save/clear` |
| open/close Annotate | workspace + optional Page Knowledge profile | acquires/releases standalone Annotate reservation and opens/closes existing Annotator session |
| list Library | workspace | sanitized Automations/Procedures/Recovery/Demonstrations/Page Knowledge metadata; no raw source/body/step/query plan |
| replay Demonstration | workspace + asset ref | acquires playback reservation and uses existing replay runtime |

The opaque interaction token/version is a transport concurrency primitive, not a user-visible identifier. A stale token never causes an automatic retry of an approval, denial, recovery choice, or return-control command.

## 13. InteractionRequest: discriminated union (per-kind)

Instead of one generic approve/deny applied to every kind, each interaction carries a kind-specific payload and a kind-specific resolution.

| Kind | Request payload (evidence, sanitized) | User resolution | Result contract |
|---|---|---|---|
| approval (`irreversible-effect-approval`) | user-facing action/target/consequence summary, irreversible risk, concurrency token | approve | deterministic execution continuation may cross the exact barrier |
| approval (`irreversible-effect-approval`) | same | deny | control continuation receives denied + reason + optional requestedAlternative; denied effect does not run |
| clarification (`user-input-clarification`) | question, schema {field, type, allowed?, min/max?, maxLength?, default?}, concurrency token | answer (validated) | Agent control continuation receives typed answer |
| recovery_decision (`recovery-confirmation`) | failure summary, evidence, backend options[{id, kind, label, eligible, block?}], concurrency token | choose optionId | execute exact option and/or return result to control continuation; `terminate` => failed |
| takeover (`takeover`) | reason, scope, observed World, guidanceModes[manual/teach/annotate], optional teachKind[procedure/recovery/demonstration] | choose allowed mode, then return control | stage `active`; linked Teach/Annotate result + fresh observe/semantic refresh/replan through control continuation |

Per-interaction state machine (product projection; backend storage may retain its existing `approved/denied/cancelled/expired` status vocabulary):

```
approval / clarification / recovery:
  pending --resolved(resolution)--> resolved
      \----cancelled-----------> cancelled
      \----expired-------------> expired

takeover:
  offered --take_over-----------> active --return_control--> resolved
      \----cancelled-----------> cancelled
      \----expired-------------> expired
```

Strictness:

- A resolution type is valid only for its kind (deny only on approval; answer only on clarification; optionId only on recovery; etc.). A mismatched resolution is rejected.
- Clarification defaults are applied only if the request contract explicitly marks the default as safe-on-timeout; otherwise expiry is a timeout resolution and never silently submits a value.
- Approval can use the current execution continuation only for the exact approved barrier. Other resolutions must enter the missing Agent control continuation described in §3.4; adding an argument to the current DSL `resume()` is insufficient. Internal continuation ids are not a product invariant.

## 14. Developer mode

- Separate surface, reached only through an explicit developer disclosure (visible, confirmable toggle). Not hidden.
- Exposes: Program vs ReAct (`executionMode`), provider/model, raw report/trace, session-level ids (`sessionId`/`runId`/`revision`), internal action names, control-RPC actions.
- Invariant: developer-mode settings never silently alter product defaults. The product Task composer is provider/model-agnostic and uses defaults unless the user opts into developer mode.
- Today's Agent panel is effectively all developer surface (provider/model/executionMode inputs and `agent.sessions.*` buttons, agent_session_ui.ts:701-767). Product UI (section 15) is a new surface; the existing panel becomes the developer view.

## 15. Main UI flow

```
launcher / Home
  -> Run: task composer / current task
       -> activity -> interaction/human guidance -> result -> history
  -> Teach: structured Procedure/Recovery recording (primary) or Basic Demonstration
       -> semantic review -> explicit save -> Library
  -> Annotate: existing annotator canvas -> check -> explicit save -> Library/Page Knowledge
  -> Library: Automations / Procedures+Recovery / Demonstrations / Page Knowledge
```

- The current Task is the active surface while running/waiting; standalone Teach/Annotate are disabled while its workspace reservation is held.
- When a Task requests linked Teach/Annotate, the authoring surface is entered from the Task interaction and returns its typed result to that same Task.
- The interaction/human-guidance card is the primary action surface while waiting; unrelated authoring commands are read-only/disabled.

## 16. Gap table: current implementation -> desired contract

Severity: **BLOCKER** = must change before any product UI; **HIGH** = blocks truthful phases/modes; **MEDIUM** = correctness/UX of projection; **LOW** = documented constraint.

| # | Current implementation (verified) | Desired contract | Severity |
|---|---|---|---|
| 1 | Deny cancels the whole session and pending interactions -> `cancelled` + `ERR_SESSION_INTERACTION_DENIED` (session/manager.ts:371-386) | Deny = structured feedback to the same loop; never cancels (section 4) | BLOCKER |
| 2 | Only `irreversible-effect-approval` is produced end-to-end; `recovery-confirmation`, `user-input-clarification`, `takeover` exist only in `INTERACTION_KINDS` (interaction/contracts.ts:7-14) | All four modes implemented end-to-end with discriminated requests (section 13) | HIGH |
| 3 | Current `continuation.resume()` is a deterministic DSL/debug continuation with no external input and no retained model loop | Add a separate Agent control continuation for denial/clarification/recovery/human-guidance input; keep execution continuation for exact approval barrier | BLOCKER |
| 4 | Lifecycle `running|paused|completed|failed|cancelled`; `paused` conflates interaction wait and orphan failure/non-approval pauses; no phase | Product projection has `waiting_for_user`; stable pause requires a concrete interaction/control continuation; separate truthful phase | HIGH |
| 5 | UI truth = 2.5s poll of `agent.sessions.list` while running (floating_ui.ts:279-286) | Truth = sanitized event stream projection; polling only as fallback; no timer phase inference | MEDIUM |
| 6 | Reports persist to disk and load on demand (session/storage.ts); debug history exists | Project AgentTaskView + sanitized stream; hide raw ids (`sessionId`/`runId`/`revision`) | MEDIUM |
| 7 | Agent panel exposes provider/model/executionMode/raw action names (agent_session_ui.ts:701-767) | Product surface hides them; developer mode gates them (section 14) | MEDIUM |
| 8 | Interactions are generic prompt+evidence with approve/deny for every kind | Per-kind discriminated request + resolution with typed options (section 13) | HIGH |
| 9 | Program persistence is already explicit via `agent.save_program`; normal completion does not auto-save (program/runner.ts) | Preserve this invariant and add a product-level Save Automation command/button for eligible completed Programs | MEDIUM |
| 10 | Coarse workspace states already protect active recording/playback/executing operations, but Agent Task start has no Task reservation across waiting/paused states and generic recording review is back at `idle` | Add WorkspaceActivityReservation above existing states/leases; one active Task or standalone authoring/replay activity; linked guidance stays under Task reservation | BLOCKER |
| 11 | Structured checkpoint recorder already implements procedure/recovery setup, recording, review summaries, semantic mappings, save/cancel; it is not integrated with Agent Task/product Library | Make this the primary Teach flow; reuse it rather than replace it; Task-linked Teach returns saved checkpoint/result to control loop | HIGH |
| 12 | Generic Recording is durable/replayable but `record.get` exposes raw step bundle and no Agent planning catalog/load seam | Keep as secondary Demonstration flow; add sanitized review + bounded Guidance Catalog/load | HIGH |
| 13 | Entity Rules annotator and runtime SemanticBindings already exist and are product-grade foundations; no Task-linked Annotate/return-control flow or unified product Library | Reuse annotator; expose Page Knowledge in Library; linked annotation returns to same Task then refreshes World/SemanticBindings | HIGH |
| 14 | Interaction expiry is lazy-only: no deadline timer and no timeout resolution enters the retained Agent | Timer-driven expiry + typed timeout control input; never cross an irreversible barrier after expired approval | MEDIUM |
| 15 | Paused continuation is in-memory only; restart => running -> `failed` `ERR_SESSION_INTERRUPTED`, paused non-resumable | Durable continuation image including control continuation + active interaction/guidance state | BLOCKER |

## 17. Implementation order

1. **Task reservation + continuation split + denial semantics.** Add WorkspaceActivityReservation and retained Agent control continuation; keep current deterministic execution continuation for exact approval. Denial returns to control loop without executing the denied effect. Gate: a waiting Task cannot be overtaken by a second Task; deny never cancels or crosses the denied barrier.
2. **Product projection / commands / event stream.** AgentTaskView, product aliases for interaction kinds, sanitized sequence-based activity, reconnect snapshot+afterSeq. Gate: no stable orphan `paused` projection and no raw internal ids in product surface.
3. **Clarification + recovery + takeover human-guidance contract.** End-to-end typed control inputs; takeover supports backend-declared `manual|teach|annotate`; automatic safe recovery precedes user interruption. Gate: all waiting states have a real resolution path into the same Task.
4. **Teach / Annotate product integration.** Make existing checkpoint procedure/recovery recorder the primary Structured Teach surface; keep generic Recording as secondary Demonstration; reuse existing Annotator. Add reservation/delegation, Library projection, linked-guidance return-control, and bounded Guidance Catalog for checkpoints/demonstrations.
5. **Product UI.** Run composer/current task/activity/result/history plus first-class Teach, Annotate, Library; old provider/model/session surfaces move to Developer Mode.
6. **Durable continuation.** Persist sufficient Task/control/execution/interaction state so restart can rehydrate a waiting Task; active human guidance must rehydrate conservatively.
7. **Black-box product E2E.** Run success/HITL/deny/clarify/recovery/takeover plus standalone Teach, standalone Annotate, Task->Teach->return, Task->Annotate->return, Library reuse, restart and no-fake-queue.

## 18. Global invariants

- I1 One mutation owner per workspace at any instant.
- I2 Deny is never a cancel; only an explicit stop cancels.
- I3 Approve/deny/clarify/recovery/return-control continue the same retained run lineage; never a new run/task.
- I4 Phases are never inferred; generic `running` until a phase event.
- I5 The product surface exposes only the opaque `taskId`; raw ids live in developer mode.
- I6 No automation is persisted without an explicit user push.
- I7 Recovery/takeover render only options/actions the backend actually provides.
- I8 Takeover return-control replans from a fresh world observation and never replays stale effect assumptions.
- I9 No queue until queue semantics are implemented.