# 浏览器扩展

## 概述

extension 是浏览器侧主入口，负责 token 生命周期、窗口到 workspace 映射、WS Action 转发与 UI 注入。代码位于 `extension/src/*`。

## 目录与职责

- `entry/sw.ts`：Service Worker 启动入口。
- `background/cmd_router.ts`：运行时消息路由与 Action 分发。
- `background/state.ts`：tab/token/workspace/window 映射状态。
- `background/action.ts`：Action 组装、回复解析、失败统一。
- `background/life.ts`：tab 生命周期、绑定重试、激活同步。
- `background/ws_client.ts`：与 agent WS 通道。
- `content/token_bridge.ts`：content token 获取与 hello。
- `entry/content.ts`：内容脚本 UI 与事件上报。
- `shared/action_types.ts`：Action type 常量。
- `shared/protocol.ts`：消息常量（`RPA_HELLO`、`RPA_ENSURE_BOUND_TOKEN` 等）。

## background 四个核心模块

- `cmd_router`：统一入口，处理 runtime message、WS inbound action、tab/window 事件。
- `state`：维护 `tabId -> token`、`token -> scope`、`windowId -> workspaceId`。
- `action`：封装 dispatch 行为、reply 识别、payload 解析。
- `life`：负责 `tab.init/tab.opened/tab.activated/tab.closed/tab.ping` 相关生命周期推进。

## WS 入站/出站流程

1. UI/content 发消息给 background。
2. background 组装 Action，经 `ws_client` 发送到 agent。
3. agent 回复 `<action>.result/.failed`。
4. background 更新映射并转发 `ACTION_EVENT` 给页面 UI。

## Action projection 机制

extension 不复制业务执行逻辑，只做协议投影：

- runtime message -> Action
- Action reply -> UI 可消费结构

业务事实以 agent 返回为准。

## windowId 与 workspaceId 映射

`state.ts` 维护窗口映射，用于：

- tab 激活时推断 workspace
- `tab.opened` 早于 token claim 时进行 defer-claim
- 跨窗口拖拽后的重绑定

## tabToken owner 规则

- token 生命周期 owner 是 background。
- content/start_extension 必须用 `RPA_ENSURE_BOUND_TOKEN` 请求可用 token。
- content 不得直接执行 `tab.init`。

## 与 ActionProtocol 的关系

extension 只实现 Action 协议客户端，不定义协议本身。协议权威在 `Contract/ActionProtocol.md`。

## 与 start_extension 的区别

- extension content：业务页面浮层，持续心跳 `tab.ping`。
- start_extension：新标签页入口，偏 workflow 管理与启动。

## 常见问题与定位

- token 未绑定：检查 `RPA_ENSURE_BOUND_TOKEN` 返回 `pending` 与重试。
- missing action target：scope/token 未传或未解析。
- workspace focus 错位：检查 window-workspace 映射是否过期。
- tab 跨窗口拖拽：关注 `tab.attached/tab.activated` 后重绑定日志。
