# Current Architecture Snapshot

## Overview

本仓库是一个 monorepo，核心由 `extension/` 与 `agent/` 两部分组成。扩展负责 UI、tabToken 与命令转发；agent 负责浏览器运行时、录制回放与动作执行。除此之外新增了本地 Chat Demo 与 MCP stdio server，用于在不依赖扩展的情况下直接驱动 agent。

## Current Tree Snapshot

```
.
├── extension/
│   └── src/
│       ├── content.ts
│       ├── sw.ts
│       └── panel.ts
├── agent/
│   ├── src/
│   │   ├── index.ts
│   │   ├── runtime/
│   │   │   ├── context_manager.ts
│   │   │   ├── page_registry.ts
│   │   │   └── target_resolver.ts
│   │   ├── runner/
│   │   │   ├── execute.ts
│   │   │   ├── commands.ts
│   │   │   ├── results.ts
│   │   │   ├── error_codes.ts
│   │   │   ├── tool_registry.ts
│   │   │   └── actions/
│   │   │       ├── click.ts
│   │   │       ├── element_click.ts
│   │   │       ├── scroll.ts
│   │   │       ├── element_scroll.ts
│   │   │       ├── type.ts
│   │   │       ├── keyboard_mouse.ts
│   │   │       ├── waits_asserts.ts
│   │   │       ├── dialogs_popups.ts
│   │   │       ├── a11y.ts
│   │   │       └── ...
│   │   ├── record/
│   │   │   ├── recorder_payload.ts
│   │   │   ├── recorder.ts
│   │   │   └── recording.ts
│   │   ├── play/
│   │   │   └── replay.ts
│   │   ├── demo/
│   │   │   ├── server.ts
│   │   │   ├── agent_loop.ts
│   │   │   ├── openai_compat_client.ts
│   │   │   ├── workspace_manager.ts
│   │   │   └── config_store.ts
│   │   └── mcp/
│   │       ├── server.ts
│   │       ├── tool_handlers.ts
│   │       ├── schemas.ts
│   │       └── index.ts
│   └── static/
│       └── index.html
└── docs/
    ├── ARCHITECTURE.md
    ├── ARCHITECTURE_CURRENT.md
    ├── DEVELOPMENT.md
    ├── DEBUGGING.md
    └── ...
```

## Data Flow

1) `extension/src/content.ts` 生成 `tabToken`，向 SW 发送 `RPA_HELLO`。
2) UI 按钮触发 `CMD` 消息，经 `extension/src/sw.ts` 获取 active tabToken。
3) `sw.ts` 通过 WebSocket 向 `agent/src/index.ts` 发送 `{ cmd, tabToken, args, requestId }`。
4) `agent/src/index.ts` 调用 `page_registry.getPage(tabToken)` 绑定/获取 Page。
5) `runner/execute.ts` 解析命令、解析 target、映射错误、调用 `actions/*`。
6) 动作返回 `Result`，经 WS 回传给 extension。

## Key Modules

- `extension/src/content.ts`：注入 UI、生成并维护 tabToken、转发 panel 命令。
- `extension/src/sw.ts`：维持 tabId->tabToken 映射，WS 转发与超时处理。
- `agent/src/runtime/context_manager.ts`：启动带扩展的 Chromium persistent context。
- `agent/src/runtime/page_registry.ts`：tabToken -> Page 绑定与重建。
- `agent/src/runtime/target_resolver.ts`：Target -> Locator 解析。
- `agent/src/runner/execute.ts`：命令路由、错误映射、日志与高亮。
- `agent/src/runner/actions/*`：真实动作实现（点击、滚动、对话框、A11y等）。
- `agent/src/runner/tool_registry.ts`：工具定义与执行（复用给 MCP 与 Demo）。
- `agent/src/record/*`：录制注入与事件保存。
- `agent/src/play/replay.ts`：回放录制事件并执行。
- `agent/src/demo/*`：本地 Chat Demo（HTTP + LLM loop）。
- `agent/src/mcp/*`：MCP stdio server 入口。

## Current Runtime Model

- **绑定模型**：`tabToken` 存储于页面 `sessionStorage`，由 content script 初始化并在 agent 端建立 `tabToken -> Page` 映射。
- **通信**：extension 使用 WS 与 agent 通信；demo 使用 HTTP；MCP 使用 stdio。
- **错误处理**：`runner/execute.ts` 将异常映射到 `Result`（含 `error.code`）。
- **日志**：extension 与 agent 使用 `console.log` 输出；未统一结构化日志。
- **工件**：回放与 A11y 证据写入 `.artifacts/...`。
