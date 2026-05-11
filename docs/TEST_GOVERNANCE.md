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
