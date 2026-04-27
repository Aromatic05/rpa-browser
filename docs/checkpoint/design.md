# Checkpoint 设计文档

## 2.1 设计定位

checkpoint 不是单纯 recovery。checkpoint 是失败上下文下执行的过程模板，用来在 step 失败后执行一组受控动作。当前实现位于 [agent/src/runner/checkpoint/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/types.ts)、[agent/src/runner/checkpoint/runtime.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/runtime.ts)、[agent/src/runner/checkpoint/run.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/run.ts)。

checkpoint 的内容仍由已有 step 和 `CheckpointAction` 组成。当前 `CheckpointAction` 支持 `snapshot`、`query`、`compute`、`act`、`wait`。这意味着 checkpoint 可以执行 query、compute、act、wait，可以读取 `input`，可以写入 `local`，可以产生 `output`。在 checkpoint 执行成功后，运行时还可以重试原始 step；当 `policy.retryOriginal: false` 时，运行时直接返回 checkpoint result，不再重试原始 step。

checkpoint 的价值在于把失败处理、数据查询、动作重试变成可序列化过程。失败后的恢复逻辑不再散落在运行时代码里，而是落到 YAML 中，由 runner 读取并执行。当前实现仍然复用已有 step executor，checkpoint 不负责浏览器底层操作细节，也不向 `browser.click`、`browser.fill`、`browser.select_option` 注入业务目标对象。动作 step 依旧只消费 `nodeId`、`selector` 这一层参数。

checkpoint 不替代 `browser.query`。checkpoint 里的查询动作是调用现有 `browser.query` 能力完成实体查询、分页查询、节点查询。checkpoint 不替代 entity-rules。实体识别、表格识别、分页识别、业务字段绑定仍由 snapshot 与 entity-rules 模块负责。checkpoint 也不替代 DSL。当前 v1 仅支持固定动作模型与已有 step 组合，没有实现新的声明式语言。

## 2.2 v1 能力边界

### 已支持能力

- `trigger.matchRules`
- `prepare`
- `content`
- `output`
- `policy.maxAttempts`
- `policy.retryOriginal`
- `policy.stopOnFailure`
- `input`、`local`、`output` scope
- `CheckpointAction`
- scoped ref
- retry original step
- `retryOriginal: false`
- `maxAttempts` 防循环

### 不支持内容

- DSL
- pagination loop
- full diagnostics UI
- cross-run ref
- complex pipeline
- complex expression language
- action 业务目标对象
- browser action 内置业务语义解析

`table.hasNextPage` 与 `table.nextPageTarget` 已属于 entity-rules query 能力，入口在 [agent/src/runner/steps/executors/query.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/query.ts) 与 [agent/src/runner/steps/executors/snapshot/core/business_entity_resolver.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/steps/executors/snapshot/core/business_entity_resolver.ts)。checkpoint 可以调用这些 query 获取分页信息，但 checkpoint 自身不实现 pagination loop。

## 2.3 数据模型

Checkpoint 核心结构定义在 [agent/src/runner/checkpoint/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/types.ts)，当前字段包括：

- `id`：checkpoint 唯一标识。
- `kind`：当前支持 `procedure`、`recovery`、`guard`。
- `name`：可读名称。
- `trigger.matchRules`：唯一触发规则入口。
- `prepare`：内容前置动作列表。
- `content`：主体内容，允许序列化 step（`id` / `name` / `args` / `resolveId`）与 `CheckpointAction`。
- `output`：结束时从 scope 取值并落入最终输出。
- `policy`：重试与失败策略。
- `enabled`：关闭后不参与匹配。
- `priority`：候选排序权重。

`policy` 当前字段包括：

- `maxAttempts`
- `retryOriginal`
- `stopOnFailure`

触发规则的唯一入口是 `trigger.matchRules`。checkpoint 根级规则数组不是当前格式，`policy` 下嵌套触发器也不是当前格式。这个限制由 [agent/src/runner/serialization/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/serialization/types.ts) 的 `validateCheckpointFileForSerialization` 校验。

`CheckpointAction` 当前语义如下：

- `snapshot`：执行 `browser.snapshot`。
- `query`：执行 `browser.query`。
- `compute`：执行 `browser.compute`。
- `act`：执行已有动作 step。
- `wait`：执行纯等待。
- `saveAs`：把 action 结果写入 `local` scope。
- `output`：在 checkpoint 结束时把 scope 中的值写入最终输出。

scope 只有三层：

- `input`
- `local`
- `output`

scoped ref 示例：

```yaml
id:
  ref: local.submitTarget.nodeId
```

scoped ref 用在 checkpoint runtime，由 [agent/src/runner/checkpoint/runtime.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/runtime.ts) 解析。它不是 runner string ref。它是结构化对象，不是字符串模板。

## 2.4 runner step ref 与 checkpoint scoped ref

runner step ref 示例：

```yaml
id: "{{resolveSubmit.data.nodeId}}"
```

使用位置：

- `runSteps` 普通 Step args
- `query -> click/fill/select` 组合
- 由 runner 在执行 step 前解析
- 只引用同一 run 中已经完成的 step result
- 不跨 run
- 不支持字符串局部插值

支持格式：

- `{{stepId.data.nodeId}}`
- `{{stepId.data.value}}`
- `{{stepId.data.nodeIds.0}}`

当前实现位于 [agent/src/runner/step_refs.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/step_refs.ts) 与 [agent/src/runner/run_steps.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/run_steps.ts)。

checkpoint scoped ref 示例：

```yaml
id:
  ref: local.submitTarget.nodeId
```

使用位置：

- checkpoint `content` 中的 `CheckpointAction`
- checkpoint runtime 内部解析
- 读取 `input`、`local`、`output`
- 用于 query `saveAs` 之后传给 act

checkpoint core YAML 示例使用 scoped ref。checkpoint core YAML 不使用 runner string ref。普通 `steps.yaml` 可以使用 runner string ref。

## 2.5 YAML 序列化边界

当前序列化边界定义在 [agent/src/runner/serialization/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/serialization/types.ts)。

### `steps.yaml`

- 保存普通 step 执行语义
- 允许 runner step ref
- 禁止 `resolve`、`hint`、`rawContext`、`locatorCandidates`、`replayHints`

### `step_resolve.yaml`

- 保存 step 的 resolve sidecar
- 允许 `hint`、`policy`
- 通过 `resolveId` 关联，不参与核心执行语义
- `Step.resolve` 不是废弃功能，但仅作为 runtime-only 字段注入执行态
- checkpoint content 内的 step-like item 也只保留 `id` / `name` / `args` / `resolveId`

### `checkpoints.yaml`

- 保存 checkpoint 核心执行语义
- 使用 `trigger`、`content`、`output`、`policy`
- 使用 checkpoint scoped ref
- 禁止 runner string ref
- 禁止 `resolve`、`hint`、`rawContext`、`locatorCandidates`、`replayHints`

### `checkpoint_hints.yaml`

- 保存解释、`fallbacks`、`preferredEntityRules`、`notes`
- 不参与核心执行语义

core YAML 任意层级禁止 `resolve`、`hint`、`rawContext`、`locatorCandidates`、`replayHints`。sidecar hints YAML 才允许这些内容。`agent/.artifacts` 是运行时产物目录，不保存仓库示例。

## 2.6 checkpoints.yaml 示例

```yaml
version: 1
checkpoints:
  - id: recover-order-form-submit
    kind: recovery
    name: 恢复订单表单提交按钮
    trigger:
      matchRules:
        - stepName: browser.click
        - errorCode: ERR_NOT_FOUND
    content:
      - type: query
        saveAs: submitTarget
        args:
          op: entity.target
          businessTag: order.form.main
          target:
            kind: form.action
            actionIntent: submit
      - type: act
        step:
          name: browser.click
          args:
            id:
              ref: local.submitTarget.nodeId
    policy:
      maxAttempts: 1
      retryOriginal: false
```

这个示例与 [agent/tests/fixtures/checkpoints/order_form_submit.checkpoints.yaml](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/fixtures/checkpoints/order_form_submit.checkpoints.yaml) 一致。`resolve submit action` 由 `browser.query` 完成，`click` 仍只消费 `nodeId`。checkpoint runtime 解析 `local.submitTarget.nodeId`，checkpoint 没有让 `browser.click` 理解业务目标对象。

## 2.7 checkpoint_hints.yaml 示例

```yaml
version: 1
hints:
  recover-order-form-submit:
    why: 订单提交按钮 DOM 结构不稳定时，通过业务实体重新定位 submit action
    scope:
      businessTag: order.form.main
    preferredEntityRules:
      - order_form
      - order_form_submit
    fallbacks:
      - kind: role
        role: button
        name: 提交
      - kind: text
        text: 提交
    notes:
      - 优先使用 entity-rules 解析出的 form.action
```

`hints` 不参与 checkpoint 核心执行。`hints` 可以被 AI 生成，也可以被人工修改，但不进入 `checkpoints.yaml`。相关类型定义位于 [agent/src/runner/serialization/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/serialization/types.ts)，测试夹具位于 [agent/tests/fixtures/checkpoints/order_form_submit.checkpoint_hints.yaml](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/fixtures/checkpoints/order_form_submit.checkpoint_hints.yaml)。

## 2.8 v1 完工标准

- runner result ref 不依赖 active page
- Step YAML / Checkpoint YAML hint 外置
- order-form 真实链路 `query -> fill/click` 通过
- order-list 真实链路 `row_count/current_rows/row_action -> click` 通过
- `matchRules` 支持 `errorCode`、`stepName`、`urlIncludes`、`textVisible`、`entityExists`
- `content` 支持 `query`、`compute`、`act`、`wait`
- `input`、`local`、`output` 生效
- `retryOriginal` 默认重试路径有测试
- `retryOriginal: false` 路径有测试
- `maxAttempts` 生效
- `click`、`fill`、`select_option` 只消费 `nodeId`、`selector`

这些能力分别覆盖在 [agent/tests/runner/checkpoint/checkpoint_runtime.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint_runtime.test.ts)、[agent/tests/runner/checkpoint/checkpoint_flow.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint_flow.integration.test.ts)、[agent/tests/runner/checkpoint/checkpoint_procedure.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint_procedure.integration.test.ts)、[agent/tests/runner/entity_query_action.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/entity_query_action.integration.test.ts)。

## 2.9 明确不属于 checkpoint 的内容

- DSL
- entity-rules 规则匹配实现
- pagination 识别逻辑
- browser action target 解析
- full diagnostics UI
- profile selection
- runtime artifacts 管理
