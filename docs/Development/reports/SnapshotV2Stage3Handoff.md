# Snapshot V2 Stage 3 Handoff

## 状态

- 阶段：Stage 3 — FormComponent 组装与表单规则迁移
- 结果：**blocked**
- 已完成：FormComponent、FormField、FormGroup、FormAction、BottomUpReducer、OwnershipIndex、结构 bridge
- 未完成：entity_rules artifact/runtime/profile selection/生产 matcher 链
- Stage 4：不得开始

仓库整体不可构建是当前迁移状态的预期结果。该状态不通过恢复 V1 Snapshot 或旧 entity_rules 实现消除。

## 已冻结结构合同

- `ComponentLocation`：selection scope、host、structural root 分离
- `FormComponentIndex`
- `FormComponent`
- `FormField.controlIds[]`
- `FormGroup`
- `FormAction`
- `FormProposal`
- `FormReductionState`
- `BottomUpReducer<T>`
- `OwnershipIndex`
- `FormInvariantValidation`
- `FormComponentMatchRule`
- `FormComponentRuleBinding`

字段只从唯一 `ControlIndex` 产生。popup/option 不成为 field；平台 label relation 优先于 Element/Ant adapter evidence；结构 action 与 semantic suggestion 分离。

## 已完成行为

- `label@for`、`aria-labelledby`、fieldset/legend、description、error、required
- composite field
- explicit form、adapter form、active dialog、local island
- residual/standalone fields 和 actions
- portal popup 保持 control ownership
- button-only 容器不升级为 form
- DataTables toolbar utility 不被伪造为 form
- form ownership invariant 和 reduction trace
- component/canonical-node 结构 bridge

## Stage 2 相关修复

本轮修复了两个会使 Stage 2 假通过的问题：

1. custom select verification 不再用 trigger 可见文本兜底。
2. Chromium 对 focused `role=option` 可能报告隐式 A11y selected；custom-select option 现在只接受显式 runtime/DOM `selected`、`aria-selected` 或 checked 事实。
3. checkbox group 在修改前解析全部 canonical locators 并记录原始 checked 状态；任一后续动作失败时回滚已修改项并报告 rollback 状态。

## 可复现语料

CI 和 baseline 不再读取被忽略的：

```text
agent/tests/fixtures/form-v2/
```

四个完整浏览器 capture 仍可由 `snapshot:v2:capture-form-fixtures` 生成并保留在本地，但不进入 Git，也不作为测试前置条件。

仓库内新增 4 个代码生成的紧凑冻结语料：

- native explicit form
- local filter island
- dialog composite form
- DataTables toolbar utility signature

truth 使用精确值，而不是 `actual >= minimum`：

- form/field/composite/residual 数量
- action/owned action/residual action 数量
- group、required、dialog host 数量
- boundary kinds
- structural root capture IDs
- residual field anchor capture IDs

Element Plus 和 Ant Design 的真实浏览器测试也使用精确字段、标签、required、action ownership 和 residual 预期。

## 当前基线

文件：

```text
docs/Development/reports/SnapshotV2Stage3Baseline.json
```

4 fixtures × 50 iterations：

```text
input nodes:            47
forms:                   4
fields:                  8
composite fields:        1
residual fields:         2
owned actions:           5
residual actions:        1
ownership edges:        22
invariant failures:      0
exact truth errors:      0
```

完整 DataTables 官方页面不再被错误描述为仓库内离线 fixture。它只是本地探索 capture；确定性的 toolbar 行为由紧凑语料保护。

## 验收

```text
pnpm -C agent test:snapshot
  60 passed / 0 failed

pnpm -C agent snapshot:v2:stage3-baseline
  passed

pnpm -C agent test:entity-rules
  0 passed / 4 failed
```

entity_rules 四项失败均来自尚未实现的 V2 能力：

- explicit per-step profile selection
- auto workflow profile selection
- inherited workspace selection
- workflow artifact save/load

## 阻塞项

`matchFormComponentRules` 目前只有测试调用方。以下生产链尚未实现：

```text
workflow entity_rules artifact
→ profile selection
→ provider
→ FormComponent capture
→ structural matching
→ annotation/binding
→ check/save/reopen/runtime query
```

不得通过旧 matcher、旧 annotator、V1 region/group 或兼容 fallback 把测试变绿。

## Stage 4 入口

Stage 4 只有在以下条件满足后才能开始：

- entity_rules artifact 可保存、读取和校验
- per-step explicit/auto/inherit selection 可用
- form bridge 有唯一生产调用方
- check/save/reopen/runtime query 使用同一 V2 规则语义
- entity_rules 失败测试逐项转绿
