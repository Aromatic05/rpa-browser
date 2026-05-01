# Workflow 运行时

## 概述

本文件定义 workflow 运行时动作的完整语义，覆盖打开、状态查询、DSL 读写、测试运行、正式运行、录制沉淀。对应实现：`agent/src/actions/workflow.ts`、`agent/src/workflow/*`。

## 规范

### 1. workflow 动作输入与输出

#### workflow.list

输入：空 payload。  
输出：

- `workflows[]`：`scene/id/name/entryDsl/entryInputs/workspaceBinding/recordCount/checkpointCount`
- `diagnostics[]`：某 scene 解析失败时返回 `code/message`

#### workflow.open

输入：

- `scene: string`（必填）

输出：

- `scene`
- `workflowRoot`
- `workspaceName`
- `tabName`
- `tabName`
- `entryUrl`（若 workspace binding 声明）

#### workflow.status

输入：`scene`。输出：`workspaceName/exists/active`。

#### workflow.record.save

输入：

- `scene`（必填）
- `recordingName`（可选）

输出：`scene/recordingName/stepCount`。

#### workflow.dsl.get

输入：`scene`。输出：`scene/dslPath/content`。

#### workflow.dsl.save

输入：`scene/content`。输出：`scene/dslPath/saved=true`。

#### workflow.dsl.test

输入：`scene`，可选 `input`。输出：

- `ok`
- `output`
- `diagnostics`
- `workspaceName`

#### workflow.releaseRun

输入：`scene`，可选 `input`。输出：

- `ok`
- `output`
- `diagnostics`
- `workspaceName/tabName/tabName`

### 2. 生命周期执行顺序

推荐顺序：

1. `workflow.list`
2. `workflow.open`
3. `workflow.status`（可选）
4. `workflow.dsl.get` / `workflow.dsl.save`
5. `workflow.dsl.test`
6. `workflow.releaseRun`
7. `record.start/stop` + `workflow.record.save`（按需）

关键约束：

- `workflow.open` 只建立上下文，不运行 DSL。
- `workflow.releaseRun` 是正式运行入口。
- `workflow.dsl.test` 是开发态运行入口。

### 3. workspace 绑定机制

- workflow workspace 规则：`workflow:<scene>`。
- 绑定由 `resolveWorkflowWorkspace` 执行。
- 策略由 `workspace.yaml` 的 `workspace.strategy` 决定：
  - `restoreOrCreate`
  - `createOnly`
  - `restoreOnly`

URL 规则：

- 若 `entryUrl` 存在，绑定后会确保导航到该 URL。
- 若 `expectedTabs` 存在，当前实现只校验活动页 URL。

### 4. 录制沉淀规则

`workflow.record.save` 额外约束：

- 当前 action scope 的 workspace 必须等于 `workflow:<scene>`。
- 否则返回 `ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED`。

默认录制名：

- `recording-YYYYMMDD-HHmmss`

当前写盘行为：

- 写 `records/<recordingName>/steps.yaml`
- 写 `records/<recordingName>/manifest.yaml`
- 默认不写 `step_resolve.yaml`

### 5. DSL 运行输入优先级

在 `dsl.test/releaseRun` 中：

1. 优先使用 action payload `input`
2. 回退到 workflow `inputs.example.yaml`
3. 最后回退 `{}`

### 6. checkpoint provider 组装

`workflow.dsl.test` 与 `workflow.releaseRun` 都会：

- 读取 manifest 声明的 checkpoints 列表
- 解析每个 `checkpoint.yaml`
- 可选读取 `checkpoint_resolve.yaml`
- 在 DSL 执行时通过 provider 注入

### 7. 典型失败边界

- `scene` 缺失：`ERR_WORKFLOW_BAD_ARGS`
- manifest 不存在：`ERR_WORKFLOW_NOT_FOUND`
- manifest 不合法：`ERR_WORKFLOW_INVALID_MANIFEST`
- dsl entry 不存在：`ERR_WORKFLOW_DSL_NOT_FOUND`
- workspace binding 不合法：`ERR_WORKFLOW_WORKSPACE_BINDING_INVALID`
- path 越界：`ERR_WORKFLOW_PATH_ESCAPE`

## 示例

### 示例 1：最小 open + run

```text
workflow.open(scene=order_scene)
-> workspaceName=workflow:order_scene
-> tabName=tab-1
-> tabName=token-1

workflow.releaseRun(scene=order_scene,input={buyer:"alice"})
-> output={...}
```

### 示例 2：编辑 DSL 后测试运行

```text
workflow.dsl.get(scene)
workflow.dsl.save(scene, content)
workflow.dsl.test(scene, input)
```

## 限制

- `expectedTabs` 目前不是全 tab 校验，仅当前活动页校验。
- `workflow.record.save` 目前不自动输出 step resolve sidecar。
- `dsl.test/releaseRun` 要求 `runStepsDeps` 已初始化。
