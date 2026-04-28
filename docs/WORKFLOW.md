# Workflow Artifacts

Workflow is the scene-level runnable package. DSL is only the main flow source inside a workflow.

## Layout

```text
agent/.artifacts/workflows/<scene>/
├─ workflow.yaml
├─ workspace.yaml
├─ dsl/
│  ├─ main.dsl
│  ├─ inputs.example.yaml
│  └─ README.md
├─ records/
│  └─ <recording-name>/
│     ├─ steps.yaml
│     ├─ step_resolve.yaml
│     └─ manifest.yaml
└─ checkpoints/
   └─ <checkpoint-name>/
      ├─ checkpoint.yaml
      ├─ checkpoint_resolve.yaml
      └─ checkpoint_hints.yaml
```

## Rules

- `workflow.yaml` is the manifest entry.
- `workflow.yaml` uses `entry.dsl` and optional `entry.inputs`.
- `workspace.yaml` belongs to workflow runtime, not DSL.
- `dsl/main.dsl` is loaded from `workflow.yaml.entry.dsl`.
- `dsl/inputs.example.yaml` can be loaded from `workflow.yaml.entry.inputs`.
- `records/` is the default write path for new recording artifacts.
- Legacy `steps/<recording-name>/` is still read for compatibility.
- Checkpoint execution still uses checkpoint runtime.
- `checkpoint_resolve.yaml` is sidecar resolve data for checkpoint action steps.
- DSL does not read checkpoint sidecar files directly.

## Workspace Binding

`workspace.yaml` supports:

- `strategy: restoreOrCreate | createOnly | restoreOnly`
- `entryUrl?: string`
- `expectedTabs?: [{ ref, urlIncludes?, exactUrl? }]`

Workflow runtime resolves workspace before DSL execution.
Current implementation validates only the current tab URL against `expectedTabs` (exactUrl/urlIncludes).
