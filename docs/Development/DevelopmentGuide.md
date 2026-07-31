# DevelopmentGuide

## 概述

本文档描述本地开发、联调和回归验证的当前流程。

## 安装

```bash
pnpm install
pnpm pw:install
```

## 主链路

```bash
pnpm dev
pnpm dev:cdp
pnpm mcp
pnpm mcp:hot
```

- `pnpm dev`：构建扩展并启动受管的 extension 开发运行时。
- `pnpm dev:cdp`：启动受管的 CDP 开发运行时。
- `pnpm mcp`：启动 MCP HTTP 服务。
- `pnpm mcp:hot`：MCP 与 runner bundle 热重载。

仓库已经移除独立 `mock/` 应用。页面识别开发应使用：

- `agent/tests/fixtures/observation-v2/` 浏览器采集 fixture；
- `agent/tests/fixtures/form-v2/` 组件 replay corpus；
- `agent/tests/e2e/` 中由 Playwright 创建的真实页面；
- 必要时新增可重复采集脚本，而不是恢复未维护的静态 mock 站点。

## 测试

```bash
pnpm test:repo-contract
pnpm typecheck
pnpm lint
pnpm test:agent:snapshot
pnpm test:agent:entity-rules
pnpm test:extension
pnpm test:dev-cdp
pnpm test
```

`pnpm test` 是非发布合并门禁，会执行仓库契约、类型、lint、Agent CI 套件、Extension 测试和开发运行时契约测试。

## Workflow artifact 验证

1. 准备 `agent/.artifacts/workflows/<scene>/workflow.yaml`。
2. 调用 `workflow.open`，确认 workspace 和 tab 绑定。
3. 调用 `workflow.dsl.get/save/test` 验证开发态读写和执行。
4. 使用普通 Step/Checkpoint 路径验证同一 runtime contract。
5. 按需执行 `record.start/stop + workflow.record.save` 验证录制落盘。

发布运行和发布构建不属于日常开发门禁，未经明确授权不得执行。

## 常见问题

- Snapshot 或业务实体异常：先读 `Runtime/Snapshot.md` 和 `Runtime/EntityRules.md`。
- `workflow.open` 失败：检查 manifest 与 workspace binding。
- `dsl.test` 失败：检查 DSL diagnostics、变量引用和 checkpoint 声明。
- `tab.ping` 异常：检查 token 映射与 stale 清理日志。
- Control RPC：见 `Contract/ControlRPCProtocol.md`。
