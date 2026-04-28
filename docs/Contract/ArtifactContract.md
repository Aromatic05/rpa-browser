# Artifact 契约

## 概述

本文档定义 workflow artifact 的目录、字段、落盘与兼容规则。该契约对应 `agent/src/workflow/*`、`agent/src/actions/workflow.ts`、`agent/src/record/persistence.ts` 的当前实现。

## 规范

### 1. 根路径与场景目录

- 全局根路径：`agent/.artifacts/`
- workflow 根路径：`agent/.artifacts/workflows/<scene>/`
- scene 与 workspace 映射：`workspaceId = workflow:<scene>`

### 2. workflow 目录结构

```text
agent/.artifacts/workflows/<scene>/
├─ workflow.yaml
├─ workspace.yaml                         # 可选；由 workflow.workspace.binding 指向
├─ dsl/
│  ├─ main.dsl
│  └─ inputs.example.yaml                # 可选；由 workflow.entry.inputs 指向
├─ records/
│  └─ <recording-name>/
│     ├─ steps.yaml
│     ├─ step_resolve.yaml               # 可选
│     └─ manifest.yaml
├─ checkpoints/
│  └─ <checkpoint-name>/
│     ├─ checkpoint.yaml
│     ├─ checkpoint_resolve.yaml         # 可选
│     └─ checkpoint_hints.yaml           # 可选
└─ entity_rules/
   └─ <rule-pack>/
      ├─ match.yaml
      └─ annotation.yaml
```

### 3. workflow.yaml schema

字段契约：

- `version: 1` 必填。
- `id: string` 必填。
- `entry.dsl: string` 必填，相对路径。
- `entry.inputs: string` 可选，相对路径。
- `records: string[]` 可选，每项是相对目录。
- `checkpoints: string[]` 可选，每项是相对目录。
- `workspace.binding: string` 可选，相对路径。

校验约束：

- 禁止 `workflow.inputs` 顶级字段。
- `records` 与 `checkpoints` 仅允许字符串数组。
- 任何路径必须落在 `<scene>` 目录内，禁止 path escape。

### 4. workspace binding schema

`workspace.yaml` 结构：

- `version: 1`
- `workspace.strategy`: `restoreOrCreate | createOnly | restoreOnly`
- `workspace.entryUrl?: string`
- `workspace.expectedTabs?: [{ ref, urlIncludes?, exactUrl? }]`

运行时规则：

- `restoreOrCreate`：先恢复失败再创建。
- `createOnly`：仅创建。
- `restoreOnly`：仅恢复。
- `expectedTabs` 当前只校验活动页 URL（`main` 优先，否则第一项）。

### 5. records 规则

- 主写路径：`records/<recording-name>/`
- 默认录制名：`recording-YYYYMMDD-HHmmss`
- `workflow.record.save` 当前默认 `includeStepResolve: false`

`steps.yaml` 是 core steps，`step_resolve.yaml` 是 sidecar；不得混写运行时字段。

### 6. checkpoints 规则

- `checkpoint.yaml` 为主文件。
- `checkpoint_resolve.yaml` 为 step resolve sidecar。
- `checkpoint_hints.yaml` 为提示信息文件。
- `workflow.checkpoints[]` 声明的每个目录必须包含 `checkpoint.yaml`。

### 7. entity_rules 规则

- workflow 级主路径：`workflows/<scene>/entity_rules/<rule-pack>/`
- 文件要求：`match.yaml` 与 `annotation.yaml` 成对存在。
- 规则加载优先 workflow 级；缺失时回退 legacy profiles。

### 8. legacy fallback

- `workflows/<scene>/steps/<recording-name>/`：仅 legacy 读兼容。
- `agent/.artifacts/entity_rules/profiles/<profile>/`：仅规则回退。

禁止将 fallback 作为主写路径。

### 9. 文件职责

- `workflow.yaml`：manifest 入口。
- `workspace.yaml`：workspace 绑定策略。
- `dsl/main.dsl`：DSL 主流程源码。
- `records/*/steps.yaml`：可执行步骤。
- `records/*/manifest.yaml`：录制上下文快照。
- `checkpoints/*/checkpoint.yaml`：checkpoint 过程定义。
- `entity_rules/*`：业务实体语义规则。

## 示例

### workflow.yaml

```yaml
version: 1
id: order_scene
name: 订单流程
entry:
  dsl: dsl/main.dsl
  inputs: dsl/inputs.example.yaml
records:
  - records/order-create-v1
checkpoints:
  - checkpoints/ensure_logged_in
workspace:
  binding: workspace.yaml
```

### workspace.yaml

```yaml
version: 1
workspace:
  strategy: restoreOrCreate
  entryUrl: http://127.0.0.1:5173/entity-rules
  expectedTabs:
    - ref: main
      urlIncludes: /entity-rules
```

### records/<recording-name>/manifest.yaml

```yaml
version: 1
workspaceId: workflow:order_scene
entryUrl: http://127.0.0.1:5173/entity-rules
tabs:
  - tabId: tab-1
    url: http://127.0.0.1:5173/entity-rules
    title: Entity Rules
    active: true
```

## 限制

- `workflow.record.save` 当前不会自动写 `step_resolve.yaml`。
- `expectedTabs` 当前不做多 tab 全量校验。
- `records[]`、`checkpoints[]` 在 manifest 中声明后会严格检查目标文件存在。

## 禁止事项

- 禁止把 `steps/` 写成主路径。
- 禁止把 `workflow.yaml` 替换为 `manifest.yaml`。
- 禁止跨目录路径逃逸。
- 禁止把 runtime-only 数据写入 core `steps.yaml`。
