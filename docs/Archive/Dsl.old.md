# DSL

## Design Goal

The DSL is a business-flow orchestration language for `rpa-browser`.

- It does not operate on DOM directly.
- It does not call Playwright directly.
- It resolves business targets through `browser.query`.
- It performs actions by emitting runner steps.
- It executes by runtime interpretation, not by compiling the whole script into a static step list.
- It is loaded as `workflow.yaml.entry.dsl` inside workflow artifacts.

See `docs/WORKFLOW.md` for workflow package structure and workspace binding rules.

## Execution Model

```text
DSL -> parse -> normalize -> validate -> runtime
runtime -> task_runner -> runSteps
```

At runtime, statements are interpreted one by one:

1. Parse source into AST.
2. Normalize refs into explicit `input.*` / `vars.*` / `output.*`.
3. Validate refs and statement shapes.
4. Execute with one DSL task runner and one runner `runId`.
5. Emit a step only when the current statement needs it.
6. Wait for the result, update scope, then continue.

## Scope Rules

DSL has no block scope in the current version.

- All variables live in global `vars`.
- Variables defined in `if` bodies are visible outside the `if`.
- Variables defined in `for` bodies are visible outside the `for`.
- `for` item variables may overwrite an existing variable with the same name.
- After a `for` loop ends, the item variable keeps the last iterated value.

Example:

```dsl
if input.enabled:
  let a = input.value

click a
```

This is valid because `a` is global after the `if`.

## Supported Syntax

### Query + Let

```dsl
let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}
```

### Actions

```dsl
fill buyer with input.user.name
click submit
```

## Form Syntax Sugar

```dsl
fill form "order.form" field "buyer" with input.user.name
click form "order.form" action "submit"
```

- This is normalize-phase syntax sugar only.
- It is expanded into `query entity.target` + `fill/click` statements.
- DSL still does not parse DOM directly.
- Table syntax sugar is not supported.
- Automatic pagination is not supported.

## Query Syntax Sugar

```dsl
let rows = query table "order.list" currentRows
let count = query table "order.list" rowCount
let hasNext = query table "order.list" hasNextPage
let next = query table "order.list" nextPageTarget

let fields = query form "order.form" fields
let actions = query form "order.form" actions
```

- This is normalize-phase syntax sugar only.
- It is expanded to `query entity ...`.
- Query sugar ops use camelCase directly.
- No automatic pagination.
- No implicit table row loops.
- Pagination still needs explicit DSL statements:
  `query hasNextPage`, `query nextPageTarget`, then `click next`.

### If / Else

```dsl
if input.enabled:
  click submit
else:
  click cancel
```

### For

```dsl
for user in input.users:
  fill buyer with user.name
```

### Checkpoint

```dsl
use checkpoint "ensure_logged_in" with {
  username: input.username
}
```

## Limits

- No functions
- No expression engine
- No arbitrary JS evaluation
- No syntax sugar for tables
- No pagination orchestration
- No module/import system
- Object literals use YAML syntax

## Error Types

- `ERR_DSL_VAR_NOT_DEFINED`
- `ERR_DSL_VAR_REDEFINED`
- `ERR_DSL_BAD_ACT_ARGS`
- `ERR_DSL_BAD_ITERABLE`
- `ERR_DSL_BAD_CHECKPOINT_INPUT`
- `ERR_DSL_NOT_NORMALIZED`
- `ERR_DSL_PARSE`
