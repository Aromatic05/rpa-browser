# ENTITY_RULES

## 设计目标

`entity_rules` 在通用结构识别后叠加业务语义，不重复结构识别：

- 实体语义：`businessTag` / `businessName` / `primaryKey` / `columns`
- 节点语义：`fieldKey` / `actionIntent`
- 下游消费：checkpoint / resolve

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

mock workspace：

```text
mock/
  ant-app/      # React + TS + Ant Design
  element-app/  # Vue + TS + Element Plus
```

## Profile 与路由映射

- `oa-ant-orders` -> `http://127.0.0.1:5173/entity-rules/fixtures/order-list`
- `oa-ant-order-form` -> `http://127.0.0.1:5173/entity-rules/fixtures/order-form`
- `oa-element-users` -> `http://127.0.0.1:5174/entity-rules/fixtures/user-list`
- `oa-element-user-form` -> `http://127.0.0.1:5174/entity-rules/fixtures/user-form`

## match.yaml / annotation.yaml

- `match.yaml`：结构匹配
- `annotation.yaml`：业务语义

边界：

- `match` 不写业务字段
- `annotation` 不写结构定位字段

## 配置加载

配置定义：`agent/src/config/entity_rules.ts`

- `enabled=false`
- `selection='explicit'`
- `profiles=[]`
- `strict=true`
- `rootDir=agent/.artifacts/entity_rules`

## Pipeline 接入

`detectStructure -> buildStructureEntityIndex -> applyBusinessEntityRules -> buildLocatorIndex -> buildFinalEntityView`

## Logger

`LogType='entity'`，关键事件：

- `entity.rules.load.start/end`
- `entity.rules.profile.selected/conflict`
- `entity.rules.validate.failed`
- `entity.rules.match.start/hit/miss`
- `entity.rules.apply.start/end`
- `entity.rules.verify.diff`
