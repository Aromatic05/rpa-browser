# 测试治理规范

## 本次治理范围

本次任务只做治理清理，不补充新测试用例，不修复旧样例。

## 删除旧 e2e 样例的原因

旧 `agent/tests/specs` 中的样例测试存在以下问题：

1. 样例导向强，验收目标弱，无法稳定代表真实业务路径。
2. 对旧 helper 绑定过深，维护成本高，且容易诱发兼容层堆积。
3. 与当前模块化测试策略（unit/integration/e2e 分层）不一致。
4. 会让默认测试命令承载低价值失败噪音，影响迭代效率。

因此本次直接删除旧样例，不保留 fallback、quarantine、legacy 入口。

## 新 e2e 七类目标

后续真实 e2e 仅围绕以下七类目标建设：

1. Step 动作实测
2. 多 tab 录制与回放
3. record/play 复杂场景专项
4. workflow saveAs/load 专项
5. entity_rules/checkpoint/dsl 专项
6. MCP 专项能力测试
7. agent + skill 完整真实流程测试

## e2e 准入规则

1. 必须对应真实业务验收路径，不接受“API 能跑通”式样例。
2. 必须定义输入、关键断言、失败判定与产物校验。
3. 必须可重复执行，禁止依赖脆弱时序与隐式环境状态。
4. 必须说明该用例为何不能下沉为 integration 或 unit。
5. 禁止通过适配层/fallback 迁就旧样例。

## E2E-2 多 Tab 录制与回放准入标准

1. 必须覆盖主动创建 tab。
2. 必须覆盖页面触发的被动创建 tab。
3. 必须覆盖 tab 切换与 tab 关闭。
4. 必须覆盖录制与回放两个阶段。
5. 必须验证 tabName 映射、active tab 与关闭 tab 状态。
6. 禁止把 tab e2e 写成单纯 create/switch/close 冒烟测试。

## integration / unit / e2e 边界

1. unit：单模块纯逻辑，快速、稳定、无跨模块编排依赖。
2. integration：验证模块协作与协议拼装，不冒充完整用户路径。
3. e2e：验证真实产品链路与业务验收结果，覆盖跨模块真实行为。

## 对 Codex 生成测试的约束

1. 禁止生成无验收意义的样例测试。
2. 真实业务样例必须先由人类定义验收路径，再实现测试。
3. 本次任务不补新测试，仅建立治理规则与目录规范。

## e2e Spec 正文语法约束

1. `agent/tests/e2e/**/*.spec.ts` 正文禁止 `if`。
2. `agent/tests/e2e/**/*.spec.ts` 正文禁止 `try/catch/finally`。
3. `agent/tests/e2e/**/*.spec.ts` 正文禁止条件表达式（`a ? b : c`）。
4. `agent/tests/e2e/**/*.spec.ts` 正文禁止固定 sleep（含自定义 `delay`/`setTimeout` 等等待分支）。
5. `agent/tests/e2e/**/*.spec.ts` 正文禁止 headed/headless 分支。
6. `agent/tests/e2e/**/*.spec.ts` 正文禁止读取 `process.env` 改变测试语义。

## 多 Tab E2E 生命周期治理

1. 多 tab e2e 中，tab 创建必须走 `browser.create_tab` Step。
2. 多 tab e2e 中，tab 切换必须走 `browser.switch_tab` Step。
3. 多 tab e2e 中，tab 关闭必须走 `browser.close_tab` Step。
4. `tab.list` 只能用于只读验证（数量、tabName、url、active），禁止用于管理 tab 生命周期。
5. 禁止使用 `tab.open`、`tab.close` Action 管理 tab 生命周期。

## E2E-4 workflow saveAs/load 准入标准

1. 必须在单条 e2e 样例中同时覆盖至少两个 workspace。
2. 必须在两个 workspace 中分别保存不同 workflow，并使用同名 `recordingName`（如 `main`）验证隔离。
3. 必须覆盖 `record.start`、`record.stop`、`record.get`、`record.save`、`workflow.open`、`play.start`。
4. 必须显式携带 `workspaceName`、`workflowName`、`recordingName`，禁止省略关键命名字段。
5. 必须验证 workflow artifact 边界：两个 workflow 的 `steps.yaml` 均存在、内容互不污染、且不包含 runtime-only 字段。
6. 必须验证 load 后 replay 可恢复对应业务状态，并验证另一 workspace 页面状态不被串改。
7. 禁止依赖 `activeWorkspace` fallback 驱动 `workflow.open` 与 `play.start` 验收。
