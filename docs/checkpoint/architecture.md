# Checkpoint 架构文档

## 3.1 模块总览

checkpoint 主链路分布在以下文件：

- [agent/src/runner/checkpoint/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/types.ts)：定义 checkpoint 数据结构、`MatchRule`、`CheckpointAction`、`CheckpointCtx`、scope。
- [agent/src/runner/checkpoint/match.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/match.ts)：负责触发规则计算、候选过滤、优先级排序、`maxAttempts` 限制。
- [agent/src/runner/checkpoint/bind.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/bind.ts)：负责旧式 `StepUnion` content 的上下文绑定。
- [agent/src/runner/checkpoint/runtime.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/runtime.ts)：负责执行 `CheckpointAction`、解析 scoped ref、管理 `input/local/output`。
- [agent/src/runner/checkpoint/fold.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/fold.ts)：负责将 checkpoint result 折叠为最终 `StepResult`。
- [agent/src/runner/checkpoint/index.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/index.ts)：负责对外暴露主流程 API，把各子模块串起来。
- [agent/src/runner/serialization/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/serialization/types.ts)：负责 YAML core 与 hints sidecar 的边界校验。
- [agent/src/runner/run_steps.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/run_steps.ts)：负责普通 step 执行、runner step ref 解析、step 失败后进入 checkpoint。

`index.ts` 的对外入口实际委托给 [agent/src/runner/checkpoint/main.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/main.ts)，主流程顺序与文档下文一致。

## 3.2 主流程

```text
runSteps
  -> executeOne
  -> step failed
  -> getFailedCtx
  -> runCheckpoint
     -> createCheckpointCtx
     -> maybeEnterCheckpoint
     -> maybePickCheckpoint
     -> maybeBindCheckpoint
     -> maybeRunCheckpoint
     -> maybeRetryOriginalStep
     -> foldCheckpointResult
```

每一步的输入输出如下：

- `runSteps`：维护 queue、signal、run-local step result map，位于 [agent/src/runner/run_steps.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/run_steps.ts)。
- `executeOne`：执行单个普通 step，并在执行前解析 runner step ref。
- `step failed`：当 step 返回 `ok: false` 时，runner 保留原始失败结果，准备创建 `FailedCtx`。
- `getFailedCtx`：收集 `runId`、`workspaceId`、失败 step、失败结果、当前 URL、依赖对象，位于 [agent/src/runner/failed_ctx.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/failed_ctx.ts)。
- `runCheckpoint`：checkpoint 总入口，创建 `CheckpointCtx`，串联 enter、pick、bind、run、retry、fold。
- `createCheckpointCtx`：初始化 `active`、`finalResult`、`meta`。
- `maybeEnterCheckpoint`：判断当前失败是否允许进入 checkpoint。
- `maybePickCheckpoint`：从候选 checkpoint 中选出命中的一个。
- `maybeBindCheckpoint`：仅对旧式 `StepUnion` content 进行失败上下文绑定。
- `maybeRunCheckpoint`：执行 `CheckpointAction` procedure 或绑定后的普通 step 列表。
- `maybeRetryOriginalStep`：在 checkpoint 成功后按策略决定是否重试原始 step。
- `foldCheckpointResult`：将 raw result、checkpoint result、retry result 折叠成最终 `StepResult` 并回到 runner。

## 3.3 FailedCtx

`FailedCtx` 定义在 [agent/src/runner/failed_ctx.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/failed_ctx.ts)。当前显式字段包括：

- `runId`
- `workspaceId`
- `step`
- `rawResult`
- `checkpointAttempt`
- `checkpointMaxAttempts`
- `deps`
- `executeStep`
- `currentUrl`

从概念上看，`FailedCtx` 覆盖以下失败上下文：

- runId
- workspaceId
- failed step
- failed result
- page context
- errorCode
- stepName
- url
- visible text context
- entity context

其中 `errorCode` 来自 `rawResult.error?.code`，`stepName` 来自 `step.name`，`url` 当前显式落在 `currentUrl`。`visible text context` 与 `entity context` 当前没有预先缓存为结构化字段，而是在 [agent/src/runner/checkpoint/match.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/match.ts) 执行 `textVisible`、`entityExists` 时按需读取 active page 与 fresh snapshot。

## 3.4 CheckpointCtx

`CheckpointCtx` 定义在 [agent/src/runner/checkpoint/types.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/types.ts)。它的职责是把 checkpoint 主流程中间状态集中到一个对象上，供 `match`、`runtime`、`fold` 共享。

当前职责包括：

- 保存 `runId`、`workspaceId`，这些信息通过 `failedCtx` 间接持有。
- 保存 `failedCtx`。
- 保存候选选中的 checkpoint，字段是 `checkpoint`。
- 保存当前尝试次数，来源是 `failedCtx.checkpointAttempt`。
- 保存 `input/local/output`。其中实际 scope 在 procedure runtime 内部创建，`CheckpointCtx` 保存运行后的 `runResult` 与输出结果。
- 保存执行结果，包括 `runResult`、`retryResult`、`finalResult`。
- 给 `runtime` 与 `fold` 提供上下文。

## 3.5 matchRules 选择流程

`matchRules` 只定义在 `trigger.matchRules`。disabled checkpoint 不参与选择，`priority` 决定候选顺序，`policy.maxAttempts` 限制同一 failed step 的进入次数。实现位于 [agent/src/runner/checkpoint/match.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/match.ts)。

当前选择流程如下：

1. 读取 checkpoint 列表。
2. 过滤 `enabled !== false`。
3. 过滤超过 `policy.maxAttempts` 的候选。
4. 先按首个 `stepName` 与失败 step 做快速剪枝。
5. 先按首个 `errorCode` 与失败结果做快速剪枝。
6. 按 `priority` 倒序排序。
7. 对每个候选顺序执行 `matchRules`。
8. 首个全部命中的候选成为当前 checkpoint。

当前支持的 matchRule 包括：

- `errorCode`
- `stepName`
- `urlIncludes`
- `textVisible`
- `entityExists`

`matchRules` 不执行动作。`matchRules` 只决定是否进入 checkpoint。

## 3.6 runtime 执行流程

checkpoint runtime 位于 [agent/src/runner/checkpoint/runtime.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/runtime.ts)。

`CheckpointAction` 执行语义如下：

- `snapshot`：构造 `browser.snapshot` step 并交给已有 step executor。
- `query`：构造 `browser.query` step 并交给已有 step executor。
- `compute`：构造 `browser.compute` step 并交给已有 step executor。
- `act`：构造已有动作 step 并交给已有 step executor。
- `wait`：仅等待指定毫秒数。
- `saveAs`：把 step result 的 `data` 写入 `local`。
- `output`：在 procedure 结束时把指定值写入 `output`。

`query` action 调用已有 `browser.query` 能力。`act` action 调用已有 step executor。`wait` action 只负责等待。`saveAs` 写入 `local`。`output` 写入 `output`。runtime 使用 scoped ref 解析 `input`、`local`、`output`，不依赖 run-local step result map。

## 3.7 retry 与 fold

retry 与 fold 位于 [agent/src/runner/checkpoint/fold.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/checkpoint/fold.ts)。

checkpoint 执行成功后，当 `policy.retryOriginal !== false` 时，runner 会重试原始 step。retry 成功时，最终 `StepResult` 使用 retry result。retry 失败时，`stopReason` 记为 `checkpoint_retry_failed`，最终结果回退到合理失败结果而不是伪造成功。

当 `policy.retryOriginal === false` 时，不重试原始 step，checkpoint result 成为最终结果。`maxAttempts` 由 `match.ts` 在进入前拦截，防止同一失败 step 无限重入 checkpoint。

## 3.8 与 runner step ref 的关系

[agent/src/runner/run_steps.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/run_steps.ts) 维护 run-local result map。runner step ref 从这个 map 读取，解析逻辑位于 [agent/src/runner/step_refs.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/src/runner/step_refs.ts)。

runner step ref 不依赖 `ensureActivePage`。它只依赖当前 run 中已经完成的 step 结果。checkpoint runtime 的 scoped ref 不从 run-local result map 读取，而是从 `input/local/output` scope 读取。两套 ref 的作用域不同，解析器不同，序列化格式也不同。

## 3.9 测试覆盖

当前相关测试与夹具路径包括：

- [agent/tests/runner/serialization/serialization_yaml.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/serialization/serialization_yaml.test.ts)
- [agent/tests/runner/serialization/workflow_artifacts.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/serialization/workflow_artifacts.test.ts)
- [agent/tests/runner/entity_query_action.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/entity_query_action.integration.test.ts)
- [agent/tests/runner/checkpoint/checkpoint.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint.test.ts)
- [agent/tests/runner/checkpoint/checkpoint_runtime.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint_runtime.test.ts)
- [agent/tests/runner/checkpoint/checkpoint_flow.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint_flow.integration.test.ts)
- [agent/tests/runner/checkpoint/checkpoint_procedure.integration.test.ts](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/runner/checkpoint/checkpoint_procedure.integration.test.ts)
- [agent/tests/fixtures/workflows/order-form/checkpoints/order-form-submit/checkpoint.yaml](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/fixtures/workflows/order-form/checkpoints/order-form-submit/checkpoint.yaml)
- [agent/tests/fixtures/workflows/order-list/checkpoints/order-list-row-action/checkpoint.yaml](/home/aromatic/Applications/OwnProject/rpa-browser/agent/tests/fixtures/workflows/order-list/checkpoints/order-list-row-action/checkpoint.yaml)

## 3.10 明确不属于 checkpoint 架构的内容

- entity-rules matcher 内部实现
- pagination disabled 判断
- browser action 的底层 Playwright 执行细节
- DSL 编译
- profile selection 策略
