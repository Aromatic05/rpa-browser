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
3. MCP HTTP（`agent/src/mcp_main.ts`）

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

# 本地 mock workspace（两个子应用并行）
pnpm mock:dev

# 仅启动 Ant fixture app
pnpm mock:dev:ant

# 仅启动 Element fixture app
pnpm mock:dev:element

# MCP 面板（HTTP UI）
pnpm mcp

# MCP HTTP（供外部程序接入）
pnpm mcp:http

# MCP HTTP + runner bundle 热重载
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

`mock/` 提供可控且稳定的本地 workspace 夹具（`mock/ant-app`、`mock/element-app`），用于测试和人工验收。

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
- 目标型 step 必须遵守三层边界：
  - `args`：业务参数（可包含 `id` / `selector`）
  - `meta`：来源和运行时元信息
  - `resolve`：`{ hint?: ResolveHint; policy?: ResolvePolicy }`
- 不允许再把解析 hint/policy 放进 `meta` 或旧兼容字段

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

### 7.2 Checkpoint 过程模板（最小版）

checkpoint 运行时位于：`agent/src/runner/checkpoint/runtime.ts`。

当前模型：

- `kind`: `procedure | recovery | guard`
- `input` / `prepare` / `content` / `output`
- 作用域：`input`、`local`、`output`
- ref/path：`input.xxx`、`local.xxx`、`output.xxx`

动作层最小能力：

- `snapshot`
- `query`
- `compute`
- `act`
- `wait`

约束：

- step executor 不持有变量名
- 变量回写与导出由 checkpoint runtime 负责（`saveAs` + `output`）
- `query` 只做查询、`compute` 只做纯计算

### 7.1 DSL 预留：流式 Step 协议（最小版）

为避免在 agent 侧提前引入完整 DSL VM（循环/分支/变量），当前采用“流式 step 执行”边界：

- agent 只负责执行 `StepEnvelope`，输出 `StepResultEnvelope`
- DSL 组件负责：
  - 解析 DSL
  - 依据反馈生成后续 step（分支/循环/条件）
  - 维护变量上下文

最小 action 协议（agent）：

- `task.run.start`
- `task.run.push`
- `task.run.poll`
- `task.run.checkpoint`
- `task.run.halt`
- `task.run.resume`

核心实现位置：

- `agent/src/runner/run_steps.ts`（Step Pipeline 主循环）
- `agent/src/runner/run_steps_types.ts`（Step Pipeline 对外类型）
- `agent/src/actions/task_stream.ts`
- `agent/src/runner/checkpoint_store.ts`（task.run checkpoint 持久化）
- `docs/DSL_EXECUTOR_PIPELINE.md`（DSL 对接规范）

Checkpoint 配置：

- 配置项：`runner.config.checkpointPolicy`
- 默认文件：`.artifacts/checkpoints/task_runs.json`
- 环境变量：
  - `RUNNER_CHECKPOINT_ENABLED`
  - `RUNNER_CHECKPOINT_FILE_PATH`
  - `RUNNER_CHECKPOINT_FLUSH_INTERVAL_MS`

设计原则：

- 执行器不感知 DSL 语法结构
- 每个 step 使用稳定 `step.id`，并配合 `seq` 支持 checkpoint/续跑
- 结果输出保持结构化字段（`outputs` + `raw`），供 DSL 变量绑定

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

## 9. Entity Rules（业务实体规则）

规则目录（agent 内部产物目录）：

- `agent/.artifacts/workflows/<scene>/entity_rules/<rule_name>/match.yaml`
- `agent/.artifacts/workflows/<scene>/entity_rules/<rule_name>/annotation.yaml`
- legacy fallback：`agent/.artifacts/entity_rules/profiles/<profile>/match.yaml`
- legacy fallback：`agent/.artifacts/entity_rules/profiles/<profile>/annotation.yaml`

运行时加载链路（snapshot）：

1. 解析 YAML
2. schema 校验（单文件）
3. cross-file 校验（`within`/`ruleId`/`page.kind` 等）
4. 规范化为 `NormalizedEntityRuleBundle`
5. 在 snapshot pipeline 的 `applyBusinessEntityRules` 阶段生成 `BusinessEntityOverlay`

测试入口（agent）：

- `tests/runner/steps/snapshot_entity_rules_schema.test.ts`
- `tests/runner/steps/snapshot_entity_rules_validate.test.ts`
- `tests/runner/steps/snapshot_entity_rules_matcher_apply.test.ts`
- `tests/runner/steps/snapshot_entity_rules_pipeline.test.ts`
- `tests/config/resolve_target_enrichment.test.ts`（entity hint）
- `tests/runner/checkpoint/checkpoint.test.ts`（businessTag entityExists）
- `tests/entity_rules/**/*.test.ts`（golden verify）

运行命令：

```bash
pnpm -C agent test:entity-rules
```

当前命令：

```bash
pnpm -C agent test:unit
pnpm -C agent test:integration
pnpm -C agent test:integration:headed
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

## 8.1 集成测试框架（多 tab 录制）

目录：

- `agent/tests/integration/harness/*`：进程编排与 WS action 客户端
- `agent/tests/integration/scenarios/*`：可插拔场景
- `agent/tests/integration/*.test.ts`：统一入口（可按环境切换 headed/headless）

## 9. Workspace / Tab 归属规则（无主标签页）

Agent 对 `tabName` 采用 strict-token 模型：同一 token 不做“按 URL 重绑”。

### 9.0 token 单一真源

- `tabName` 只允许由 agent 生成（`tab.init`）。
- start/content 侧禁止本地 UUID 生成，只可读取已有 token 或向 agent 请求初始化。
- token 丢失视为异常状态，必须重新向 agent 初始化，不做 token 改写重绑。

### 9.1 无主标签页定义

- token 已存在于运行时，但 `token -> (workspaceName, tabId)` 尚未建立。

### 9.2 归属策略

- 显式路径（`workspace.create` / `workspace.restore`）创建的 tab：直接归属目标 workspace。
- 初始 start 页 token（`tab.opened` 且 `source=start_extension`）：
  - 保持无主，直到首次 `tab.ping` 报告真实网页 URL（`http/https`）。
  - 首次真实 URL 时，强制创建新 workspace 并归属。
- 手动新开未知标签页 token：
  - 首次真实 URL 时优先并入当前 active workspace。
  - 若当前没有 workspace，则新建 workspace。
- `workspace.restore` 若由无主标签页发起：restore 成功后关闭该源标签页。

### 9.3 并发约束

- 所有“无主 -> 归属”决策使用单一全局串行锁，避免并发抢占造成归属冲突。

### 9.4 窗口约束

- extension 使用 `windowId -> workspaceName` 运行时映射管理工作区归属。
- `chrome.windows.onFocusChanged` 触发 `workspace.setActive` 同步。
- `chrome.tabs.onCreated` 必须携带 `windowId` 并执行 `tab.opened` 归属（按窗口映射绑定，不允许自动新建 workspace）。
- `chrome.tabs.onAttached` 负责跨窗口拖拽时的 `tab.reassign` 重分配。
- `workspace.create` 在 extension 侧通过 `chrome.windows.create` 强制创建新窗口，再用首 tab 的 `tab.ping` 完成 workspace 绑定。

设计原则：

- 启动完整进程栈（mock + agent + 浏览器扩展）
- 场景只描述行为与断言，框架负责启动、连接、清理
- `headless` 用于 CI/CD，`headed` 用于本地可视化调试
- 场景建议覆盖组合动作（fill/click/scroll/switch/select），避免使用固定 `sleep`
- 时序诊断优先依赖 `step.start/step.end` 时间戳和步骤顺序断言
- 多 tab 录制依赖 `tab.activated` 生命周期事件自动落库为 `browser.switch_tab`（同 workspace 下跨 tab）
- `record.stop/get/clear` 在仅有一个录制会话时允许“错误 tabName”兜底到该会话，避免 UI 焦点切换导致停错录制
- 面板 `tab.setActive` 也会直接写入 `browser.switch_tab`，不依赖生命周期回调先到达
- workflow artifact 根目录统一为 `agent/.artifacts/workflows/<scene>/`
- `steps/` 下每个录制单独一个目录：`steps/<recording-name>/steps.yaml` 与 `steps/<recording-name>/step_resolve.yaml`
- `checkpoints/` 下每个 checkpoint 单独一个目录：`checkpoints/<checkpoint-name>/checkpoint.yaml`、`checkpoint_resolve.yaml`、`checkpoint_hints.yaml`
- `step_resolve.yaml` 只服务同目录 `steps.yaml`；`checkpoint_resolve.yaml` 只服务同目录 `checkpoint.yaml`
- 当录制出来的目标不稳定时，推荐追加执行 `browser.capture_resolve`，再把修订后的 `StepResolve` 写入对应录制目录下的 `step_resolve.yaml`
- DSL 目录规范暂不定义，待 DSL 设计完成后再确定

## 9. A1 持久化契约（workspace restore）

- 持久化文件：`agent` userData 目录下 `recordings.state.json`。
- 版本：当前 `version: 1`（后续结构变更必须升级版本并提供迁移）。
- 存储范围：
  - 录制 bundle（`recordings` + `recordingManifests`）。
  - `workspaceLatestRecording` 索引。
  - `workspaceSnapshots`（`workspace.save` 产物）。

`workspaceSnapshots` 约束：
- 保存 `tabs`（`tabId/url/title/active`），不保存运行时 `tabName`。
- 保存录制 `steps`，并移除 step `meta.tabName`。
- 保存录制 `manifest` 的 tab 列表时，移除 `tabs[].tabName`。
- 多 tab step 持久化优先写 `args.tabRef`；运行时 `tabId` 与 `tabName` 不进入 core step YAML。

恢复语义约束：
- `workspace.restore` 只负责恢复 workspace/tab 与录制上下文，不自动触发 `play.start`。
- 若无可恢复快照，返回 `ERR_WORKSPACE_SNAPSHOT_NOT_FOUND`。
- 失败路径统一返回 `ERR_WORKSPACE_RESTORE_FAILED`（含原始 message）。
- 切换到目标 tab 时会补装 recorder，确保新 tab 后续动作可继续录制
- 热回放会优先使用当前运行时的 `tabName -> tabId` 映射；仅在无法解析时才走 `browser.create_tab`（cold replay）
- 录制结果包含 `manifest`（`workspaceName`、`entryTabRef`、`entryUrl`、tabs 快照）以及步骤级 `meta.tabRef/meta.urlAtRecord`
- 回放采用 `workspace` 先决策略：命中录制 workspace 走热启动；未命中走冷启动（创建 workspace/tab 并用记录 URL 预热）

关键环境变量：

- `RPA_INTEGRATION_HEADED=true|false`：控制集成测试是否有头
- `RPA_HEADLESS=true|false`：agent 启动浏览器模式（由测试脚本自动设置）
- `RPA_BROWSER_MODE=extension|cdp`：浏览器连接模式（默认 `extension`）
- `RPA_CDP_ENDPOINT`：当 `RPA_BROWSER_MODE=cdp` 时，Playwright `connectOverCDP` 连接地址（如 `http://127.0.0.1:9222`）
- `RPA_CDP_AUTO_LAUNCH=true|false`：CDP 模式下未提供 `RPA_CDP_ENDPOINT` 时，是否由 agent 自动拉起本地 Chrome（默认 `true`）
- `RPA_CDP_PORT`：自动拉起 Chrome 时使用的远程调试端口（默认 `9222`）
- `RPA_CDP_USER_DATA_DIR`：自动拉起 Chrome 时使用的用户目录；未设置则落到 `agent/.user-data/cdp-browser`
- `RPA_CDP_CHROME_PATH`：自动拉起 Chrome 的可执行文件路径（可选）
- `RPA_INTEGRATION_VERBOSE=true|false`：输出集成测试中 `mock/agent` 子进程日志（headed 默认开启）
- `RPA_INTEGRATION_EXTENSION_AWARE=true|false`：是否固定使用扩展默认 WS 端口（`17333`）；headed 默认开启
- `RPA_INTEGRATION_WS_PORT`：当 `RPA_INTEGRATION_EXTENSION_AWARE=true` 时使用的 agent WS 端口（默认 `17333`）

CDP 快速入口：

- 根目录：`pnpm dev:cdp`
- `agent` 目录：`pnpm dev:cdp`

脚本复用说明：

- `pnpm -C agent test:integration:run`：统一执行入口
- `test:integration` 与 `test:integration:headed` 仅通过 `RPA_INTEGRATION_HEADED` 切换模式

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

### 8.2 Target 解析测试约束

涉及 target 解析重构时，至少补齐：

- `resolveTarget` 的 selector / id / hint 三路径单测
- `ResolvePolicy`（`preferDirect`、`preferScoped`、`requireVisible`、`allowFuzzy`、`allowIndexDrift`）分支覆盖
- `click` + 一个 `fill` 类 + 一个 `select` 类 executor 走统一解析链路
- replay 显式写入 `step.resolve` 的回归测试（禁止全局隐式 sidecar 查询）
