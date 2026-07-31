# Control RPC 协议

## 概述

Control RPC 是 agent 的本地诊断与开发控制通道。它通过 Unix socket（Windows 使用命名管道）接收 JSON Lines 请求，不对网络公开，也不替代 MCP 或 Action 协议。

## 启动与客户端

运行 agent 时显式启用：

```bash
RPA_CONTROL_EVAL=1 pnpm dev
```

使用根目录命令连接：

```bash
pnpm control --source "ctx.log('hello')"
pnpm control --file ./script.js
```

默认端点由运行时目录解析；也可以使用 `--endpoint` 指定。

## 请求

每行一个 JSON 对象：

```json
{"id":"request-id","source":"return ctx.input","workspaceName":"default","input":{},"timeoutMs":10000}
```

字段：

- `id`：请求标识。
- `source`：待执行的异步 JavaScript 源码。
- `workspaceName`：可选 workspace。
- `input`：传给 `ctx.input` 的值。
- `timeoutMs`：执行超时。

## 响应

成功：

```json
{"id":"request-id","ok":true,"result":null,"logs":[]}
```

失败：

```json
{"id":"request-id","ok":false,"error":{"code":"ERR_*","name":"Error","message":"..."},"logs":[]}
```

## 安全边界

- 未设置 `RPA_CONTROL_EVAL=1` 时，eval 请求必须失败。
- Control RPC 仅用于本机开发和诊断，不应暴露到 TCP 或反向代理。
- 调用方不得把它当作稳定的外部自动化协议；外部工具使用 MCP。
