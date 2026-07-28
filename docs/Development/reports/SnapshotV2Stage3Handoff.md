# Snapshot V2 Stage 3 Handoff

## 状态

- 阶段：Stage 3 — FormComponent 组装与表单规则迁移
- 结果：**accepted**
- Stage 1 基线提交：`dc903b5 feat(snapshot): establish v2 stage1 observation foundation`
- Stage 2、Stage 3 当前实现：尚未提交，保留在既有迁移工作区中
- 下一阶段：Stage 4 可以依赖本阶段冻结的 component、ownership、form contracts

Stage 3 不恢复 `agent/src/runner/steps/executors/snapshot/`，不依赖 V1 region/group/entityIndex，也不建立第二套 control collector。旧 form recognition、groups/LCA ownership 和 entity-rule matcher 均未恢复。

## 冻结 contracts

### Component core

- `ComponentLocation`
- `GeometryFragment`
- `SemanticSuggestion`

用户 selection scope、逻辑 host 与 structural root 分离。Form recognize 可以在 selection scope 内选择更准确的 `<form>`，但不会覆盖 selection scope。

### Form

- `FormProposal`
- `FormComponent`
- `FormField`
- `FormGroup`
- `FormAction`
- `FormReductionState`
- `FormReductionTraceRecord`
- `FormComponentIndex`
- `BottomUpReducer<T>`
- `FormInvariantValidation`

`FormProposal` 只包含结构候选、field/action IDs 和 evidence，不包含 `businessTag`、`fieldKey` 或 `actionIntent` binding。

### Ownership

- `OwnershipEndpoint`
- `OwnershipEdge`
- `OwnershipIndex`
- `OwnershipValidation`

ownership 唯一性按同一 member、同一 owner kind、同一 role 检查。`form-group -> field` 与 `form -> field` 属于不同层级，可以同时存在；同一层的多个 owner 会产生 `ownership.role.duplicate`。

### Entity-rule bridge

- `RuleExpectedCardinality`
- `FormComponentMatchRule`
- `FormComponentRuleBinding`
- `FormComponentRuleMatchResult`
- `matchFormComponentRules`

归档 matcher 的 `unique` / `one_or_more` cardinality 语义被抽成独立 core。bridge 的候选只有：

- `FormComponent`
- `FormField` / `FormAction` 的 canonical member node
- canonical observation node

bridge 不构造 V1 region/group entity，不生成业务语义，不吞掉 missing/multiple diagnostics。

## Field assembly

字段只从唯一 `ControlIndex` 产生，popup/option control 永远不能成为 field control。

label evidence 顺序：

1. `label@for` typed relation
2. `aria-labelledby`
3. `fieldset/legend`
4. Element Plus / Ant Design Form.Item adapter evidence
5. wrapping label

同时保留：

- `aria-describedby`
- `aria-errormessage`
- framework error node
- required state
- `controlIds[]` composite field
- `primaryControlId`

Element Plus 与 Ant Design adapter 只提供 strong structural evidence，不覆盖平台 relation，也不生成业务 field key。

## Bottom-up reduction

reducer 按 canonical document order 自底向上汇总 fields 和 actions。

消费边界：

- explicit `<form>`
- role/framework form
- active dialog
- 满足多字段、label 和 local action 条件的 local island

停止规则：

- 显式 form 内不提前形成局部 island
- active dialog 不向 body 泄漏未消费 fields
- button-only 容器不升级为 form
- DataTables/table utility fields 不参与 local-island reduction
- geometry proximity 不参与 field/form 合并
- popup/listbox 不成为 field anchor

未消费对象明确保留：

- `residualFieldIds`
- `residualActionIds`
- reduction trace 中的停止原因

主要 trace reason：

- `consumed-by-explicit-form`
- `dialog-requires-multiple-fields`
- `boundary-without-fields`
- `utility-or-table-standalone`
- `no-valid-form-boundary`
- `actions-without-form-boundary`

## Structural actions 与 suggestions

结构事实：

- submit
- reset
- button
- link

inferred suggestions 与结构事实分离：

- action：search、save、save-draft、cancel
- component：filter-form、data-entry-form、dialog-form

suggestion 只作为 inferred evidence，不写入 confirmed/manual business binding。

## 真实浏览器与固定语料

覆盖：

- Element Plus list/filter form
- Ant Design list/filter form 与 page-size residual control
- Element Plus create form、required field、DatePicker range composite
- Ant Design active Modal、Form.List、RangePicker composite
- native form、fieldset/legend、descriptions/errors
- native DataTables-compatible utility signature
- DataTables 3.0.0 官方 zero-configuration 页面
- document utility controls

DataTables 官方 fixture 来源：

```text
https://datatables.net/examples/core/basic_init/zero_configuration.html
```

官方页面中的 `.dt-length select` 与 `.dt-search input` 均映射为 field，但保持 residual，没有被页面其他 form 或 document actions 消费。

## 生产边界

Stage 3 的 agent-side form 入口：

- `buildFormComponentIndex`
- `buildFormSnapshot`
- `captureFormSnapshot`
- `matchFormComponentRules`

当前活动源码中：

- 只有一个 `FormComponentIndex` assembler
- 只有一个 form component-target matcher
- 没有 V1 form region/group/LCA 实现
- 没有 raw DOM control rescanning
- 没有 common-ancestor 或 geometry clustering form path

extension、query、session、annotator 与最终 snapshot projection 尚未切换；这些属于 Stage 5。Stage 3 输出已经包含后续 visual binding 所需的 location、geometry、field/control membership、ownership、evidence 和 diagnostics。

## 测试

执行：

```text
pnpm -C agent typecheck:snapshot
pnpm -C agent test:snapshot
pnpm -C agent snapshot:v2:stage1-baseline
pnpm -C agent snapshot:v2:stage2-baseline
pnpm -C agent snapshot:v2:stage3-baseline
```

当前结果：

```text
snapshot typecheck: pass
snapshot tests:     56 pass / 0 fail
stage1 baseline:    pass
stage2 baseline:    pass
stage3 baseline:    pass
```

## Stage 3 基线

文件：

```text
docs/Development/reports/SnapshotV2Stage3Baseline.json
```

6 fixtures × 50 iterations：

```text
input nodes:               1334
forms:                        6
fields:                      15
composite fields:             2
residual fields:              5
owned actions:                6
residual actions:           225
ownership edges:             33
form invariant failures:      0
fixture truth errors:         0
```

225 个 residual actions 主要来自完整 DataTables 官方文档页面的导航、示例和文档按钮；它们被显式保留，但不属于任何识别出的 form。

```text
form build: p50 0.486 ms, p95 4.082 ms
```

具体 timing 以 JSON 基线文件为准，重新运行时会随环境更新。

## Stage 4 输入边界

Stage 4 可以复用：

```text
PageObservation
RelationIndex
ControlIndex
LocatorIndex
ComponentLocation
OwnershipIndex
Evidence / diagnostics
SemanticSuggestion
```

Stage 4 不允许：

- 把 generic repeated group 当作 table model
- 从 FormField 或 FormGroup 推导 table rows/columns
- 复用 form local-island reducer 代替 table part assembly
- 恢复 V1 table region/group/candidate/key/model
- 根据 geometry proximity 或第一个 `<table>` 选择逻辑表格
