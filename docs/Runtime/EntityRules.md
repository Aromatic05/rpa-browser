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

`entity_rules.save` 在持久化前会把候选 artifact 编译成 QueryPlan。保存阶段与实际 matcher 共用同一 profile-domain 推导；unsupported match key、非法参数等不可执行规则直接返回 `ERR_BAD_ARGS`，不会留下一个“保存成功但首次执行必失败”的 profile。

通用 authoring API 使用 artifact revision：`entity_rules.get/save` 返回 `artifactRevision`，`entity_rules.save/delete` 可带 `expectedRevision`。比较与写入发生在同一个 workflow mutation lock 内；协作式 editor/AI 应使用 `get -> edit -> save(expectedRevision)`，遇到 `ERR_CONFLICT` 后重新读取。

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

`projection-v1` 的 `open/recognize/visualize` 会携带当前 `artifactRevision`；extension annotator session 保存该 revision，并在 `save` 时作为 `expectedRevision` 回传，成功后替换为服务端返回的新 revision。不同 profile 之间不会复用旧 revision。

Annotator 不是长期占有 workspace 的独立状态，但每个会 capture、修改 selection 或保存规则的 annotator 请求都会通过 workspace execution coordinator。它不能与正在运行的 DSL/task/playback/MCP browser mutation 并发操作同一 workspace。

Annotator 请求使用显式 `annotatorProtocol` discriminator：

- `projection-v1`：共享 V2 projection/draft API；
- `canvas-v1`：当前产品 CanvasDraft 编辑 API。

服务端会在路由前剥离 discriminator。缺失或未知协议会返回 `ERR_BAD_ARGS`，不能根据 `url`、`canvasDraft`、`expectedRevision` 等普通业务字段猜测协议版本。

## V1 导入

V1 的 `page.kind` 和 `urlPattern` 是独立的页面适用信息。导入器不得要求每个合法 V1 profile 都存在显式 `match.kind` 根规则；没有显式根规则时，应在 V2 中构造能保持页面 domain 的明确根规则，或返回可见迁移诊断。

## 排障

- profile 不显示：检查 manifest catalog、artifact 读取错误和迁移 diagnostics。
- query 命中错误组件：检查 binding 的 componentIds/nodeIds 与 scope 隔离。
- 保存覆盖他人修改：检查 artifact revision 比较和原子写入。
- 规则可见但当前页不生效：检查 `page.kind`、`urlPattern` 和当前 PageSession URL。
