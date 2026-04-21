# 调试

## 常见日志

- 扩展 content: `[rpa-ext][content] ...`
- 扩展 SW: `[rpa-ext][sw] ws open/send/message/close`
- 扩展 UI: `[rpa-ext][panel] ...`
- Agent: `[RPA:agent] ...`
- MCP: `[RPA:mcp] ...`（输出到 stderr）
- Step: `[step] start/end ...`

## 常见问题

### 1) 扩展命令无响应

检查：

- `pnpm dev` 是否在运行
- extension 是否已重新加载
- 页面是否刷新（避免 `Extension context invalidated`）

### 2) 元素找不到（`ERR_NOT_FOUND` / `ERR_AMBIGUOUS`）

排查：

- 先执行 `browser.snapshot` 查看 a11y 树
- 优先用稳定的 `a11yNodeId`
- 无法稳定定位时补充 `a11yHint`（role/name/text）

### 3) mock 页面无法访问

```bash
pnpm mock:dev
```

并确认路由可访问：`/entity-rules`、`/entity-rules/fixtures/*`。

## 工件

- 回放证据：`agent/.artifacts/replay/...`
- A11y/trace 相关输出：`agent/.artifacts/...`

## MCP 快速闭环

```bash
pnpm test:agent:smoke:mcp
```
