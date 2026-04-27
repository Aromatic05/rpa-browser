# Entity Rules Verify

## verify 做什么

对每个 profile 执行：
1. 打开真实 mock 路由
2. 生成 snapshot
3. 应用 entity_rules
4. 导出 `final_entities` 和 `node_hints`
5. 与 profile 里的 expected 比较

## 运行命令

```bash
pnpm -C agent test:entity-rules
```

## expected 文件

- `expected.final_entities.json`: 业务实体语义
- `expected.node_hints.json`: 节点语义提示

## 常见失败定位

看日志类型 `entity`：
- `entity.rules.profile.selected`: 选中了哪个 profile
- `entity.rules.match.hit/miss`: 哪条规则命中/未命中
- `entity.rules.verify.diff`: 具体 diff

如果是 DOM backend id 波动，不要把不稳定字段当 golden 主键。
