# 浏览器扩展

## 概述

extension 是浏览器侧入口，负责 chrome message wiring、lifecycle wiring、state wiring，以及 Action 与 agent 的传输接入。

## 边界

- `extension/src/actions` 是 extension action gateway 边界。
- `extension/src/background` 只负责 wiring，不负责 request 路由推导。
- 普通 request action 不推导 `workspaceName`。
- request routing 与 reply/event projection 分离。
- control action 不携带 `workspaceName`。
- workspace action 必须显式携带 `workspaceName`。

## 目录与职责

- `entry/sw.ts`：Service Worker 启动与监听注册。
- `background/cmd_router.ts`：runtime message 接线、生命周期接线、state 注入。
- `background/state.ts`：tab/binding/workspace/window 映射状态。
- `background/life.ts`：tab/window lifecycle；lifecycle 产出的 action 显式携带 `workspaceName`。
- `actions/action_types.ts`：extension action type 与 request/reply/event 判定。
- `actions/envelope.ts`：Action envelope 校验。
- `actions/classify.ts`：control/workspace request 分类。
- `actions/control_gateway.ts`：control request 网关。
- `actions/workspace_gateway.ts`：workspace request 网关。
- `actions/index.ts`：request 分发入口 `dispatchActionRequest`。
- `actions/projection.ts`：reply/event 对 RouterState 的投影。
- `actions/ws_client.ts`：WebSocket Action 传输。

## 当前协议约束

- 已删除 `workflow.init`。
- 已删除 `workflow.record.save`。
- request action 只按显式 envelope 路由，不做 sender tab、active tab、window mapping、active workspace 回填。
