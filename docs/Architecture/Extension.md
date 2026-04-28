# Extension

## 概述

extension 是浏览器侧主入口，负责 token、Action 转发、生命周期事件上报与浮层交互。

## 规范

### 关键组件

- `entry/sw.ts`：Service Worker 装配入口。
- `background/cmd_router.ts`：消息路由与 action 分发。
- `background/life.ts`：tab 生命周期、绑定、节流。
- `background/ws_client.ts`：与 agent WS 通道。
- `content/token_bridge.ts`：token 注入与 hello。
- `entry/content.ts`：内容脚本 UI 与 action 发送。

### 协议常量

消息常量来源：`shared/protocol.ts`（`RPA_HELLO`、`RPA_ENSURE_BOUND_TOKEN` 等）。

### 绑定规则

- background 是 `tabToken` owner。
- content 与 start_extension 必须走 `ENSURE_BOUND_TOKEN`。

## 示例

- content 初始化时调用 `ensureTabTokenAsync`，成功后再发 `tab.report/tab.ping`。

## 限制

- 内容脚本非 module 场景下使用动态 import。
