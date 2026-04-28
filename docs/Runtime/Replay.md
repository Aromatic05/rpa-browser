# Replay

## 概述

Replay 执行录制得到的 Step 序列，支持 tab 映射、补建 tab、事件回传与取消。

## 规范

### 入口

- `play.start`：异步启动 replay。
- `play.stop`：设置取消标记。

### replayRecording 行为

- 单步执行走 `runStepList`。
- 维护 `tokenToTab` 与 `refToTab` 映射。
- 缺失目标 tab 时可调用 `browser.create_tab` 补建。
- 发送进度事件：`step.started/step.finished/progress`。

### 终态事件

- 成功：`play.completed`
- 失败：`play.failed`
- 取消：`play.canceled`

## 示例

```text
play.start(stopOnError=true)
-> replay steps
-> play.completed
```

## 限制

- replay 对 `createdTabId` 依赖当前 executor data 结构。
- stopOnError=true 时首个失败会提前返回。
