# 架构总览

## 概述

系统目标是把多入口自动化请求统一收敛到同一执行内核，核心是 Action 协议、runSteps 引擎、trace 原子层、workflow/DSL 编排层。

## 规范

### 1. 分层架构

#### 入口层

- extension：浏览器扩展入口。
- start_extension：新标签页 workflow 操作入口。
- MCP：外部工具调用入口。
- Control RPC：本地控制入口。

#### 协议层

- Action：跨端协议。
- Step：内部执行协议。
- Trace：原子操作观测协议。

#### 执行层

- runSteps：步骤调度、信号控制、checkpoint 折叠。
- executors：每个 step 的业务实现。
- trace tools：Playwright 原子调用与错误映射。

#### 语义层

- snapshot pipeline：结构化页面语义。
- entity rules：业务语义标注。
- finalEntityView：对外查询语义视图。

### 2. 模块关系

```text
extension/start_extension/mcp/control
  -> action/tool bridge
  -> action handlers / runWorkflow / runDslSource
  -> runSteps
  -> executors
  -> trace
```

### 3. workflow 与 workspace/tab

- workflow 绑定 workspaceId：`workflow:<scene>`。
- workspace 维护 tab 集合和 activeTab。
- tab 通过 `tabToken` 与扩展侧生命周期绑定。

### 4. 录制与回放

- 录制：recording state + recorder event。
- 回放：replayRecording -> runStepList。
- 回放过程支持 tab 重映射和缺失 tab 补建。

### 5. MCP 与 Control 的定位差异

- MCP：对外标准工具接口，schema 完整，工具数量多。
- Control RPC：本地调试控制接口，方法较少，强调轻量桥接。

## 示例

- UI 调 `workflow.releaseRun`，最终会进入 `runWorkflow -> runDslSource -> runSteps`。

## 限制

- 入口层的 pageless 范围在 WS 主入口与 dispatcher 存在实现差异。
- 语义质量受 snapshot 与 entity_rules 数据质量影响。
