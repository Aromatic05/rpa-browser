# Snapshot Stage1 设计说明

## 1. 第一阶段目标

第一阶段只做最小可用链路：

- 从页面采集 `DOM tree` 与 `A11y tree`
- 按 DOM 骨架融合 A11y 的 `role/name`
- 产出可调试的 `unified graph`

不进入完整语义系统，不实现复杂策略。

## 2. Pipeline 简图

```text
generateSemanticSnapshot(page)
  -> collectRawData(page)
    -> getDomTree(page)
    -> getA11yTree(page)
  -> fuseDomAndA11y(domTree, a11yTree)
  -> buildSnapshot(root)
```

## 3. DOM + A11y 融合说明

- 以 DOM 为主骨架，先保证结构稳定。
- 尝试按节点 `id` 注入 A11y `role/name`。
- 对不上则跳过或按顺序回退，不做复杂匹配算法。
- 目标是“先可用、可观察”，不是追求一次性完美对齐。

## 4. 为什么剔除 `script/style`

- `script/style` 不参与可交互语义树的主体信息。
- 先剔除可降低树噪声，便于调试与人工排查。
- 第一阶段只做低成本、确定性的剔除，不扩展复杂清洗规则。

## 5. Unified Graph 结构

第一阶段输出节点字段：

- `id`
- `role`
- `children`
- `name?`
- `text?`
- `bbox?`
- `attrs?`

整体结构：

```ts
{
  root: UnifiedNode
}
```

## 6. Debug Viewer 的作用

`agent/debug/snapshot-viewer` 提供独立调试视图：

- 切换查看 `DOM tree / A11y tree / Unified graph`
- 递归展开/折叠树
- 点击节点查看详情（`id/role/name/text/attrs`）

用途是快速验证采集与融合结果是否符合预期。

## 7. 当前未实现内容

以下能力仍为后续阶段：

- 区域检测（form/table/list/card/dialog 等）
- LCA 归因
- tier 分级与压缩
- 跨层关系链接
- 稳定 ID 生成策略
- 高亮页面 / bbox overlay / 实时注入调试

