# DSL 执行器对接：Step Pipeline 规范

本文档定义 `agent/src/runner/run_steps.ts` 的对外运行模型，供 DSL 解析器/状态机模块对接。

## 1. 设计目标

- 执行器只负责执行，不负责业务编排。
- DSL 负责循环、分支、变量、重试和异常策略。
- 数据面与控制面分离：
  - 数据面：`stepsQueue`（输入）、`resultPipe`（输出）
  - 控制面：`signalChannel`（信号）

## 2. 核心对象

- `StepsQueue`
  - `items: StepUnion[]`
  - `cursor: number`
  - `closed: boolean`
- `ResultPipe`
  - `items: StepResult[]`（只 append）
- `SignalChannel`
  - `items: { signal, ts, priority }[]`
  - `cursor: number`

## 3. 信号表

- `halt`
  - 立即停机，状态变为 `halted`。
- `suspend`
  - 挂起执行，状态变为 `suspended`。
- `continue`
  - 从 `suspended` 恢复为 `running`。
- `flush`
  - 清空未执行区间（`stepsQueue.cursor..tail`）。
  - 已执行结果不会被回滚。
- `checkpoint`
  - 仅用于触发/请求快照语义，不改变执行状态。

信号优先级（高到低）：

1. `halt`
2. `flush`
3. `suspend`
4. `continue`
5. `checkpoint`

## 4. 执行器状态机

- `running`
- `suspended`
- `completed`
- `failed`
- `halted`

结束条件：

- 收到 `halt` -> `halted`
- 执行失败且 `stopOnError=true` -> `failed`
- `stepsQueue.closed=true` 且 `cursor == items.length` -> `completed`

缺 step 时：

- 不报错，不退出，等待新 step 或新信号。

## 5. DSL 模块职责边界

DSL 负责：

- 生成 step 并写入 `stepsQueue`
- 读取 `resultPipe` 做状态转移
- 根据结果决定重试/分支/补步/终止
- 在需要时发送控制信号（`suspend/continue/flush/halt`）

执行器负责：

- 顺序执行 step
- 产出 `StepResult`
- 执行信号优先级与状态切换

## 6. 推荐对接流程

1. DSL 创建 `queue/pipe/signal`。
2. 启动 `runSteps(...)`（开机）。
3. DSL 持续写 `stepsQueue`。
4. DSL 以 cursor 读取 `resultPipe`。
5. DSL 在控制需求时发送 signal。
6. DSL 完成后 `closeStepsQueue(queue)`，等待执行器自然 `completed`。

## 7. 注意事项

- `StepResult` 是单向提交流，建议 DSL 自己保存读取 cursor。
- 不要直接修改已进入队列且已执行区域的数据。
- `flush` 仅用于未执行 step，不能当作回滚机制。
