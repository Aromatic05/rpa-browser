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

首次打开会显示中文使用入口：可以不填 API，先点“开始录制练习”；也可以粘贴目标网址，选择录制或 AI 任务，打开后自动显示助手。网页内右侧“RPA 助手”提供“怎么用”和“我的录制”。AI 模型配置为可选项，密钥仅保存在本机。完整的场景和操作步骤见 [使用入门](docs/使用入门.md)。

仓库不再提供独立 `mock/` 应用。框架页面回归由 Playwright E2E 页面、浏览器采集 fixture 和 replay corpus 提供。

## 验证

```bash
# 非发布合并门禁
pnpm test

# 产品无窗口启动冒烟（先构建产品并安装 Chromium）
pnpm test:product-start

# 单独运行核心套件
pnpm test:agent:snapshot
pnpm test:agent:entity-rules
pnpm test:extension
pnpm test:dev-cdp

# 有头 E2E
pnpm test:agent:headed
```

`agent/src/app/entrypoints/mcp.ts` 是 MCP HTTP 服务入口。Snapshot V2 和 Entity Rules V2 的运行时边界见 `docs/Runtime/`。
