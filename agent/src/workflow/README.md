# Workflow Boundary

Prompt-Version: workflow-correction-v0.3

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

- `workflow.status`
- `workflow.dsl.get`
- `workflow.dsl.save`
- `workflow.dsl.test`
- `workflow.releaseRun`
- `workflow.record.save`
- `workflow.record.load`

Workspace actions must use `action.workspaceName` only.

## Artifact Kinds

- `recording`
- `checkpoint`
- `dsl`
- `entity_rules`

## Directories

- root: `agent/.artifacts/workflows/<workflowName>/`
- recordings: `recordings/<recordingName>/`
- checkpoints: `checkpoints/<checkpointName>/`
- dsls: `dsls/<dslName>.dsl`
- entity rules: `entity_rules/<profileName>/`

## Legacy Paths Removed

- no `steps/<recordingName>/` main path
- no `dsl/<dslName>.dsl` main path
- no `agent/.artifacts/entity_rules/profiles/<profile>/` main path
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

## Record Persistence Boundary

- `record.save` may create workflow persistence location.
- `record.load` must not create workflow artifacts.
