# RPA Browser Monorepo

这个仓库包含三个对外交互层：

- `dev`（Extension -> Agent WS）：浏览器扩展控制后端，支持录制/回放。
- `mcp`（Panel）：本地控制面板（HTTP UI）。
- `mcp:http`（MCP）：给外部程序通过 MCP HTTP(SSE) 调用后端工具。

后端统一由 `runner + step + trace` 执行链路提供能力。

## 目录

- `extension/`: Chrome MV3 扩展（UI、状态、命令转发）
- `agent/`: Node + Playwright 后端（WS/MCP/Demo、runSteps、trace）
- `mock/`: 本地静态站点（默认 `http://127.0.0.1:4173`）
- `docs/`: 项目文档

## 环境

- Node.js >= 20
- pnpm

## 安装

```bash
pnpm install
pnpm pw:install
```

## 常用启动命令（根目录）

```bash
# 1) 扩展主链路（推荐）
pnpm dev

# 2) 启动 mock 站点（可选）
pnpm mock:dev

# 3) MCP 面板（HTTP UI）
pnpm mcp

# 4) MCP HTTP（给外部程序）
pnpm mcp:http

# 5) MCP HTTP + runner bundle 热重载
pnpm mcp:hot
```

## 测试（根目录）

```bash
# agent 全量测试
pnpm test:agent

# agent headed E2E
pnpm test:agent:headed

# MCP 冒烟
pnpm test:agent:smoke:mcp

# extension 测试
pnpm test:extension
```

Agent 侧测试脚本采用统一前缀 `test:*`，详见 [agent/package.json](./agent/package.json)。

## 说明

- `mcp_main.ts` 是 MCP HTTP 服务入口，定位是供外部程序调用，不是面向用户的页面入口。
- 开发态热重载依赖 `agent/.runner-dist/plugin.mjs`，`dev:hot`/`mcp:hot` 会自动启动 bundle watcher。
