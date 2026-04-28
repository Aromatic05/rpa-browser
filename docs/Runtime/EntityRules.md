# EntityRules

## 概述

Entity rules 将结构节点映射为业务语义，输出到 `finalEntityView`，供 `browser.entity` 与 `browser.query` 消费。对应 `snapshot/entity_rules/*`。

## 规范

### 1. 路径与优先级

主路径：

- `agent/.artifacts/workflows/<scene>/entity_rules/<rule-pack>/`

fallback：

- `agent/.artifacts/entity_rules/profiles/<profile>/`

优先级：workflow-scoped > legacy profiles。

### 2. 文件职责

- `match.yaml`：规则匹配定义。
- `annotation.yaml`：语义标注定义。

匹配和标注必须成对存在。

### 3. match schema 核心

字段：

- `version`
- `page.kind/urlPattern`
- `entities[]`
  - `ruleId`
  - `source: region|group|node`
  - `expect: unique|one_or_more`
  - `within?`
  - `match`（kind/nameContains/keyHint/relation/classContains/textContains/ariaContains）

### 4. annotation schema 核心

字段：

- `version`
- `page`
- `annotations[]`
  - `ruleId`
  - `businessTag/businessName`
  - `primaryKey`
  - `columns`
  - `fields`
  - `actions`
  - `pagination.nextAction`
  - `fieldKey/actionIntent`

### 5. 运行时流程

```text
loadEntityRules
-> validateEntityRules
-> matcher
-> apply
-> ruleEntityOverlay
-> finalEntityView
```

### 6. table 语义

常用标注：

- `primaryKey.fieldKey`
- `columns[].fieldKey`
- `columns[].kind=action_column`
- `pagination.nextAction.actionIntent/nodeRuleId`

查询映射：

- `table.rowCount/currentRows/hasNextPage/nextPageTarget`
- `entity.target table.row/table.row_action`

### 7. form 语义

常用标注：

- `fields[].fieldKey`
- `fields[].controlRuleId/labelRuleId`
- `actions[].actionIntent/nodeRuleId`

查询映射：

- `form.fields/form.actions`
- `entity.target form.field/form.action`

### 8. diagnostics

规则系统输出 diagnostics，常见问题包括：

- 匹配 0 个节点
- 匹配多个节点
- 引用 ruleId 不存在
- field/action/pagination 无法解析

### 9. workflow 引用方式

workflow 运行时按 scene 自动加载对应目录规则；同名规则存在时 workflow-scoped 覆盖 legacy。

## 示例

### match.yaml

```yaml
version: 1
page:
  kind: form
entities:
  - ruleId: order_form_root
    source: region
    expect: unique
    match:
      kind: form
      nameContains: 订单
```

### annotation.yaml

```yaml
version: 1
page:
  kind: form
annotations:
  - ruleId: order_form_root
    businessTag: order.form
    fields:
      - fieldKey: buyer
        controlRuleId: buyer_input
    actions:
      - actionIntent: submit
        nodeRuleId: submit_btn
```

## 限制

- schema 字段不可随意扩展。
- 非法规则在 strict 配置下会进入 errors 并阻断可靠加载。
- legacy profiles 仅做回退，不应继续作为新规则主沉淀。
