# 开发指南

## 1. 目标

本文件是仓库的工程开发手册，目标是让新功能在现有架构中可持续演进。

内容覆盖：

- 运行时整体模型（`extension`、`agent`、`runner`、`trace`、`mock`）
- 如何新增 `step` 命令
- 如何新增 `trace` 原子能力
- 如何新增交互层（例如脚本执行器 / DSL 解释器）
- 测试目录与测试规范
- 文档与代码的一致性维护规则

## 2. 运行时模型

当前有三个对外交互入口：

1. Extension -> Agent WS（`agent/src/index.ts`）
2. MCP 面板（HTTP UI，`agent/src/demo/server.ts`）
3. MCP stdio（`agent/src/mcp_main.ts`）

三者最终共享同一后端执行内核：

- 运行时绑定：`agent/src/runtime/*`
- 统一执行入口：`agent/src/runner/run_steps.ts`
- Step 执行器：`agent/src/runner/steps/executors/*`
- Trace 原子能力：`agent/src/runner/trace/*`

设计约束：

- 新入口层只做协议适配。
- 真实浏览器行为统一落在 `runSteps` + trace/executor。

## 3. 本地开发流程

安装：

```bash
pnpm install
pnpm pw:install
```

根目录常用命令：

```bash
# Extension + agent 热更新主链路（推荐）
pnpm dev

# 本地 mock 夹具站点
pnpm mock:dev

# MCP 面板（HTTP UI）
pnpm mcp

# MCP stdio（供外部程序接入）
pnpm mcp:stdio

# MCP stdio + runner bundle 热重载
pnpm mcp:hot
```

仅运行 agent（agent 目录）：

```bash
pnpm -C agent dev
pnpm -C agent dev:hot
pnpm -C agent mcp
pnpm -C agent mcp:hot
```

## 4. mock 的作用

`mock/` 提供可控且稳定的本地页面夹具，用于测试和人工验收。

价值：

- 固定 DOM / a11y 结构，降低用例波动
- 避免外部网络不稳定
- 便于为新命令补充最小复现页面

建议更新 mock 的场景：

- 新增交互能力（如 `drag_and_drop`、dialog、popup 等）
- 修复定位不稳定问题并补回归用例

## 5. 如何新增一个 step 命令

示例：新增 `browser.foo`。

### 5.1 增加类型契约

- 在 `agent/src/runner/steps/types.ts` 更新 `StepName` 与 `StepArgsMap`
- 如有需要补充子类型

### 5.2 实现 executor

- 新增 `agent/src/runner/steps/executors/foo.ts`
- 返回标准 `StepResult`（`ok` / `error`）
- executor 负责编排，原子操作调用 trace tools

### 5.3 注册 executor

- 在 `agent/src/runner/steps/executors/index.ts` 注册 `browser.foo`

### 5.4 暴露给 MCP（如需要）

若该命令需要被 MCP 调用：

- 在 `agent/src/mcp/schemas.ts` 增加输入 schema
- 在 `agent/src/mcp/tool_handlers.ts` 增加 handler 映射
- 在 `agent/src/mcp/server.ts` 的 `tools/list` 中注册

### 5.5 补测试

建议至少覆盖：

- executor 级测试（`agent/src/runner/steps/__tests__/*.test.ts`）
- runner 集成测试（`agent/tests/runner/*.test.ts`）
- e2e 行为测试（`agent/tests/specs/*.spec.ts`）
- 若对外暴露 MCP，再补 MCP 路径覆盖（`agent/tests/trace/*` 或 `test:smoke:mcp`）

## 6. 如何新增一个 trace 原子能力

示例：新增 `trace.locator.foo`。

### 6.1 定义类型

- 在 `agent/src/runner/trace/types.ts` 添加 `TraceOpName`
- 在 `agent/src/runner/trace/tools.ts` 扩展 `BrowserAutomationTools`

### 6.2 在 trace tools 实现

- 在 `createTraceTools()` 中新增实现
- 通过本地 `run(...)` 包装，统一走 `traceCall`
- 保持“原子能力”边界，不做高层策略

### 6.3 缓存与观测

- 状态变更操作要按需失效 a11y cache
- 保证 `op.start` / `op.end` 语义稳定

### 6.4 连接到 step executor

- 更新对应 step executor 调用该 trace op

### 6.5 补测试

- trace 层测试：`agent/tests/trace/*.test.ts`
- 若影响 step 语义，再补 runner/e2e 覆盖

## 7. 如何新增一个交互层（MCP-like / DSL / Script）

推荐接入方式：

1. 定义该层输入协议
2. 解析 + 校验为 `StepUnion[]`
3. 解析 workspace 作用域
4. 调用 `runSteps(...)`
5. 包装为该层自己的返回结构

现有参考：

- `agent/src/script/run_script.ts` 已实现一个最小脚本解释器：
  - 输入可为行式 DSL 或 `StepUnion[]`
  - 先编译成 steps，再调用 `runSteps`

约束：

- 不要在新层复制执行逻辑
- 新层应是“协议翻译器”，不是“第二套执行引擎”

## 8. 测试布局与规范

Agent 测试分层：

- `agent/src/runner/steps/__tests__/*.test.ts`：executor 级
- `agent/tests/config/*.test.ts`：配置加载/覆盖
- `agent/tests/trace/*.test.ts`：trace 原子/集成
- `agent/tests/runner/*.test.ts`：runSteps + runtime 集成
- `agent/tests/specs/*.spec.ts`：Playwright e2e
- `agent/tests/fixtures/*`：固定夹具页面
- `agent/tests/helpers/*`：测试工具

Extension 测试：

- `extension/src/__tests__/*.test.mjs`

当前命令：

```bash
pnpm -C agent test:unit
pnpm -C agent test:trace
pnpm -C agent test:runner
pnpm -C agent test:e2e
pnpm -C agent test:headed
pnpm -C agent test:smoke:mcp
pnpm -C agent test
pnpm test:extension
```

测试质量要求：

- 同时覆盖成功路径和错误码路径
- 优先使用可重复的 fixture
- 协议变更至少补一个协议级断言
- 新 trace op 在必要时断言 op 序列

## 9. 文档维护规则

代码改动请在同一 PR 同步文档：

- Step/Trace/API 合同变更 -> `docs/PROTOCOL.md`
- 架构/入口/运行链路变更 -> `docs/ARCHITECTURE.md`
- 命令/开发流程/测试入口变更 -> `docs/DEVELOPMENT.md`
- 已实现功能状态变更 -> `docs/IMPLEMENTED_FEATURES.md`

PR 检查项：

- `package.json` / `agent/package.json` 脚本准确
- 协议文档与代码一致
- 相关测试已补齐或更新
- 已删除不可信或过时文档
