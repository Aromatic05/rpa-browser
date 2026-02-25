# 开发指南

## 安装

```bash
pnpm install
pnpm pw:install
```

## 本地运行

### 1) 启动 mock 站点（可选）

```bash
pnpm mock:dev
```

默认地址：`http://127.0.0.1:4173/pages/start.html#beta`

### 2) 扩展主链路（Extension -> Agent）

```bash
pnpm dev
```

这条命令会：

- 构建 extension
- 启动 `agent dev:hot`（含 runner bundle watch）

### 3) MCP 入口

```bash
# MCP 面板（本地 HTTP UI）
pnpm mcp

# MCP stdio（供外部程序调用）
pnpm mcp:stdio

# MCP stdio + runner 热重载
pnpm mcp:hot
```

### 4) 仅启动 agent（在 agent 目录）

```bash
pnpm -C agent dev
pnpm -C agent dev:hot
pnpm -C agent mcp
pnpm -C agent mcp:hot
```

## 测试

```bash
# agent 聚合
pnpm test:agent

# agent 子集
pnpm -C agent test:e2e
pnpm -C agent test:runner
pnpm -C agent test:trace
pnpm -C agent test:unit
pnpm -C agent test:smoke:mcp
pnpm -C agent test:headed

# extension
pnpm test:extension
```
