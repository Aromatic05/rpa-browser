# Snapshot V2 / V1 功能替代审计

## 结论

截至 2026-07-29，Snapshot/实体识别 V2 已完成**仓库内生产功能替代**：当前 agent、extension、record、Step 序列、task.run、Checkpoint、DSL、MCP、annotator、trace 和 snapshot viewer 均使用 V2 canonical facts、PageSession、QueryPlan、SemanticBindings 与 SnapshotProjection。

该结论不等于旧输出 JSON 的 drop-in wire 兼容：

- V1 `browser.snapshot` 输出以 `root/nodeIndex/entityIndex/locatorIndex/bboxIndex/attrIndex/contentStore` 为中心；
- V2 输出是 `SnapshotProjection schemaVersion: 2`，并通过 `browser.query`、`browser.capture_resolve`、`browser.get_content` 和 typed target 提供运行能力；
- 仓库内未发现仍引用 V1 snapshot result path 的生产 workflow、Step、Checkpoint 或 DSL；
- 任意仓库外消费者如果直接读取旧字段，必须迁移，不能依赖 V1 shape bridge。

因此准确表述是：

```text
生产功能替代：完成
仓库内运行链替代：完成
V1 entity_rules artifact 迁移：完成
V1 snapshot JSON wire compatibility：不提供，需显式迁移
V1 启发式实现行为复刻：不提供，已按计划退休
```

## Snapshot 能力对照

| V1 能力 | V2 替代路径 | 结果 |
| --- | --- | --- |
| DOM/A11y/runtime 页面采集 | PageObservation + source completeness + ScopeForest | 已替代 |
| 单根压缩树 | 不可变 canonical observation + 按需 SnapshotProjection roots | 已替代，不复制压缩树 |
| node lookup | canonical `observation.nodes` / Step typed nodeId | 已替代 |
| locatorIndex | canonical LocatorIndex + `capture_resolve` + ResolveHint | 已替代 |
| bboxIndex | canonical geometry sidecar + AnnotatorProjection | 已替代 |
| attrIndex/runtime state | PageObservation sidecars | 已替代 |
| contentStore | epoch-bound `contentRef` + `browser.get_content` | 已替代 |
| scoped snapshot | `contain/depth/filter` projection options | 已替代 |
| snapshot diff | SemanticDiff + explicit ambiguous/navigation full fallback | 已替代 |
| table/form entity output | FormComponent/TableComponent + RuntimeEntityView | 已替代 |
| list/KV group members | 仅基于明确 role/tag 的 generic entity + `itemNodeIds/keySlot` | 已替代，不恢复 group scorer |
| manual entity add/delete/rename | confirmed selection/manual semantic layer | 已替代 |
| entity list/find | RuntimeEntityView over canonical components/bindings | 已替代 |
| cache stats/tier/debug internals | PageSession refresh reason、projection meta、pass performance reports | 功能替代，字段不兼容 |

明确退休且不应复刻的 V1 行为：

- region/group 双轨候选模型；
- 全局 candidate score、family limit、same-kind nested drop；
- LCA 代替 typed ownership；
- 依赖压缩树 node ID 的 diff；
- extension DOM 二次 entity recognizer；
- 用启发式猜测 list/table/form 业务语义。

## entity_rules 能力对照

### Artifact 与页面适用条件

V1 profile 的以下信息由 importer 转换到 V2 artifact：

- `page.kind`：form、table、dialog、list、panel、toolbar、kv；
- `page.urlPattern`：保留并在 auto selection 中按当前 PageSession URL 过滤；
- match rules：source、expect、within、kind、id/role/name/text/class、label/field/action、table header/column 等；
- annotation root metadata：businessTag、businessName/displayName、primaryKey、columns、pagination；
- form `fields/controlRuleId/labelRuleId`；
- form/table `actions/nodeRuleId`；
- pagination `nodeRuleId/disabledRuleId`。

### Runtime

- Form/Table profile 使用对应 component QueryPlan；
- dialog/list/panel/toolbar/kv 使用 canonical observation 上的 `node` QueryPlan；
- generic kind 只接受明确 ARIA role 或 HTML tag，不重新引入 V1 模糊 candidate pipeline；
- SemanticBindings 统一进入 PageSession；
- auto/explicit/inherit/disabled selection 均受同一 step control 约束；
- annotator open/check/save/reopen 和 extension JSON 编辑均保留 page metadata；
- business query 可执行 form fields/actions、table rows/columns/primary key/row action/pagination。

真实验收包括：

- V1 form artifact 导入后查询字段、定位字段和提交 action；
- V1 table artifact 导入后查询主键/列/当前行、定位 row/row action/next page；
- 五种 generic kind 的 canonical node-domain 执行；
- URL applicability 只激活当前页面 profile；
- page metadata save/load/open/check/reopen 往返。

## Step 序列支撑能力

顶层 Step 和嵌套 Step 统一通过 `executeStepWithRuntimeContracts()`：

1. Step result ref 解析；
2. `resolveId -> StepResolve` 注入；
3. entity_rules step control 校验；
4. executor 调用；
5. 成功交互后的 PageSession dirty 标记；
6. structured error details。

已验证的连续链：

```text
browser.query entity.target
  -> Step result nodeId ref
  -> browser.snapshot contain
  -> projection contentRef
  -> browser.get_content
  -> browser.entity add/find/rename/assert/delete
  -> browser.click
```

`task.run.start/push/resume` 会保留并增量合并：

- `stepResolves`；
- checkpoint definitions；
- Step queue/cursor/checkpoint state。

因此流式 Step 序列不会丢失录制产生的 V2 ResolveHint。

## Checkpoint 支撑能力

`browser.checkpoint` 现在：

- 优先读取 workflow checkpoint artifact；
- 同时支持 `runSteps(checkpoints)` 调用方传入定义；
- 加载 `checkpoint_resolve.yaml`；
- 内嵌 Step 复用完整 runtime contracts；
- 保留 nested Step result refs、query/compute/act/content/output 数据流；
- 在 executor 前拒绝无效 entity_rules control；
- 嵌套交互同样标记 PageSession dirty。

这解决了此前 DSL 路径有 resolve sidecar、普通 checkpoint 路径没有的分叉。

## DSL 支撑能力

DSL runtime 使用 `browser.query entity.target` 获取 typed target，再生成普通 Step：

- click/fill/select/checkpoint/snapshot；
- let/ref；
- query/compute；
- checkpoint call；
- Step executor 和 PageSession 生命周期与普通 Step 序列一致。

V2 target metadata 会携带 canonical control kind，因此 `select` 能生成：

- native_select；
- custom_select；
- radio_group；
- checkbox_group。

不再把所有 select 强制当作 native select。

## 整栈验收

`agent/tests/integration/runner/v2_orchestration_stack.test.ts` 在同一 PageSession 中验证：

- business target query；
- Step refs；
- snapshot contain；
- contentRef；
- manual entity lifecycle；
- browser action；
- Checkpoint nested action；
- DSL snapshot/query/click。

此外：

- integration：640 tests / 638 pass / 0 fail / 2 explicit perf skipped；
- Snapshot：136/136；
- entity_rules：37/37；
- trace：7/7；
- unit：259 tests / 257 pass / 0 fail / 2 explicit perf skipped；
- E2E：5/5；
- Stage 1 perf：1/1；
- Stage 4/5 full perf：1/1；
- extension tests：pass；
- Snapshot V2 viewer build：pass；
- lint/typecheck：pass。

## Wire migration boundary

以下 V1 表达式不保证继续工作：

```text
{{snapshotStep.data.root...}}
{{snapshotStep.data.nodeIndex...}}
{{snapshotStep.data.entityIndex...}}
{{snapshotStep.data.contentStore...}}
```

应迁移为：

- `browser.query` 获取 node/value；
- `browser.capture_resolve` 获取可执行 ResolveHint；
- `browser.snapshot` 的 `roots/components/semantics/collections/diagnostics`；
- `contentRef + browser.get_content`；
- businessTag + typed entity target。

仓库当前生产源码和持久化示例中没有发现上述旧引用。独立 snapshot viewer 也已迁移为 V2，并通过静态守卫禁止 V1 import/token 回归。
