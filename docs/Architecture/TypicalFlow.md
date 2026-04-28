# 典型工作流

## 概述

本文件描述从 workflow 打开到 releaseRun 的完整闭环，区分“已实现自动化”与“需要人工/UI 辅助”的阶段。

## 端到端流程

1. `workflow.open`
2. `record.start`
3. 人工操作页面录制
4. `record.stop`
5. `workflow.record.save`
6. `play.start` / `play.stop` 回放核验
7. `browser.snapshot` 与 `browser.capture_resolve` 抽取结构信息
8. 通过 MCP/AI 做页面探索与候选定位
9. 人工编写/修订 `entity_rules`（`match.yaml` + `annotation.yaml`）
10. 生成或修订 checkpoint 过程模板
11. 用回放或 DSL 单步测试 checkpoint
12. 编写/保存 `dsl/main.dsl`
13. `workflow.dsl.test` 验证
14. 失败后回流修订：
   - resolve
   - entity_rules
   - checkpoint
   - DSL
15. `workflow.releaseRun` 正式运行
16. 进入后续迭代（新页面漂移、新规则补充）

## 阶段状态标注

当前已实现自动化能力：

- `workflow.open`
- `record.start/stop`
- `workflow.record.save`
- `workflow.dsl.get/save/test`
- `workflow.releaseRun`
- `play.start/stop`
- `browser.snapshot/query/capture_resolve`

当前需要人工/UI 辅助：

- entity_rules 标注
- checkpoint 语义设计与修订
- DSL 业务流程编写

当前仅预留、未形成完整自动化 UI：

- 全功能 DSL 编辑器
- entity_rules 可视化标注器
- 多 DSL 文件图形化选择

## 失败反馈闭环

`workflow.dsl.test` 或回放失败时，按顺序排查：

1. 目标解析是否漂移（resolve 提示）
2. entity_rules 业务标签是否覆盖当前页面
3. checkpoint 前置/恢复/断言是否错误
4. DSL 控制流是否与页面状态同步

## 与 workspace 的关系

每个 workflow 场景绑定唯一 `workspaceId=workflow:<scene>`。record/play/dsl 测试在该 workspace 上下文复用同一浏览器会话。

## 禁止事项

- 禁止把人工标注阶段写成“系统已自动完成”。
- 禁止跳过回放核验直接宣称 artifact 可发布。
