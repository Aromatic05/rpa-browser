# 测试目录说明

## e2e/step_actions
用于 E2E-1 Step 动作实测。该目录下测试必须走真实产品链路：`agent -> extension -> workspace -> 真实页面`，并通过正式 action 入口下发 browser step，不允许使用伪造 page/runtime/workspace 绑定。

## e2e/multitab
用于 E2E-2 多 tab 录制与回放实测。该目录覆盖主动创建 tab、页面触发被动创建 tab、tab 切换、tab 关闭、关闭后回到主 tab 继续操作、录制与回放一致性验证。

## fixtures/step_actions
用于 Step 动作实测的真实 HTML 夹具页面，页面行为由 HTML 自身实现，不依赖外部网络。

## fixtures/multitab
用于多 tab 工单处理工作台夹具页面，覆盖主动开页、被动 `window.open`、跨 tab 状态回显与最终业务汇总。

## 运行入口
- `pnpm -C agent test:e2e`：无头模式，默认验收入口。
- `pnpm -C agent test:e2e:headed`：有头模式，仅用于本地观察和调试。

同一套 `e2e` spec 必须同时支持无头与有头运行，测试语义不得因模式变化。
多 tab e2e 不依赖 extension 调试面板。
