# Entity Rules Skill 约束

## 输入

- 页面 URL / page kind
- snapshot 摘要
- `EntityIndex`
- `finalEntityView`
- 业务语义目标

## 输出

必须输出：
- `match.yaml`
- `annotation.yaml`
- 风险点
- 人工确认项
- `README.md` 草稿
- `expected.*.json` 草稿

## 强约束

- annotation 不得写结构定位
- match 不得写业务语义字段
- 优先复用结构实体索引
- 只有不够时才用 node fallback
- 输出必须可 verify（真实 mock 路由可跑通）

## 人工 Review 清单

- `ruleId` 是否稳定
- `within` 是否无循环且必要
- `businessTag` 是否清晰
- `primaryKey/columns/fieldKey` 是否与页面一致
- expected 是否与当前 mock 页面一致
