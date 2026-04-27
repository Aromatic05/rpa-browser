# Entity Rules 架构文档

## 5.1 运行时主流程

```text
generateSemanticSnapshot
  -> detect structure
  -> build entity index
  -> load profile
  -> match rules
  -> validate annotations
  -> apply annotations
  -> ruleEntityOverlay
  -> manual overlay
  -> finalEntityView
  -> bindingIndex
  -> browser.entity / browser.query
```

每一步的产物如下：

- `generateSemanticSnapshot`：生成统一 snapshot，包含 DOM、a11y、runtime state。
- `detect structure`：识别表格、表单、group、region 等结构。
- `build entity index`：生成 `entityIndex`，供规则匹配与 overlay 使用。
- `load profile`：从配置根目录加载 profile，对应 `match.yaml` 与 `annotation.yaml`。
- `match rules`：得到 `ruleId -> ResolvedRuleBinding`。
- `validate annotations`：在加载阶段校验 ruleId 引用、字段重复、pagination 结构。
- `apply annotations`：把业务语义落到 entity 与 node。
- `ruleEntityOverlay`：规则层 overlay。
- `manual overlay`：来自 `browser.entity` 的 rename、add、delete。
- `finalEntityView`：规则与手工 overlay 合成后的最终视图。
- `bindingIndex`：为 field、action、column 提供按业务键访问的索引。
- `browser.entity / browser.query`：统一从 `finalEntityView` 消费结果。

## 5.2 模块职责

当前模块职责如下：

- [agent/src/runner/steps/executors/snapshot/entity_rules/loader.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/loader.ts)：从 `config.rootDir/profiles` 读取 profile，并选择当前页面使用的 bundle。
- [agent/src/runner/steps/executors/snapshot/entity_rules/schema/index.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/schema/index.ts)：导出 match 与 annotation 的 schema。
- [agent/src/runner/steps/executors/snapshot/entity_rules/validate.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/validate.ts)：校验 YAML 结构、rule 引用、字段冲突、pagination 绑定。
- [agent/src/runner/steps/executors/snapshot/entity_rules/matcher.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/matcher.ts)：执行 match rule，输出 `ResolvedRuleBinding`。
- [agent/src/runner/steps/executors/snapshot/entity_rules/apply.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/apply.ts)：把 annotation 应用到 entity overlay，并生成 diagnostics 与 node semantic hints。
- [agent/src/runner/steps/executors/snapshot/entity_rules/overlay.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/overlay.ts)：负责 overlay 的初始化与业务信息合并。
- [agent/src/runner/steps/executors/snapshot/core/table_model.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/table_model.ts)：构建表格结构模型与 primary key 候选。
- [agent/src/runner/steps/executors/snapshot/core/entity_query.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/entity_query.ts)：构建 `bindingIndex`，并解析 table row、row action。
- [agent/src/runner/steps/executors/snapshot/core/business_entity_resolver.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/business_entity_resolver.ts)：提供业务实体 query 与 target resolver。
- [agent/src/runner/steps/executors/snapshot/core/diagnostics.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/diagnostics.ts)：诊断收集、去重、汇总、按实体过滤。
- [agent/src/runner/steps/executors/snapshot/core/pagination.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/pagination.ts)：处理分页 next action 状态与 target 解析。
- [agent/src/runner/steps/executors/entity.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/entity.ts)：实现 `browser.entity`。
- [agent/src/runner/steps/executors/query.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/query.ts)：实现 `browser.query`，包括 `op=entity` 与 `op=entity.target`。

## 5.3 loader 边界

loader 位于 [agent/src/runner/steps/executors/snapshot/entity_rules/loader.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/loader.ts)。

当前边界很明确：

- loader 只读取 `config.rootDir/profiles`
- loader 不读取 `tests` 目录
- 测试 helper 负责复制 profiles 到临时 `rootDir`
- runtime loader 不做测试 profile sync
- profile selection 当前不继续扩展

这意味着测试中的 fixture profile 只是测试输入，不是 runtime loader 的隐式搜索路径。

## 5.4 matcher 与 apply

matcher 位于 [agent/src/runner/steps/executors/snapshot/entity_rules/matcher.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/matcher.ts)。

matcher 的职责：

- 输入 `match.yaml` normal form
- 输出 `ruleId -> ResolvedRuleBinding`
- binding 包含 `matchedNodeIds`
- binding 包含 `matchedEntityRefs`
- binding 记录 `ok`、`failed` 状态

apply 位于 [agent/src/runner/steps/executors/snapshot/entity_rules/apply.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/apply.ts)。

apply 的职责：

- 输入 `annotation.yaml` normal form
- 读取 bindings
- 写 `ruleEntityOverlay.byEntityId`
- 写 `ruleEntityOverlay.nodeHintsByNodeId`
- 写 `ruleEntityOverlay.diagnostics`
- 将 form、table、pagination 标注落到业务信息
- 将 field、action、pagination hint 写到节点 semantic hints

## 5.5 finalEntityView 组合

`finalEntityView` 的组装逻辑位于 [agent/src/runner/steps/executors/snapshot/core/overlay.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/overlay.ts)。

当前组合关系如下：

- `ruleEntityOverlay` 来自 entity-rules
- manual overlay 来自 `browser.entity add/delete/rename`
- `buildFinalEntityViewFromSnapshot` 组合两者
- `finalEntityView.entities` 是最终实体列表
- `finalEntityView.byNodeId` 按 `nodeId` 建索引
- `finalEntityView.bindingIndex` 存 field、action、column 绑定
- `finalEntityView.diagnostics` 存诊断信息

`finalEntityView` 是唯一对外消费入口。`browser.entity` 与 `browser.query` 都不直接绕过它访问底层 rule binding。

## 5.6 query resolver

[agent/src/runner/steps/executors/snapshot/core/business_entity_resolver.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/business_entity_resolver.ts) 提供以下能力：

- `resolveUniqueBusinessEntity`
- `queryBusinessEntity`
- `resolveBusinessEntityTarget`

`queryBusinessEntity` 处理 `op=entity`。`resolveBusinessEntityTarget` 处理 `op=entity.target`。`table.hasNextPage` 与 `table.nextPageTarget` 通过 [pagination.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/pagination.ts) 解析。`table.row_action` 通过 `primaryKey` 与 `actionIntent` 解析。失败时 resolver 会在 error `details` 中带回 diagnostic 信息。

## 5.7 pagination 运行时

[agent/src/runner/steps/executors/snapshot/core/pagination.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/pagination.ts) 当前包括：

- `resolveTablePagination`
- `isPaginationActionDisabled`
- `queryTableHasNextPage`
- `resolveTableNextPageTarget`

disabled 判断当前依据如下：

- `disabled` attr
- `aria-disabled`
- `class` / `className` 包含 `disabled`

当前限制如下：

- 不使用 OCR
- 不做视觉推断
- 不依赖按钮文本判断 disabled
- `runtimeState.disabled` 的显式接入是后续小修补项，当前主要通过 attrs 和 class 判断

## 5.8 diagnostics 运行时

[agent/src/runner/steps/executors/snapshot/core/diagnostics.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/diagnostics.ts) 负责：

- collector
- dedupe
- summary
- entity filter

diagnostics 的来源包括：

- rule matching
- form binding
- table column/header 派生
- pagination binding
- query resolver 失败

展示入口包括：

- `browser.entity list/find` summary
- `browser.entity get` entity diagnostics
- `browser.query` error details

## 5.9 测试覆盖

当前相关测试路径包括：

- [agent/tests/runner/entity_rules/diagnostics.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/entity_rules/diagnostics.test.ts)
- [agent/tests/runner/entity_rules/pagination.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/entity_rules/pagination.test.ts)
- [agent/tests/runner/entity_query_action.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/entity_query_action.integration.test.ts)
- [agent/tests/runner/serialization/serialization_yaml.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/serialization/serialization_yaml.test.ts)

## 5.10 明确不属于 entity-rules 架构的内容

- checkpoint retry / fold
- DSL 编译
- browser action 具体执行
- 跨页面流程调度
- `agent/.artifacts` 运行时产物管理
