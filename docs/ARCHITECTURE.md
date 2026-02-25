# 架构

## 概览

仓库由两层核心组成：

- `extension/`：浏览器侧 UI 与命令发送（WS）。
- `agent/`：后端执行层（WS server / MCP stdio / MCP 面板），统一走 `runSteps` + `trace`。

另外：

- `mock/`：本地页面夹具。
- `agent/src/demo/*`：本地 MCP 面板服务。
- `agent/src/mcp/*`：MCP stdio 服务。

## 三个交互入口

1. Extension 入口：`agent/src/index.ts`
2. MCP stdio 入口：`agent/src/mcp_main.ts`
3. MCP 面板入口：`agent/src/demo/server.ts`

这三个入口最终共享 runner/runtime/trace。

## 执行主链路

- Step 统一入口：`agent/src/runner/run_steps.ts`
- Step 执行器：`agent/src/runner/steps/executors/*`
- Trace 原子层：`agent/src/runner/trace/*`
- 运行时绑定：`agent/src/runtime/*`

## WS（extension -> agent）

- 扩展发 Action 包到 `ws://127.0.0.1:17333`
- `agent/src/index.ts` 校验 action 后调用 `agent/src/actions/execute.ts`
- 部分动作会进一步调用 `runSteps`

## MCP（stdio）

- `agent/src/mcp_main.ts` 启动 MCP server
- `agent/src/mcp/server.ts` 处理 `tools/list`、`tools/call`
- `agent/src/mcp/tool_handlers.ts` 将工具调用转换成 step，并调用 `runSteps`

## 热重载

- Runner 插件入口：`agent/src/runner/plugin_entry.ts`
- 运行时加载：`RunnerPluginHost(.runner-dist/plugin.mjs)`
- 开发模式 watcher：`agent/src/runner/hotreload/plugin_host.ts`

`dev:hot` 与 `mcp:hot` 会自动启动 bundle watcher。
