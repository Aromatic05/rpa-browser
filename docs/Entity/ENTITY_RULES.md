# Entity Rules 快速说明

## 这是什么

`entity_rules` 是给 snapshot 通用实体识别结果做“业务语义补丁”的系统。

它不负责重新识别结构，只做两件事：
- 给实体打业务标签（`businessTag`、`businessName`、`primaryKey`、`columns`）
- 给节点打动作/字段提示（`fieldKey`、`actionIntent`）

## 规则文件在哪里

源码（可提交）：
- `agent/tests/entity_rules/workflows/<scene>/entity_rules/<rule_name>/*`
- golden/legacy fixtures：`agent/tests/entity_rules/profiles/*`

运行时目录（不可提交，自动生成）：
- `agent/.artifacts/workflows/<scene>/entity_rules/<rule_name>/*`
- legacy fallback：`agent/.artifacts/entity_rules/profiles/*`

说明：loader 运行时优先读取 workflow scene 下的 `entity_rules/<rule_name>`，旧 `profiles` 目录只作为 legacy fallback。

## 一套 rule 的结构

每个 `entity_rules/<rule_name>` 目录必须包含：
- `match.yaml`
- `annotation.yaml`

测试 golden 通常与 legacy fixture 目录一起维护：
- `README.md`
- `expected.final_entities.json`
- `expected.node_hints.json`

## match.yaml 和 annotation.yaml 分工

`match.yaml` 只做“结构匹配”：
- `source`: `region | group | node`
- `within`: 作用域约束
- `expect`: `unique | one_or_more`
- `match`: `kind/nameContains/...`

`annotation.yaml` 只做“业务语义”：
- `businessTag` / `businessName`
- `primaryKey` / `columns`
- `fieldKey` / `actionIntent`

禁止混写：
- annotation 里不能写结构定位字段
- match 里不能写业务语义字段

## 配置入口

配置在 `agent/src/config/entity_rules.ts`，默认保守关闭：
- `enabled=false`
- `selection='explicit'`
- `profiles=[]`
- `strict=true`

显式选择建议使用：
- `scene/rule_name`，例如 `order-list/oa-ant-orders`
- 兼容纯 `rule_name`，但仅在全局唯一时可安全解析

## 在主流程的位置

`detectStructure -> buildStructureEntityIndex -> applyBusinessEntityRules -> buildLocatorIndex -> buildFinalEntityView`

下游消费：
- checkpoint: `entityExists.businessTag`
- resolve: `resolve.hint.entity`
