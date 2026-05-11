# 测试目录规范

本目录用于承载 `agent` 的跨模块测试资产与场景测试。

## 目标结构

- `agent/src/<module>/__tests__/`
- `agent/tests/fixtures/`
- `agent/tests/helpers/`
- `agent/tests/integration/`
- `agent/tests/e2e/`

## 目录语义

- `src/**/__tests__`：纯单元测试，只验证单模块逻辑，不走真实产品路径。
- `tests/integration`：模块协作测试，允许拼装运行时依赖，但不伪造完整用户业务链路。
- `tests/e2e`：仅放真实产品路径测试，必须有明确业务验收价值。
- `tests/fixtures`：仅放测试资产（HTML fixture、mock 页面、样本数据等）。
- `tests/helpers`：仅放薄工具（启动、清理、装配），不允许伪造产品路径，不允许承载样例型测试 DSL。

## 治理要求

- 禁止新增无验收意义的样例 e2e。
- 禁止为历史样例保留兼容入口、隔离区或 fallback。
- 新增 e2e 前必须先由人类定义真实验收路径，再实现测试。
