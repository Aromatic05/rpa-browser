# 主扩展启动页

## 概述

`newtab.html` 是主 `extension` 的启动控制面，不再存在独立的 `start_extension` 包、manifest、extension id 或 service worker。页面代码位于 `extension/src/start/newtab.ts`，由主扩展 manifest 的 `chrome_url_overrides.newtab` 接管。

单扩展运行时必须保持以下不变量：

- build stamp 只发布 `mainExtensionPath`；
- Chromium 只加载一个扩展目录；
- 主扩展只有一个 `entry/sw.js` service worker；
- newtab 与 service worker 共享同一份 `chrome.storage.local` session 配置；
- session runtime 的重复 `configure(workspaceName, wsPort)` 必须幂等，并重新发布 `rpa.runtime.ready`，不能依赖 storage value 变化事件再次触发。

## Automation 列表

启动页展示的是当前 workspace Product Library 中的 **Automation（saved Program / DSL）**，不是 workflow 目录。列表通过 `agent.product {verb: "librarySummary"}` 读取 `automations[]` 的名称、说明和健康状态。

workflow/workspace 是运行容器，不是普通用户可见的 Automation 身份。空 workflow、内部 workflow、草稿 workflow 都不会因为目录存在而污染启动页。

## 按钮与 Action 映射

- 列表刷新 -> `agent.product {verb: "librarySummary"}`
- 运行 -> `dsl.run {dslName: automation.name}`，作用域固定为启动页已绑定的 session workspace

真正的浏览器启动延迟到 `dsl.run`。浏览 Automation 列表和打开新标签页本身不得启动第二个 BrowserSession、创建业务 tab 或切换 workflow。

录制、Teach、Annotate 属于页面内产品 authoring surface，不由启动页伪造 `workflow.*` action。

## Scope 与绑定

启动页自身的 `tab.report` / `tab.ping` 与 Automation 列表/运行都使用启动 session 已绑定的 `workspaceName`。Automation 是该 workspace 内的 DSL asset，运行时只显式选择 `dslName`，不把 Automation 名称冒充 workspace identity。

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
