# Snapshot V2 Stage 6 Handoff

## 状态

- 阶段：6 — V1 删除与发行级验收
- 结果：accepted（复审修复后重新验收）
- 日期：2026-07-29
- 分支：`feat/canvas`
- 复审代码基线：`be727535`
- V1 归档 tag：`archive/snapshot-entity-recognition-v1`（`9ed0d958`）

初次 handoff 后的独立审查重新打开了 Stage 5/6，发现 record 双快照生命周期、真实浏览器矩阵证据不足、完整性能门禁缺失、失败诊断不完整和文档漂移。以下修复完成后，Stage 5/6 才重新 accepted：

```text
b0aa68ae refactor(record): share page session lifecycle
e5faa3e4 test(snapshot): cover required browser table matrix
e749a742 test(snapshot): add full pipeline performance gate
0e67141c fix(runner): attach semantic failure diagnostics
be727535 test(snapshot): complete browser fault matrix
```

本报告只描述 Snapshot/实体识别 V2 迁移验收；未运行发布构建或发布门禁。

## 生产入口与生命周期

### 唯一事实与生命周期入口

- 页面事实：`captureControlSnapshot()` / `buildPageObservation()`。
- 页面生命周期：`PageSnapshotSessionStore`。
- 结构组件：canonical Control/Form/Table V2 assemblers。
- 业务规则：QueryPlan + SemanticBindings。
- snapshot：`buildSnapshotProjection()` / `diffSnapshotProjection()`。
- runtime query：canonical observation 与 component indexes。
- annotator：agent projection/picking/check/save；extension 只发送事件、坐标和 draft。
- record、checkpoint、assert、entity、query：统一消费 V2 PageSession。

record 与 runner 共享 PageSession。以下私有生命周期已删除：

- `recordSnapshotCache`；
- 1500ms TTL；
- URL 私有判鲜；
- record 直接重复执行 `captureControlSnapshot + Form/Table assembly`。

record 现在通过 `RecordingSnapshotPort` 进入同一 dirty/navigation/explicit freshness、并发 refresh 合并、selection remap 与 semantic composition。Stage 6 静态守卫禁止 `recordSnapshotCache` 和 `SNAPSHOT_CACHE_TTL_MS` 返回生产源码。

## 已删除旧入口

- `runner/steps/executors/snapshot/*`；
- V1 region/group、candidate score/select/prune、LCA ownership；
- family-limit、nested-drop、pre-index mutating compression；
- V1 scoped diff、stable-id projection fallback；
- `FinalEntityView`；
- `businessEntityOverlay` / `ruleEntityOverlay`；
- `latestSnapshot` / `snapshotSessionStore` Trace cache bridge；
- extension DOM entity recovery 与重复 matcher；
- V1 keyslot/Ant acceptance/bulk/dump/repro 脚本；
- 只验证退休实现细节的 V1 测试套件。

`agent/tests/integration/snapshot/stage6_legacy_boundary.test.ts` 持续验证退休路径、token、相对导入、record 私有 cache 和验收文档状态。

## 复审修复结果

### Record PageSession 统一

`page_session_capture.test.ts` 验证：

- runner 首次 capture 与 record enrichment 读取同一个 PageSession capture 对象；
- DOM 重渲染后 record 标记共享 session dirty；
- capture revision 增加；
- runner 随后读取同一个刷新结果；
- refresh reason 为 `dirty-interaction`。

多标签录制回放 E2E 在删除私有 TTL cache 后重新通过。

### 真实浏览器矩阵

`table_required_matrix_browser.test.ts` 使用 Playwright 实际 DOM，而不是手工 `RawPageCapture`，覆盖：

- 旧版 clone-based fixed-left/fixed-right；
- outer `role=table` host 去重；
- fixed mirror row/cell mapping；
- 大量重复 links/controls 的 CellControlSlot 有界性；
- multi-level header；
- body rowspan/colspan；
- nested table；
- expanded tree 与无 `aria-level` hierarchy unknown；
- virtualization 与 `aria-rowcount`；
- loading、empty；
- 同 host 两表与 ambiguous pagination；
- responsive hidden column 与 row selection。

该矩阵先暴露出真实 bug：12 个重复链接会生成 12 个 slot。修复后每列每 control kind 最多使用 4 个 structural-position buckets，同时完整保留 occurrence/control IDs，不再随单行 control 数量线性增长。

其他真实浏览器证据：

| Required fixture | 证据 |
| --- | --- |
| native/Element/Ant form | `form_framework_browser.test.ts`、native form browser/step tests |
| Element 23 logical tables | `table_framework_browser.test.ts`，23 个 `.el-table` 严格组装为 23 个 TableComponent |
| Ant sticky/fixed/summary/pagination | `table_framework_browser.test.ts` |
| editable cell/portal editor | `table_editor_browser.test.ts` |
| opened/multiple select popup | `control_action_browser.test.ts`、`control_framework_browser.test.ts` |
| shadow duplicate ID、zero-box、controller mismatch、captured-without-candidate iframe | `observation_browser_acceptance.test.ts` |
| iframe scope geometry | `observation_browser_regressions.test.ts`、control iframe action tests |
| partial observation source failure | `observation_browser_regressions.test.ts`：真实浏览器页面 + 单一 runtime source 故障注入，DOM facts 保持 complete |
| zoom/scroll/visual viewport | annotator browser tests 与 extension live geometry tests |
| filter/modal/rerender | `dynamic_page_browser.test.ts` |
| SessionAnchor exact/stale/ambiguous | PageSession 与 annotator lifecycle tests |
| entity_rules import/check/save/reopen/runtime | entity_rules 与 annotator integration tests |
| snapshot mode/contain/filter/diff | projection、runner snapshot、MCP schema tests |
| Step/Checkpoint/DSL | integration suite 与 4 个 E2E spec |

未完成 required fixture：0。

### 完整性能门禁

Stage 1 frozen corpus 门禁继续验证 work-set 与 canonical node 数量；容差从 8 倍收紧为：

```text
max(baseline × 1.2, baseline + 0.5ms)
```

新增 `SnapshotV2Stage45PerformanceBaseline.json`，冻结结构：

```text
observation fixtures: 10
business cases: 3
input nodes: 267
controls: 160
forms: 7
tables: 8
rows: 132
projected nodes: 543
annotator targets: 284
```

14 个独立 pass：

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

结构计数必须与 baseline 精确一致，避免通过删除 canonical nodes、rows、components 或 targets 换取性能。Stage 1 与 Stage 4/5 两个显式性能门禁均通过。

### 发行诊断

`capture_resolve` 未命中现在返回：

- workspace；
- page epoch / capture revision；
- root scope IDs；
- active node count；
- candidate count；
- 实际查询输入。

structural `browser.query` 参数失败现在返回：

- page epoch / capture revision；
- root scope IDs；
- relation；
- `from` 输入。

这些路径由测试直接断言 `error.details`，不再只有 `ERR_NOT_FOUND` 或泛化 message。既有 component、ownership、QueryPlan、locator、projection diagnostics 继续保留 canonical node、evidence 与 plan step 信息。

## 最终验证

```text
pnpm -C agent test:integration               614 tests / 612 pass / 0 fail / 2 skipped
pnpm -C agent test:snapshot                  135/135
pnpm -C agent test:entity-rules              31/31
pnpm -C agent test:trace                     7/7
pnpm -C agent test:e2e                       4/4
pnpm -C agent test:unit                      254 tests / 252 pass / 0 fail / 2 skipped
pnpm -C agent test:unit:snapshot:perf         1/1
pnpm -C agent test:unit:snapshot:full-perf    1/1
pnpm -C agent typecheck                      pass
pnpm --filter ./extension test               pass
pnpm lint                                    0 errors / 0 warnings
```

普通 integration/unit 中跳过的两项就是显式 Stage 1 与 Stage 4/5 性能门禁，已分别执行通过。

E2E 覆盖：

- 多标签录制与回放；
- fill/type/select/checkbox/radio/press/hover/scroll/click/snapshot/screenshot；
- workflow MCP 生命周期与 workspace 隔离；
- workflow save/load 与 recording 隔离。

## 依赖、归档与工作区

- 生产 legacy token/path 扫描：0 命中。
- record 私有 snapshot cache token：0 命中。
- `agent/src`、`extension/src`、`start_extension/src`、`shared` 相对导入：0 个未解析。
- Snapshot V1 runtime/implementation 仅保留于 tag：`archive/snapshot-entity-recognition-v1`。
- legacy entity_rules artifact importer 只把旧制品转换为 V2 QueryPlan，不执行 V1 matcher。
- `pnpm lint`：0 errors / 0 warnings。
- 最终提交前工作区必须保持干净。

## 退出检查

- [x] 全部 production consumer 使用 V2 canonical facts/components
- [x] record 与 runner 共享 PageSession
- [x] 无 runtime flag、V1 fallback、双 matcher 或私有 record TTL cache
- [x] required browser matrix 未完成项为 0
- [x] Stage 1 与完整 Stage 4/5 性能门禁通过
- [x] 关键失败路径提供结构化诊断
- [x] 文档、contracts、实现和测试一致
- [x] 全仓 lint clean
- [x] V1 仅通过归档 tag 查看

Snapshot/实体识别 V2 分阶段迁移至此结束。后续功能应作为独立任务，不再扩展本迁移计划。
