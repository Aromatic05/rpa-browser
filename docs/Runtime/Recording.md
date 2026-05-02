# 录制机制

## 概述

Recording 负责步骤采集、事件归一化、录制清理与持久化关联。

## 规范

### 动作

- `record.start`：按 `workspaceName` 开启 workspace 级录制并安装 recorder。
- `record.stop`：停止录制。
- `record.get`：返回 steps/manifest/enrichments。
- `record.clear`：清空当前录制。
- `record.list`：列出 workspace 录制。
- `record.event`：接收 step 或 raw recorder event。

`record.start` 约束：

- 必须提供顶层 `workspaceName`。
- 不要求 `payload.tabName`。
- 录制对象是 workspace 下所有已绑定真实 Page。
- workspace 下无已绑定 Page 时返回明确业务失败。

### 数据结构

- steps：`StepUnion[]`
- manifest：`workspaceName`、入口 tab、tabs 时间轴与 URL
- enrichments：resolveHint/resolvePolicy 等增强

### 录制上下文

`record.event` 会补写 meta：

- `source=record`
- `workspaceName/tabName/tabName/tabRef`
- `urlAtRecord`

`tabName` 语义：

- `workspaceName` 是唯一录制地址。
- `tabName` 仅作为事件来源与 manifest 中的 tab 标识。
- Page 绑定依赖统一 bridge key：`__rpa_tab_name`。
- 不允许恢复旧 token 路由。

Page 绑定行为：

- workspace 下所有 bound Page 参与同一个 workspace recording。
- `record.start` 之后新绑定 Page 自动加入当前 workspace recording。

## 示例

```text
record.start -> user actions -> record.event* -> record.stop -> record.get
```

## 限制

- raw event 与 step event 兼容共存，调试时需区分 mode。
