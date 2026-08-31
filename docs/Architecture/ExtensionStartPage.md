# 主扩展启动页

## 概述

`newtab.html` 是主 `extension` 的启动控制面，不再存在独立的 `start_extension` 包、manifest、extension id 或 service worker。页面代码位于 `extension/src/start/newtab.ts`，由主扩展 manifest 的 `chrome_url_overrides.newtab` 接管。

单扩展运行时必须保持以下不变量：

- build stamp 只发布 `mainExtensionPath`；
- Chromium 只加载一个扩展目录；
- 主扩展只有一个 `entry/sw.js` service worker；
- newtab 与 service worker 共享同一份 `chrome.storage.local` session 配置；
- session runtime 的重复 `configure(workspaceName, wsPort)` 必须幂等，并重新发布 `rpa.runtime.ready`，不能依赖 storage value 变化事件再次触发。

## Workflow 列表

`workflow.list` 返回启动页需要的最小事实：`workflowName`、`entryDslName`、`runnable`。

普通启动页只展示 `runnable=true` 的 Automation。新建但尚未保存 entry DSL 的 workflow（包括全新 `default`）属于内部/草稿状态，不在启动面暴露，也不能通过“打开”产生浏览器副作用。

## 按钮与 Action 映射

- 列表刷新 -> `workflow.list`
- 运行 -> 内部先 `workflow.open` 取得目标 `workspaceName`，再发送 `dsl.run`

`workflow.open` 是纯 workspace 选择/载入操作：不得启动 BrowserSession、创建 tab 或打开窗口。真正的浏览器启动延迟到 `dsl.run`。

录制、Teach、Annotate 属于页面内产品 authoring surface，不由启动页伪造 `workflow.*` action。

## Scope 与绑定

启动页自身的 `tab.report` / `tab.ping` 使用启动 session 的 `workspaceName`。Automation 运行不能沿用这个 scope 猜目标 workspace：`workflow.open` 返回哪个 `workspaceName`，后续 `dsl.run` 就显式发送到哪个 workspace。

`workflow.open` 的 workspace identity 与 workflow identity 相同；不再使用 `workflow:<scene>` 前缀模型。

## 与普通 content surface 的区别

- newtab 是扩展自己的控制面，不注入业务网站 DOM；
- content surface 负责业务网页里的 Task、Teach、Annotate、Library 等产品交互；
- 两者共享同一个扩展 service worker 和同一套 Action/WS runtime contract。

## 失败处理

- `workflow.list` 失败：显示错误并保留刷新入口；
- `workflow.open` 失败：不执行后续 DSL action；
- `dsl.run` 失败：直接显示后端返回的失败信息；
- session config 或 tab binding 不可用：启动页保持 offline，不伪造 connected 状态。

## 验收要求

不能只以 build/unit test 作为启动页可用证明。至少要用真实 Chromium 验证：主 service worker 被发现、`extension.configured`、`extension.connected`、可运行 Automation 列表可见，并实际点击一次“Run”；同时验证空 workflow 不启动 BrowserSession、不创建 tab。
