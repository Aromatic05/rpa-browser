# 架构

## 概述

该示例包含两个主要部分：

- `extension/`：MV3 Chrome 扩展，注入 UI、生成 `tabToken` 并转发命令。
- `agent/`：基于 Node + Playwright 的代理，负责浏览器、录制、回放和执行动作。

扩展不会直接执行自动化操作。它只向 service worker 发送 `CMD` 消息。由 agent 在 Playwright 中执行所有动作。

## 数据流

1) `content.ts` 生成 `tabToken` 并向 SW 发送 `RPA_HELLO`。
2) UI 按钮 -> `content.ts` -> `chrome.runtime.sendMessage({ type:'CMD', cmd, tabToken, args })`。
3) `sw.ts` 在缺失时附加活动标签 token，并将 `{ cmd: { cmd, tabToken, args, requestId } }` 发送到 WS。
4) `agent/src/index.ts` 解析 WS，按 `tabToken` 解析页面，并分派到 runner。
5) Runner 执行动作并返回标准结果。

## 运行时

- `agent/src/runtime/context_manager.ts`：使用扩展启动 Chromium 持久化上下文。
- `agent/src/runtime/page_registry.ts`：维护 `tabToken -> Page` 绑定。
- `agent/src/runtime/target_resolver.ts`：将 `Target` 解析为页面或 frame 内的 `Locator`。

## Runner

- `agent/src/runner/execute.ts`：命令路由、错误映射、日志。
- `agent/src/runner/actions/*`：动作实现。
- `agent/src/runner/commands.ts`：命令联合类型。
- `agent/src/runner/results.ts`：标准响应类型。

## 录制

- `agent/src/record/recorder_payload.ts`：注入页面的脚本，用于捕获事件。
- `agent/src/record/recorder.ts`：注入 payload，桥接到 Node。
- `agent/src/record/recording.ts`：录制状态与过滤。

## 回放

- `agent/src/play/replay.ts`：回放 RecordedEvent 列表并使用自愈定位器。

## 无障碍（A11y）

- `agent/src/runner/actions/a11y.ts`：基于 `@axe-core/playwright` 的 `page.a11yScan`。
