# Workflow Boundary

Prompt-Version: workflow-correction-v0.4

- workflow is the workspace-scoped serialization gate.
- workflowName must equal workspaceName.
- Workflow.name is an internal readonly identity field.
- workflow facade is fixed to:
  - `workflow.save(value)`
  - `workflow.get(name, dummy)`
  - `workflow.list(dummy)`
  - `workflow.delete(name, dummy)`
- `name` is the artifact key.
- `dummy` is the kind marker only.
- `dummy` must not carry `name`, path fields, runtime objects, or artifact content.

## Control Actions

- `workflow.list`
- `workflow.create`
- `workflow.open`
- `workflow.rename`

Control actions must use payload workflow naming fields only:

- `payload.workflowName`
- `payload.fromName`
- `payload.toName`

Control actions must not use `payload.workspaceName` or active-workspace fallback.

## Workspace Actions

- `dsl.get`
- `dsl.save`
- `dsl.test`
- `dsl.run`

Workspace actions must use `action.workspaceName` only.

## Artifact Kinds

- `recording`
- `checkpoint`
- `dsl`

## Directories

- root: `agent/.artifacts/workflows/<workflowName>/`
- recordings: `recordings/<recordingName>/`
- checkpoints: `checkpoints/<checkpointName>/`
- dsls: `dsls/<dslName>.dsl`
- entity-rule profiles: `entity_rules/<profileName>/` with `match.yaml`, `annotation.yaml`, and optional `page.yaml`

## Manifest and Artifact Authority

- `workflow.yaml.name` and `workflow.yaml.entry.dsl` are workflow source-of-truth fields.
- `workflow.yaml.catalog` is optional cache/display metadata. Artifact existence is discovered from the artifact directories, not from catalog membership.
- A valid artifact added directly under `dsls/`, `checkpoints/`, `recordings/`, or `entity_rules/` is visible through `workflow.get/list` even when no catalog entry exists.
- A catalog entry whose artifact was fully deleted is stale cache and is ignored. A partially present but invalid artifact is still reported as an invalid artifact.
- Workflow API save/delete operations reconcile stale catalog entries and refresh metadata for the mutated artifact; authors do not need to hand-maintain derived `summary`, checkpoint `enabled/priority`, or catalog membership.
- `.locks/` and `*.lock.reclaimed/` are runtime lock internals, not workflow artifacts. Reclaimed generation tombstones are intentionally retained to prevent delayed stale reclaimers from acting on a newer lock generation.
- Workflow save/delete supports lock-held `expectedRevision` CAS for writers that participate in the workflow lock protocol. Revisions are stable hashes of the loaded artifact's semantic content, so direct filesystem edits completed before CAS invalidate stale editor revisions without a revision sidecar; raw concurrent filesystem writers are not transactional participants.

## Artifact Names and Entry DSL

- Workflow names, recording names, checkpoint IDs, DSL names, and entity-rule profile names use the same safe artifact-name boundary. Empty names, `.`/`..`, path separators, traversal, and other unsafe names are rejected before filesystem access.
- Filesystem artifact paths are checked for canonical containment under the workflow root before reads, writes, or deletes.
- `workflow.yaml.entry.dsl` is the authoritative default for `dsl.get`, `dsl.save`, `dsl.test`, and `dsl.run`. A missing or unreadable entry DSL returns the action's structured not-found diagnostic; it never falls back to another catalog item.
- The entry DSL cannot be deleted while it is configured as `workflow.yaml.entry.dsl`.

## Legacy Paths Removed

- no `steps/<recordingName>/` main path
- no `dsl/<dslName>.dsl` main path
- no scene-based workflow main path
- no `workflow:<name>` main path

## Runtime Boundaries

- checkpoint runtime receives checkpoint object + step resolves only.
- checkpoint runtime must not read YAML files.
- checkpoint artifact name must equal checkpoint.id.
- DSL runtime must not read checkpoint sidecar files directly.
- DSL runtime must not read entity rules `match.yaml` or `annotation.yaml` directly.
- entity rules persistence is owned by workflow.
- snapshot pipeline applies entity rules from loaded workflow artifacts.

## Workspace Runtime Controls

- `checkpoint.*` is routed to workspace checkpoint control.
- `task.run.checkpoint` remains runner-owned execution progress checkpoint.
- workflow checkpoint artifact and runner task checkpoint are separate domains.
- DSL uses workspace checkpoint provider.
- snapshot executor does not read workflow directly.
- snapshot executor does not read filesystem rule artifacts directly.
- shared action protocol package is not introduced in this stage.
- `dsl.save`/`dsl.validate` validate referenced checkpoint existence, callability, body availability, recursion, and call-depth before execution.
- `checkpoint.save` validates a DSL body before persistence, including recovery-only `failure.*` scope and nested checkpoint dependencies.
- `dsl.get/save` and `checkpoint.list/get/save` expose `artifactRevision`; DSL/checkpoint mutations accept optional `expectedRevision` for collaborative authoring.
- `dsl.run` and `task.run.start/resume` share one workspace execution ownership boundary. Destructive workspace lifecycle actions require `idle` and cannot tear down an active run.

## Record Persistence Boundary

- `record.save` may create workflow persistence location.
- `record.load` must not create workflow artifacts.
- `workflow.record.save` does not exist.
- `workflow.record.load` does not exist.

## Rename Identity Migration

- `workflow.rename` must update workflow directory name.
- `workflow.rename` must update `workflow.yaml.name`.
- `workflow.rename` must update workspace registry entry name.
- after rename: `workspace.name === workspace.workflow.name`.
