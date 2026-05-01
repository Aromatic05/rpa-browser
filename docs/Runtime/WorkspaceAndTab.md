# WorkspaceAndTab

## 1. 强约束（唯一来源）

- `tabName` 的唯一生成入口：**extension background -> `tab.init`**。
- content 与 start_extension **禁止**直接发送 `tab.init`、`tab.opened`。
- `tab.opened` 的唯一发送入口：**extension background**。
- 页面侧（content/start_extension）只能通过 `RPA_ENSURE_BOUND_TOKEN` 申请已绑定 token。

## 2. 运行时对象

- agent: `pageRegistry` 维护 `tokenToPage`、`tokenToTab`、`workspaces`。
- extension background: `RouterState` 维护 `tabState`、`bindingNameToWorkspaceTab`、`windowToWorkspace`。
- 绑定目标：每个 `tabName` 必须映射到唯一 `(workspaceName, tabName)`。

## 3. 通信总线

### 3.1 runtime message（页面 <-> background）

- `RPA_ENSURE_BOUND_TOKEN`
- `RPA_GET_TOKEN`
- `RPA_SET_TOKEN`
- `ACTION`
- `RPA_HELLO`

### 3.2 action（background <-> agent）

- 绑定相关：`tab.init`、`tab.opened`
- 生命周期：`tab.report`、`tab.ping`、`tab.activated`、`tab.closed`、`tab.reassign`
- workspace：`workspace.list/create/setActive/save/restore`

## 4. 绑定流程（硬规则）

1. 页面发 `RPA_ENSURE_BOUND_TOKEN`。
2. background `ensureBoundTabName` 处理：
- 先尝试 `state` / `preferredToken` / `GET_TOKEN`。
- 无 token 时由 background 发 `tab.init` 生成，并 `SET_TOKEN` 回写页面。
- 解析 workspace（`tokenScope -> window mapping -> active workspace -> workspace.list`）。
- 发 `tab.opened` 完成 agent 绑定；必须拿到 `tabName` 才算成功。
3. 返回 `{ tabName, workspaceName, tabName }` 给页面。
4. 页面拿到绑定结果后，才允许发 `tab.ping/tab.report/workflow.*`。

## 5. chrome://newtab 阶段规则

- `chrome://newtab` 阶段不发送生命周期动作。
- `ensureBoundTabName` 在该阶段直接返回不可用（null），调用方不得继续发送业务 action。

## 6. agent 侧严格语义

- Action 入口分流仅按 `workspaceName`；缺失或非法地址返回 `ERR_BAD_ARGS`。
- 未知 token 不做降级、不吞错。
- `tab.opened` 由 `bindTabOpenedAction` 专门处理，并执行 claim/bind。

## 7. 关键失败定义

- `resolve_scope_from_token.miss`：agent 未找到 token->scope 映射。
- `tab.opened.defer_claim`：agent 尚未完成 token page 绑定，`tab.opened` 暂未拿到 `tabName`。

## 8. 详细通信图

### 8.1 分层拓扑

```mermaid
flowchart LR
  subgraph PAGE["Page Context"]
    C["content/start_extension"]
  end

  subgraph BG["Extension Background"]
    R["cmd_router"]
    L["life.ensureBoundTabName"]
    S["RouterState"]
  end

  subgraph AG["Agent"]
    W["WS server"]
    P["pageRegistry"]
    H["workspace/tab handlers"]
  end

  C -- "RPA_ENSURE_BOUND_TOKEN" --> R
  R --> L
  L -- "RPA_GET_TOKEN / RPA_SET_TOKEN" --> C
  L -- "tab.init / tab.opened / workspace.list" --> W
  C -- "ACTION(tab.ping/report/workflow.*)" --> R
  R -- "scoped ACTION" --> W
  W --> P
  W --> H
  W -- "tab.bound/workspace.sync" --> R
  R --> S
```

### 8.2 ENSURE_BOUND_TOKEN 分支

```mermaid
flowchart TD
  A["ENSURE_BOUND_TOKEN"] --> B["resolve tab/window"]
  B --> C{"has token?"}
  C -- yes --> D["use token"]
  C -- no --> E["GET_TOKEN"]
  E --> F{"token returned?"}
  F -- yes --> D
  F -- no --> G["tab.init by background"]
  G --> H["SET_TOKEN"]
  H --> D

  D --> I{"url is chrome://newtab?"}
  I -- yes --> J["return unavailable (null)"]
  I -- no --> K["resolve workspace"]
  K --> L["tab.opened"]
  L --> M{"tabName returned?"}
  M -- no --> N["strict failure"]
  M -- yes --> O["upsert binding workspace mapping"]
  O --> P["return bound tab reference/scope"]
```

### 8.3 ACTION 入口

```mermaid
flowchart TD
  A["ACTION ingress"] --> B{"workspace/pageless?"}
  B -- yes --> C["direct route"]
  B -- no --> D["ensureTabName(sender tab)"]
  D --> E{"token resolved?"}
  E -- no --> F["failed: tab token unavailable"]
  E -- yes --> G["attach workspaceName/tabName payload"]
  C --> H["send to agent"]
  G --> H
  H --> I["agent reply"]
  I --> J["applyReplyProjection"]
  J --> K["update bindingNameToWorkspaceTab/window mapping"]
```

## 9. 代码定位

- extension
- `src/background/life.ts`
- `src/background/cmd_router.ts`
- `src/background/action.ts`
- `src/content/token_bridge.ts`
- `src/entry/content.ts`
- start_extension
- `src/entry/newtab.ts`
- agent
- `src/index.ts`
- `src/runtime/page_registry.ts`
- `src/actions/workspace.ts`

## 10. 第二阶段接口迁移边界

- 删除 `runtime.ensureActivePage`，运行时入口统一为 `workspaceName/tabName`。
- 删除 `ActionContext.page`、`ActionContext.tabName` 通用字段。
- `Action` 顶层地址字段仅保留 `workspaceName`。
- `tabName` 只在 workspace 内部运行时和 payload 中使用。
- `workspace` 运行时对象持有 `workflow`、`runner`、`tabRegistry`。
- `tabRegistry` 归属单个 workspace，并维护该 workspace 的 `activeTab`。
- `page_registry` 退化为底层 page/lifecycle adapter，不再承担业务路由核心。
- 本阶段只迁公共接口与直接编译断点。
- 本阶段不做 record/play 深层迁移。
- 本阶段不做 workflow artifact 迁移。
- 本阶段不做 checkpoint runtime 重写。
- 本阶段不做 DSL 实现修改。
