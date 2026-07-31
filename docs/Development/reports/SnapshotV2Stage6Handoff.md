# Snapshot V2 Stage 6 Handoff

## 状态

- 阶段：6 — V1 删除与发行级验收
- 结果：accepted（两轮独立复审修复后重新验收）
- 日期：2026-07-29
- 分支：`feat/canvas`
- 当前代码基线：`031b7310`
- V1 归档 tag：`archive/snapshot-entity-recognition-v1`（`9ed0d958`）

本报告只描述 Snapshot/实体识别 V2 迁移。未运行发布构建或发布门禁。

完整 V1 能力对照和 wire migration 边界见：

```text
docs/Development/reports/SnapshotV2V1ParityAudit.md
```

## 两轮复审修复

第一轮复审修复：

```text
b0aa68ae refactor(record): share page session lifecycle
e5faa3e4 test(snapshot): cover required browser table matrix
e749a742 test(snapshot): add full pipeline performance gate
0e67141c fix(runner): attach semantic failure diagnostics
be727535 test(snapshot): complete browser fault matrix
a87fe842 docs(snapshot): reaccept stage6 after review
```

第二轮复审发现并修复：

```text
125ad3a4 fix(snapshot): preserve exact control slot positions
922bbaa0 fix(record): enforce one page session snapshot per event
85f87539 fix(runner): complete semantic failure diagnostics
235cbb6a test(snapshot): benchmark large-page assembly
39b142ab fix(checkpoint): reuse step runtime contracts
f636d9cc fix(runner): retain v2 task context
bfd98309 fix(dsl): preserve select control kinds
a75dd86c feat(entity-rules): preserve v1 profile semantics
d0fd1c2a test(runner): verify v2 orchestration stack
7bc59c53 refactor(debug): migrate snapshot viewer to v2
6548b1b9 fix(checkpoint): support supplied checkpoint sets
031b7310 test(snapshot): stabilize full pipeline performance gate
```

## 生产架构

唯一事实和执行链：

```text
browser capture
  -> PageObservation / ScopeForest / sidecar indexes
  -> ControlIndex
  -> FormComponentIndex / TableComponentIndex
  -> QueryPlan / SemanticBindings
  -> PageSnapshotSessionStore
  -> SnapshotProjection / RuntimeQuery / AnnotatorProjection
  -> Step / task.run / Checkpoint / DSL / MCP
```

以下入口全部使用 V2：

- browser.snapshot、browser.query、browser.capture_resolve、browser.get_content；
- record enhancement 和 select_option normalizer；
- browser.entity、browser.assert、business query/target；
- Step result refs 和 ResolveHint；
- task.run start/push/resume；
- workflow Checkpoint 和调用方 supplied checkpoint sets；
- DSL snapshot/query/action/checkpoint；
- annotator open/check/save/reopen；
- extension panel/session 和 live geometry；
- trace；
- Snapshot V2 viewer。

## PageSession 与 Record

record 与 runner 共享同一个 `PageSnapshotSessionStore`：

- `recordSnapshotCache` 已删除；
- 1500ms TTL 与 URL 私有判鲜已删除；
- RecordingSnapshotPort 是 RecordingState 强制依赖；
- 同一 recorder event 最多解析一次 canonical snapshot；
- custom-select pending comparison 和最终 step 使用同一 capture revision；
- 多标签录制与回放 E2E 重新通过。

## TableComponent 与真实浏览器矩阵

`table_required_matrix_browser.test.ts` 覆盖：

- clone-based fixed-left/fixed-right；
- outer `role=table` host 去重；
- fixed mirror row/cell mapping；
- multi-level header 和 body rowspan/colspan；
- nested/expanded/treegrid 与 hierarchy unknown；
- virtualization、loading、empty；
- ambiguous sibling pagination；
- responsive hidden column 与 row selection；
- 大量 links/controls。

第二轮复审纠正了 CellControlSlot 的错误限流实现：

- 不再把第 4 个之后的 controls 截断并合并到同一个位置；
- 只为最多 4 个**精确相对位置**建立跨行 slot；
- overflow controls 作为逐行 exceptions 保留；
- invariant 禁止一个 slot 在同一行出现多个 controls。

其他真实浏览器场景：

- Element 页面 23 个 `.el-table` -> 23 个 logical TableComponent；
- Ant fixed/sticky/summary/pagination；
- Form、custom select、portal editor；
- shadow duplicate ID、zero-box、controller mismatch；
- iframe geometry、scroll/zoom/visual viewport；
- filter/modal/rerender；
- partial runtime source failure；
- SessionAnchor exact/stale/ambiguous。

required browser matrix 未完成项：0。

## Step、Checkpoint 与 DSL

顶层和嵌套 Step 统一通过 `executeStepWithRuntimeContracts()`：

1. Step result ref；
2. resolveId sidecar 注入；
3. entity_rules step control；
4. executor；
5. PageSession dirty marking；
6. structured diagnostics。

Checkpoint：

- 加载 workflow checkpoint 和 `checkpoint_resolve.yaml`；
- 支持 `runSteps(checkpoints)` supplied definitions；
- query/compute/act/content/output 和 nested refs 保持；
- 无效 nested entity_rules 在 executor 前失败。

`task.run.start/push/resume` 保存并合并：

- stepResolves；
- checkpoint definitions；
- queue/cursor/checkpoint state。

DSL target 会携带 V2 canonical control kind，select 可生成：

- native_select；
- custom_select；
- radio_group；
- checkbox_group。

`v2_orchestration_stack.test.ts` 在同一 PageSession 验证：

```text
business target query
  -> Step ref
  -> snapshot contain
  -> contentRef/get_content
  -> manual entity add/find/rename/assert/delete
  -> click
  -> Checkpoint nested click
  -> DSL snapshot/query/click
```

## V1 entity_rules 迁移

legacy importer 保留并执行：

- page.kind：form/table/dialog/list/panel/toolbar/kv；
- page.urlPattern 与 auto URL filtering；
- Form/Table QueryPlan；
- generic canonical node QueryPlan；
- businessName/displayName；
- fields/controlRuleId/labelRuleId；
- actions/nodeRuleId；
- primaryKey、columns、row action；
- pagination nodeRuleId/disabledRuleId。

已通过端到端测试：

- V1 form artifact -> fields query、field target、action target；
- V1 table artifact -> primary key、current rows、row target、row action、next page；
- dialog/list/panel/toolbar/kv generic profiles；
- annotator page metadata save/load/check/reopen；
- extension JSON panel/session page metadata 往返。

通用实体只使用明确 ARIA role/HTML tag，不恢复 V1 candidate score、LCA 或 region/group 猜测。list/KV 可输出 canonical `itemNodeIds/keySlot`。

## 发行诊断

失败详情覆盖：

- page epoch / capture revision；
- root scopes；
- active node 与 candidate count；
- 完整 ResolveHint；
- structural query relation/from；
- business operation/businessTag/query/target；
- semantic profiles 和 available business tags；
- component/ownership/locator/QueryPlan diagnostics。

不再存在仅返回“未找到实体”而没有 PageSession 语境的 business query 分支。

## 性能门禁

Stage 1 frozen corpus 门禁继续验证 work-set 和 canonical node 数量。

Stage 4/5 完整门禁：

```text
observation fixtures: 10
business cases: 3 (1 / 25 / 100 rows)
input nodes: 810
controls: 160
forms: 7
tables: 8
rows: 132
projected nodes: 543
annotator targets: 284
```

14 个 pass：

```text
observation
relation
locator
control
form
table
query-plan-compile
query-plan-execute
semantic-bindings
page-session-compose
projection-full
projection-overview
semantic-diff
annotator-projection
```

规则：

- 1/25/100-row pages 均真实经过 observation/control/form/table assembly；
- 40 次 measured iterations，之前有 assembly warmup；
- 使用 `process.cpuUsage()` 进程 CPU 时间，避免其他编译任务抢占导致 wall-time 假回归；
- aggregate p50/p95 不超过 `max(baseline × 1.2, baseline + 0.5ms)`；
- 25→100 rows 的 table assembly 同次运行增长不超过 8 倍；
- 结构计数必须与 baseline 精确一致。

Stage 1 与 Stage 4/5 两个性能门禁均通过。

## V1 删除与工具链

生产和工具链中不存在：

- `runner/steps/executors/snapshot/*` V1 pipeline；
- V1 region/group/candidate score/compress；
- FinalEntityView；
- businessEntityOverlay/ruleEntityOverlay；
- latestSnapshot/snapshotSessionStore bridge；
- extension DOM entity recovery；
- record 私有 snapshot cache；
- 双 entity_rules matcher。

Snapshot viewer 已重写为 V2：

```text
captureControlSnapshot
  -> PageSnapshotSessionStore
  -> buildSnapshotProjection
```

Stage 6 静态测试禁止 viewer 再出现 V1 pipeline/import/index/overlay token。

## 最终验证

```text
pnpm -C agent test:integration               640 tests / 638 pass / 0 fail / 2 skipped
pnpm -C agent test:snapshot                  136/136
pnpm -C agent test:entity-rules              42/42
pnpm -C agent test:trace                     7/7
pnpm -C agent test:e2e                       5/5
pnpm -C agent test:unit                      259 tests / 257 pass / 0 fail / 2 skipped
pnpm -C agent test:unit:snapshot:perf         1/1
pnpm -C agent test:unit:snapshot:full-perf    1/1
pnpm -C agent typecheck                      pass
pnpm --filter ./extension test               pass
pnpm -C agent/debug/snapshot-viewer build    pass
pnpm lint                                    0 errors / 0 warnings
```

普通 integration/unit 跳过的两项就是两个显式性能门禁，均已单独通过。

## 功能替代与 wire 边界

结论：

- 仓库内 Snapshot/entity_rules **生产功能替代完成**；
- Step、task.run、Checkpoint、DSL **可由 V2 完整支撑**；
- V1 entity_rules artifact **可迁移并运行**；
- V1 snapshot JSON shape **不提供 drop-in wire compatibility**。

以下旧引用需要显式迁移：

```text
snapshot.data.root
snapshot.data.nodeIndex
snapshot.data.entityIndex
snapshot.data.contentStore
```

应改用 V2 Projection、browser.query、browser.capture_resolve、contentRef 和 typed business target。仓库当前未发现生产 workflow/Step/Checkpoint/DSL 使用上述旧路径。

## 退出检查

- [x] 全部 production consumer 使用 V2 facts/components
- [x] record 与 runner 共享 PageSession
- [x] 同一 recorder event 单一 capture revision
- [x] CellControlSlot 保持精确相对位置
- [x] Step/Checkpoint/task.run/DSL 共享 runtime contracts
- [x] V1 entity_rules artifact 保留可执行语义
- [x] required browser matrix 未完成项为 0
- [x] 两套性能门禁通过
- [x] 关键失败路径结构化诊断完整
- [x] debug viewer 使用 V2
- [x] lint/typecheck clean
- [x] V1 runtime 只存在于归档 tag
- [x] wire compatibility 边界已明确记录
