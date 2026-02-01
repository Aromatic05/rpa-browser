# 架构

## 概述

该项目包含两个主要部分：

- `extension/`：MV3 Chrome 扩展，负责 UI、录制、workspace/tab 管理与命令转发。
- `agent/`：Node + Playwright 代理，负责浏览器运行时、统一 step 执行、trace 观测与回放。
- `mock/`：本地静态站点，提供可注入的起始页与工具测试页面。
- `agent/src/demo/*`：本地 Chat Demo（HTTP 服务 + UI + LLM loop）。
- `agent/src/mcp/*`：MCP stdio server（可选模式）。

扩展不会直接执行自动化操作，仅转发 `CMD`；真正的自动化执行与日志/错误处理全部发生在 agent 侧的 `runSteps` 与 trace 层。

## 数据流

1. `content.ts` 生成 `tabToken` 并向 SW 发送 `RPA_HELLO`。
2. Side panel 触发操作 -> `cmd_router` 生成 `{ cmd, args, workspaceId/tabId, requestId }`。
3. `ws_client` 发送到 `agent/src/index.ts`。
4. `runner/execute.ts` 路由命令：`steps.run` -> `runner/run_steps.ts`。
5. `runSteps` 绑定 workspace/page/trace 并执行 step executor。
6. `trace.*` 产生 op.start/op.end 观测日志与 ToolResult。
7. 结果回传扩展并更新 UI。

## 运行时模型

- `agent/src/runtime/context_manager.ts`：启动带扩展的 Chromium persistent context。
- `agent/src/runtime/runtime_registry.ts`：维护 `workspace -> tabs -> Page` 绑定与 trace 绑定。
- `agent/src/runtime/target_resolver.ts`：保留用于 legacy target 解析（现阶段以 trace/a11yNodeId 为主）。

## Runner（统一执行）

- `agent/src/runner/run_steps.ts`：统一 step 执行入口。
- `agent/src/runner/steps/*`：step executor（goto/snapshot/click/fill 等）。
- `agent/src/runner/trace/*`：原子操作与观测层（A11y snapshot + locator 绑定）。
- `agent/src/runner/config/*`：统一配置（timeout/重试/人类模拟/观测）。
- `agent/src/runner/tool_registry.ts`：工具层入口（MCP/Demo 复用）。

## 录制与回放

- `extension/src/record/*`：录制捕获与归一化，输出 `RecordedStep`（包含 a11y hint）。
- `record_store`：本地缓存录制步骤，可用 `record.replay` 触发回放。
- `agent/src/play/replay.ts`：将 RecordedStep 转换为 runSteps 调用。

## 无障碍（A11y）

- `trace.page.snapshotA11y`：基于 Playwright accessibility snapshot。
- `agent/src/runner/actions/a11y.ts`：保留 axe 扫描（用于报告/检测）。

## 本地 Chat Demo

- `agent/src/demo/server.ts`：本地 HTTP 服务（仅监听 `127.0.0.1`）。
- `agent/src/demo/agent_loop.ts`：LLM tool-calling 循环。
- `agent/static/index.html`：纯 HTML UI（Settings / Environment / Chat）。

## MCP（stdio）

- `agent/src/mcp/server.ts`：MCP server。
- `agent/src/mcp/tool_handlers.ts`：调用 tool registry，最终进入 `runSteps`。
