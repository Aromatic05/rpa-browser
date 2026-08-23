# Checkpoint 运行时

## 两个不同的 checkpoint domain

项目中存在两个不同概念，不能混用：

1. **Workflow checkpoint artifact**：业务 procedure / failure recovery，本文件描述它。
2. **Task run checkpoint**：runner 的持久化 cursor/status，用于任务执行进度恢复，由 `task.run.*` / checkpoint store 管理。

Workflow checkpoint 不等价于 durable task checkpoint。

## Artifact 布局

```text
checkpoints/<checkpointId>/
  checkpoint.yaml
  body.dsl                  # DSL body 声明时必需
  checkpoint_resolve.yaml   # 可选低层 resolve sidecar
  checkpoint_hints.yaml     # authoring / recovery hints
```

`checkpoint.yaml` 示例：

```yaml
version: 1
checkpoint:
  id: ensure-login
  kind: procedure
  name: 确保登录
  body:
    language: dsl
    source: body.dsl
```

`checkpoint.id` 必须与 artifact 目录名一致。

## Procedure

Procedure 由 DSL 显式调用：

```dsl
let session = use checkpoint "ensure-login" with {
  username: input.username
  password: input.password
}
```

推荐 procedure 使用 `body.dsl`：

```dsl
use entity_rules "login-page" as login
fill login.loginForm.username with input.username
fill login.loginForm.password with input.password
click login.loginForm.submit
output authenticatedUser = input.username
```

procedure 输出就是 `body.dsl` 的 `output` scope。

## Recovery

Recovery checkpoint 在普通 runner step 失败后自动候选匹配。

```yaml
version: 1
checkpoint:
  id: renew-session
  kind: recovery
  enabled: true
  priority: 100
  trigger:
    matchRules:
      - errorCode: ERR_UNRESOLVED
      - entityExists:
          query: ""
          kind: panel
          businessTag: auth.expired
  policy:
    maxAttempts: 1
    retryOriginal: true
  body:
    language: dsl
    source: body.dsl
```

`trigger.matchRules` 当前是 **all-of** 语义：一个 checkpoint 中的所有 rule 都命中才选择该 checkpoint。

支持的 match rule：

- `errorCode`
- `stepName`
- `urlIncludes`
- `textVisible`
- `entityExists`

候选先过滤 disabled / attempts / stepName / errorCode，再按 `priority` 从高到低选择。

## Recovery body scope

Recovery `body.dsl` 除普通 DSL scope 外还可读取 `failure.*`：

- `failure.step`
- `failure.error.code`
- `failure.error.message`
- `failure.attempt`
- `failure.maxAttempts`
- `failure.url`（可用时）

`failure.*` 不允许出现在普通 workflow DSL 或 procedure body 中。

## Retry 语义

Recovery body 成功后：

- `policy.retryOriginal !== false`：重新执行原失败 step；最终结果取 retry result。
- `policy.retryOriginal === false`：checkpoint 成功即完成该 recovery。
- `maxAttempts` 同时受 checkpoint policy 与 runner 全局上限限制。

Checkpoint flow 内再次失败不会无限递归进入同一 recovery flow。

## DSL body validation

`checkpoint.save` 在写盘前验证：

- checkpoint serialization / body metadata；
- body DSL parse/link/normalize/validate；
- recovery-only `failure.*` scope；
- entity-rule / resolve imports；
- nested checkpoint 是否存在、是否可调用；
- body 是否缺失；
- checkpoint recursion；
- 最大调用深度。

metadata-only 更新会复用并重新验证已持久化的 `body.dsl`，不会绕过 body validation。

`checkpoint.list/get/save` 返回 `artifactRevision`。协作式 `checkpoint.save/delete` 可传 `expectedRevision`：省略表示兼容的无条件 mutation，`null` 表示要求 artifact 不存在，字符串表示要求当前实际 revision 精确匹配。比较与 mutation 在同一个 workflow filesystem lock 内完成，冲突返回 `ERR_CONFLICT`。

Checkpoint revision 直接由 checkpoint metadata、`body.dsl`、resolve sidecar 与 hints 的语义内容计算，不额外保存 revision 文件；直接文件编辑会自动让旧 revision 失效。

## 运行时 snapshot

DSL run 开始时会物化其引用的 checkpoint graph、body、resolve 和 entity-rule exports，并冻结为本次执行 snapshot。执行开始后的 artifact 修改不会直接改变已经启动的这次 run。

## Legacy procedure model

运行时仍保留旧的 `prepare` / `content` / `output` action model 以兼容现有 artifact。

新 checkpoint 应优先使用 `body.dsl`。一个 checkpoint 一旦声明 `body.dsl`，不能同时持久化 legacy `prepare` / `content` / `output`，避免两套 procedure 语义混合。

## 当前限制

- Workflow recovery 解决的是页面/step 失败恢复，不提供 DSL run 的进程崩溃续跑。
- `checkpoint` 这个名称同时出现在 workflow artifact 与 runner durable checkpoint 中；代码 domain 已分开，但术语仍需注意。
- 相同 priority 的 recovery 候选目前没有独立的显式 tie-break policy。
