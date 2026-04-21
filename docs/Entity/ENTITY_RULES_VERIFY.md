# ENTITY_RULES_VERIFY

## Golden Verify 输入输出

输入：

- profile 名称（例如 `oa-ant-orders`）
- 真实框架 fixture 路由
  - Ant: `/entity-rules/fixtures/order-list|order-form`
  - Element: `/entity-rules/fixtures/user-list|user-form`

流程：

1. 启动对应 mock 子应用（`mock/ant-app` 或 `mock/element-app`）
2. 打开 fixture 路由并生成 snapshot
3. 应用 entity_rules
4. 导出稳定产物
5. 对比 profile 下 golden

输出：

- `expected.final_entities.json`
- `expected.node_hints.json`

## expected 文件说明

`expected.final_entities.json`

- 仅保留业务语义实体
- 字段：`kind/type/name/businessTag/businessName/primaryKey/columns/nodeDomId`

`expected.node_hints.json`

- 仅保留语义注入节点
- 字段：`nodeDomId/fieldKey/actionIntent/entityKind/entityNodeDomId/name`

## 失败排查

1. profile 选择是否正确
- 看 `entity.rules.profile.selected/conflict`

2. 匹配是否命中
- 看 `entity.rules.match.hit/miss`

3. overlay 是否注入
- 看 `entity.rules.apply.start/end`

4. golden diff 失败点
- 看 `entity.rules.verify.diff`
- `kind` 表示 `final_entities` 或 `node_hints`

## 运行入口

```bash
pnpm -C agent test:entity-rules
```
