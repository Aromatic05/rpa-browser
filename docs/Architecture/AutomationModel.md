# Product Automation Model

Status: Design (DESIGN FIRST). Codifies the durable automation model behind the product: the real runtime hierarchy **Entity Rules -> DSL / Workflow Checkpoint -> Step runtime**, the run-closure snapshot, the dependency DAG, and the authoring flow. This is the authority for terminology and layer boundaries; [Overview.md](./Overview.md), [AgentProductInteraction.md](./AgentProductInteraction.md) and [AgentProductUI.md](./AgentProductUI.md) reference it instead of restating it.

Grounding: [docs/Runtime/Dsl.md](../Runtime/Dsl.md), [docs/Runtime/Checkpoint.md](../Runtime/Checkpoint.md), [docs/Runtime/EntityRules.md](../Runtime/EntityRules.md), [docs/Runtime/Recording.md](../Runtime/Recording.md), [docs/Runtime/Workflow.md](../Runtime/Workflow.md) and the agent source under `agent/src/automation/{dsl,runner,checkpoint,snapshot/rules}`.

## 1. The three layers

```text
[Product surface]  Task · Teach · Annotate · Library · Guidance Catalog

[Semantic layer]   Entity Rules (page semantic schema/bindings)
                        ^  feeds DSL symbols (use entity_rules)
                   DSL — top-level business program/composition language
                        |  references (use checkpoint) / composes
                   Workflow Checkpoint — Procedure / Recovery subprograms (body = DSL)
                        |
[Execution layer]  Step runtime — unified execution ABI / runtime IR
                        -> executors -> leaf observations / World effects
                        -> trace + effect journal / transaction
```

-   **Entity Rules** are the _page semantic schema and bindings_: they define the business nouns/entities (`entityKey`, `businessTag`), their fields, actions, row actions, primary key and supported queries. They consume Snapshot V2's canonical observation and are compiled to a QueryPlan at save time (docs/Runtime/EntityRules.md; `annotation.yaml`). At runtime, selected rules feed the `PageSession`/SemanticBindings and expose `RuntimeEntityView` (fields/actions/rows/pagination/dialog/list/panel/toolbar/kv).
-   **DSL** is the top-level _business program/composition language_. It describes business objects, queries, page actions, control flow and reusable checkpoints; it never calls Playwright directly (docs/Runtime/Dsl.md). The compile pipeline is `parse -> link -> normalize -> validate` (`compileDslSource`, agent/src/automation/dsl/runtime/run_dsl_source.ts): `link` lowers `entity_rules`/`resolves` symbols to executable targets, `normalize` expands sugar (form/table/query sugar), and every remaining statement is executed through the unified step runner. The runtime rejects anything not normalized (`ERR_DSL_NOT_NORMALIZED`) or not linked (`ERR_DSL_NOT_LINKED`).
-   **Step runtime** is the _unified execution ABI / runtime IR_: `Step` is the instruction shape shared by MCP/play/script/record/control-rpc/DSL, describes _what to do_ without carrying Page/Locator runtime objects, and has strongly typed `name`+`args` (agent/src/automation/runner/steps/types.ts). It is **not necessarily a leaf or one atomic World effect**: `browser.query`/`browser.compute` are reads/computation, and composite `browser.checkpoint` can execute a Procedure body containing nested Steps. `runSteps`/the Step execution port dispatch instructions to executors; the transactional World-effect boundary is the runtime effect descriptor + actual leaf effect recorded by the effect journal. Step is never a durable user-facing product asset, although Recording may persist Step sequences internally.

## 2. Workflow Checkpoint is not a parallel language

A Workflow Checkpoint is **metadata around a DSL body**, not a second language:

-   **Procedure** — an explicit named, reusable subprogram. Invoked from DSL with `use checkpoint "id" with { ... }`; its output is the `output` scope of `body.dsl`. The artifact adds only the invocation contract (`checkpoint.yaml`, `body.dsl`, optional resolve sidecar/hints).
-   **Recovery** — a failure-triggered handler. The artifact adds trigger/policy metadata (`trigger.matchRules` all-of: `errorCode`/`stepName`/`urlIncludes`/`textVisible`/`entityExists`; `policy.maxAttempts`/`retryOriginal`) and the `failure.*` body scope. The ordinary `runSteps` / default DSL task-runner path snapshots automatic Recovery candidates and may select one after a failing Step; its `body.dsl` then executes through the same DSL pipeline. The retained program-first Agent path currently uses a custom `StepExecutionPort` plus debug transaction recovery and therefore **does not yet consume this automatic Workflow-Recovery selector**; integrating taught Recoveries into Agent recovery is a product gap.

Both `body.dsl` sources compile and validate through `parse -> link -> normalize -> validate` (`checkpoint.save` validates body DSL and the nested checkpoint graph; `runCheckpointDslBody` executes the body via `runDslSource`), and both execute via steps. There is no separate checkpoint language (docs/Runtime/Checkpoint.md; agent/src/automation/runner/checkpoint/{run,dsl_body,main}.ts).

## 3. Terminology

| Product term (user-facing) | Internal artifact                                                  | Runtime doc / notes     |
| -------------------------- | ------------------------------------------------------------------ | ----------------------- |
| Automation                 | saved Program / DSL (`dsls/<name>.dsl` + `resolve.yaml`)           | Dsl.md, Workflow.md     |
| Procedure                  | Workflow Checkpoint `kind: procedure` (`body.dsl`)                 | Checkpoint.md           |
| Recovery                   | Workflow Checkpoint `kind: recovery` (`body.dsl` + trigger/policy) | Checkpoint.md           |
| Demonstration              | generic Recording (`recordings/<name>/steps.yaml`)                 | Recording.md, Replay.md |
| Page Knowledge             | Entity Rules profile (`entity_rules/<profile>/`)                   | EntityRules.md          |
| Step                       | execution ABI / runtime IR — **never a durable product asset**     | steps/types.ts          |

Product rule: the surface says **Procedure / Recovery** and never the ambiguous word **Checkpoint**, except in Developer Mode. "Checkpoint" also names the unrelated **Task run checkpoint** (runner durable cursor/status for progress recovery); the two domains must stay separate (docs/Runtime/Checkpoint.md §两个不同的 checkpoint domain). "Run closure snapshot" and "savepoint" are implementation terms, not product vocabulary.

## 4. Run closure snapshot

`dsl.run` and retained Agent Program execution both materialize a frozen DSL dependency runtime before executing effects. The direct `dsl.run` path performs this inside its workspace `executing` lifecycle; the retained Agent executor performs the corresponding materialization before creating the debug execution session:

```text
materialize referenced checkpoint runtime snapshot
  -> freeze (structuredClone + deep Object.freeze)
     checkpoints + bodies + step resolves
     + entity-rule resolve exports (entity_rules.resolveExports)
     + resolve bundles (workflow DSL sidecars)
  -> preflight: source parse/link/normalize/validate
     + whole referenced checkpoint graph (missing/non-callable/body-missing/recursion/depth)
  -> execute DSL (only after preflight passes; no step runs before it)
```

The explicitly referenced Procedure/Page-Knowledge/resolve closure is discovered transitively by scanning DSL asset references from the top-level source through nested `body.dsl` (`materializeReferencedCheckpointRuntimeSnapshot`, agent/src/automation/runner/checkpoint/runtime_snapshot.ts; wiring in `dsl.run` and the Agent workspace program executor). Automatic Recovery is different: ordinary `runSteps` additionally snapshots the workspace Recovery candidate set, while the retained Agent path does not yet route failures through that selector.

**Why edits affect the next run, not the active run:** the snapshot is materialized and _frozen at run start_, inside the execution lease. The run then executes only against that frozen copy; a later `dsl.save`/`checkpoint.save`/direct file edit changes artifact content and revision, so it is picked up by the _next_ run's fresh materialization, and produces `ERR_CONFLICT` for cooperative saves that still carry the old `expectedRevision`. The freeze is also why a bad direct file edit left after run start cannot inject a broken dependency mid-run (docs/Runtime/Workflow.md §DSL 保存边界, docs/Runtime/Checkpoint.md §运行时 snapshot).

## 5. Dependency DAG and invariants

```text
Automation (top-level DSL)
   ├── use entity_rules ...  -> Page Knowledge profile (semantic symbols)
   ├── use checkpoint ...    -> Procedure (body.dsl)  [recursive: nested use checkpoint]
   └── use resolves ...      -> Recording/DSL resolve sidecar (low-level)

Recovery (body.dsl)          -> same as Procedure + trigger/policy metadata + failure.* scope
Page Knowledge (profile)     -> Snapshot V2 QueryPlan / SemanticBindings  [runtime-applied]
Demonstration (Recording)    -> Step sequence (replay) — NOT a semantic dependency of Automation
Step runtime                 <- every layer above (execution ABI)
```

Invariants:

-   **D1** DSL (top-level + procedure/recovery bodies) is the authorable program surface. Step is execution IR; it is never authored or listed as a product asset. Recording may persist Step sequences as an internal replay representation without promoting Step into product vocabulary.
-   **D2** Entity Rules are the stable semantic interface. Business DSL depends on `entity_rules` symbols; raw selectors / resolve sidecars are lower-level and never the business interface (docs/Runtime/Dsl.md §Import).
-   **D3** Procedure/Recovery compile through the DSL pipeline and execute via steps; there is no parallel checkpoint language.
-   **D4** The run closure is frozen at run start; mid-run artifact edits never affect the active run.
-   **D5** Product vocabulary uses Procedure/Recovery/Demonstration/Page Knowledge/Automation, never bare "Checkpoint" outside Developer Mode.
-   **D6** Library and Guidance Catalog expose compact metadata and _high-level dependency references_; raw bodies, step lists and selectors are loaded only on explicit selection, and raw source only in Developer Mode.

## 6. Authoring flow

```text
Annotate  (defines nouns/schema)
   page.yaml + match.yaml + annotation.yaml
   -> Entity Rules profile (entityKey, fields, actions, row actions, primary key, businessTag)
        |
        v  (provides semantic symbols)
Structured Teach  (records verbs, maps them to Entity Rules)
   checkpoint.record.* -> Procedure/Recovery: body.dsl + checkpoint.yaml (+ trigger/policy)
        |
        v
Automation  (composes Page Knowledge + Procedures into the top-level DSL)
   dsls/<name>.dsl: use entity_rules + use checkpoint + control flow
```

-   **Annotate** defines the business nouns and their schema; it is the prerequisite for semantic Teach and for symbol-based DSL.
-   **Structured Teach** records the verbs (what a human does) and semantically maps them to Page Knowledge fields/actions/row actions, producing a **Procedure** (reusable subprogram) or **Recovery** (failure handler with trigger/policy) as DSL — not a raw step dump.
-   **Automation** composes Page Knowledge + Procedures into a top-level business program.
-   **Demonstration** is the lower-level Recording source/replay asset (`record.start -> actions -> record.stop -> record.save`, replayable via playback). It is _not equivalent to a Procedure_: it has no semantic mapping and does not feed DSL symbols automatically. It exists for capture/replay and as material for later authoring/repair (docs/Runtime/Recording.md, docs/Runtime/Workflow.md §Recording).

## 7. Library IA and Guidance Catalog

-   **Library IA** (product): Automations, Procedures, Recoveries, Demonstrations, Page Knowledge. **Step is never a library asset.** Dependency detail shows high-level references (an Automation "uses Procedure X and Page Knowledge Y"; a Procedure "uses Page Knowledge Z"), never raw selectors/steps.
-   **Contract view, not source preview:** Automation shows purpose/dependencies/health; Procedure shows declared inputs/outputs and dependencies; Recovery shows trigger/policy (`maxAttempts`, `retryOriginal`) plus dependencies; Page Knowledge shows page applicability, business entities/fields/actions/primary key and action-safety semantics; Demonstration shows entry/page scope, step count and replayability. Raw DSL/YAML/Step data stays in Developer Mode.
-   **Dependency health** is `Ready | Needs review | Broken dependency` only when backed by validation evidence. Existing artifact revisions, save-time DSL/checkpoint validation and run preflight are the evidence seams; there is **no background dependency-health service today**, so the UI must not guess. An active run keeps its frozen closure; a dependency edit can make the _next_ validation/run fail without mutating the active execution.
-   **Guidance Catalog** (Agent planning): compact metadata + dependency references for Automations/Procedures/Recoveries/Demonstrations/Page Knowledge (name, kind, meaning, applicable page, counts/contract metadata). Raw bodies and Step lists are loaded **only when explicitly selected**; raw source is Developer Mode. Page Knowledge may already be selected/runtime-applied, so the catalog surfaces applicability rather than dumping QueryPlan internals.
-   **Current Agent-consumption maturity is uneven:** Page Knowledge already enters runtime semantics; referenced Procedures execute when DSL names them but the Agent lacks a Procedure catalog/discovery seam; Workflow Recovery auto-selection exists in ordinary `runSteps` but is not yet wired into retained Agent debug recovery; Demonstrations are replayable but have no Agent load/catalog seam.

## 8. Step-side-effect declaration, world preconditions, credentials

The source supports these execution-boundary facts, and the product must surface them truthfully (approval/recovery decisions depend on them):

-   **Side-effect classification:** execution instructions are classified `read | effect` by `classifyBrowserOperation` (with dynamic classification where needed). Entity Rules members may declare **effect reversibility** (`unknown | reversible | compensatable | irreversible`) which DSL linking propagates as `EffectSemantics` with an `entity_rules` source. This is business semantics a raw physical click cannot infer. The current Annotator does **not** expose authoring for this field; product Annotate needs a user-facing safety question such as “Can this action be undone?” mapped to the internal reversibility enum.
-   **World preconditions:** DSL effect execution can pass an `expected-world` precondition (`{pageEpoch, captureRevision}`) through `StepExecutionPort`, so a mutation derived from an observed target can be refused when the World moved. This is execution context, not a persisted field present on every Step.
-   **Credential finalization:** credential refs inside step args are resolved to final values at the step execution port boundary — immediately before the step runs, never persisted into the artifact (agent/src/automation/dsl/runtime/credentials/step_port.ts). A failure to resolve yields `ERR_SECURITY_CREDENTIAL_UNRESOLVABLE`; redaction applies.

These are current-source facts, not proposals. Anything the runtime does not emit must not be projected.

## 9. Cross-references

-   Runtime authority: Dsl.md, Checkpoint.md, EntityRules.md, Recording.md, Replay.md, Workflow.md.
-   Source pointers: `agent/src/automation/dsl/{runtime,link,emit,validate}`, `agent/src/automation/runner/{run_steps,steps,checkpoint}`, `agent/src/automation/snapshot/rules`, `agent/src/program/{dsl,effects,query}`.
-   Consumed by: Overview.md (layering), AgentProductInteraction.md (product identity/authoring/guidance), AgentProductUI.md (Library/Teach presentation).

## 9. Terminology evolution (non-blocking)

The product uses **Procedure / Recovery** today even though internal APIs and current DSL syntax still say `checkpoint`. A future DSL revision may add `use procedure "..."` as the preferred authoring alias for callable procedure checkpoints while retaining `use checkpoint` for backward compatibility. This is terminology cleanup, not a delivery blocker and not a reason to rename runtime checkpoint APIs now.
