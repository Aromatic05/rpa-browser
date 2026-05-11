# oa-ant-order-form

## 适用页面

- Mock Route: `http://127.0.0.1:5173/entity-rules/fixtures/order-form`

## 关键 ruleId

- `order_form_main`
- `order_form_submit`

## 关键 businessTag

- `order.form.main`

## 如何加载

- `entityRules.selection=explicit`
- `entityRules.profiles=["oa-ant-order-form"]`

## 如何验证

- 运行：`pnpm -C agent test:entity-rules`
- 对应 golden：
  - `expected.final_entities.json`
  - `expected.node_hints.json`

## 预期命中

- 主实体：`order.form.main`
- 关键动作：`order_form_submit`
