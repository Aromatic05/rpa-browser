# Current Architecture Snapshot

## Overview

本仓库是一个 monorepo，核心由 `extension/` 与 `agent/` 两部分组成。扩展负责 UI、录制、workspace/tab 管理与命令转发；agent 负责浏览器运行时、统一的 step 执行、trace 观测与录制回放。除此之外还有本地 Chat Demo 与 MCP stdio server，用于在不依赖扩展的情况下驱动 agent。开发期使用 `mock/` 本地站点作为可注入的起始页（避免扩展页无法注入 content script）。

## Current Tree Snapshot

```
.
├── extension/
│   └── src/
│       ├── entry/            # content/sw/panel 入口
│       ├── background/       # ws_client + cmd_router + scope_resolver
│       ├── record/           # 录制捕获与 step 生成
│       ├── services/         # name_store / tab_grouping / mock_config
│       ├── state/            # workspace/tabs 状态模型
│       ├── ui/               # side panel UI
│       └── shared/           # types/constants/logger
├── agent/
│   ├── src/
│   │   ├── index.ts
│   │   ├── runtime/
│   │   │   ├── context_manager.ts
│   │   │   ├── runtime_registry.ts
│   │   │   └── target_resolver.ts
│   │   ├── runner/
│   │   │   ├── run_steps.ts
│   │   │   ├── steps/
│   │   │   ├── trace/
│   │   │   ├── config/
│   │   │   ├── commands.ts
│   │   │   ├── results.ts
│   │   │   ├── error_codes.ts
│   │   │   ├── tool_registry.ts
│   │   │   └── actions/      # 仅保留少量 legacy/桥接动作
│   │   ├── record/
│   │   ├── play/
│   │   ├── demo/
│   │   └── mcp/
│   └── static/
│       └── index.html
├── mock/
│   ├── server.js
│   └── pages/start.html
└── docs/
    ├── ARCHITECTURE.md
    ├── ARCHITECTURE_CURRENT.md
    ├── DEVELOPMENT.md
    ├── DEBUGGING.md
    └── ...
```

## Data Flow

1) `extension/src/entry/content.ts` 生成 `tabToken`，向 SW 发送 `RPA_HELLO`。
2) Side panel UI 触发 `CMD`，经 `cmd_router` 补全 scope（workspaceId/tabId）并通过 `ws_client` 发送到 agent。
3) `agent/src/index.ts` 接收 WS，进入 `runner/execute.ts`，其中 `steps.run` 会转交给 `runner/run_steps.ts`。
4) `runSteps` 解析 workspace 绑定，调用 `runtime_registry` 获取 page + trace tools。
5) 具体 step executor 调用 `trace.*` 原子操作，产生 op.start/op.end，并返回 `StepResult`。
6) 结果经 WS 回传，extension 更新 UI 与日志。
7) Side panel 新建 tab 后会导航到本地 mock start page：`http://localhost:<PORT>/pages/start.html#beta`。

旁路（Demo）：
- `agent/static/index.html` -> `agent/src/demo/server.ts` -> `agent/src/demo/agent_loop.ts`
- -> `runner/tool_registry.ts` -> `runner/run_steps.ts` -> `runner/trace/*` -> Result -> UI

旁路（MCP）：
- stdio -> `agent/src/mcp/server.ts` -> `agent/src/mcp/tool_handlers.ts`
- -> `runner/tool_registry.ts` -> `runner/run_steps.ts` -> `runner/trace/*` -> Result

录制链路：
- `extension/src/record/*` 捕获事件并归一化为 `RecordedStep`（含 a11y hint）
- `record_store` 缓存后通过 `record.replay` 触发 `steps.run`
- agent 侧 `runSteps` 执行并使用 trace 产生观测日志

## Key Modules

- `extension/src/entry/content.ts`：注入悬浮 UI、生成并维护 tabToken、转发 panel 命令。
- `extension/src/ui/panel/PanelApp.ts`：Workspace Explorer（workspace/tab 列表与操作）。
- `extension/src/background/ws_client.ts`：WS 连接与发送。
- `extension/src/background/cmd_router.ts`：命令封装、scope 补全与录制命令桥接。
- `extension/src/record/*`：录制捕获与 step 生成（role/name hint 优先）。
- `extension/src/services/name_store.ts`：workspace/tab displayName 与 tabGroup 元数据。
- `extension/src/services/tab_grouping.ts`：tabGroups 分组封装与降级处理。
- `mock/pages/start.html`：工具测试样例页面（start page / sandbox）。
- `agent/src/runtime/context_manager.ts`：启动带扩展的 Chromium persistent context。
- `agent/src/runtime/runtime_registry.ts`：workspace -> tabs -> Page 绑定与 trace 绑定。
- `agent/src/runner/run_steps.ts`：统一 step 执行入口。
- `agent/src/runner/trace/*`：原子执行与观测日志（op.start/op.end）。
- `agent/src/runner/config/*`：统一配置加载（timeout/重试/人类模拟/观测）。
- `agent/src/runner/tool_registry.ts`：工具定义与执行（复用给 MCP 与 Demo）。
- `agent/src/record/*`：录制注入与事件保存（legacy/对照）。
- `agent/src/play/replay.ts`：回放 RecordedStep 并通过 runSteps 执行。
- `agent/src/demo/*`：本地 Chat Demo（HTTP + LLM loop）。
- `agent/src/mcp/*`：MCP stdio server 入口。

## Identifiers & Scoping

- `tabToken`：页面绑定用内部标识；由 `content.ts` 生成并透传；不暴露给 AI。
- `requestId`：请求追踪标识；由扩展生成并透传。
- `workspaceId/tabId`：对外可见的 scope 标识；用于 UI/协议层。
- `a11yNodeId`：A11y 快照中的节点 ID；trace/step 层执行元素操作的首选键。
- `a11yHint`：{ role/name/text } 提示；当无法直接拿到 nodeId 时用于二次解析。

## Current Runtime Model

- **绑定模型**：`workspace -> tabs -> Page` 作为运行时主模型（`runtime_registry.ts`），tabToken 仅用于内部绑定。
- **统一执行**：所有入口（MCP/Play/Script）通过 `runSteps` 调用 trace 原子操作。
- **错误处理**：step 级返回结构化 `StepResult`；trace 级记录 op.start/op.end。
- **日志**：trace 默认输出 `[trace]` 日志，step 层输出 step.start/step.end。
- **工件**：录制/回放与 A11y 证据写入 `.artifacts/...`（以实现为准）。
- **起始页机制**：新建可自动化 tab 默认导航至本地 mock start page（避免扩展页不可注入导致悬浮球失效）。
- **本地依赖**：需先运行 `pnpm mock:dev` 启动 mock 静态站点（默认 `http://localhost:4173`）。
- **显示名与分组**：workspace/tab 展示为 “Workspace N / Tab N”，tabGroups 分组失败则降级。
- **演进方向**：当前为 workspace/tabs/page + runSteps/trace；后续补齐持久化与更高层策略（以实现为准）。
