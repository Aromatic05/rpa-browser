# Snapshot Stage1 调查摘要

## 1) 旧 snapshot executor（历史文件）

- 路径：`agent/src/runner/steps/executors/snapshot.ts`（已在后续重构中替换为目录模块）
- 历史职责：
  - 调用 `trace.page.getInfo`
  - 调用 `trace.page.snapshotA11y`
  - 返回 `{ snapshot_id, url, title, a11y }`
- 输入：`Step<'browser.snapshot'>`，参数含 `includeA11y`、`focus_only`
- 输出：`StepResult`
- 调用链：`stepExecutors['browser.snapshot'] -> executeBrowserSnapshot`

## 2) runner/trace 现状

- 已有 DOM/A11y/CDP 相关能力：
  - A11y：`trace/a11y/adopt.ts`、`cache.ts`、`find.ts`、`getA11yTree.ts`
  - DOM：`trace/dom/getDomTree.ts`
  - CDP 在 A11y 采集中已使用 `Accessibility.getFullAXTree`
- `Page`/binding/traceTools 风格：
  - `runtime_registry.ensureActivePage` 返回 `PageBinding`
  - `PageBinding.traceTools` 暴露 `'trace.xxx.yyy'` 原子能力
  - `tools` 内通过 `traceCall` 统一记录 op.start/op.end

## 3) snapshot scaffold 现状

当前目录：`agent/src/runner/steps/executors/snapshot/`

- 已有骨架文件（collect/fusion/spatial/regions/process/lca/compress/relations/stable_id/build_snapshot 等）
- 当前 `snapshot.ts` 已串联整条长链路，但多数模块仍是占位
- `types.ts` 当前包含 `SemanticNode`，超过 stage1 目标最小类型集

## 4) debug/前端工具与可复用体系

- 仓库当前无现成 Vue/Vite 前端工程
- `agent` 为 Node + tsx/esbuild 工具链，不含 Vue 依赖
- `extension` 也无 Vue/Vite
- 结论：debug viewer 适合做成独立 debug tooling（静态 HTML + Vue3 CDN）

