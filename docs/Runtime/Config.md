# 运行时配置

## 概述

配置系统定义 agent 运行时策略，代码位于 `agent/src/config/*`。配置源由默认值、本地文件、环境变量三级合并，最终产出 `RunnerConfig`。

## 配置职责

- `defaults.ts`：提供默认配置。
- `loader.ts`：加载 `.rpa/runner_config.json` 并应用环境变量覆盖。
- `config_schema.ts`：类型约束。
- `entity_rules.ts`：entity rules 相关默认路径与策略。

## 覆盖优先级

1. 默认值：`defaultRunnerConfig`
2. 文件覆盖：`RUNNER_CONFIG_PATH` 指定文件，默认 `.rpa/runner_config.json`
3. 环境变量覆盖：`RUNNER_*`

同一字段按后者覆盖前者。

## waitPolicy

默认字段：

- `defaultTimeoutMs: 5000`
- `interactionTimeoutMs: 12000`
- `navigationTimeoutMs: 15000`
- `a11ySnapshotTimeoutMs: 5000`
- `visibleTimeoutMs: 5000`
- `settleTimeoutMs: 800`

环境变量：

- `RUNNER_DEFAULT_TIMEOUT_MS`
- `RUNNER_INTERACTION_TIMEOUT_MS`
- `RUNNER_NAVIGATION_TIMEOUT_MS`
- `RUNNER_A11Y_SNAPSHOT_TIMEOUT_MS`
- `RUNNER_VISIBLE_TIMEOUT_MS`
- `RUNNER_SETTLE_TIMEOUT_MS`

## retryPolicy

默认：

- `enabled: false`
- `maxAttempts: 2`
- `backoffMs: 300`
- `retryableErrorCodes: [ERR_TIMEOUT, ERR_NOT_INTERACTABLE]`

环境变量：

- `RUNNER_RETRY_ENABLED`
- `RUNNER_RETRY_MAX_ATTEMPTS`
- `RUNNER_RETRY_BACKOFF_MS`

## humanPolicy

默认开启，控制拟人延迟与滚动节奏：

- 点击、输入、滚动步长与延迟区间
- `idleBehavior`

环境变量：

- `RUNNER_HUMAN_ENABLED`
- `RUNNER_CLICK_DELAY_MIN_MS` / `MAX_MS`
- `RUNNER_TYPE_DELAY_MIN_MS` / `MAX_MS`

## observability（trace/logging）

关键字段：

- `traceEnabled`
- `traceLogArgs`
- `traceConsoleEnabled`
- `traceFileEnabled`
- `traceFilePath`
- `actionConsoleEnabled`
- `actionFileEnabled`
- `actionFilePath`
- `recordConsoleEnabled`
- `recordFileEnabled`
- `recordFilePath`
- `actionLogLevel` / `recordLogLevel` / `traceLogLevel` / `stepLogLevel`

环境变量同名映射为 `RUNNER_TRACE_*`、`RUNNER_ACTION_*`、`RUNNER_RECORD_*`、`RUNNER_STEP_LOG_LEVEL`。

## confidencePolicy

用于目标解析评分：

- `enabled`
- `minScore`
- `roleWeight`
- `nameWeight`
- `textWeight`
- `selectorBonus`

环境变量：`RUNNER_CONFIDENCE_*`。

## checkpointPolicy

用于 task.run checkpoint 持久化：

- `enabled`
- `filePath`
- `flushIntervalMs`

环境变量：

- `RUNNER_CHECKPOINT_ENABLED`
- `RUNNER_CHECKPOINT_FILE_PATH`
- `RUNNER_CHECKPOINT_FLUSH_INTERVAL_MS`

## mcpPolicy

控制 MCP 工具可见性：

- `enabledToolGroups`
- `enableTools`
- `disableTools`

环境变量：

- `RUNNER_MCP_TOOL_GROUPS`
- `RUNNER_MCP_ENABLE_TOOLS`
- `RUNNER_MCP_DISABLE_TOOLS`

## runner 与 extension 的关系

配置属于 agent 运行时，不直接由 extension 加载。extension 通过 Action/WS 与 agent 交互，间接受配置影响。

## 最小配置示例

```json
{
  "waitPolicy": { "defaultTimeoutMs": 8000 },
  "checkpointPolicy": {
    "enabled": true,
    "filePath": ".artifacts/checkpoints/task_runs.json",
    "flushIntervalMs": 1000
  },
  "mcpPolicy": {
    "enabledToolGroups": [],
    "enableTools": [],
    "disableTools": ["browser.mouse"]
  }
}
```

## 配置变更联动要求

修改配置字段时必须同步：

1. `config_schema.ts` 与默认值。
2. `loader.ts` 环境变量映射。
3. 配置相关测试（`agent/tests/config/*`）。
4. 文档：本文件与关联协议文档。

## 禁止事项

- 禁止在文档声明代码中不存在的配置项。
- 禁止跳过默认值与环境变量映射校验。
