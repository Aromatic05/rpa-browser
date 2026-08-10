# Workflow 持久化与运行时

## 定位

Workflow 是 workspace 绑定的持久化自动化工程。当前约束：

```text
workspace.name === workflow.name
```

Workflow 负责保存和组织 DSL、checkpoint、recording、entity rules；workspace 负责浏览器会话和运行时控制。

## 目录结构

默认根目录：

```text
agent/.artifacts/workflows/<workflowName>/
```

单个 workflow：

```text
<workflowName>/
  workflow.yaml

  dsls/
    main.dsl
    main.resolve.yaml

  checkpoints/
    <checkpointId>/
      checkpoint.yaml
      body.dsl
      checkpoint_resolve.yaml
      checkpoint_hints.yaml

  recordings/
    <recordingName>/
      recording.yaml
      steps.yaml
      step_resolve.yaml

  entity_rules/
    <profileName>/
      page.yaml
      match.yaml
      annotation.yaml
```

## workflow.yaml

核心 source-of-truth 字段：

```yaml
version: 1
name: orders
entry:
  dsl: main
createdAt: 1700000000000
updatedAt: 1700000000000
```

`entry.dsl` 是默认 DSL 入口。

### catalog

`catalog` 是**可选的 cache / display metadata**，不是 artifact 存在性的 source of truth。

运行时行为：

- `dsls/`、`checkpoints/`、`recordings/`、`entity_rules/` 中真实存在的合法 artifact 可直接被 `workflow.get/list` 发现，即使没有 catalog entry。
- artifact 已被完整删除但 catalog 仍有 entry 时，该 entry 视为 stale cache，不会把 workflow 判坏。
- artifact 目录仍存在但内部必需文件损坏/缺失时，仍返回 artifact corruption；不会因为 catalog 可选而吞掉真实损坏。
- `catalog` 整体缺失时 workflow 仍可加载。
- 通过 workflow API save/delete 后会清理可确认的 stale cache，并刷新当前 mutation 的派生 metadata。

因此直接 Git/AI 编辑 artifact 时，不需要同步维护 `summary`、checkpoint `enabled/priority` 副本或 catalog membership。

## Artifact facade

Workflow 内部 facade：

```text
workflow.save(value)
workflow.get(name, {kind})
workflow.list({kind})
workflow.delete(name, {kind})
```

artifact kind：

- `dsl`
- `checkpoint`
- `recording`
- `entity_rules`

所有 workflow/artifact 名称必须满足安全 artifact-name 边界；path traversal 和 path separator 在 filesystem access 前拒绝。

## Control actions

Control-plane workflow actions：

- `workflow.list`
- `workflow.create`
- `workflow.open`
- `workflow.rename`
- `workflow.saveAs`
- `workflow.resetDefault`

命名只来自显式 payload，例如 `workflowName`、`fromName/toName`、`sourceName/targetName`，不使用隐式 active-workspace fallback。

`workflow.open` 会创建/绑定同名 workspace、启动 browser session，并在没有 live tab 时创建一个 `about:blank` tab；它不会自动运行 entry DSL。

## Workspace authoring actions

DSL：

- `dsl.get`
- `dsl.save`
- `dsl.validate`
- `dsl.test`（兼容入口，仅 validate）
- `dsl.run`

Checkpoint：

- `checkpoint.list`
- `checkpoint.get`
- `checkpoint.save`
- `checkpoint.delete`

Entity rules 和 recording 也通过 workspace-scoped actions 操作。

## DSL 保存边界

`dsl.save` 在持久化前执行：

```text
parse -> link -> normalize -> validate
```

并检查引用的 checkpoint graph，包括 missing/non-callable/body-missing/recursion/depth，以及每个被引用 procedure body 的 DSL 语义有效性。

`dsl.run` 在同一个 workspace `executing` 生命周期内完成 snapshot 物化、source + whole checkpoint graph preflight 和实际执行。任何 step 执行前都会先验证本次真正要使用的冻结 checkpoint/entity-rule/resolve snapshot；这既覆盖直接文件编辑绕过 `dsl.save` 的情况，也保证“验证对象”与“实际执行对象”一致。

如果 `stepResolves` 没有显式提供，保存会保留已有 sidecar；显式提供时先验证候选 sidecar，再写入。

## Checkpoint 保存边界

`checkpoint.save` 会：

- 保持 `artifact name === checkpoint.id`；
- 校验 checkpoint serialization；
- 保留 metadata-only update 未显式替换的 body/resolve/hints；
- 对 `body.dsl` 做 DSL validation；
- 校验 nested checkpoint graph。

## Entity rules

Entity rules 持久化分为：

- `page.yaml`：页面适用范围；
- `match.yaml`：如何从 snapshot 找到结构/节点；
- `annotation.yaml`：业务 `entityKey`、`businessTag`、field/action/primary-key 语义。

业务 DSL 应依赖这些稳定语义，而不是直接依赖 selector。

## Recording

Recording 保存真实步骤与 resolve sidecar，主要面向录制、回放和后续生成/维修，不要求人类把 `steps.yaml` / `step_resolve.yaml` 当主业务源码维护。

## 并发与一致性

Workflow mutation 通过 filesystem lock 序列化。stale lock 回收使用 generation-aware handoff，延迟的旧 reclaimer 不能删除后来获得的新 owner lock。

stale generation 会留下很小的 `*.lock.reclaimed/` tombstone；它属于运行时锁协议，不是 workflow artifact，不应在运行中的 agent 下由 authoring 工具自动清理。

save/delete 的 artifact 与 manifest mutation 带 rollback 边界：manifest 更新失败时尝试恢复 mutation 前 artifact snapshot。

rename/copy 在执行前扫描真实存在的 artifact：

- stale catalog 不阻塞；
- 实际存在但损坏的 artifact 会阻止生命周期 mutation。

## 人类与 AI 编辑建议

适合作为主源码直接编辑：

- `dsls/*.dsl`
- `checkpoints/*/checkpoint.yaml`
- `checkpoints/*/body.dsl`
- `entity_rules/*/page.yaml`
- `entity_rules/*/match.yaml`
- `entity_rules/*/annotation.yaml`

偏机器生成/辅助资产：

- `*.resolve.yaml`
- `checkpoint_hints.yaml`
- recordings 的 step/resolve 文件
- `workflow.yaml.catalog`

AI 可以直接新增、删除和修改合法 artifact，而不需要手工同步 catalog；但修改后仍应通过对应 `dsl.validate` / save validation 和实际执行验证。

## 当前限制

- DSL 尚未覆盖 runner 的全部 browser primitive。
- `dsl.run` 尚未接入 task runner durable checkpoint store，进程崩溃后不能从 DSL cursor 继续。
- DSL/checkpoint 普通 authoring API 尚未全面采用 artifact revision / expectedRevision 乐观并发；旧读取结果仍可能被后写覆盖。
- DSL diagnostic 尚无完整 source span。
- Workflow transaction 提供进程级 rollback，但当前不是完整的掉电 durability protocol。
