# EntityRules 运行时

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

## 可视化标注

可视化标注器（visual annotator）提供在真实页面上直接产出 entity_rules 的 best-effort 路径。对应 `agent/src/entity_rules/annotator/*`。

### 1. 编辑模型

- 编辑态模型为 `CanvasDraft`：`WorkflowEntityRules → CanvasDraft → WorkflowEntityRules`。
- 打开已存规则时 `importEntityRulesToCanvasDraft` 导入为草稿；保存时 `compileCanvasDraft` 编译回 `WorkflowEntityRules`。

### 2. 画布交互契约

标注器以真实网页为主要编辑界面，不使用对象列表或永久侧栏替代页面语义：

- 首次操作只选择完整业务区域；确认后立即自动识别，不再要求额外点击“开始识别”。
- 已确认区域持续显示边界和外部遮罩，但实体边界不接收普通点击；范围修改只能从底部“调整”进入。
- 搜索字段、按钮、表头和分页直接装饰真实 DOM；全屏宿主和底栏空白区域必须允许页面点击穿透。
- 点击真实元素后，在元素附近打开小型编辑卡片；卡片只提供名称、业务标识、类型、主键、重新选择、忽略和删除等直接操作。
- 默认不显示外围标签墙和连线。只有当前选中项、无法直接表达的对象或错误状态才允许显示附加标签。
- 同构按钮每种语义只装饰一个代表元素，由用户命名；规则本身仍可使用 `one_or_more` 匹配全部同构元素。
- 表头整体使用紫色虚线边框，列间使用单条竖线，不叠加底部实线；主键直接在对应表头上高亮。
- 底部只保留紧凑操作组件；容器背景不截获点击，只有实际按钮可交互。

确认实体后的预设识别范围限定为：搜索字段、表头、上一页和下一页。查询按钮与行操作不属于预设，需由用户按需添加。

### 3. Plan B 不透明保留

- Canvas 未建模的字段（如 `keyHint`、locator 规则）通过 `preserved` 块无损保留。
- 保存时若保留项无法回挂到 canvas（`opaque_unmergeable`），save gate 会阻断保存，避免静默丢规则。
- 禁止新旧路径并存：所有保存都走 compile → validate → match → apply → gate 单链路。

### 4. check 与 save 流程

```
compileCanvasDraft -> validateEntityRules -> matchEntityRules -> apply -> evaluateSaveGate -> workflow.save
```

- check 按 annotation 报告 `unique` / `multiple` / `missing` / `invalid`。
- save gate 校验：page stale、revision conflict、primary entity unresolved、confirmed annotation 未解析、opaque unmergeable。

### 5. 页面身份与修订冲突

- `detectStale`：当 `draft.page.urlPattern` 与当前 URL 不匹配时标记 stale，阻断保存（`ERR_STALE`）。
- `revision`：保存基于内容哈希；expectedRevision 与存储不一致时返回 `ERR_CONFLICT`，避免覆盖 Debug 面板并发改动。

### 6. 首版本支持范围

支持：

- 顶层文档、普通 DOM、open Shadow Root。

不支持：

- 跨域 iframe。
- closed Shadow Root。
- canvas / svg 内部结构。
- 浏览器原生 UI（select 下拉、文件选择器等）。

### 7. best-effort 声明

标注器的 pick / recognize 为启发式推断，对任意页面不保证识别成功；class 共享（如多个 `ant-input`）会导致目标歧义，需人工确认 target。

## 限制

- schema 字段不可随意扩展。
- 非法规则在 strict 配置下会进入 errors 并阻断可靠加载。
- legacy profiles 仅做回退，不应继续作为新规则主沉淀。
