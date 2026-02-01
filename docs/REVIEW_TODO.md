# Code Review TODOs

> 说明：以下仅列出“需要改什么与问题在哪里”，不包含实施方案。

## Agent

### P0

- [P0] 统一配置未覆盖全部执行路径
  - Where: `agent/src/runner/run_steps.ts`, `agent/src/runner/trace/tools.ts`, `agent/src/runner/steps/executors/*`
  - Problem: 目前只有部分 step 使用 wait/timeout/humanPolicy，trace 层仍依赖调用方传参
  - Impact: 同一动作在不同入口下表现不一致，难以统一调参
  - Evidence: `trace.page.goto` 仅使用 args.timeout；`click/fill` 仅在 step executor 中读取 config

- [P0] a11yHint 解析策略偏弱
  - Where: `agent/src/runner/steps/helpers/a11y_hint.ts`
  - Problem: 仅做浅层 role/name/text 匹配，歧义处理有限
  - Impact: 复杂页面可能返回 ERR_AMBIGUOUS/ERR_NOT_FOUND
  - Evidence: 解析逻辑为单次查找，缺少候选摘要输出

- [P0] runSteps 覆盖范围有限
  - Where: `agent/src/runner/steps/*`, `agent/src/runner/tool_registry.ts`
  - Problem: v0 只支持 goto/snapshot/click/fill
  - Impact: 其它动作暂时不可用或需要回退（ERR_NOT_IMPLEMENTED）
  - Evidence: tool_registry 仅定义 4 个工具，actions 已大量收敛

- [P0] 录制/回放缺少串行队列与状态机
  - Where: `agent/src/play/replay.ts`, `agent/src/runner/actions/recording.ts`
  - Problem: 回放执行与录制状态并发管理依赖简单 flag
  - Impact: 并发操作时可能遗漏/重复执行
  - Evidence: `replay.ts` 直接遍历 step；recording 状态仅在 action 层维护

### P1

- [P1] Task DSL/运行日志未形成持久化审计链路
  - Where: `agent/src/runner/run_steps.ts`, `agent/src/runner/trace/*`
  - Problem: step/trace 日志仅输出到 console/memory
  - Impact: 无法长期审计与复现
  - Evidence: step/trace 日志未落盘
  - Notes: Architecture Evolution

- [P1] legacy actions 未完全退役
  - Where: `agent/src/runner/actions/*`
  - Problem: 仍保留 a11y/workspace/recording/steps 动作，边界需进一步收敛
  - Impact: 入口不一致，易产生重复逻辑
  - Evidence: `actions/index.ts` 仍导出少量 legacy actions
  - Notes: Architecture Evolution

### P2

- [P2] Session/Workspace 持久化与恢复缺失
  - Where: `agent/src/runtime/runtime_registry.ts`
  - Problem: 运行时模型仅内存态
  - Impact: 重启后会话丢失
  - Evidence: registry 仅使用 Map，无落盘/恢复逻辑
  - Notes: Architecture Evolution（DSL/日志字段需预留 sessionId）

- [P2] TabGroup 多页编排能力缺失
  - Where: `agent/src/runtime/runtime_registry.ts`, `agent/src/runner/run_steps.ts`
  - Problem: workspace 内多 tab 仅支持 active tab
  - Impact: 无法跨页面读写与策略编排
  - Evidence: runSteps 只解析 active page
  - Notes: Architecture Evolution（DSL/日志字段需预留 tabId/groupId）

## MCP & Demo

### P0

- [P0] 工具调用仍依赖模型产出的 a11yNodeId/a11yHint
  - Where: `agent/src/runner/tool_registry.ts`, `agent/src/demo/agent_loop.ts`
  - Problem: 模型可能不调用工具或提供弱 hint
  - Impact: 任务可用性不稳定
  - Evidence: tool schema 仅提供 a11yNodeId/a11yHint，缺少强制约束

### P1

- [P1] 缺少统一任务日志输出
  - Where: `agent/src/demo/agent_loop.ts`
  - Problem: demo UI 仅展示 toolEvents
  - Impact: 无法审计/复现
  - Evidence: demo 未持久化 step 日志
  - Notes: Architecture Evolution

## Extension

### P0

- [P0] Workspace Explorer 已实现最小闭环，但缺少人机协同与调试面板增强
  - Where: `extension/src/ui/panel/*`
  - Problem: 仅支持基础 workspace/tab 切换与日志输出
  - Impact: 复杂场景下可用性与诊断能力不足
  - Evidence: panel 仅展示列表与基础日志，无 human-in-loop

- [P0] WS 错误处理粗糙
  - Where: `extension/src/background/ws_client.ts`
  - Problem: 连接失败仅返回文本错误
  - Impact: 用户难以定位问题
  - Evidence: 连接失败仅打印日志，没有分类/提示

### P1

- [P1] 录制器未提供持久化恢复
  - Where: `extension/src/record/record_store.ts`
  - Problem: 仅存储在 storage.local，缺少跨会话恢复策略
  - Impact: 浏览器重启后录制数据丢失
  - Evidence: record_store 仅提供保存/加载（无版本/迁移）
  - Notes: Architecture Evolution

### P2

- [P2] 人机协同缺失
  - Where: `extension/src/ui/panel/*`, `extension/src/record/*`
  - Problem: 目标歧义时没有人工选择与回写
  - Impact: 自动化稳定性下降
  - Evidence: 无相关 UI/flow
  - Notes: Architecture Evolution

- [P2] tabGroups/垂直标签页属于增强能力
  - Where: `extension/src/services/tab_grouping.ts`
  - Problem: 分组与垂直标签页仅能尽力而为
  - Impact: 视觉增强不可用时需要明确降级
  - Evidence: tabGroups 调用失败仅降级处理
