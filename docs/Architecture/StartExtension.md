# StartExtension

## 概述

start_extension 是新标签页扩展入口，用于快速绑定 token 并操作 workflow。

## 规范

### 功能范围

- 通过 `RPA_ENSURE_BOUND_TOKEN` 获取绑定 token/workspace。
- 通过 WS 直接发送 `workflow.list/open/releaseRun/dsl.test/record.save`。
- 提供 workflow 列表和快捷按钮。

### 关键约束

- 若返回 `pending=true`，需要轮询重试绑定。
- action 回复优先按 `<action>.result/.failed` 解析。

## 示例

- 页面初始化后：`ensureBoundToken -> workflow.list -> 渲染场景列表`。

## 限制

- 当前 start_extension 未直接提供 DSL 编辑器，仅触发动作。
