# Mock 应用

## 概述

mock 应用用于提供稳定、可复现的页面结构，支撑 snapshot、entity_rules、DSL、workflow artifact、record/replay 的开发与回归验证。

## 应用职责

- `mock/ant-app`：偏业务表单、表格与常见组件交互。
- `mock/element-app`：补充另一套组件语义与结构差异。

## 启动地址

- ant：`http://127.0.0.1:5173/`
- element：按项目实际启动端口（以 `pnpm mock:dev` 输出为准）。

## 支撑测试类型

- snapshot pipeline 验证
- entity_rules 规则命中验证
- DSL 语法与执行路径验证
- workflow artifact 目录与运行验证
- 录制/回放一致性验证

## 稳定用例设计原则

1. 页面必须有稳定可识别锚点。
2. 表格与表单要覆盖真实业务复杂度（分页、校验、禁用态、浮层）。
3. 不依赖外网与随机数据。
4. 结构变更必须同步更新用例与文档。

## 表格/表单样例约束

- 表格：至少覆盖列标题、行操作、筛选或分页中的两类要素。
- 表单：至少覆盖输入、选择、校验反馈三类交互。

## 禁止过度简化

mock 不能退化成“只剩单按钮演示页”。若 mock 与真实场景差距过大，会导致 entity_rules 与 DSL 在真实页面失效。

## 与 workflow artifact 的关系

mock 页面应驱动 workflow artifact 的沉淀：

- `records/` 录制步骤
- `entity_rules/` 标注规则
- `checkpoints/` 过程模板
- `dsl/main.dsl` 业务流程

## 与 entity_rules fallback 的关系

优先使用 workflow-scoped `entity_rules`；legacy profiles 仅用于兜底与迁移，不作为新样例主路径。
