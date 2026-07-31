# Snapshot V2 运行时

## 概述

Snapshot V2 是页面观察、组件组装、业务规则和目标解析的统一事实层。生产链路不再生成或消费 V1 的压缩树、`nodeIndex`、`entityIndex`、`locatorIndex` 或内嵌 `contentStore`。

## 运行链

```text
browser capture
  -> PageObservation
  -> Relation/Locator/Control snapshots
  -> FormComponent / TableComponent
  -> entity_rules QueryPlan + SemanticBindings
  -> PageSession
  -> SnapshotProjection / RuntimeEntityView
```

`PageObservation` 是不可变采集结果。`PageSession` 持有当前页面 epoch、capture revision、规则选择和语义绑定。交互步骤完成后会标记 session dirty，下一次读取按策略刷新。

## `browser.snapshot`

主要输入：

- `mode`: `overview | interaction | annotation | debug | full`
- `refresh`: 强制刷新 PageSession
- `contain`: 以节点为范围生成投影
- `depth`: 投影深度，`-1` 表示不限制
- `filter`: role、text、interactive 过滤
- `diff`: 请求相对上次投影的语义差量

输出为 `SnapshotProjection`，当前 `schemaVersion` 为 2。输出面向观察和引用，不承诺兼容 V1 JSON 路径。

## 内容读取

较大文本通过 epoch-bound `contentRef` 返回，并由 `browser.get_content` 读取。页面 epoch 改变后，旧引用不得继续使用。

## 查询和目标解析

- 结构查询使用 `browser.query`。
- 可执行目标草稿使用 `browser.capture_resolve`。
- 业务实体查询使用 `businessTag` 和 typed target。
- 交互步骤最终仍通过统一 Step executor 和 target resolver 执行。

## Diff 规则

`diff=true` 只在 baseline 和页面身份明确时生成差量。以下情况回退 full：

- 没有 baseline；
- 页面导航或 epoch 改变；
- 差量身份不明确；
- 结构变化无法安全表达。

回退是正常结果，不是错误。

## V1 迁移边界

以下旧路径不再提供：

```text
snapshot.data.root
snapshot.data.nodeIndex
snapshot.data.entityIndex
snapshot.data.locatorIndex
snapshot.data.contentStore
```

迁移方式：

- 节点和值：`browser.query`
- 可执行提示：`browser.capture_resolve`
- 页面结构：Snapshot V2 `roots/components/semantics/collections`
- 大文本：`contentRef` + `browser.get_content`
- 业务操作：`businessTag` + typed entity target

## 排障

- 内容为空：检查页面是否完成加载及 capture completeness diagnostics。
- 业务实体缺失：检查规则选择、URL applicability 和 SemanticBindings diagnostics。
- diff 总是 full：检查页面是否持续导航或 baseline 是否被重置。
- 目标漂移：检查 PageSession epoch、ResolveHint 和目标所属 component。
