# Workflow 生命周期

## 概述

本文件描述 workflow 从加载到正式运行的结构化生命周期。

## 规范

### 生命周期顺序

1. `workflow.list`
2. `workflow.open`
3. `workflow.status`
4. `workflow.dsl.get/save`
5. `workflow.dsl.test`
6. `workflow.record.save`
7. `workflow.releaseRun`

### 关键规则

- `workflow.open` 只做 manifest + workspace 绑定，不执行 DSL。
- `workflow.releaseRun` 才执行正式流程。
- `workflow.dsl.test` 属于开发态运行。

### 绑定规则

- workflow workspace 固定为 `workflow:<scene>`。
- 策略来自 `workspace.yaml`（通过 `workflow.workspace.binding` 引用）。

## 示例

```text
workflow.open(order_scene)
-> workspaceName=workflow:order_scene
-> tabName=...
-> workflow.releaseRun(order_scene)
```

## 限制

- expectedTabs 目前只校验活动页 URL。
