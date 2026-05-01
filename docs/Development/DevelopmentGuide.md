# DevelopmentGuide

## 概述

本文档描述本地开发、联调、回归验证的标准流程。

## 规范

### 1. 安装与初始化

```bash
pnpm install
```

可选：首次浏览器依赖安装按项目既有脚本执行。

### 2. 主链路开发命令

```bash
pnpm dev
pnpm mock:dev
pnpm mock:dev:ant
pnpm mcp
```

说明：

- `pnpm dev`：extension + agent 主联调。
- `pnpm mock:dev`：启动 mock 双应用。
- `pnpm mock:dev:ant`：仅 Ant mock。
- `pnpm mcp`：MCP 入口调试。

### 3. 测试命令

```bash
pnpm -C agent test
pnpm test:extension
pnpm test
```

### 4. workflow artifact 本地验证流程

1. 准备 `agent/.artifacts/workflows/<scene>/workflow.yaml`。
2. 调用 `workflow.open`，确认绑定返回。
3. 调用 `workflow.dsl.get/save` 验证读写链路。
4. 调用 `workflow.dsl.test` 验证开发态运行。
5. 调用 `workflow.releaseRun` 验证正式执行。
6. 按需 `record.start/stop + workflow.record.save` 验证录制落盘。

### 5. extension/start_extension 联调要点

- 内容页与 start_extension 必须先确保 bound token。
- WS 回复必须按 `<action>.result/.failed` 处理。

### 6. 常见问题排查

- `workflow.open` 失败：检查 manifest 与 workspace binding schema。
- `dsl.test` 失败：检查 DSL 缩进、变量引用、checkpoint 声明。
- `record.save` 失败：检查 scope.workspaceName 是否为 `workflow:<scene>`。
- `tab.ping` 异常：检查 token 映射与 watchdog stale 清理日志。

## 示例

```text
pnpm dev
pnpm mock:dev
# 在 start_extension 执行 workflow.open -> workflow.dsl.test -> workflow.releaseRun
```

## 限制

- 本文档不重复 Step/Trace/Action 字段契约，详情见 `Contract/`。
