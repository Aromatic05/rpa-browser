# 协议

## Action 协议（extension -> agent）

Service worker 通过 WS 发送 Action：

```
{
  v: 1,
  id: string,
  type: "workspace.list" | "tab.create" | "record.event" | "play.start" | ...,
  scope?: { workspaceId?: string; tabId?: string; tabToken?: string },
  tabToken?: string,
  payload?: object,
  at?: number,
  traceId?: string
}
```

字段说明：

- `v`：协议版本（当前固定为 1）
- `id`：请求唯一标识（必填）
- `type`：动作类型（例如 `workspace.list` / `tab.create` / `record.event` / `play.start`）
- `scope`：路由范围（workspace/tab），优先使用
- `tabToken`：内容脚本生成的页面 token（可选）
- `payload`：动作参数
- `replyTo`：仅用于响应

## 响应（agent -> extension）

成功响应：

```
{ type: "<action>.result", replyTo: "<id>", payload: { ok: true, data: ... } }
```

失败响应：

```
{ type: "error", replyTo: "<id>", payload: { ok: false, error: { code, message, details? } } }
```

## 广播事件（agent -> extension）

agent 在 workspace/tab 发生变更时主动广播：

```
{ type: "event", event: "workspace.changed", data: { workspaceId, tabId, type } }
```

扩展收到后刷新 workspace/tab 列表。

## 关键 Action 类型

- Workspace：`workspace.list` / `workspace.create` / `workspace.setActive`
- Tab：`tab.list` / `tab.create` / `tab.setActive` / `tab.close`
- Record：`record.start` / `record.stop` / `record.get` / `record.clear` / `record.event`
- Play：`play.start` / `play.stop`

说明：
- 不再支持旧 Command 协议（`cmd/requestId/args`）。
- `record.replay` → `play.start`，`record.stopReplay` → `play.stop`。
- `steps.run` 不再提供。

## Step 结构（简化）

```
{
  id: string,
  name: "browser.goto" | "browser.snapshot" | "browser.click" | "browser.fill",
  args: {
    // click/fill 优先 a11yNodeId，无法获取时使用 a11yHint
    a11yNodeId?: string,
    a11yHint?: { role?: string; name?: string; text?: string },
    url?: string,
    value?: string
  },
  meta?: { requestId?: string; source: "mcp"|"play"|"script"|"record"; ts?: number }
}
```

## 无障碍与定位

- 元素类 step 优先使用 `a11yNodeId`。
- 当无法获取节点 ID 时，使用 `a11yHint`（role/name/text），由 agent 在 snapshot 后解析。
