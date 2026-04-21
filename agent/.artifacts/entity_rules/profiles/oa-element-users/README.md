# oa-element-users

## 适用页面

- Mock URL: `http://localhost:4173/pages/entity-rules/element-user-list.html`

## 关键 ruleId

- `user_list_main`
- `user_action_edit`

## 关键 businessTag

- `user.list.main`

## 如何加载

- 通过 `entityRules.selection=explicit`
- `entityRules.profiles` 指向当前 profile 名

## 如何验证

- 运行：`pnpm -C agent test:entity-rules`
- 对应 golden：
  - `expected.final_entities.json`
  - `expected.node_hints.json`

## 预期命中

- 主实体：`user.list.main`
- 关键动作：`user_action_edit`
