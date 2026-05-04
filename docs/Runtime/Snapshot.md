# Snapshot 机制

## 概述

snapshot 是当前运行时的页面语义中间层，服务于 `browser.query`、`browser.entity`、目标解析与规则叠加。Step 定义位于 `runner/steps/types.ts`，执行器位于 snapshot 相关模块。

## 在系统中的位置

调用链：

1. `browser.snapshot` 触发采集
2. 产出统一 snapshot
3. `applyBusinessEntityRules` 叠加业务 overlay
4. `browser.query` 在 snapshot 与 overlay 上查询
5. 目标解析流程消费 locator/entity 索引

## browser.snapshot 参数契约

`browser.snapshot` 支持参数：

- `includeA11y?: boolean`
- `focus_only?: boolean`
- `refresh?: boolean`
- `contain?: string`
- `depth?: number`
- `filter?: SnapshotFilter`
- `diff?: boolean`

语义约束：

- `refresh=true`：强制刷新缓存。
- `focus_only=true`：聚焦当前关注区域。
- `contain/depth/filter`：限制采集范围与结构体积。
- `diff=true`：请求差量快照，可能回退 full。

## DOM / A11y / runtime state 关系

snapshot 不是单一 DOM dump，而是融合三类信息：

- DOM 节点与属性
- A11y 树语义
- runtime 追踪态（例如最近快照上下文与缓存）

A11y 采集受 `waitPolicy.a11ySnapshotTimeoutMs` 影响。

## 关键索引职责

- `stableId`：跨轮次尽量稳定的节点标识。
- `bindId`：绑定同一语义节点在多源数据中的映射。
- `locatorIndex`：面向目标解析与交互定位。
- `entityIndex`：面向业务实体查询与标签检索。

这些索引共同支撑“可查、可定位、可解释”。

## BusinessEntityOverlay 叠加

`applyBusinessEntityRules` 会把 entity_rules 的规则叠加到 snapshot，产出业务实体 overlay：

1. 匹配规则筛选候选节点
2. annotation 规则补充字段语义
3. 生成可查询业务标签

overlay 是运行时叠加层，不直接改写原始 DOM。

## browser.query 如何消费 snapshot

`browser.query` 以 snapshot 或节点集合为输入，在结构化索引上执行查询表达式；返回值可能是：

- 单值
- 单节点 ID
- 多节点 ID 列表

查询结果可进一步驱动 click/fill/assert 等 Step。

## diff snapshot 机制

当 `diff=true` 时，运行时尝试使用 baseline 做差量：

- baseline 不存在 -> 回退 full
- 页面身份变化（导航/关键结构漂移）-> 回退 full
- diff 失败或不可安全合并 -> 回退 full

回退是设计内行为，不是异常。

## 与 entity_rules 的关系

entity_rules 是 snapshot 业务语义层，不是替代 snapshot。关系是：

- snapshot 提供结构底座
- entity_rules 提供业务标签与字段解释
- query/resolve 在两者上联合工作

## 与 target resolve 的关系

target resolve 可使用：

- snapshot 节点结构
- locatorIndex
- entity overlay 标签

当 selector 不稳定时，resolve 依赖 snapshot/overlay 提供候选与回退路径。

## 常见失败与排查

- snapshot 空或节点过少：检查页面是否加载完成、A11y 超时、过滤条件是否过严。
- query 无命中：检查 entity_rules 是否覆盖当前页面。
- diff 频繁回退 full：检查页面是否持续导航或结构剧烈变动。
- resolve 漂移：检查 stableId/bindId 关联是否失效并复核规则。

## 当前限制

- diff 依赖会话内 baseline，不保证跨会话复用。
- overlay 质量依赖人工规则质量。
- snapshot 不是视觉像素级模型，不能直接替代截图比对。

## 禁止事项

- 禁止将 snapshot 当作一次性静态数据缓存长期复用。
- 禁止在无规则验证情况下把 query 命中视为业务正确。
