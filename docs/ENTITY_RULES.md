# Entity Rules

## 目标

`entity_rules` 用于在 snapshot 的通用结构实体识别结果之上，叠加固定业务页语义：

- 给实体补 `businessTag` / `businessName`
- 给节点补 `fieldKey` / `actionIntent`
- 让 checkpoint / resolve 消费业务语义

不重复实现通用结构识别，不引入新 DSL。

## 文件结构

- `entity_rules/<page-id>/match.yaml`
- `entity_rules/<page-id>/annotation.yaml`

`match.yaml`：结构匹配规则（`source/within/expect/match`）。

`annotation.yaml`：业务语义（`businessTag/businessName/primaryKey/columns/fieldKey/actionIntent`）。

## 校验

两层校验：

1. 单文件 schema（`entity_rules/schema/*`）
2. 跨文件语义校验（`entity_rules/validate.ts`）

关键约束：

- `version/page/entities/annotations` 必填且结构合法
- `source` 仅允许 `region|group|node`
- `expect` 仅允许 `unique|one_or_more`
- `annotation.ruleId` 必须存在于 `match.yaml`
- `within` 引用必须存在且不可成环
- `page.kind` 必须一致

## 运行时 Overlay

规则运行后生成 `BusinessEntityOverlay`：

- `byRuleId`: rule 到匹配结果
- `byEntityId`: 实体业务信息
- `nodeHintsByNodeId`: 节点业务 hints

`EntityIndex` 保持纯净，最终在 `finalEntityView` 构建时合并 overlay。

## Snapshot / Checkpoint / Resolve 接入

snapshot pipeline：

`detectStructure -> buildStructureEntityIndex -> applyBusinessEntityRules -> buildLocatorIndex -> buildFinalEntityView`

checkpoint：

- `entityExists` 可按 `businessTag` 命中 `finalEntityView.entities`

resolve：

- 新增 `resolve.hint.entity`：
  - `businessTag?`
  - `fieldKey?`
  - `actionIntent?`
- `resolveTarget` 优先走 snapshot + overlay 解析，再复用现有 selector 落地流程。
