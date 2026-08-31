# Snapshot V2 Stage 1 Handoff

## 状态

- 阶段：Stage 1 — Canonical Observation 与 Relation 基础层
- 实现状态：核心实现与独立验收已修复并通过
- 阶段验收：**accepted**
- 后续边界：生产消费者切换属于 Stage 5；V1 runtime 删除属于 Stage 6。Stage 2 可以直接依赖本阶段冻结的 V2 facts。

此前提交 `9ecd51c` 删除了 V1 Snapshot 实现，而 runner、query、record、select-option、checkpoint 等调用方尚未完成迁移。因此仓库整体类型检查仍会准确报告缺失旧模块；本轮不恢复旧实现，也不把整体零错误作为 Stage 1 核心层验收条件。

## 本轮修复

### Identity 与 runtime state

- `PageEpoch` 与 `CaptureRevision` 保持分离。
- runtime join token 与页面属性分离，进入 `RawCapturedNode.runtimeStateToken`。
- `runtimeIdentityToken` 是同一 document 内稳定的精确身份，可用于同 page epoch 的 anchor remap。
- runtime sampler 按 capture run 保存 restoration，cleanup 恢复页面原有 `data-rpa-state-id`，不再无条件删除。
- 页面原有 `data-rpa-observation-id` 同样完整恢复。
- canonical attributes 过滤所有采集器内部 marker。
- runtime 执行失败返回 `unavailable` 和明确错误；成功但零记录返回 `complete`。

### Completeness、activity 与 geometry

- `TreeScope` 携带自己的 `ObservationCompleteness`。
- A11y 成功但空结果为 `complete`；CDP 失败为 `unavailable`。
- `rendered` 表示视觉呈现，不再因为 `inert` 自动变成 false；`subtreeActive` 仍受 inert 阻断。
- iframe transform 根据实际 border box 与未变换尺寸推导比例，真实 `transform: scale(2)` 的子页面 geometry 已通过浏览器数值验收。
- 报告字段改为 `capturedWithoutCandidateCount`；“captured without candidate”是分析结果，不再伪装成第三种 scope 状态。

### Relation、candidate、quotient 与 invariant

- `RelationIndex` 同时建立 `bySourceNodeId` 与 `byTargetNodeId`。
- semantic role resolution 返回实际来源和强度；DOM role/class 不再伪标为 A11y/adapter。
- 同类 host + structural signal 归为 host；只有互相冲突的 entity kind 才归为 ambiguous。
- part candidate 不再各自建立 quotient；同 kind 的 host 已覆盖其内部 structural candidate 时不重复建立视图。
- quotient 通过 relation indexes 收集 endpoint，不再为每个 candidate 扫描所有 relation。
- pass 的 node/edge visits 为实际计数，不再使用固定输入规模冒充访问量。
- InvariantValidator 增加 canonical indexes、ScopeForest、parent/child scope、relation indexes、relation status、quotient scope/candidate/provenance、外部 endpoint 和线性 cycle 检查。

## 验收

执行：

```text
pnpm -C agent typecheck:snapshot
pnpm -C agent test:snapshot
# 仓库整体 typecheck 预期失败，用于暴露尚未迁移的生产调用方
pnpm -C agent typecheck
```

结果：

```text
snapshot typecheck: pass
snapshot tests:     25 pass / 0 fail
full agent typecheck: expected failure（未迁移调用方仍引用已删除 V1 模块）
```

浏览器回归覆盖：

- page-owned runtime/observation marker 完整恢复；
- canonical attributes 不包含内部 marker；
- backend identity 缺失时仍可用稳定 runtime identity 精确 remap；
- runtime/A11y 成功空采集为 complete；
- runtime 执行失败为 unavailable；
- scaled iframe 输出准确 top CSS viewport geometry；
- shadow/iframe scope path、scope-local duplicate ID、zero-box descendant 和 activity mismatch。

500 行级表格工作集测试使用 50 行 × 10 列原生表格：

```text
canonical nodes: 555
part candidates: 551
quotient views: 1
```

它验证 part candidate 不再产生 551 个重复 quotient，并验证报告的 visit 数来自真实遍历。

## 固定语料

语料版本：`snapshot-v2-stage1-v2`

共 10 个 fixture：

1. `native-form`
2. `element-table`
3. `ant-select-activity`
4. `shadow-duplicate-id`
5. `partial-unavailable`
6. `frame-geometry`
7. `captured-without-candidate-zero-box`
8. `join-resolution`
9. `element-plus-browser`
10. `ant-design-browser`

后两个 fixture 由 `snapshot_v2_capture_framework_fixtures.ts` 使用仓库实际安装的框架包渲染并采集：

```text
Element Plus 2.13.7 / Vue 3.5.31: 100 nodes
Ant Design 5.29.3 / React 19.2.5: 103 nodes
```

它们不是只带框架 class 名的手写 HTML。全部 10 个 fixture：truth errors 0、invariant failures 0、quotient orphan 0。

## 基线

文件：`docs/Development/reports/SnapshotV2Stage1Baseline.json`

```text
10 fixtures × 50 iterations
canonical input nodes: 267
relation edges: 9

candidate classifications:
  structural: 10
  host:        7
  part:        61
  latent:      7
  rejected:    181
  ambiguous:   1

candidate-local quotient:
  max: 65
  p50: 4
  p95: 65
  orphan: 0
  maximum union ratio: 0.7864
  peak retained index entries: 1339
  max collapsed depth: 1
  max projection-parent fan-out: 5
```

固定语料 timing：

```text
observation            p50 0.031 ms  p95 0.637 ms
relation               p50 0.008 ms  p95 0.041 ms
candidate              p50 0.010 ms  p95 0.178 ms
quotient               p50 0.005 ms  p95 0.057 ms
activity-consistency   p50 0.000 ms  p95 0.002 ms
invariant              p50 0.015 ms  p95 0.153 ms
```

live capture 30 samples：

```text
capture      p50 32.034 ms  p95 42.361 ms
observation  p50  0.121 ms  p95  0.171 ms
```

## 当前边界

已经成立：

- `agent/src/automation/snapshot/` 内部唯一 V2 capture/observation/analysis API；
- 不可变 canonical observation；
- exact joins、scope-local relations、实际 activity、scope geometry；
- candidate-local quotient 与强化 invariant；
- 固定语料、真实框架语料和性能基线；
- Stage 1 独立类型检查通过；仓库整体类型检查继续保留迁移错误。

尚未成立：

- `browser.snapshot` 及其他生产消费者切换到 V2；
- V1 runtime 删除；
- Stage 1 原计划的完整生产切换退出门槛。

因此 Stage 1 已完成交接，Stage 2 可以开始；不得提前恢复或扩展 V1 runtime。
