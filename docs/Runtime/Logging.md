# 日志与观测

## 概述

日志系统位于 `agent/src/logging/logger.ts`，用于统一 Action、record、trace、step、entity、dsl 六类日志输出，并支持 console/file 双通道。

## 日志类别

`LogType` 当前固定为：

- `action`
- `record`
- `trace`
- `step`
- `entity`
- `dsl`

新增类别需要改类型定义与配置映射。

## 输出策略

每个类别由 `observability` 决定：

- `consoleEnabled`
- `fileEnabled`
- `filePath`
- `minLevel`

文件输出格式为 JSONL，每行结构：

```json
{"ts":1710000000000,"type":"action","level":"warning","message":["..."]}
```

## 路径模板

`resolveLogPath` 支持 `{ts}` 占位符；未包含时会自动追加时间戳后缀。

## 关键类别事件（代码事实）

- `action`：Action 请求、目标解析、生命周期事件、WS 通道事件。
- `record`：录制启动/停止、录制事件落盘。
- `trace`：`op.start/op.end`。
- `step`：`step.start/step.end`。
- `entity`：entity 规则加载、overlay 合并相关日志。
- `dsl`：DSL 解析、规范化、校验和执行诊断。

## 关键排查场景

### workflow.open 失败

优先看：

1. `action` 日志中 `workflow.open` 的失败码。
2. `ERR_WORKFLOW_*` 细节（manifest、路径、workspace 绑定）。
3. 是否命中 `missing action target`（WS pageless 范围不足时）。

### workflow.dsl.test 失败

优先看：

1. `dsl` 类别中的语法/校验诊断。
2. `step` 与 `trace` 的首个失败 step。
3. 关联 checkpoint 或 resolve 失败码。

### resolve_scope_from_token.miss

该事件在 `runtime/page_registry.ts` 记录，表示 token 无法映射到 workspace/tab。需检查：

1. token 是否已过期。
2. extension background 是否完成 `tab.init/tab.opened`。
3. 是否跨窗口拖拽导致映射漂移。

### tab.opened.defer_claim

该事件在 `agent/src/index.ts`，表示 `tab.opened` 到达时 workspace 尚未可直接 claim，进入延迟认领重试流程。需检查窗口映射与 token 绑定先后顺序。

### checkpoint 失败

查看 `runner/checkpoint/*` 相关事件：

- resolve 失败
- guard/assert 未通过
- recover 未收敛

并结合 `step` 与 `trace` 定位原子操作失败点。

## 日志新增规则

新增日志必须满足：

1. 归属明确类别。
2. 事件名稳定，可用于检索。
3. 不输出敏感信息明文。
4. 错误日志包含可复现的上下文字段（workspaceId/tabToken/stepId）。

## 限制

- `step` 类别默认 console/file 都关闭，仅保留 `stepLogLevel`，属于当前实现限制。
- logger 是轻量封装，不包含集中式聚合与索引功能。

## 禁止事项

- 禁止用 `console.log` 替代分类 logger。
- 禁止新增不可检索的随意文本日志。
