# ENTITY_RULES_VERIFY

## Golden Verify 输入输出

输入：

- mock 页面 URL（例如 `/pages/entity-rules/ant-order-list.html`）
- profile 名称（例如 `oa-ant-orders`）

流程：

1. 打开 mock 页面
2. 生成 snapshot（启用指定 profile）
3. 构建 finalEntityView
4. 导出稳定化产物
5. 与 expected json 比对

输出：

- `expected.final_entities.json`
- `expected.node_hints.json`

## expected 文件说明

`expected.final_entities.json`

- 仅保留业务相关最终实体
- 包含：`kind/type/name/businessTag/businessName/primaryKey/columns/nodeDomId`

`expected.node_hints.json`

- 仅保留被注入的语义节点
- 包含：`nodeDomId/fieldKey/actionIntent/entityKind/entityNodeDomId/name`

## 失败排查

1. 看 profile 是否选对
- 关注 `entity.rules.profile.selected/conflict`

2. 看匹配是否命中
- 关注 `entity.rules.match.hit/miss`

3. 看是否注入到 overlay
- 关注 `entity.rules.apply.start/end`

4. 看 golden diff
- 关注 `entity.rules.verify.diff`
- `reason` 会指出 `final_entities` 或 `node_hints` 的断言差异

## 运行入口

```bash
pnpm -C agent test:entity-rules
```
