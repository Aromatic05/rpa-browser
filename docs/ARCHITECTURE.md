# 架构

## 概览

仓库由两层核心组成：

- `extension/`：浏览器侧 UI 与命令发送（WS）。
- `agent/`：后端执行层（WS server / MCP HTTP / MCP 面板），统一走 `runSteps` + `trace`。

另外：

- `mock/`：本地页面夹具。
- `agent/src/demo/*`：本地 MCP 面板服务。
- `agent/src/mcp/*`：MCP HTTP(SSE) 服务。

## 三个交互入口

1. Extension 入口：`agent/src/index.ts`
2. MCP HTTP 入口：`agent/src/mcp_main.ts`
3. MCP 面板入口：`agent/src/demo/server.ts`

这三个入口最终共享 runner/runtime/trace。

## 执行主链路

- Step 统一入口：`agent/src/runner/run_steps.ts`
- Step 执行器：`agent/src/runner/steps/executors/*`
- Trace 原子层：`agent/src/runner/trace/*`
- Checkpoint 模板运行时：`agent/src/runner/checkpoint/runtime.ts`
- 运行时绑定：`agent/src/runtime/*`

Checkpoint 在当前版本支持两种路径：

- recovery：失败后匹配 `kind=recovery` checkpoint 执行恢复内容
- procedure：通过 `browser.checkpoint` 显式调用模板，执行 `prepare/content/output` 并导出结构化 output

## WS（extension -> agent）

- 扩展发 Action 包到 `ws://127.0.0.1:17333`
- `agent/src/index.ts` 校验 action 后调用 `agent/src/actions/execute.ts`
- 部分动作会进一步调用 `runSteps`
- 广播同样使用 Action 协议（`workspace.sync/workspace.changed/tab.bound`），不再使用 `type="event"`。
- workspace 物理承载以浏览器窗口为单位，extension 在 SW 内维护 `windowId -> workspaceId` 映射并同步焦点/关闭副作用。

## MCP（HTTP）

- `agent/src/mcp_main.ts` 启动 MCP server
- `agent/src/mcp/server.ts` 处理 `tools/list`、`tools/call`
- `agent/src/mcp/tool_handlers.ts` 将工具调用转换成 step，并调用 `runSteps`

## 热重载

- Runner 插件入口：`agent/src/runner/plugin_entry.ts`
- 运行时加载：`RunnerPluginHost(.runner-dist/plugin.mjs)`
- 开发模式 watcher：`agent/src/runner/hotreload/plugin_host.ts`

`dev:hot` 与 `mcp:hot` 会自动启动 bundle watcher。

## Target 解析协议

目标型 step 的协议边界固定为三层：

- `args`：业务参数（`id` / `selector` / value 等）
- `meta`：来源、时序、workspace/tab 元信息
- `resolve`：目标解析辅助信息（`hint` + `policy`）

执行链路：

1. executor 收集 `args.id` / `args.selector` / `step.resolve.hint`
2. 调用 `resolveTarget(...)` 收敛为最终 `selector`
3. trace 仅接收 `selector` 执行，不承担 id/hint/replay 语义

约束：

- 不保留 `A11yHint` 作为公开 Step 协议字段
- replay 不再通过全局 stepId sidecar 隐式读取增强信息
- replay 必须在构造 step 时显式写入 `step.resolve`
