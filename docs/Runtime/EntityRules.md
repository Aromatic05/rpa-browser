# Entity Rules V2 运行时

## 概述

Entity Rules V2 把页面业务语义描述为 QueryPlan 和 SemanticBindings。规则只消费 Snapshot V2 的 canonical observation、FormComponent、TableComponent 或明确的 generic node domain，不运行独立 DOM 识别器。

## Artifact

一个 profile 位于：

```text
workflows/<workflow>/entity_rules/<profile>/
  page.yaml
  match.yaml
  annotation.yaml
```

`page.yaml` 描述页面适用条件：

```yaml
kind: table
urlPattern: /orders$
```

`match.yaml`：

```yaml
version: 2
rules: []
```

`annotation.yaml`：

```yaml
version: 2
bindings: []
```

发布保存只接受 V2。读取时允许导入合法 V1 artifact，但导入失败必须可诊断，不能静默改写原文件。

## 选择与执行

规则选择支持 explicit、auto、inherit 和 disabled。页面 URL 与 `page.kind` 共同限制 profile applicability。规则执行结果进入当前 PageSession，并由 RuntimeEntityView 提供：

- form fields/actions；
- table filters/module actions/rows/row actions/pagination；
- dialog/list/panel/toolbar/kv 的明确 node-domain 字段与操作。

成员 binding 必须按实际 component 或 node scope 隔离，不能只按 profileName 合并。

## Annotator

Annotator 的编辑流程为：

```text
open -> pick/recognize -> local edit -> apply -> check -> save
```

`apply` 只更新草稿；`save` 才写入 workflow artifact。保存必须使用真实 artifact revision 做乐观并发控制，页面 capture revision 不能替代 artifact revision。

Annotator 协议必须显式版本化或使用独立 action 名，不能根据 `url`、`canvasDraft` 等普通业务字段猜测协议版本。

## V1 导入

V1 的 `page.kind` 和 `urlPattern` 是独立的页面适用信息。导入器不得要求每个合法 V1 profile 都存在显式 `match.kind` 根规则；没有显式根规则时，应在 V2 中构造能保持页面 domain 的明确根规则，或返回可见迁移诊断。

## 排障

- profile 不显示：检查 manifest catalog、artifact 读取错误和迁移 diagnostics。
- query 命中错误组件：检查 binding 的 componentIds/nodeIds 与 scope 隔离。
- 保存覆盖他人修改：检查 artifact revision 比较和原子写入。
- 规则可见但当前页不生效：检查 `page.kind`、`urlPattern` 和当前 PageSession URL。
