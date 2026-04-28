# TypicalFlow

## 概述

本文件描述“录制 -> 规则 -> DSL -> 运行 -> 验证”的典型闭环。

## 规范

### 流程

1. `workflow.open` 建立场景上下文。
2. `record.start/stop` 采集步骤。
3. `workflow.record.save` 落盘到 `records/`。
4. 编写 `entity_rules`（match/annotation）。
5. 编写或更新 `dsl/main.dsl`。
6. `workflow.dsl.test` 做开发验证。
7. `workflow.releaseRun` 做正式运行。
8. 结合 `browser.snapshot/entity/query` 做回归排查。

### 测试侧

- agent 单测与集成测试验证 runner/DSL/workflow。
- extension 测试验证 token/action 路由。

## 示例

```text
open -> record -> save -> edit dsl -> dsl.test -> releaseRun
```

## 限制

- record.save 当前默认不写 step_resolve sidecar。
