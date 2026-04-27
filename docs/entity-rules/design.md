# Entity Rules 设计文档

## 4.1 设计定位

entity-rules 是业务实体规则系统，不是 DOM selector 集合。它的职责是把页面结构标注成业务实体。当前实现入口集中在 [agent/src/runner/steps/executors/snapshot/entity_rules](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules) 与 [agent/src/runner/steps/executors/snapshot/core](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core)。

`match.yaml` 负责定位结构和节点，`annotation.yaml` 负责业务语义。规则执行后的输出是 `ruleEntityOverlay`。`ruleEntityOverlay` 与 manual overlay 组合成 `finalEntityView`。`finalEntityView` 是 `browser.entity` 与 `browser.query` 的统一消费入口，具体见 [agent/src/runner/steps/executors/entity.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/entity.ts) 与 [agent/src/runner/steps/executors/query.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/query.ts)。

overlay 与 entity-rules 是同一个体系的两种来源。rule overlay 来自规则，manual overlay 来自 `browser.entity` 操作。当前不存在两套互不相关的实体系统。

## 4.2 match.yaml 与 annotation.yaml

### match.yaml

- 描述如何定位页面结构
- 产出 `ruleId -> matched nodes`
- 可以定位 `form`、`table`、`action`、`button`、`control`、`header`
- 不写业务字段含义

### annotation.yaml

- 描述业务语义
- 引用 `match.yaml` 的 `ruleId`
- 标注 `businessTag`、`businessName`
- 标注 form 的 fields 与 actions
- 标注 table 的 `primaryKey`、`columns`、`actions`、`pagination`

拆成两个文件的原因很直接。AI 更适合生成定位规则，人类更适合审核业务语义。`annotation.yaml` 更稳定，`match.yaml` 更贴近页面 DOM 结构。当前校验逻辑位于 [agent/src/runner/steps/executors/snapshot/entity_rules/validate.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/validate.ts)。

## 4.3 表格模型

table meta 是表格识别系统的一部分，不是调试残留。核心结构定义在 [agent/src/runner/steps/executors/snapshot/core/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/types.ts)，构建逻辑位于 [agent/src/runner/steps/executors/snapshot/core/table_model.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/table_model.ts)。

当前表格模型覆盖：

- `rowCount`
- `columnCount`
- `headers`
- `rows`
- `cells`
- `rowNodeIds`
- `cellNodeIdsByRowNodeId`
- `columnCellNodeIdsByHeader`
- `primaryKeyCandidates`
- `recommendedPrimaryKey`

`tableMeta` 可以作为没有人工标注时的规则来源。`annotation.yaml` 中的 `primaryKey` 优先于 `recommendedPrimaryKey`。`columns` 可以来自 annotation，也可以来自 `tableMeta`。`action_column` 描述操作列。`row_action` resolver 根据 `primaryKey` 与 `actionIntent` 找行内按钮，相关逻辑位于 [agent/src/runner/steps/executors/snapshot/core/entity_query.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/entity_query.ts)。

## 4.4 表单模型

表单业务结构定义在 [agent/src/runner/steps/executors/snapshot/core/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/types.ts)，规则落点位于 [agent/src/runner/steps/executors/snapshot/entity_rules/apply.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/apply.ts)。

当前表单模型覆盖：

- `formFields`
- `formActions`
- `fieldKey`
- `name`
- `kind`
- `controlRuleId`
- `labelRuleId`
- `optionSource`
- `optionRuleId`
- `actionIntent`
- `nodeRuleId`
- `controlNodeId`
- `labelNodeId`
- action `nodeId`

`fieldKey` 是业务字段名。`controlNodeId` 是实际可操作控件节点。`labelNodeId` 是字段标签节点。`actionIntent` 是业务动作名。form action 最终解析到 `nodeId`，再由 `browser.query op=entity.target` 返回给调用方。

## 4.5 pagination 模型

pagination 是 table entity 的一部分，不属于 checkpoint 专属逻辑。annotation 结构如下：

```yaml
pagination:
  nextAction:
    actionIntent: nextPage
    nodeRuleId: order_table_next_page
    disabledRuleId: order_table_next_page_disabled
```

`actionIntent` 表达分页动作。`nodeRuleId` 定位下一页按钮。`disabledRuleId` 是预留绑定。当前 `hasNextPage` 主要根据 `nextAction` node 的 disabled 状态判断，运行时在 [agent/src/runner/steps/executors/snapshot/core/pagination.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/pagination.ts)。

checkpoint 只能通过 `browser.query` 消费 pagination。当前 query 约定如下：

- `table.hasNextPage` 返回 `kind=value`，`value` 是 boolean
- `table.nextPageTarget` 返回 `kind=nodeId`

## 4.6 diagnostics 模型

diagnostics 是 entity-rules 的可观察调试输出。当前结构定义在 [agent/src/runner/steps/executors/snapshot/core/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/types.ts)，收集与去重逻辑位于 [agent/src/runner/steps/executors/snapshot/core/diagnostics.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/diagnostics.ts)。

诊断输出位于 `finalEntityView.diagnostics`，单条记录类型是 `EntityRuleDiagnostic`，字段包括：

- `code`
- `level`
- `message`
- `profile`
- `ruleId`
- `annotationId`
- `entityId`
- `businessTag`
- `fieldKey`
- `actionIntent`
- `columnName`
- `nodeIds`
- `details`

当前主要 `code` 包括：

- `RULE_MATCHED_ZERO`
- `RULE_MATCHED_MULTIPLE`
- `ANNOTATION_RULE_REF_NOT_FOUND`
- `FIELD_CONTROL_UNRESOLVED`
- `FIELD_LABEL_UNRESOLVED`
- `FORM_ACTION_UNRESOLVED`
- `OPTION_RULE_UNRESOLVED`
- `TABLE_COLUMN_HEADER_UNRESOLVED`
- `TABLE_ACTION_COLUMN_UNRESOLVED`
- `TABLE_PAGINATION_NEXT_UNRESOLVED`
- `TABLE_PAGINATION_NEXT_AMBIGUOUS`
- `TABLE_ROW_NOT_FOUND`
- `TABLE_ROW_ACTION_NOT_FOUND`

diagnostics 不阻断 snapshot。diagnostics 不参与 checkpoint trigger。diagnostics 可通过 `browser.entity` 的 `list`、`find`、`get` 观察。`browser.query` 错误 `details` 可附带 `diagnostic` 与 `relatedDiagnostics`。

## 4.7 browser.query 输出规范

当前 `browser.query` 的 entity 结果统一使用以下 envelope，调用入口位于 [agent/src/runner/steps/executors/query.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/query.ts)：

```ts
type BrowserQueryResult =
  | { kind: 'value'; value: unknown; meta?: Record<string, unknown> }
  | { kind: 'nodeId'; nodeId: string; meta?: Record<string, unknown> }
  | { kind: 'nodeIds'; nodeIds: string[]; count: number; meta?: Record<string, unknown> };
```

当前映射关系如下：

- `browser.query op=entity table.row_count -> kind=value`
- `browser.query op=entity table.current_rows -> kind=value`
- `browser.query op=entity table.hasNextPage -> kind=value`
- `browser.query op=entity table.nextPageTarget -> kind=nodeId`
- `browser.query op=entity.target form.field -> kind=nodeId`
- `browser.query op=entity.target form.action -> kind=nodeId`
- `browser.query op=entity.target table.row -> kind=nodeId`
- `browser.query op=entity.target table.row_action -> kind=nodeId`
- 普通 `browser.query from snapshot -> kind=nodeIds`

文档中的字段名统一使用 camelCase。

## 4.8 browser.entity 能力边界

当前实体管理 step 只有 `browser.entity`。它支持以下 op：

- `list`
- `find`
- `get`
- `add`
- `delete`
- `rename`

`list` 与 `find` 返回 diagnostics summary。`get` 返回实体相关 diagnostics。`add`、`delete`、`rename` 修改 manual overlay。`browser.entity` 不执行 query target，`browser.entity` 不替代 `browser.query`。实现位于 [agent/src/runner/steps/executors/entity.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/entity.ts)。

## 4.9 明确不属于 entity-rules 的内容

- checkpoint retry 策略
- runner step ref
- browser action 内部执行
- DSL 编译
- OCR
- 视觉推断
- 跨页面业务流程编排
