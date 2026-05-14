# 测试治理

## E2E-1 Step 动作实测准入标准

1. 必须使用真实 HTML 页面作为测试对象，禁止使用空洞样例页。
2. 必须经过完整链路：`agent -> extension -> workspace -> browser step -> 页面状态变化`。
3. 必须通过正式 action 入口执行 step，禁止退化为直接调用内部执行函数。
4. 不得伪造 page/runtime/workspace 绑定，不得绕过 extension 建立 tab/page 归属。
5. 不得退化为薄样例：
   - 不能只断言 `ok=true`。
   - 不能只断言“未抛异常”。
   - 不能只测单按钮点击。
6. 每个新增 Step e2e 必须同时覆盖：
   - 页面状态断言。
   - step result 断言。
   - 失败路径断言（包含 `error.code`）。
7. `test:e2e` 默认无头验收，`test:e2e:headed` 仅用于本地观察；两者必须运行同一套 spec。

## 2026-05-14 本轮治理结论

1. E2E-2 `agent/tests/e2e/multitab/record_replay.spec.ts` 已升级为纯 Step 驱动 tab 生命周期管理。
2. `tab.list` 在 E2E-2 中仅保留为只读验证用途。
3. E2E-2 已移除 `pauseForHeaded`、`delay`、`process.env` 语义分支。
4. E2E-2 已增强录制产物断言：`create/switch/close` 数量与字段契约、顶层禁用字段、被动开页 create_tab、目标 close_tab。
5. E2E-1 `agent/tests/e2e/step_actions/basic_actions.spec.ts` 已改为统一生命周期清理，无 `if`、无 `try/catch/finally`。
