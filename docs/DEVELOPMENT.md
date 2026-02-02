# 开发指南

## 安装

```
pnpm install
```

## 运行

### 1) 启动 mock 本地站点（起始页）

```
pnpm mock:dev
```

默认访问：`http://localhost:4173/pages/start.html#beta`

### 2) 构建并加载扩展

```
pnpm -C extension build
```

在 Chrome 中从 `extension/dist` 加载扩展。

### 3) 启动 agent

```
pnpm -C agent dev
```

### Runner 热重载（开发模式）

启动 runner bundle watcher 并运行 agent（推荐）：

```
pnpm -C agent dev:hot
```

或用两个终端分别启动：

```
pnpm -C agent runner:bundle:watch
pnpm -C agent dev
```

说明：
- 热重载仅在开发模式下开启（`NODE_ENV !== 'production'`）。
- reload 失败会保留旧版本 runner，并在日志里输出 `[runner] hot reload FAILED (kept previous)`。

### 4) 本地 Chat Demo（可选）

```
pnpm -C agent dev:demo
```

访问 `http://127.0.0.1:17334`。

### 5) MCP stdio server（可选）

```
pnpm -C agent mcp
```

### 6) 统一 runner 有头演示（人工验收）

```
pnpm -C agent demo:headed-runner
```

## 测试

```
pnpm -C agent test
pnpm -C agent test:trace
pnpm -C agent test:headed
```

扩展侧轻量测试：

```
pnpm -C extension test
```

## 常用路径

- 扩展入口：`extension/src/entry/*`
- SW 路由：`extension/src/background/*`
- 录制：`extension/src/record/*`
- Runner 统一入口：`agent/src/runner/run_steps.ts`
- Trace 原子层：`agent/src/runner/trace/*`
- 统一配置：`agent/src/runner/config/*`
- Demo 服务：`agent/src/demo/server.ts`
- Mock 起始页：`mock/pages/start.html`
