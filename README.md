# RPA Browser Monorepo

仓库包含产品运行时与开发/集成链路：

- `start`：正式本地产品运行时；单实例启动 Agent 与主 Chrome MV3 Extension，不启用源码 watcher/hot reload。
- `dev`：开发运行时，构建并监听 Extension/runner 变更。
- `mcp`：Agent 提供 HTTP MCP JSON-RPC 服务，供外部程序调用工具。

后端统一由 `runner + step + trace` 执行链路提供能力。

## 目录

- `extension/`：Chrome MV3 扩展
- `agent/`：Node + Playwright Agent、MCP、Step 和 Trace
- `docs/`：当前契约、运行时和开发文档

## 环境

- Node.js >= 22.19
- pnpm 11

## 安装

```bash
pnpm install
pnpm pw:install
```

## 启动

```bash
# 正式本地产品运行时；缺少构建产物时会先构建一次
pnpm start

# 显式刷新产品构建产物
pnpm build:product

# 扩展模式开发运行时（源码监听 / 自动重构建）
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

首次 `pnpm start` 打开的 RPA Browser 新标签页会在模型尚未配置时显示 `Finish setup`。Provider、Model 和 OpenAI-compatible Base URL 写入本地 runner config；API key 单独写入权限为 `0600` 的本地 secret 文件，runner config 和运行日志不保存明文 key。保存后同一 Agent 进程立即生效，无需重启浏览器或运行时。

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

`agent/src/app/entrypoints/mcp.ts` 是 MCP HTTP 服务入口。Snapshot V2 和 Entity Rules V2 的运行时边界见 `docs/Runtime/`。
