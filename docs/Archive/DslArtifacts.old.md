# DSL Artifacts

## Directory Structure

```text
agent/.artifacts/workflows/<scene>/dsl/
├─ main.dsl
├─ inputs.example.yaml
└─ README.md
```

## Notes

- DSL scripts are authored by human/AI and maintained as source files.
- DSL files are not auto-generated.
- Workflow ↔ workspace binding is not implemented yet.
- DSL can be executed via `runDslSource` or control RPC.

## Example

`main.dsl`:

```dsl
let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}

for user in input.users:
  if user.enabled:
    fill buyer with user.name
```
