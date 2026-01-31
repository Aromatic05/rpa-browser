# Code Review TODOs

> 说明：以下仅列出“需要改什么与问题在哪里”，不包含实施方案。

## Agent

### P0

- [P0] 工具统一等待/超时策略入口缺失
  - Where: `agent/src/runner/execute.ts`, `agent/src/runner/actions/*`
  - Problem: 等待与超时分散在各动作，缺少统一入口
  - Impact: 行为不一致、易 flake、难调参
  - Evidence: `element_click.ts`/`element_scroll.ts`/`navigation.ts`/`click.ts`/`type.ts` 各自硬编码等待与超时

- [P0] 行为参数分散（BehaviorPolicy/Persona 入口缺失）
  - Where: `agent/src/index.ts`, `agent/src/demo/server.ts`, `agent/src/play/replay.ts`, `agent/src/runner/actions/scroll.ts`
  - Problem: 人类化延迟、滚动、鼠标行为散落在多处
  - Impact: 无法统一控制行为策略、难以复现
  - Evidence: `CLICK_DELAY_MS`/`REPLAY_STEP_DELAY_MS`/`SCROLL_CONFIG` 与 `scroll.ts` 内随机逻辑并存

- [P0] strict violation/歧义目标未结构化处理（需要 candidates）
  - Where: `agent/src/runtime/target_resolver.ts`, `agent/src/runner/tool_registry.ts`, `agent/src/runner/actions/locators.ts`
  - Problem: tool schema 允许裸 selector；失败时仅返回文本错误
  - Impact: 模型可能乱写 selector，错误不可审查
  - Evidence: `tool_registry.ts` 中 `target.selector` 必填；`target_resolver.ts` 仅接受 selector；错误映射为 `ERR_BAD_ARGS`

- [P0] 工具 API 与人类操作模型不统一（仅用变量区分）
  - Where: `agent/src/runner/commands.ts`, `agent/src/record/recorder_payload.ts`, `agent/src/play/replay.ts`, `agent/src/runner/tool_registry.ts`
  - Problem: 录制/回放/工具调用的模型未统一到同一 Action/Command 体系
  - Impact: 审计与回放难以一致化
  - Evidence: `RecordedEvent` 与 `Command` 结构不同，回放中手工映射 `RecordedEvent -> Command`

- [P0] Idle 行为缺少集中管理与可复现控制
  - Where: `agent/src/runner/*`, `agent/src/demo/agent_loop.ts`
  - Problem: 无统一 idle/think 行为管理
  - Impact: 行为不可复现，难以审计
  - Evidence: Not found / missing module（未发现 idle policy 或开关）

- [P0] 录制/回放缺少串行队列与状态机
  - Where: `agent/src/record/recording.ts`, `agent/src/play/replay.ts`, `agent/src/runner/actions/recording.ts`
  - Problem: 回放执行与录制状态并发管理依赖散落的 flag，未统一串行控制
  - Impact: 并发操作时可能导致遗漏/重复执行或停不下来
  - Evidence: `recording.ts` 使用 `recordingEnabled`/`replayCancel` 集合；`replay.ts` 直接遍历执行

- [P0] 工具输入校验与错误结构不一致
  - Where: `agent/src/runner/execute.ts`, `agent/src/runner/actions/*`
  - Problem: 仅部分路径返回结构化错误，部分异常直接抛出
  - Impact: 调用端难以统一处理失败原因
  - Evidence: `execute.ts` 依赖 ActionError，但多个 actions 内直接 `throw new Error(...)`

- [P0] Selector/Target 解析分裂
  - Where: `agent/src/runtime/target_resolver.ts`, `agent/src/runner/actions/locators.ts`, `agent/src/runner/actions/click.ts`
  - Problem: 同时存在运行时 target_resolver 与 actions 内部的 locators
  - Impact: 行为不一致，难以统一定位策略
  - Evidence: `click.ts`/`type.ts` 使用 `actions/locators.ts`，而 `execute.ts` 走 `runtime/target_resolver.ts`

- [P0] A11y 输出与错误信息结构化不足
  - Where: `agent/src/runner/actions/a11y.ts`
  - Problem: 报告结构未与工具统一抽象/缺乏策略化输出
  - Impact: 上层难以直接消费、审计与过滤
  - Evidence: 直接返回 Axe 原始结构或简单封装

### P1

- [P1] 录制日志未形成可审计 Task DSL
  - Where: `agent/src/record/recorder_payload.ts`, `agent/src/record/recording.ts`, `agent/src/play/replay.ts`
  - Problem: 录制事件结构偏原始，缺乏 DSL 语义层
  - Impact: 难以审查与复现复杂任务
  - Evidence: `RecordedEvent` 直接存 selector/text/value，缺少 DSL 结构
  - Notes: Architecture Evolution

- [P1] 行为参数分散
  - Where: `agent/src/index.ts`, `agent/src/demo/server.ts`, `agent/src/play/replay.ts`, `agent/src/runner/actions/*`
  - Problem: 延迟/滚动/人类化参数散落在多个模块
  - Impact: 无法统一控制行为策略
  - Evidence: `CLICK_DELAY_MS`/`REPLAY_STEP_DELAY_MS`/`SCROLL_CONFIG` 分别存在
  - Notes: Architecture Evolution

- [P1] 工具体系缺乏层次结构
  - Where: `agent/src/runner/actions/*`, `agent/src/runner/tool_registry.ts`
  - Problem: L0/L1/L2 动作混杂，缺乏清晰层次
  - Impact: 复用困难，策略难以编排
  - Evidence: `element_click.ts` 与 `click.ts` 等重复实现
  - Notes: Architecture Evolution

### P2

- [P2] Session/Workspace 持久化与恢复缺失
  - Where: `agent/src/runtime/page_registry.ts`
  - Problem: 已有 workspace/tabs 运行时模型，但缺少持久化与恢复能力
  - Impact: 重启后会话丢失，无法恢复并行 session
  - Evidence: `page_registry.ts` 仅内存 Map，无落盘/恢复逻辑
  - Notes: Architecture Evolution（DSL/日志字段需预留 sessionId）

- [P2] TabGroup 模型缺失（跨页面读写）
  - Where: `agent/src/runtime/page_registry.ts`, `agent/src/play/replay.ts`
  - Problem: 当前仅支持单 Page 绑定，不存在 tabGroup 抽象
  - Impact: 无法跨页面读写与分组管理
  - Evidence: Not found / missing module（未发现 tabGroup 结构）
  - Notes: Architecture Evolution（DSL/日志字段需预留 tabId/groupId）

- [P2] 行为模式（fast vs humanlike）未统一
  - Where: `agent/src/runner/actions/*`, `agent/src/play/replay.ts`
  - Problem: 人类化行为仅部分 actions 覆盖
  - Impact: 行为一致性与可复现性不足
  - Evidence: `scroll.ts` 仅在特定路径使用人类化滚动
  - Notes: Architecture Evolution

## MCP & Demo

### P0

- [P0] 工具调用稳定性不足
  - Where: `agent/src/runner/tool_registry.ts`, `agent/src/demo/agent_loop.ts`
  - Problem: tool schema 允许 selector 直接输入，模型可能产生不受控 selector
  - Impact: 导致执行失败或点击错误元素
  - Evidence: tool schema 中 `target.selector` 直接开放

- [P0] Demo 缺少实时输出流
  - Where: `agent/src/demo/server.ts`, `agent/static/index.html`
  - Problem: /api/chat 为一次性返回，缺少 SSE/流式进度
  - Impact: 用户无法看到即时执行过程
  - Evidence: 仅提供一次性 JSON 响应

### P1

- [P1] 缺少 Task DSL 运行日志
  - Where: `agent/src/demo/agent_loop.ts`, `agent/src/record/*`
  - Problem: toolEvents 与 messages 仅用于 UI 展示，未形成 DSL 日志
  - Impact: 无法做审计与回放复现
  - Evidence: 无 DSL 结构化日志模块
  - Notes: Architecture Evolution

- [P1] Prompt 约束不足
  - Where: `agent/src/demo/agent_loop.ts`
  - Problem: LLM 仍可能直接回答不调用工具
  - Impact: 任务结果不可靠
  - Evidence: 依赖模型行为，没有强制执行策略

### P2

- [P2] MCP 与 Demo 的观察性不足
  - Where: `agent/src/mcp/server.ts`, `agent/src/demo/server.ts`
  - Problem: 缺少统一日志/事件订阅
  - Impact: 无法统一审计或回放
  - Evidence: 仅 stderr/stdout 打印
  - Notes: Architecture Evolution

## Extension

### P0

- [P0] Workspace Explorer 已实现最小闭环，但缺少人机协同与调试面板增强
  - Where: `extension/src/panel.ts`, `extension/panel.html`
  - Problem: 仅支持基础 workspace/tab 切换与日志输出，缺少人类纠错与更丰富的状态反馈
  - Impact: 复杂场景下可用性与诊断能力不足
  - Evidence: Side panel 仅展示列表与基础日志，无 human-in-loop 交互

- [P0] （已解决）新建标签页悬浮球不显示（NTP/扩展页不可注入）
  - Where: `mock/pages/start.html`, `extension/src/panel.ts`, `extension/src/content.ts`
  - Problem: chrome://newtab 与扩展页无法注入 content script，导致浮层缺失
  - Impact: 新建 tab 无法稳定自动化
  - Evidence: 新建 tab 默认导航到本地 mock start page（`http://localhost:<PORT>/pages/start.html#beta`）
  - Notes: Resolved by local mock start page

- [P0] WS 错误处理粗糙
  - Where: `extension/src/sw.ts`
  - Problem: WS 连接失败仅返回文本错误
  - Impact: 用户难以诊断问题
  - Evidence: `respondOnce({ ok: false, error: 'ws error' })`

### P1

- [P1] 录制引擎仍依赖 CSS 选择器
  - Where: `agent/src/record/recorder_payload.ts`
  - Problem: CSS selector 易碎，语义候选不足
  - Impact: 回放易失败
  - Evidence: selectorFor 主要输出 css 结构，候选数量有限

- [P1] 人机协同缺失
  - Where: `extension/src/panel.ts`, `extension/src/content.ts`
  - Problem: 目标歧义时没有人工选择与回写
  - Impact: 自动化稳定性下降
  - Evidence: 无相关 UI/flow
  - Notes: Architecture Evolution

### P2

- [P2] Session/TabGroup UI 缺失
  - Where: `extension/src/*`
  - Problem: 无多会话管理视图
  - Impact: 无法进行并行或恢复
  - Evidence: panel 未支持 session 列表
  - Notes: Architecture Evolution

- [P2] tabGroups/垂直标签页属于增强能力（需降级路径与用户引导）
  - Where: `extension/src/sw.ts`, `extension/src/panel.ts`
  - Problem: 分组与垂直标签页仅能尽力而为，浏览器配置不可控
  - Impact: 功能视觉增强不可用时需要明确降级
  - Evidence: 目前仅在可用时执行分组，失败需提示

## Tooling Layering Audit

### 粗分类（疑似层级）

- L0 Primitives（基础原语）
  - `runner/actions/keyboard_mouse.ts`
  - `runner/actions/scroll.ts`
  - `runner/actions/locators.ts`
  - `runner/actions/highlight.ts`

- L1 Interactions（用户交互）
  - `runner/actions/element_click.ts`
  - `runner/actions/element_form.ts`
  - `runner/actions/element_choice.ts`
  - `runner/actions/element_date.ts`
  - `runner/actions/element_scroll.ts`
  - `runner/actions/type.ts`
  - `runner/actions/click.ts`

- L2 Strategies（策略/流程）
  - `play/replay.ts`
  - `record/recording.ts`
  - `runner/actions/recording.ts`
  - `runner/actions/dialogs_popups.ts`

- L3 Orchestration（编排层）
  - `demo/agent_loop.ts`
  - `demo/server.ts`
  - `mcp/server.ts`
  - `mcp/tool_handlers.ts`
  - `runner/tool_registry.ts`

### 重复/交叉

- `click.ts` vs `element_click.ts`：两套 click 实现
- `scroll.ts` vs `element_scroll.ts`：滚动行为分散
- `type.ts` vs `element_form.ts`：输入逻辑分散
- `navigate.ts` vs `navigation.ts`：导航命令实现分裂
- `keydown.ts` vs `keyboard_mouse.ts`：键盘操作入口重复
- `locators.ts` vs `element_choice.ts`：定位与选择策略交叉

### 需要下沉为 primitives 的缺口（只列问题）

- 统一的 `wait/timeout` 原语缺失
- 统一的 `humanlike` 行为策略缺失
- 统一的 `target/locator` 解析与错误包装缺失
