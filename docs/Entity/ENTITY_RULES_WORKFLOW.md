# Entity Rules Workflow（可执行版）

## 0. 前置

启动 mock：
```bash
pnpm -C mock dev
```

## 1. 选页面

固定从真实框架 fixture 路由开始，例如：
- Ant 列表：`http://127.0.0.1:5173/entity-rules/fixtures/order-list`
- Ant 表单：`http://127.0.0.1:5173/entity-rules/fixtures/order-form`

## 2. 写规则

在 builtin profiles 新建目录，例如：
`agent/src/runner/steps/executors/snapshot/entity_rules/builtin_profiles/profiles/oa-ant-orders`

先写 `match.yaml`（结构匹配），再写 `annotation.yaml`（业务语义）。

## 3. 校验

运行 entity_rules 测试：
```bash
pnpm -C agent test:entity-rules
```

失败时先看：
- `ruleId` 是否对应
- `within` 是否引用存在
- `page.kind` 是否一致

## 4. 生成/更新 golden

golden 文件在 profile 内：
- `expected.final_entities.json`
- `expected.node_hints.json`

当页面结构有合理变更时，同步更新 expected。

## 5. 接入下游

- checkpoint: 用 `businessTag` 匹配
- resolve: 用 `hint.entity.businessTag/fieldKey/actionIntent`
