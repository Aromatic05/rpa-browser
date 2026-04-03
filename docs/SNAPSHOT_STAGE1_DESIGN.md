# Snapshot Stage1 设计说明

## 1. 第一阶段目标

第一阶段只做最小可用链路：

- 从页面采集 `DOM tree` 与 `A11y tree`
- 按 DOM 骨架融合 A11y 的 `role/name`
- 产出可调试的 `unified graph`

不进入完整语义系统，不实现复杂策略。

## 2. Pipeline（保持骨架不变）

```text
generateSemanticSnapshot(page)
  -> collectRawData(page)
    -> getDomTree(page)
    -> getA11yTree(page)
  -> fuseDomAndA11y(domTree, a11yTree)
  -> buildSpatialLayers(graph)
  -> detectRegions(node)
  -> processRegion(node)
    -> detectBusinessEntities(node)
    -> buildTree(node)
    -> markStrongSemantics(tree)
    -> applyLCA(tree, entities)
    -> rankTiers(tree)
    -> compress(tree)
  -> linkGlobalRelations(root)
  -> assignStableIds(root)
  -> buildSnapshot(root)
```

说明：
- Pipeline 没有改写为单阶段流程。
- 第二阶段仅填充 `buildSpatialLayers` 与 `detectBusinessEntities` 的轻量能力，其余阶段继续占位并保持调用。

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

## 7. 第二阶段目标（Stage2）

在第一阶段 `collect + fuse` 基础上，补齐两项最小可用能力：

- 空间分层（light version）
- 业务实体识别（minimal version）

目标是让 unified graph 具备初步结构分层，不追求完整语义系统。

## 8. 空间分层设计（轻量版）

`buildSpatialLayers(graph)` 只在 `NodeGraph.root.children` 上做重排，不引入额外 Layer 类型：

- 主内容：保留为一个主子树（必要时合并为 `role=main` 容器）。
- 浮层：将 overlay-like 子树提到顶层。

当前 overlay 识别为极简启发：

- `role ∈ {dialog, menu, listbox, tooltip}`
- `attrs.position` 为 `fixed/absolute` 或 `style` 中出现对应声明
- `z-index` 较高

`isNoiseLayer` 仅做保守过滤：

- 小尺寸 + 靠边 + 无交互 才判定为噪声

## 9. 业务实体识别范围（最小版）

`detectBusinessEntities(node)` 当前仅支持基础类型：

- `form`
- `table`
- `row`（table row / list row）
- `dialog`
- `list item`
- `card`（弱检测）

识别方式是简单启发组合：

- role 命中
- tag 命中（`form/table/tr/li`）
- 基础结构特征（多子节点 + 有文本 + 有交互）

## 10. 当前限制（非完整实现）

以下能力仍为后续阶段：

- 复杂区域检测细则（当前 `detectRegions` 仍是占位）
- 完整 LCA 归因与上下文抽取
- 完整 tier 分级与压缩策略
- 跨层关系链接
- 稳定 ID 生成策略
- 高亮页面 / bbox overlay / 实时注入调试
