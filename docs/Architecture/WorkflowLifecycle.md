# Workflow 生命周期

## 概述

本文件描述 workflow 从加载到正式运行的结构化生命周期。

## 规范

### 生命周期顺序

1. `workflow.list`
2. `workflow.open`
3. `dsl.get` / `dsl.save`
4. `dsl.test`
5. `dsl.run`
6. 按需通过独立录制流程执行 `record.start` / `record.stop` / `record.save`

### 关键规则

- `workflow.open` 负责载入 workflow、建立或激活同名 workspace 并确保 browser session 可用，不执行 DSL。
- `dsl.test` 只做 DSL / Checkpoint graph 校验，不执行正式流程。
- `dsl.run` 执行当前 workflow 的 entry DSL。

### 绑定规则

- workflow workspaceName 与 workflow name 相同。
- action 必须显式使用 `workflow.open` 返回的 `workspaceName`，不能依赖 active workspace 猜测。

## 示例

```text
workflow.open({ workflowName: "order_scene" })
-> workspaceName="order_scene"
-> dsl.test(workspaceName="order_scene")
-> dsl.run(workspaceName="order_scene")
```

## 限制

- expectedTabs 目前只校验活动页 URL。
