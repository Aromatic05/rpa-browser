# ENTITY_RULES

## 设计目标

`entity_rules` 是 snapshot 结构识别后的业务语义叠加层，用于稳定补充：

- 实体级语义：`businessTag` / `businessName` / `primaryKey` / `columns`
- 节点级语义：`fieldKey` / `actionIntent`
- 下游消费：checkpoint `entityExists`、`resolve.hint.entity`

约束：

- 不重复结构识别（复用 `buildStructureEntityIndex`）
- 不新造 DSL
- v1 仅硬匹配

## 目录结构

规则根目录固定为：`agent/.artifacts/entity_rules`

```text
agent/.artifacts/entity_rules/
  profiles/
    <profile>/
      match.yaml
      annotation.yaml
      README.md
      expected.final_entities.json
      expected.node_hints.json
```

## Profile 概念

`profile` 是一套完整规则包（页面范围 + 语义注入 + golden 期望），可独立验证与回归。

当前内置样例：

- `oa-ant-orders`
- `oa-ant-order-form`
- `oa-element-users`
- `oa-element-user-form`

## match.yaml / annotation.yaml

- `match.yaml`：结构匹配（`source/within/expect/match`）
- `annotation.yaml`：业务语义（`businessTag/.../fieldKey/actionIntent`）

边界：

- `match` 不写业务字段
- `annotation` 不写结构定位字段

## Schema + Validate

实现位置：`agent/src/runner/steps/executors/snapshot/entity_rules`

- 单文件校验：`schema/match_rule.schema.ts`、`schema/annotation_rule.schema.ts`
- 跨文件校验：`validate.ts`

校验包含：`version/page`、`ruleId` 映射、`within` 存在与循环、`page.kind` 一致性。

## 配置加载方式

配置位于：`agent/src/config/entity_rules.ts`

```ts
export type EntityRuleConfig = {
  enabled: boolean;
  rootDir: string;
  selection: 'disabled' | 'explicit' | 'auto';
  profiles: string[];
  strict: boolean;
}
```

默认：

- `enabled=false`
- `rootDir=agent/.artifacts/entity_rules`
- `selection='explicit'`
- `profiles=[]`
- `strict=true`

策略：

- `disabled`：不加载
- `explicit`：仅加载 `profiles`
- `auto`：按 `page.kind/urlPattern` 自动选

多 profile 同时命中：失败。

## Pipeline 接入位置

snapshot 主链路：

`detectStructure -> buildStructureEntityIndex -> applyBusinessEntityRules -> buildLocatorIndex -> buildFinalEntityView`

下游：

- checkpoint：`match.entityExists.businessTag`
- resolve：`resolve.hint.entity`

## Logger Explain

复用 `agent/src/logging/logger.ts`，新增 `LogType='entity'`。

关键事件：

- `entity.rules.load.start/end`
- `entity.rules.profile.selected/conflict`
- `entity.rules.validate.failed`
- `entity.rules.match.start/hit/miss`
- `entity.rules.apply.start/end`
- `entity.rules.verify.diff`
