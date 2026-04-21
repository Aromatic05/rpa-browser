# ENTITY_RULES_WORKFLOW

## 目标

把“真实业务页面 -> 可复用 profile -> 稳定回归”串成一个闭环。

## 标准流程

1. 准备真实框架 mock 页面
- 在 `mock/pages/entity-rules/*` 建立列表页/表单页
- 页面需含真实布局（筛选区、主表格、分页、表单按钮）

2. 生成 snapshot
- 使用现有 snapshot pipeline
- 观察通用结构实体与节点语义

3. AI 生成 `match.yaml`
- 仅写结构匹配（region/group/node + within）
- 优先复用通用实体索引，不够再用 node fallback

4. 人工确认 `annotation.yaml`
- 补业务标签与字段语义
- 校对 `businessTag/primaryKey/columns/fieldKey/actionIntent`

5. validate
- 运行 schema + cross-file 校验
- 修复 `ruleId`、`within`、`page.kind` 等错误

6. verify
- 跑 `pnpm -C agent test:entity-rules`
- 对比 profile 下 golden：
  - `expected.final_entities.json`
  - `expected.node_hints.json`

7. 接 checkpoint / resolve
- checkpoint 用 `entityExists.businessTag`
- resolve 用 `resolve.hint.entity`

8. 回归沉淀
- 更新 profile README
- 固化 expected json
- 保留失败日志用于排查
