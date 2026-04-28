# TargetResolve

## 概述

Target resolve 负责把 `nodeId/selector/resolve` 收敛成可执行 selector。

## 规范

### 输入优先级

1. `selector`
2. `nodeId`
3. `resolve.hint + policy`

### hint 来源

- `entity`：`businessTag/fieldKey/actionIntent`
- `target`：`nodeId/primaryDomId/sourceDomIds/role/text/...`
- `locator`：direct/scope/origin
- `raw`：候选 selector 与提示

### policy

- `preferDirect`
- `preferScoped`
- `requireVisible`
- `allowFuzzy`
- `allowIndexDrift`

### 失败语义

未命中返回 `ERR_NOT_FOUND`，附带可诊断 details。

## 示例

```text
nodeId -> locatorIndex.direct.css -> selector
```

## 限制

- resolve 依赖最近 snapshot cache。
- 无 snapshot 时，nodeId 路径无法执行。
