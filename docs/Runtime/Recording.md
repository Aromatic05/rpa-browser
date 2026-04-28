# 录制机制

## 概述

Recording 负责步骤采集、事件归一化、录制清理与持久化关联。

## 规范

### 动作

- `record.start`：开启录制并安装 recorder。
- `record.stop`：停止录制。
- `record.get`：返回 steps/manifest/enrichments。
- `record.clear`：清空当前录制。
- `record.list`：列出 workspace 录制。
- `record.event`：接收 step 或 raw recorder event。

### 数据结构

- steps：`StepUnion[]`
- manifest：入口 tab、tabs 时间轴与 URL
- enrichments：resolveHint/resolvePolicy 等增强

### 录制上下文

`record.event` 会补写 meta：

- `source=record`
- `workspaceId/tabId/tabToken/tabRef`
- `urlAtRecord`

## 示例

```text
record.start -> user actions -> record.event* -> record.stop -> record.get
```

## 限制

- raw event 与 step event 兼容共存，调试时需区分 mode。
