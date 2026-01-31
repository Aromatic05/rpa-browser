# 调试

## 常见日志

- 扩展内容脚本：`[RPA] HELLO`, `[RPA] send command`, `[RPA] response`
- Service worker：`[RPA:sw] ws open/send/message/close`, `onMessage`
- Agent：`[RPA:agent] cmd`, `[RPA:agent] execute`

## 典型问题

### 1) `missing cmd`

原因：消息包不匹配或扩展构建已过时。
修复：

- `pnpm -C extension build`
- 重新加载扩展并刷新页面

### 2) `Extension context invalidated`

原因：扩展已重新加载但页面未刷新。
修复：刷新页面。

### 3) 回放超时

原因：选择器脆弱、隐藏菜单或动态类。
修复：

- 录制语义定位器（role/label/text）
- 确保存在打开菜单的步骤

### 4) 停止录制看起来无效

原因：录制器仍在发出事件，但在禁用录制时这些事件被忽略。
仅检查 `record { ... }` 日志，而非原始事件日志。

## 工件

- 回放证据：`.artifacts/replay/<tabToken>/<ts>.png`
- 无障碍证据：`.artifacts/a11y/<ts>.png`

## 本地 Chat Demo 调试

- **LLM 连接检查**：Settings 区点击 `Debug LLM`，后端调用 `/api/llm/debug`，返回最小响应与延迟。
- **工具调用是否触发**：在 Chat 区域查看 `Tool events` 折叠区。
- **查看 LLM 原始回复**：`LLM replies` 折叠区展示所有 assistant 消息（含 tool calls）。
- **apiBase 生效检查**：调用 `GET /api/config`，确认保存的 `apiBase` 值。

## MCP 调试

- MCP server 日志输出在 stderr。
- 使用 `pnpm -C agent mcp:smoke` 进行最小闭环验证。
