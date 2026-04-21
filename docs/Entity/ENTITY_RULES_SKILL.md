# ENTITY_RULES_SKILL

## 输入

- 页面 URL / page kind
- snapshot 摘要
- `finalEntityView`
- 结构检测结果（region/group candidates）
- `EntityIndex`
- 目标业务语义描述

## 输出

- `match.yaml`
- `annotation.yaml`
- 风险说明（命中不稳点）
- 待人工确认项
- profile `README.md` 草稿
- `expected.final_entities.json` / `expected.node_hints.json` 草稿

## 约束

- annotation 不写结构定位字段
- match 不写业务语义字段
- 优先复用通用实体索引
- 仅在必要时使用 node fallback
- 必须可验证（可落入 golden）
- 必须给出人工 review checklist

## 不允许做的事

- 不扩展规则语法能力
- 不引入模糊打分
- 不引入规则继承/平台化
- 不生成与 mock 页面脱节的 expected

## 人工 Review Checklist

- `ruleId` 是否稳定、可读
- `within` 是否必要且无歧义
- `businessTag` 是否清晰且可复用
- `primaryKey/columns/fieldKey` 是否与业务字段一致
- `expected.*.json` 是否与 mock 页面真实输出一致
- checkpoint/resolve 是否能消费关键语义
