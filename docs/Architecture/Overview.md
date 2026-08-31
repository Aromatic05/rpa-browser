# 架构总览

## 概述

系统把多入口自动化请求统一收敛到同一执行内核。产品架构围绕真实运行时层级组织：**Entity Rules（页面语义）-> DSL / Workflow Checkpoint（业务流程）-> Step runtime（执行 ABI）**，详见 [AutomationModel.md](./AutomationModel.md)。

## 规范

### 1. 分层架构

```text
入口层          extension / start_extension / MCP / Control RPC
                  -> action/tool bridge -> action handlers
产品交互层        Task（Agent 自主执行）、Teach / Annotate（人工 authoring）、Library
语义层           Entity Rules：页面业务语义 schema/bindings（nouns/fields/actions/primary-key）
                 DSL：顶层业务编排语言（use entity_rules / use checkpoint）
                 Workflow Checkpoint：Procedure / Recovery 子程序（body 即 DSL）
执行层           Step runtime：runSteps 调度 -> executors 实现 -> trace 原子层 -> Playwright
```

-   **Entity Rules** 是页面语义 schema/bindings，消费 Snapshot V2 观测，保存时编译成 QueryPlan；运行时选择后进入 PageSession，提供 form/table/dialog/list/panel/toolbar/kv 的字段、动作、行、分页视图。
-   **DSL** 是顶层业务程序/组合语言，编译流水线 `parse -> link -> normalize -> validate`；`link` 把 entity_rules / resolves 符号降到可执行目标，`normalize` 展开 sugar，动作最终统一走 Step runner。
-   **Workflow Checkpoint 不是第二种语言**：Procedure（显式 `use checkpoint` 调用）与 Recovery（失败触发 + trigger/policy 元数据）的 body 都是 DSL，通过同一流水线编译/校验、经 Step 执行。
-   **Step 是执行 ABI / runtime IR，不是持久化产品资产**：统一 MCP/play/script/record/DSL 的最小执行单元，只描述"要做什么"，不携带 Page/Locator 运行时对象。

### 2. 产品交互

-   Agent 自主执行以 Task 为用户侧执行单元；Teach（Procedure/Recovery/Demonstration）与 Annotate（Entity Rules）仍是产品一等 authoring 能力。
-   产品术语：Automation = 保存的 Program/DSL；Procedure / Recovery = Workflow Checkpoint；Demonstration = 通用 Recording；Page Knowledge = Entity Rules。除 Developer Mode 外不使用歧义的 "Checkpoint"。
-   Task / 人机交互 / workspace activity reservation / Teach+Annotate 闭环见 [AgentProductInteraction.md](./AgentProductInteraction.md)。
-   产品侧栏、Home/Task/Library/History、Structured Teach 与 Annotator 复用方式见 [AgentProductUI.md](./AgentProductUI.md)。

### 3. workflow 与 workspace/tab

-   workflow 绑定 workspaceName：`workflow:<scene>`；workspace 维护 tab 集合和 activeTab；tab 通过 `tabName` 与扩展侧生命周期绑定。

### 4. 录制与回放

-   录制：recording state + recorder event，得到 Step 序列（Demonstration 资产）。
-   回放：replayRecording -> runStepList；支持 tab 重映射和缺失 tab 补建。
-   Demonstration 是低层录制源/回放资产，不提供语义映射，不等价于 Procedure。

### 5. MCP 与 Control 的定位差异

-   MCP：对外标准工具接口，schema 完整，工具数量多。
-   Control RPC：本地调试控制接口，方法较少，强调轻量桥接。

## 运行闭包快照

`dsl.run` 在 workspace `executing` 生命周期内先物化并冻结本次引用的 checkpoint graph、body、resolve 与 entity-rule exports，再做 source + 整图 preflight，之后才执行；因此运行开始后的 artifact 修改只会影响下一次 run，不会改变已启动的本次 run。详见 [AutomationModel.md](./AutomationModel.md) §4 与 docs/Runtime/Workflow.md。

## 示例

-   UI 调 `workflow.releaseRun`，最终进入 `runWorkflow -> runDslSource -> runSteps`。

## 限制

-   入口层的 pageless 范围在 WS 主入口与 dispatcher 存在实现差异。
