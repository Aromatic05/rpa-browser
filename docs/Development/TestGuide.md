# TestGuide

## 概述

本文档定义本仓库的测试入口与 workflow artifact 验证步骤。

## 规范

### 核心命令

```bash
pnpm -C agent test
pnpm test:extension
pnpm test
```

### workflow artifact 验证

1. 准备 `agent/.artifacts/workflows/<scene>/workflow.yaml`。
2. 执行 `workflow.open`，确认返回 workspace 与 token。
3. 执行 `workflow.dsl.test`，检查 output 与 diagnostics。
4. 执行 `workflow.releaseRun`，确认正式路径可运行。
5. 可选执行 `record.start/stop + workflow.record.save` 验证 records 落盘。

### entity rules 验证建议

- 使用 mock 路由进行 snapshot + entity query。
- 检查 diagnostics 与业务查询结果是否一致。

## 示例

- 先 `pnpm mock:dev`，再跑 agent 测试和 UI 手动回归。

## 限制

- start_extension 的手工验证不替代自动化测试。
