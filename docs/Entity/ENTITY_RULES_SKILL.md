# ENTITY_RULES_SKILL

## 输入

- 页面 URL / page kind
- snapshot 摘要
- `finalEntityView`
- structure detection 结果
- `EntityIndex`
- 目标业务语义描述

## 输出

- `match.yaml`
- `annotation.yaml`
- 风险说明
- 待人工确认项
- profile `README.md` 草稿
- `expected.final_entities.json` / `expected.node_hints.json` 草稿

## 约束

- annotation 不写结构定位字段
- match 不写业务语义字段
- 优先复用通用实体索引
- 仅在不够时写 node fallback
- 必须能落到真实框架 fixture 路由验证

## 人工 Review Checklist

- `ruleId` 稳定可读
- `within` 无循环且作用域合理
- `businessTag` 命名清晰
- `primaryKey/columns/fieldKey` 与页面一致
- expected 与 mock 页面输出一致
- checkpoint/resolve 可消费
