# oa-element-user-form

## 适用页面

- Mock Route: `http://127.0.0.1:5174/entity-rules/fixtures/user-form`

## 关键 ruleId

- `user_form_main`
- `user_form_submit`

## 关键 businessTag

- `user.form.main`

## 如何加载

- `entityRules.selection=explicit`
- `entityRules.profiles=["oa-element-user-form"]`

## 如何验证

- 运行：`pnpm -C agent test:entity-rules`
- 对应 golden：
  - `expected.final_entities.json`
  - `expected.node_hints.json`

## 预期命中

- 主实体：`user.form.main`
- 关键动作：`user_form_submit`
