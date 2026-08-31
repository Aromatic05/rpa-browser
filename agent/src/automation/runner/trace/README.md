# Trace 模块结构

当前目录按职责分层，减少“所有文件平铺在根目录”的混杂感：

- `a11y/`：可访问性树相关能力（采集、缓存、查找、节点绑定）。
- `dom/`：DOM 基础采集能力。
- 根目录 `types.ts/hooks.ts/sink.ts/trace_call.ts/tools.ts`：Trace 核心模型、生命周期钩子、事件落盘与工具编排。
- `index.ts`：统一导出入口。

## 导入约定

- 新代码优先从 `trace` 统一入口导入。
- 如需按职责导入，优先使用 `trace/a11y/*`、`trace/dom/*`。
