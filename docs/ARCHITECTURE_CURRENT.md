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
2) UI 按钮触发 `CMD` 消息，经 `extension/src/sw.ts` 获取 active tabToken（兼容旧协议）与可选 scope。
3) `sw.ts` 通过 WebSocket 向 `agent/src/index.ts` 发送 `{ cmd, tabToken?, scope?, args, requestId }`。
4) `agent/src/index.ts` 按 `scope(workspaceId/tabId)` 解析 Page（缺省为 active workspace/tab）。
5) `runner/execute.ts` 解析命令、解析 target、映射错误、调用 `actions/*`。
6) 动作返回 `Result`，经 WS 回传给 extension。

旁路（Demo）：
- `agent/static/index.html` -> `agent/src/demo/server.ts` -> `agent/src/demo/agent_loop.ts`
- -> `runner/tool_registry.ts` -> `runner/execute.ts` -> `runner/actions/*` -> Result -> UI

旁路（MCP）：
- stdio -> `agent/src/mcp/server.ts` -> `agent/src/mcp/tool_handlers.ts`
- -> `runner/tool_registry.ts` -> `runner/execute.ts` -> `runner/actions/*` -> Result

## Key Modules

- `extension/src/content.ts`：注入 UI、生成并维护 tabToken、转发 panel 命令。
- `extension/src/sw.ts`：维持 tabId->tabToken 映射，WS 转发与超时处理。
- `agent/src/runtime/context_manager.ts`：启动带扩展的 Chromium persistent context。
- `agent/src/runtime/page_registry.ts`：workspace -> tabs -> Page 绑定与重建（tabToken 作为内部绑定）。
- `agent/src/runtime/target_resolver.ts`：Target -> Locator 解析。
- `agent/src/runner/execute.ts`：命令路由、错误映射、日志与高亮。
- `agent/src/runner/actions/*`：真实动作实现（点击、滚动、对话框、A11y等）。
- `agent/src/runner/tool_registry.ts`：工具定义与执行（复用给 MCP 与 Demo）。
- `agent/src/record/*`：录制注入与事件保存。
- `agent/src/play/replay.ts`：回放录制事件并执行。
- `agent/src/demo/*`：本地 Chat Demo（HTTP + LLM loop）。
- `agent/src/mcp/*`：MCP stdio server 入口。

## Identifiers & Scoping

- `tabToken`：页面绑定用内部标识；由 `extension/src/content.ts` 写入 `sessionStorage` 生成（以实现为准），agent 侧用于 `page_registry` 绑定；不暴露给 AI。
- `requestId`：请求追踪标识；由 `extension/src/sw.ts` 为每次命令生成并透传。
- `sessionId/workspaceId`：对外可见的会话/工作区标识；当前由 `page_registry` 在内存中维护（未持久化）。
- `tabId/groupId`：Session 内部 tab/group 概念；`tabId` 已在运行时模型中使用，`groupId` 预留给未来 TabGroup。

## Current Runtime Model

- **绑定模型**：`workspace -> tabs -> Page` 作为运行时主模型（证据见 `agent/src/runtime/page_registry.ts`），`tabToken` 仅作为内部绑定。
- **通信**：extension 使用 WS 与 agent 通信；demo 使用 HTTP；MCP 使用 stdio。
- **错误处理**：`runner/execute.ts` 将异常映射到 `Result`（含 `error.code`）。
- **日志**：extension 与 agent 使用 `console.log` 输出；未统一结构化日志。
- **工件**：回放与 A11y 证据写入 `.artifacts/...`。
- **演进方向**：当前为 `workspace -> tabs -> Page`，后续补齐持久化与 TabGroup 视觉映射（以实现为准）。
