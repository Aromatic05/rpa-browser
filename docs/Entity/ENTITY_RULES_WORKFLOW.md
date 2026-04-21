# ENTITY_RULES_WORKFLOW

## 标准闭环

1. 准备真实框架页面
- Ant 页面在 `mock/ant-app`
- Element 页面在 `mock/element-app`

2. 选择 fixture 路由
- Ant: `/entity-rules/fixtures/order-list`、`/entity-rules/fixtures/order-form`
- Element: `/entity-rules/fixtures/user-list`、`/entity-rules/fixtures/user-form`

3. 生成 snapshot
- 复用 snapshot pipeline 与通用实体索引

4. AI 产出 `match.yaml`
- 只写结构匹配

5. 人工确认 `annotation.yaml`
- 只写业务语义

6. 执行 validate
- 校验 schema + 跨文件一致性

7. 执行 verify
- 对比 `expected.final_entities.json`
- 对比 `expected.node_hints.json`

8. 接 checkpoint / resolve
- checkpoint 用 `entityExists.businessTag`
- resolve 用 `resolve.hint.entity`

9. 回归沉淀
- 更新 profile README（含路由映射）
- 固化 golden expected
