# RPA Browser Monorepo

仓库包含两条对外交互链路：

- `dev`：Extension 通过 WebSocket 连接 Agent，提供录制、回放、规则编辑和浏览器自动化。
- `mcp`：Agent 提供 HTTP MCP JSON-RPC 服务，供外部程序调用工具。

后端统一由 `runner + step + trace` 执行链路提供能力。

## 目录

- `extension/`：Chrome MV3 扩展
- `start_extension/`：启动页扩展
- `agent/`：Node + Playwright Agent、MCP、Step 和 Trace
- `docs/`：当前契约、运行时和开发文档

## 环境

- Node.js >= 20
- pnpm 11

## 安装

```bash
pnpm install
pnpm pw:install
```

## 启动

```bash
# 扩展模式开发运行时
pnpm dev

# CDP 模式开发运行时
pnpm dev:cdp

# MCP HTTP 服务
pnpm mcp

# MCP HTTP + runner bundle 热重载
pnpm mcp:hot

# 本地 Control RPC 客户端
pnpm control --source "ctx.log('hello')"
```

仓库不再提供独立 `mock/` 应用。框架页面回归由 Playwright E2E 页面、浏览器采集 fixture 和 replay corpus 提供。

## 验证

```bash
# 非发布合并门禁
pnpm test

# 单独运行核心套件
pnpm test:agent:snapshot
pnpm test:agent:entity-rules
pnpm test:extension
pnpm test:dev-cdp

# 有头 E2E
pnpm test:agent:headed
```

`agent/src/mcp_main.ts` 是 MCP HTTP 服务入口。Snapshot V2 和 Entity Rules V2 的运行时边界见 `docs/Runtime/`。
