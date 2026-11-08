# 回放机制

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
- `play.started` 回复和同次回放的事件携带相同的 `payload.replayId`，值为启动请求 ID。开发模式的 Play 面板按工作区和回放 ID 汇总进度、失败步骤及原因。回放切换标签页时，事件仍发给起始标签页。

### 终态事件

- 执行完毕：`play.completed`；当 `stopOnError=false` 时，`results` 中可能包含失败步骤。
- 失败：`play.failed`
- 取消：`play.canceled`

## 示例

```text
play.start(stopOnError=true)
-> replay steps
-> play.completed
```

## 限制

- replay 对 `createdTabName` 依赖当前 executor data 结构。
- stopOnError=true 时首个失败会提前返回。
