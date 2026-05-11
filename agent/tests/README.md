# 测试目录说明

## e2e/step_actions
用于 E2E-1 Step 动作实测。该目录下测试必须走真实产品链路：`agent -> extension -> workspace -> 真实页面`，并通过正式 action 入口下发 browser step，不允许使用伪造 page/runtime/workspace 绑定。

## fixtures/step_actions
用于 Step 动作实测的真实 HTML 夹具页面，页面行为由 HTML 自身实现，不依赖外部网络。

## 运行入口
- `pnpm -C agent test:e2e`：无头模式，默认验收入口。
- `pnpm -C agent test:e2e:headed`：有头模式，仅用于本地观察和调试。

同一套 `e2e` spec 必须同时支持无头与有头运行，测试语义不得因模式变化。
