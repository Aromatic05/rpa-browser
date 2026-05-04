# Checkpoint v1 状态说明

## 4.1 已完成能力

- StepName 已收敛。
- 实体管理统一到 `browser.entity`。
- 实体查询统一到 `browser.query`。
- `browser.query` 返回 `value / nodeId / nodeIds` envelope。
- runner result ref 支持 `{{stepId.data.nodeId}}`。
- runner result ref 使用 run-local result map。
- runner result ref 不依赖 `ensureActivePage`。
- checkpoint 支持 `trigger.matchRules`。
- checkpoint 支持 `input/local/output` scope。
- checkpoint 支持 `query / compute / act / wait`。
- checkpoint 支持 scoped ref。
- checkpoint 支持 `retryOriginal` 默认重试。
- checkpoint 支持 `retryOriginal: false`。
- checkpoint 支持 `policy.maxAttempts`。
- Step / Checkpoint YAML hint 外置。
- entity-rules 支持 `finalEntityView / bindingIndex`。
- entity-rules 支持 diagnostics。
- entity-rules 支持 `table.hasNextPage`。
- entity-rules 支持 `table.nextPageTarget`。
- order-form `query -> fill/click` 集成测试已覆盖。
- order-list `rowCount/currentRows/row_action -> click` 集成测试已覆盖。
- order-list pagination `query -> clickNext` 集成测试已覆盖。

## 4.2 明确不包含能力

- DSL
- checkpoint loop action
- full diagnostics UI
- cross-run ref
- complex pipeline
- complex expression language
- browser action entity target
- OCR
- visual disabled inference
- runtimeState.disabled direct pagination check

当前 pagination disabled 判断主要基于 attrs / aria-disabled / class。`runtimeState.disabled` direct pagination check 是后续小修补项。

## 4.3 核心文件路径

- [agent/src/runner/run_steps.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/run_steps.ts)：执行普通 step，维护 run-local result map，失败后进入 checkpoint。
- [agent/src/runner/step_refs.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/step_refs.ts)：解析 runner result ref。
- [agent/src/runner/checkpoint/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/types.ts)：定义 checkpoint 数据结构、作用域、动作模型。
- [agent/src/runner/checkpoint/match.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/match.ts)：处理进入判断、规则匹配、候选选择。
- [agent/src/runner/checkpoint/runtime.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/runtime.ts)：执行 `CheckpointAction`，解析 scoped ref。
- [agent/src/runner/checkpoint/fold.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/fold.ts)：处理 retry 与最终结果折叠。
- [agent/src/runner/serialization/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/serialization/types.ts)：校验 Step / Checkpoint core YAML 与 hints sidecar 边界。
- [agent/src/runner/steps/executors/entity.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/entity.ts)：实现 `browser.entity`。
- [agent/src/runner/steps/executors/query.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/query.ts)：实现 `browser.query`。
- [agent/src/runner/steps/executors/snapshot/core/business_entity_resolver.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/business_entity_resolver.ts)：解析实体 query 与 target。
- [agent/src/runner/steps/executors/snapshot/core/diagnostics.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/diagnostics.ts)：诊断收集、去重、汇总、过滤。
- [agent/src/runner/steps/executors/snapshot/core/pagination.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/pagination.ts)：分页状态与下一页目标解析。
- [agent/src/runner/steps/executors/snapshot/entity_rules/apply.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/apply.ts)：应用 annotation，生成 overlay、节点 hint、diagnostics。
- [agent/src/runner/steps/executors/snapshot/entity_rules/validate.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/entity_rules/validate.ts)：校验规则与 annotation 引用关系。

## 4.4 测试覆盖

- [agent/tests/runner/serialization/serialization_yaml.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/serialization/serialization_yaml.test.ts)
- [agent/tests/runner/entity_query_action.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/entity_query_action.integration.test.ts)
- [agent/tests/runner/entity_rules/diagnostics.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/entity_rules/diagnostics.test.ts)
- [agent/tests/runner/entity_rules/pagination.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/entity_rules/pagination.test.ts)
- [agent/tests/runner/checkpoint/checkpoint.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint.test.ts)
- [agent/tests/runner/checkpoint/checkpoint_runtime.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint_runtime.test.ts)
- [agent/tests/runner/checkpoint/checkpoint_flow.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint_flow.integration.test.ts)
- [agent/tests/runner/checkpoint/checkpoint_procedure.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint_procedure.integration.test.ts)

## 4.5 合并前检查清单

- `pnpm -C agent test` 通过。
- 仓库中没有 `agent/.artifacts` 下的 `checkpoints/examples` 目录。
- core checkpoint fixture 不含 runner string ref。
- checkpoint fixture 使用 `ref: local.xxx`。
- Step core YAML 不含 `hint` 字段。
- Checkpoint core YAML 不含 `hint` 字段。
- `click/fill/select_option` 不支持 entity target。
- `browser.query` 返回 envelope 未改变。
- `table.hasNextPage` 使用 camelCase。
- `table.nextPageTarget` 使用 camelCase。
