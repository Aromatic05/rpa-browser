# Dsl

## 概述

DSL 是 workflow 主流程语言，运行路径为 `parse -> normalize -> validate -> runDslSource -> runSteps`。本文只描述当前实现语法与行为。

## 规范

### 1. 执行流水线

#### parseDsl

- 读取缩进语法并生成 AST。
- 规则：不允许 tab 缩进；缩进必须是 2 的倍数。
- `if/for` 语句必须以 `:` 结尾。

#### normalizeDsl

- 展开 `query sugar` 与 `form sugar`。
- 把未显式前缀的 ref 归一化到 `vars.`。
- `form_act` 会变成 `let(query entity.target)` + `act` 两条语句。

#### validateDsl

- 校验变量定义、引用、动作参数。
- 拒绝未 normalize 的 `querySugar/form_act`。

#### runDslSource

- 管道式调用 parse/normalize/validate/run。
- 返回 `scope + diagnostics`。

### 2. 作用域模型

根作用域：

- `input`
- `vars`
- `output`

当前限制：

- 无 block scope。
- `if/for` 中定义的变量会留在 `vars`。
- `for` item 会覆盖同名变量。

### 3. 语法清单

#### let + query entity

```dsl
let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}
```

#### act

- `fill <ref> with <ref>`
- `type <ref> with <ref>`
- `select <ref> with <ref>`
- `click <ref>`
- `wait <ms>`
- `snapshot`

#### if / else

```dsl
if input.enabled:
  click submit
else:
  click cancel
```

#### for

```dsl
for user in input.users:
  fill buyer with user.name
```

#### checkpoint

```dsl
use checkpoint "ensure_logged_in" with {
  username: input.username
}
```

### 4. query sugar（全部 camelCase）

表格：

- `currentRows`
- `rowCount`
- `hasNextPage`
- `nextPageTarget`

表单：

- `fields`
- `actions`

展开后分别对应：

- `query entity ... "table.<op>"`
- `query entity ... "form.<op>"`

### 5. form sugar

支持：

- `fill form "<tag>" field "<fieldKey>" with <ref>`
- `click form "<tag>" action "<actionIntent>"`

行为：

- normalize 阶段生成临时变量 `dslFormTargetN`
- 先 query `entity.target`，再执行 fill/click

### 6. 诊断与错误码

常见诊断：

- `ERR_DSL_PARSE`
- `ERR_DSL_NOT_NORMALIZED`
- `ERR_DSL_VAR_NOT_DEFINED`
- `ERR_DSL_VAR_REDEFINED`
- `ERR_DSL_BAD_ACT_ARGS`
- `ERR_DSL_BAD_ITERABLE`
- `ERR_DSL_BAD_CHECKPOINT_INPUT`

### 7. 不支持语法

- 函数与模块系统
- import
- 任意 JS 表达式
- break/continue
- 自动分页编排
- 非 camelCase query sugar 操作符

## 示例

```dsl
let rows = query table "order.list" currentRows
let next = query table "order.list" nextPageTarget
if input.autoNext:
  click next
for item in input.items:
  fill form "order.form" field "buyer" with item.buyer
use checkpoint "ensure_logged_in" with { username: input.username }
snapshot
```

## 限制

- `for` iterable 必须解析为数组。
- query/entity 能力受 snapshot 与 entity_rules 质量影响。
- DSL 仅负责编排，不直接调用 Playwright API。
