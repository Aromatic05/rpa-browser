# Snapshot V2 Stage 6 Handoff

## 状态

- 阶段：6 — V1 删除与发行级验收
- 结果：accepted
- 日期：2026-07-29
- 分支：`feat/canvas`
- 验收前代码提交：`0a536f28`
- V1 归档 tag：`archive/snapshot-entity-recognition-v1`（`9ed0d958`）
- 工作区状态：报告生成前干净；本报告与计划状态更新属于最终文档提交

Stage 6 的显式退出门槛已全部满足。该结论只针对 Snapshot/实体识别 V2 迁移，不等价于宣称整个仓库的通用 lint 门禁已通过。

## 冻结 contracts

- `PageEpochId` / `CaptureRevision` / `ObservationNodeId`
- `PageObservation`、ScopeForest、ActivityFacts、GeometryRecord、RelationIndex
- canonical `ControlIndex`、`FormComponentIndex`、`TableComponentIndex`
- QueryPlan、SemanticBindings、SemanticSuggestions
- `PageSnapshotSessionStore` 与 exact-only SessionAnchor
- `SnapshotProjection`、`AnnotatorProjection`、SemanticDiff
- `browser.snapshot` 五种 mode：overview / interaction / annotation / debug / full
- extension/agent 共享 `shared/annotator-contract`

## 生产入口

### 当前唯一入口

- 页面事实：`captureControlSnapshot()` / `buildPageObservation()`
- 页面生命周期：`PageSnapshotSessionStore`
- 结构组件：Control/Form/Table V2 assemblers
- 业务规则：QueryPlan + SemanticBindings
- snapshot：`buildSnapshotProjection()` / `diffSnapshotProjection()`
- runtime query：canonical observation 与 component indexes
- annotator：agent projection/picking/check/save；extension 仅发送事件、坐标和 draft
- record/checkpoint/assert/entity：统一消费 V2 PageSession

### 已删除旧入口

- `runner/steps/executors/snapshot/*`
- V1 region/group、candidate score/select/prune、LCA ownership
- family-limit、nested-drop、pre-index mutating compression
- V1 scoped diff、stable-id projection fallback
- `FinalEntityView`
- `businessEntityOverlay` / `ruleEntityOverlay`
- `latestSnapshot` / `snapshotSessionStore` Trace cache bridge
- extension DOM entity recovery 与重复 matcher
- V1 keyslot/Ant acceptance/bulk/dump/repro 脚本
- 只验证退休实现细节的 V1 测试套件

### 静态防回归

`agent/tests/integration/snapshot/stage6_legacy_boundary.test.ts` 持续验证：

- 退休路径不存在；
- 生产源码不含 V1 cache/overlay/matcher contract；
- 生产相对导入全部可解析；
- 不允许重新导入 V1 snapshot 路径。

## 测试先行证据

Stage 6 中新增的失败验收先后暴露并修复：

- body `rowspan` 未占用后续行列位；
- responsive hidden column 被错误纳入可见 schema；
- wrong-kind select_option 被压成 `ERR_NOT_FOUND`；
- V1 E2E snapshot `{id, children}` 断言；
- 动态 filter/modal、scroll/zoom/visualViewport 缺少独立验收；
- V1 测试、脚本、配置和文档协议残留。

最终命令与结果：

```text
pnpm -C agent test:integration
606 tests / 605 pass / 0 fail / 1 skipped
```

跳过项是显式性能测试；单独执行结果：

```text
pnpm -C agent test:unit:snapshot:perf
1/1 pass
```

其余分组：

```text
pnpm -C agent test:snapshot       129/129
pnpm -C agent test:entity-rules   31/31
pnpm -C agent test:trace           7/7
pnpm -C agent test:e2e             4/4
pnpm typecheck                     pass
pnpm --filter ./extension test     pass
```

E2E 覆盖：

- 多标签录制与回放；
- fill/type/select/checkbox/radio/press/hover/scroll/click/snapshot/screenshot；
- workflow MCP 生命周期与 workspace 隔离；
- workflow save/load 与 recording 隔离。

## 真实页面验收矩阵

| Required fixture | 主要证据 |
| --- | --- |
| native HTML form/table | `form_component.test.ts`、`table_component.test.ts` |
| Element list/create form | `form_framework_browser.test.ts`、`annotator_framework_browser.integration.test.ts` |
| Ant list/create form/dialog | 同上 |
| Element fixed/summary/pagination | `table_component.test.ts`、`table_framework_browser.test.ts` |
| Ant fixed/sticky/summary/pagination | 同上 |
| clone-based fixed table | fixed-left/right mirror 测试 |
| multi-level header / span / merged | header tree 与 body rowspan/colspan 测试 |
| expandable / nested / tree | nested table、treegrid、expanded row 测试 |
| virtualization / loading / empty | TableComponent required fixture 测试 |
| row selection / responsive hidden column | `row selection is canonical...` |
| editable cell / portal editor | `table_editor_browser.test.ts` 与 editor ownership 测试 |
| dialog / Form.List / composite/date range | `form_framework_browser.test.ts` |
| opened select popup / multiple popup | `control_action_browser.test.ts`、`control_framework_browser.test.ts` |
| multiple tables / ambiguous pagination | sibling pagination ambiguity 测试 |
| shadow duplicate ID / iframe / locator geometry | observation acceptance、locator index、control action browser 测试 |
| captured-without-candidate / partial source | Stage 1 observation contracts 与 browser regressions |
| zero-box active descendant / activity mismatch | Stage 1 fixtures与 activity diagnostics |
| zoom / scroll / visual viewport | annotator real scroll/CDP zoom 与 extension live geometry 测试 |
| filter / modal / rerender | `dynamic_page_browser.test.ts` |
| SessionAnchor exact/stale/ambiguous | PageSession、locator、annotator lifecycle 测试 |
| entity_rules import/check/save/reopen/runtime | entity_rules integration 与 annotator action tests |
| snapshot mode/contain/filter/diff | projection、runner snapshot、MCP schema tests |
| Step/Checkpoint/DSL actions/assertions | integration suite 与 4 个 E2E spec |

未完成 required fixture：0。

## 发行诊断验收

现有 diagnostics 能定位：

- page epoch / capture revision / scope；
- canonical node identity 与 exact anchor resolution；
- relation resolved/missing/ambiguous；
- control/component status；
- selection scope / host / structural root / physical part；
- ownership、mirror、editor、pagination decision；
- adapter 与 evidence；
- QueryPlan rule/step/cardinality；
- locator stale/ambiguous/unresolved；
- projection omission、component/state diff。

对应失败测试均断言结构化 code/details，不依赖“未找到实体”或“selector failed”泛化文本。

## 性能与工作集

Stage 1 当前重放：

```text
fixtures: 10
input nodes: 267
candidate work-set max/p50/p95: 65 / 4 / 65
orphan count: 0
maximum union ratio: 0.7864
peak retained index entries: 1339
observation p50/p95: 0.066 / 0.822 ms
relation p50/p95: 0.018 / 0.059 ms
candidate p50/p95: 0.032 / 0.152 ms
quotient p50/p95: 0.011 / 0.076 ms
invariant failures: 0
```

Stage 2 当前重放：

```text
controls: 28
executable controls: 23
executable without resolved locator: 0
locator p50/p95: 0.036 / 0.666 ms
control p50/p95: 0.029 / 0.157 ms
validation failures: 0
```

Stage 3 当前重放：

```text
forms: 4
fields: 8
composite fields: 1
owned actions: 5
ownership edges: 22
form assembly p50/p95: 0.095 / 0.246 ms
validation failures: 0
truth errors: 0
```

冻结语料 work-set 与签入基线精确一致；没有通过删除 canonical nodes 降低指标，也没有重新引入可变压缩树 cache。

## 依赖与归档证明

- 生产 legacy token/path 扫描：0 命中。
- `agent/src`、`extension/src`、`start_extension/src`、`shared` 相对导入：0 个未解析。
- Stage 6 静态边界测试：3/3。
- Snapshot V1 runtime/implementation 仅保留于 tag：`archive/snapshot-entity-recognition-v1`。legacy entity_rules artifact importer 只把旧制品转换为 V2 QueryPlan，不执行 V1 matcher。

## 未解决问题

### 非 Stage 6 阻塞：仓库级 lint 债务

`pnpm lint` 当前结果：

```text
610 findings
156 errors
454 warnings
```

范围跨越 Snapshot、workflow、extension 和 start_extension，并包含大量本阶段未修改文件。Stage 6 新增/修改文件均通过定向 `--max-warnings=0`。因此：

- 不阻塞 Snapshot V2 Stage 6 的显式退出门槛；
- 阻止宣称“整个仓库 lint clean”；
- 若全仓 lint 是发布门禁，仍需独立工程任务处理；
- 本阶段未运行发布构建或发布门禁。

## 下一阶段入口检查

- [x] 本阶段退出门槛全部满足
- [x] 无后续迁移阶段依赖临时 bridge
- [x] 无 runtime flag、V1 fallback 或双 matcher
- [x] required fixture 为 0
- [x] 无未报告的工作区修改

Snapshot/实体识别 V2 分阶段迁移至此结束。后续新增功能和全仓 lint 治理应作为独立任务，不再扩展本迁移计划。
