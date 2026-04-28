# Snapshot

## 概述

Snapshot 是页面语义快照流水线，输出统一节点树、实体索引、定位索引与规则 overlay。

## 规范

### 执行阶段

1. collect 原始数据（DOM/A11y/runtime）
2. fuse 融合
3. spatial 分层
4. regions 处理
5. relations 链接
6. stable id
7. entityIndex
8. locatorIndex
9. applyBusinessEntityRules
10. final snapshot 输出

### diff 模式

- `browser.snapshot` 支持 `diff=true`。
- 若无 baseline 或发生导航，回退 full 模式。

### 输出

- `snapshotMeta`：`mode/snapshotId/pageIdentity/baseSnapshotId/diffRootId/...`

## 示例

```text
browser.snapshot(refresh=true,diff=true)
-> snapshotMeta.mode = full 或 diff
```

## 限制

- diff 基线依赖 session cache。
- 页面身份变化会跳过 diff。
