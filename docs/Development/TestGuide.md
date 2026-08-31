# TestGuide

## 概述

本文档定义当前仓库的有效测试入口。

## 核心门禁

```bash
pnpm test:repo-contract
pnpm typecheck
pnpm lint
pnpm test
```

## 核心子系统

```bash
pnpm test:agent:snapshot
pnpm test:agent:entity-rules
pnpm test:extension
pnpm test:dev-cdp
pnpm test:agent:headed
```

测试应验证行为和失败边界，不以字符串、配置文件存在性或模拟成功结果替代真实执行。新增回归先证明测试在修复前失败，再实施代码修复。

## Snapshot 和 Entity Rules

- 固定采集回放：`agent/tests/fixtures/observation-v2/`。
- Form/Table corpus：`agent/tests/fixtures/form-v2/`。
- Agent 集成：`agent/tests/integration/snapshot/`、`agent/tests/integration/entity_rules/`。
- 真实浏览器：`agent/tests/e2e/entity_rules/` 及相关 Playwright 页面。

仓库不再依赖独立 mock 站点。

## Workflow artifact

1. 载入 workflow，确认 catalog 和 artifact 可读取。
2. 执行 `dsl.test`，并按需要执行 `dsl.run`。
3. 验证普通 Step、Checkpoint、task.run 和 DSL 使用同一 runtime contract。
4. 验证 artifact 保存、重新载入和错误诊断。

手工验证不能替代自动化测试。
