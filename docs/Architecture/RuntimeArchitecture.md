# 运行时架构

## 概述

本文档描述 rpa-browser agent 最终运行时架构，覆盖 action 路由、workspace 聚合、MCP 集成边界、tab 生命周期及已删除的旧版概念。

## 1. Action 路由

### 1.1 核心规则

Action 路由由 `classifyActionRoute` 单函数决定，不再使用白名单：

- `action.workspaceName` 存在且 `payload.workspaceName` 不存在 → **workspace 路由**
- `action.workspaceName` 不存在 → **control 路由**
- `action.workspaceName` 与 `payload.workspaceName` 同时存在 → **非法**

路由类型仅依赖 `workspaceName` 的存在性，不依赖 action type 或任何白名单集合。

### 1.2 合法性校验

`classifyActionType` 仅校验 action type 是否在 `REQUEST_ACTION_TYPES` 集合中。不在集合中的 action type 一律路由为 `invalid`。

### 1.3 已删除的 action

| Action | 替代方案 |
|--------|---------|
| `tab.init` | extension background 使用 `crypto.randomUUID()` 本地生成 binding name |
| `workspace.save` | 删除，无替代 |
| `workspace.restore` | 删除，无替代 |
| `workflow.status` | 删除，无替代 |

### 1.4 一致性要求

agent 和 extension 的 `classifyActionRoute` 实现逻辑完全相同，均接受完整 `Action` 对象作为参数。

## 2. RuntimeWorkspace 聚合

### 2.1 聚合结构

`RuntimeWorkspace` 是 workflow workspace 的聚合根，单次构造（无 `null as unknown` 两阶段回填）：

```
RuntimeWorkspace
├── name: string
├── workflow: Workflow
├── tabs: WorkspaceTabs
├── record: RecordControl
├── dsl: DslControl
├── checkpoint: CheckpointControl
├── entityRules: EntityRulesControl
├── runner: RunnerControl
├── mcp: McpControl
├── router: WorkspaceRouter
├── createdAt: number
└── updatedAt: number
```

### 2.2 不持有的字段

`RuntimeWorkspace` 明确**不持有**：

- `tabRegistry` — 已从聚合移除，tab 管理统一由 `WorkspaceTabs` 负责
- `getPage` — page 获取由 `WorkspaceTabs.ensurePage` 内部调用
- `controls` — 各 domain control 直接挂在聚合上
- `serviceLifecycle` — 已删除，生命周期由外部调度

### 2.3 协议不变量

- `workspaceName === workflowName` — workspace 名称必须等于其绑定的 workflow 名称
- workspace 的 workflow binding 使用 `workflow:<scene>` 命名规则

## 3. WorkspaceRouter 前缀转发

`WorkspaceRouter` 是每 workspace 的 action 转发器，仅做前缀匹配：

| 前缀 | 目标 Control | 说明 |
|------|-------------|------|
| `tab.*` | TabsControl | tab 生命周期管理 |
| `mcp.*` | McpControl | MCP 服务器生命周期 |
| `record.*` / `play.*` | RecordControl | 录制与回放 |
| `dsl.*` | DslControl | DSL 读写与执行 |
| `checkpoint.*` | CheckpointControl | checkpoint 管理 |
| `entity_rules.*` | EntityRulesControl | 实体规则管理 |
| `task.run.*` | RunnerControl | 任务运行 |

Router 不负责 action 合法性判断——已由上层 `classifyActionRoute` 完成。router 收到不支持的 action 时返回 `ERR_UNSUPPORTED`。

## 4. MCP 集成

### 4.1 依赖边界

MCP 层使用缩窄的 workspace 依赖类型：

```typescript
{ name: string; tabs: WorkspaceTabs }
```

而非完整的 `RuntimeWorkspace`。这打破了构造时的循环依赖：MCP service 可在 `RuntimeWorkspace` 对象形成前创建。

### 4.2 工具名称约定

所有 MCP 工具以 `browser.` 为前缀（`browser.goto`、`browser.click`、`browser.snapshot` 等）。MCP tool handler 通过 `createWorkspaceToolHandlers` 创建，接收缩窄的 workspace deps。

### 4.3 启动入口

MCP 通过 `workspace.mcp.start` 启动（非 `startMcpServer` 或 `createMcpServer` 旧接口）。`mcp_main.ts` 调用 `workspace.mcp.start` 完成初始化。

## 5. Tab 生命周期

### 5.1 命名生成

`bindingName` 由 extension background 使用 `crypto.randomUUID()` 本地生成，通过 `pushBindingNameToTab` 写入 tab。background 不再依赖 agent 侧 `tab.init` 生成 tabName。

### 5.2 WorkspaceTabs 职责

`WorkspaceTabs` 负责单个 workspace 内的 tab 生命周期：

- `createTab` — 创建 tab 元数据并设置 active
- `ensurePage` — 确保 Page 存在并绑定 tab（通过 `PageRegistry` 低层基础设施）
- `closeTab` — 移除 tab
- `setActiveTab` — 切换 active tab
- `report/ping` — CDP 侧生命周期同步
- `reassign` — tab 重分配到当前 workspace

### 5.3 绑定流程

1. 页面发送 `RPA_ENSURE_BOUND_TOKEN`
2. background 检查已绑定 token；若无则本地 `crypto.randomUUID()` 生成并 `SET_TOKEN` 回写
3. background 解析 workspace 归属
4. background 发送 `tab.opened` 给 agent
5. agent 的 `bindTabOpenedAction` 执行 claim/bind
6. 绑定成功后页面方可发送 `tab.ping/tab.report/workflow.*`

## 6. 已删除的旧版概念

以下概念已从代码库完全移除，测试以负向断言（验证不存在）覆盖：

| 旧概念 | 清理状态 |
|--------|---------|
| `CONTROL_ACTIONS` 白名单 | agent/extension 均不导出 |
| `WORKSPACE_ACTIONS` 白名单 | agent/extension 均不导出 |
| `startMcpServer` | 无任何源码引用 |
| `createMcpServer` | 无任何 export/import |
| `McpToolDeps`（未带 Workspace 前缀） | 仅 `WorkspaceMcpToolDeps` 存在 |
| `RuntimeWorkspaceControls` | 不存在 |
| `WorkspaceControlServices` | 不存在 |
| `controls` 属性（on RuntimeWorkspace） | 不存在 |
| `serviceLifecycle` | 不存在 |
| `getLifecycle` | 不存在 |
| `tabRegistry` 属性（on RuntimeWorkspace） | 不存在 |
| `getPage` 属性（on RuntimeWorkspace） | 不存在 |
| `workspace.save/restore` action | 不合法 action |
| `workflow.status` action | 不合法 action |
| `tab.init` action | 不合法 action |

## 7. 测试覆盖

### 7.1 Action 路由测试

`agent/tests/actions/classify_discipline.test.ts` — 38 个测试用例：
- tab.init / workspace.save / workspace.restore / workflow.status 不是合法 request action
- workspaceName → workspace 路由
- 无 workspaceName → control 路由
- workspaceName 与 payload.workspaceName 共存 → invalid
- agent 与 extension 一致性
- CONTROL_ACTIONS / WORKSPACE_ACTIONS 不在模块导出中

### 7.2 Router 与控制边界测试

`agent/tests/runtime/workspace_router_boundary.test.ts` — 33 个测试用例：
- 所有前缀转发正确（tab/mcp/record/play/dsl/checkpoint/entity_rules/task.run）
- Router 拒绝 control action
- Router 拒绝已删除 action
- TabsControl 拒绝 tab.init

### 7.3 Workspace 聚合测试

`agent/tests/runtime/workspace_router_aggregate.test.ts` — 33 个测试用例：
- RuntimeWorkspace 聚合结构验证
- workspace.ts 构造纪律（无 null as unknown、无回填）
- tab 生命周期通过 router
- tab.create/opened/reassign 通过 TabsControl

### 7.4 MCP 边界测试

`agent/tests/mcp/legacy_guard.test.ts` — 22 个测试用例：
- 旧版 MCP 入口不存在
- 旧版类型/函数不存在
- browser.* 工具名在 handler map 中保留
- browser.* 未注册为 action type
- `workspace.mcp.start` 为正确入口
- `ensurePage` 在 runtime.ts 中传递

## 8. 目录结构

```
agent/src/
├── actions/
│   ├── classify.ts          # classifyActionRoute / classifyActionType
│   ├── action_types.ts      # REQUEST_ACTION_TYPES 集合
│   ├── action_protocol.ts   # Action 类型定义
│   ├── results.ts           # ErrorCode 定义
│   ├── dispatcher.ts        # Action dispatch 入口
│   └── control_gateway.ts   # Control 路由处理
├── mcp/
│   ├── index.ts             # 仅导出 WorkspaceMcp*
│   ├── runtime.ts           # createWorkspaceMcpService
│   ├── tool_handlers.ts     # createWorkspaceToolHandlers
│   ├── tool_registry.ts     # WorkspaceMcpToolRegistry
│   └── control.ts           # createMcpControl
├── runtime/
│   ├── workspace/
│   │   ├── workspace.ts     # createRuntimeWorkspace
│   │   ├── router.ts        # createWorkspaceRouter
│   │   ├── tabs.ts          # createWorkspaceTabs
│   │   └── registry.ts      # createWorkspaceRegistry
│   ├── browser/
│   │   └── page_registry.ts # PageRegistry（低层基础设施）
│   ├── execution/           # ExecutionBindings
│   └── service/             # WorkspaceService 类型
├── workflow/                # Workflow 持久化门面
└── mcp_main.ts              # MCP 启动入口

extension/src/
├── actions/
│   ├── classify.ts          # classifyActionRoute（与 agent 一致）
│   ├── action_types.ts      # REQUEST_ACTION_TYPES
│   ├── action_protocol.ts
│   └── results.ts
├── background/
│   ├── life.ts              # ensureBoundTabName（本地 crypto.randomUUID()）
│   ├── cmd_router.ts
│   └── action.ts
└── content/
    └── token_bridge.ts
```
