# 启动页扩展

## 概述

start_extension 是 workflow 首页/新标签页入口，负责“场景选择、快速测试、发布运行”的轻量控制面板。代码位于 `start_extension/src/entry/newtab.ts`。

## 按钮与 Action 映射

当前页面按钮直接映射：

- 列表刷新 -> `workflow.list`
- 打开场景 -> `workflow.open`
- DSL 测试 -> `workflow.dsl.test`
- 正式运行 -> `workflow.releaseRun`
- 保存录制 -> `workflow.record.save`

## workflow.open 后接管规则

`workflow.open` 成功后，UI 以返回的 `workspaceId/tabId/tabToken` 更新当前会话上下文，后续 Action 必须沿用这组 scope。

## 与普通 extension content 的区别

- start_extension 不注入业务网站 DOM。
- start_extension 重点是 workflow 控制，不承担页面内录制交互。
- 普通 content 会长期发送 `tab.ping`、`tab.report`。

## 为什么不直接读取 workflow 文件

workflow artifact 在 agent 侧受路径校验与绑定策略控制。start_extension 通过 Action 请求 agent，避免扩展侧直接访问文件系统并绕开校验链路。

## 失败处理

- `workflow.list` 失败：显示错误并保留重试入口。
- `workflow.open` 失败：不更新本地 scope，提示用户重新绑定。
- tabToken 绑定失败：`RPA_ENSURE_BOUND_TOKEN` 返回失败时中止操作。
- `workflow.record.save workspace mismatch`：提示当前 workspace 与 scene 不一致，需重新 open 场景。

## 当前限制

- 暂无完整 DSL 编辑器。
- 暂无人工标注 UI。
- 暂无多 DSL 文件选择 UI。

## 风险提示

受 WS pageless 集限制，若 scope/token 为空可能出现 `missing action target`。UI 必须确保发送已绑定 scope。
