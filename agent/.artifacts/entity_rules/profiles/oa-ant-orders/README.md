# oa-ant-orders

## 适用页面

- Mock Route: `http://127.0.0.1:5173/entity-rules/fixtures/order-list`

## 关键 ruleId

- `order_list_main`
- `order_action_delete`

## 关键 businessTag

- `order.list.main`

## 如何加载

- `entityRules.selection=explicit`
- `entityRules.profiles=["oa-ant-orders"]`

## 如何验证

- 运行：`pnpm -C agent test:entity-rules`
- 对应 golden：
  - `expected.final_entities.json`
  - `expected.node_hints.json`

## 预期命中

- 主实体：`order.list.main`
- 关键动作：`order_action_edit` / `order_action_delete`
