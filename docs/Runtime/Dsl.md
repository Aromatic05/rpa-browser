# DSL 运行时与语法

## 定位

DSL 是 workflow 的业务自动化编排语言。它描述业务对象、查询、页面动作、控制流和可复用 checkpoint procedure，不直接调用 Playwright。

当前编译/执行流水线为：

```text
parse -> link -> normalize -> validate -> runDsl -> runSteps
```

`link` 负责把 `entity_rules` / resolve symbol 转成运行时可执行目标；`normalize` 负责展开 sugar 和规范化 ref；最终动作仍通过统一 step runner 执行。

## 文件与入口

Workflow DSL 位于：

```text
dsls/<dslName>.dsl
dsls/<dslName>.resolve.yaml
```

`workflow.yaml.entry.dsl` 指定默认入口。`dsl.get/save/validate/run` 未显式指定 `dslName` 时使用该入口。

`dsl.get` 同时返回 `artifactRevision`。协作式保存可把它作为 `dsl.save.expectedRevision` 回传；如果 `.dsl` 或 resolve sidecar 已被人类/另一个 agent 修改，保存返回 `ERR_CONFLICT`。省略 `expectedRevision` 保持兼容的无条件保存，`null` 表示仅允许创建不存在的 DSL。

## Import

Import 只能出现在 DSL 顶层开头。

```dsl
use entity_rules "orders-page" as orders
use resolves "main" as recorded
```

- `entity_rules` 暴露稳定的业务 entity/member symbol。
- `resolves` 暴露录制或显式保存的低层 resolve symbol。
- alias 在同一个 DSL 中必须唯一。

推荐业务 DSL 优先依赖 `entity_rules`，不要把低层 selector 当成业务接口。

## Scope 与变量

根 scope：

- `input.*`：调用输入，只读语义。
- `vars.*`：DSL 局部变量。
- `output.*`：DSL 输出。
- `failure.*`：仅 recovery checkpoint body 可用。

未带根前缀的普通 ref 会在 normalize 阶段归一化为 `vars.*`。

```dsl
let rows = query orders.ordersTable.currentRows
output processed = rows
```

### if

`if` 的两个分支使用独立 child scope。分支内新增变量不会天然泄漏到外层；只有两个分支都确定赋值的同名变量才会在分支后提升。

普通 `let` 和 checkpoint bind 都参与 definite-assignment：

```dsl
if input.usePrimary:
  let session = use checkpoint "primary-session"
else:
  let session = use checkpoint "fallback-session"

output session = session
```

如果只有一个分支定义 `session`，分支后引用会得到 `ERR_DSL_VAR_NOT_DEFINED`。

### for

```dsl
for row in rows:
  click orders.ordersTable.row(row.orderNo).approve
```

- iterable 必须在运行时解析为数组。
- loop item 和 loop body 新增变量不提升到循环外。

## Entity rules 语法

Entity rules 提供业务稳定 symbol：

```dsl
use entity_rules "orders-page" as orders

let rows = query orders.ordersTable.currentRows
click orders.ordersTable.row(row.orderNo).approve
```

link 阶段会校验：

- profile 是否存在；
- `entityKey` 是否唯一；
- field/action/query member 是否存在；
- row 操作是否具备 primary key；
- 当前动作是否适用于该 member。

因此业务 DSL 不需要知道 DOM selector。

## Query

### Entity symbol query

```dsl
let rows = query orders.ordersTable.currentRows
```

### Raw entity query

```dsl
let buyer = query entity.target "order.form" {
  kind: "form.field"
  fieldKey: "buyer"
}
```

### Table sugar

支持：

- `currentRows`
- `rowCount`
- `hasNextPage`
- `nextPageTarget`

```dsl
let rows = query table "order.list" currentRows
```

### Form sugar

支持：

- `fields`
- `actions`

```dsl
let fields = query form "order.form" fields
```

## Action

当前 DSL 直接暴露：

```dsl
fill target with value
type target with value
select target with value
click target
wait 500
snapshot
```

也支持 form/table business sugar：

```dsl
fill form "order.form" field "buyer" with input.buyer
click form "order.form" action "submit"
fill table "orders" filter "status" with input.status
click table "orders" action "refresh"
```

这些语句在 link/normalize 后会降到统一 query + runner step。

## Checkpoint procedure

显式调用：

```dsl
use checkpoint "ensure-login" with {
  username: input.username
  password: input.password
}
```

绑定输出：

```dsl
let session = use checkpoint "ensure-login" with {
  username: input.username
}
output user = session.authenticatedUser
```

`dsl.save` 和 `dsl.validate` 会在执行前检查引用的 checkpoint graph：

- checkpoint 是否存在；
- 是否可作为 procedure 调用；
- 声明了 `body.dsl` 时 body 是否存在；
- 每个被引用 procedure body 自身是否能通过 parse/link/normalize/validate；
- 是否存在递归调用；
- 调用深度是否超过运行时上限。

`dsl.run` 从取得 workspace `executing` execution lease 开始，就把“物化本次执行实际使用的 checkpoint / entity-rule / resolve snapshot -> 对冻结 snapshot 做 source + checkpoint graph preflight -> 执行 DSL”放在同一个 execution 生命周期内。preflight 完成前不会执行第一个 step；直接修改 `.dsl` / `body.dsl` 后留下的坏依赖或坏 procedure body 不会先产生前半段副作用再失败。活动 `task.run` 持有同一个 workspace execution ownership，因此不会与 `dsl.run` 并发操作同一 workspace。

## Control flow

```dsl
if input.enabled:
  click input.submit
else:
  click input.cancel

for user in input.users:
  fill input.target with user.name
```

当前 condition 是 ref 值的 truthiness，不是通用表达式语言。

## 诊断

常见错误：

- `ERR_DSL_PARSE`
- `ERR_DSL_ENTITY_PROFILE_NOT_FOUND`
- `ERR_DSL_ENTITY_MEMBER_NOT_FOUND`
- `ERR_DSL_RESOLVE_BUNDLE_NOT_FOUND`
- `ERR_DSL_VAR_NOT_DEFINED`
- `ERR_DSL_VAR_REDEFINED`
- `ERR_DSL_BAD_ACT_ARGS`
- `ERR_DSL_BAD_ITERABLE`
- `ERR_DSL_BAD_CHECKPOINT_INPUT`
- `ERR_DSL_CHECKPOINT_NOT_FOUND`
- `ERR_DSL_CHECKPOINT_NOT_CALLABLE`
- `ERR_DSL_CHECKPOINT_BODY_MISSING`
- `ERR_DSL_CHECKPOINT_RECURSION`
- `ERR_DSL_CHECKPOINT_DEPTH`

当前 diagnostic 提供结构路径，但 DSL 尚未提供完整 source span / line-column 诊断。

## 当前自动化边界

DSL 已能承担页面内业务流程编排，包括 entity query、表单/表格操作、循环、条件分支、procedure 和失败恢复配合。

它目前还不是 runner 全能力的 browser automation language。runner 已有但 DSL 尚未直接暴露的能力包括导航、tab 生命周期、hover、scroll、keyboard、drag-and-drop、assert、compute 等。因此需要这些 primitive 的流程仍可能需要 workspace/runner 层先完成页面准备，或等待 DSL 继续扩展。

当前也不支持：

- 通用函数与模块系统；
- 任意 JavaScript 表达式；
- `break` / `continue`；
- 一等 `==` / `and` / `or` / `not` 等表达式；
- DSL comment 语法；
- DSL language version header；
- 自动分页编排。

DSL run 当前使用 workspace execution 生命周期，但尚未接入 task runner 的 durable checkpoint store；进程级恢复与页面步骤 recovery 是两个不同能力。
