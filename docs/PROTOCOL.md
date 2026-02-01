# 协议

## 消息封装（extension -> agent）

Service worker 通过 WS 发送：

```
{ type: "cmd", cmd: { cmd, args, requestId, workspaceId?, tabId?, tabToken? } }
```

字段说明：

- `cmd`：命令名（字符串），例如 `workspace.list` / `tab.create` / `steps.run`
- `args`：命令参数
- `requestId`：请求追踪（可选）
- `workspaceId/tabId`：外部可见 scope（优先使用）
- `tabToken`：内部绑定 token（内容脚本生成；不暴露给 AI）

## 结果（agent -> extension）

WS 返回：

```
{ type: "result", requestId, payload }
```

其中 `payload` 为 Runner 标准结果：

```
{ ok: true, tabToken, requestId?, data }
{ ok: false, tabToken, requestId?, error: { code, message, details? } }
```

## 广播事件（agent -> extension）

agent 在 workspace/tab 发生变更时主动广播：

```
{ type: "event", event: "workspace.changed", data: { workspaceId, tabId, cmd } }
```

扩展收到后刷新 workspace/tab 列表。

## 关键命令

- `workspace.list` / `workspace.create` / `workspace.setActive`
- `tab.list` / `tab.create` / `tab.setActive` / `tab.close`
- `steps.run`：统一 step 执行入口（推荐）
- `record.start` / `record.stop` / `record.get` / `record.clear` / `record.replay`
  - 录制数据由扩展生成 `RecordedStep`，回放通过 `steps.run` 执行

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
