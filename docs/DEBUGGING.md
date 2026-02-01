# 调试

## 常见日志

- 扩展 content：`[rpa-ext][content] ...`
- 扩展 SW：`[rpa-ext][sw] ws open/send/message/close`
- 扩展 UI：`[rpa-ext][panel] ...`
- Agent：`[RPA:agent] cmd/execute`
- Trace：`[trace] op=... ok=...`（默认开启）
- Step：`step.start / step.end`（runSteps 输出）

## 典型问题

### 1) `missing cmd`

原因：消息包不匹配或扩展构建已过时。
修复：

- `pnpm -C extension build`
- 重新加载扩展并刷新页面

### 2) `Extension context invalidated`

原因：扩展已重新加载但页面未刷新。
修复：刷新页面。

### 3) 回放找不到元素（ERR_NOT_FOUND）

原因：可访问性信息缺失或 role/name 不稳定。
修复：

- 优先使用语义稳定的 `role/name` 目标
- 确保页面已渲染完成，再触发录制/回放

### 4) mock 起始页无法打开

原因：mock server 未启动或端口不一致。
修复：

- `pnpm mock:dev`
- 检查 `DEFAULT_MOCK_ORIGIN` 是否与本地端口一致

## 工件

- 回放证据：`.artifacts/replay/<tabToken>/<ts>.png`
- A11y 证据：`.artifacts/a11y/<ts>.png`（如启用）

## MCP 调试

- MCP server 日志输出在 stderr。
- 使用 `pnpm -C agent mcp:smoke` 进行最小闭环验证。
