# WorkspaceAndTab

## 概述

本文件定义 workspace/tab/token 的运行时关系与生命周期。

## 规范

### 核心关系

- workspace 包含多个 tab。
- tab 绑定一个 `tabToken`。
- token 可映射到 `workspaceId/tabId`。

### 主要动作

- workspace: `list/create/setActive/save/restore`
- tab: `init/list/create/close/setActive/opened/report/activated/closed/ping/reassign`

### token 生命周期

- `tab.init` 生成 token。
- `tab.opened` 绑定 token 与 workspace。
- `tab.ping` 更新存活时间。
- watchdog 超时关闭 stale token 页面。

### workspace 快照

- `workspace.save` 保存 tabs + recording bundle。
- `workspace.restore` 基于 snapshot 创建新 workspace 并恢复 tabs/steps。

## 示例

```text
tab.init -> tab.opened -> tab.report -> tab.ping -> tab.closed
```

## 限制

- `workspace.restore` 生成的是新 workspace，不覆盖原 workspace。
