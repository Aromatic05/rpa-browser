# WorkspaceAndTab

## 1. 强约束（唯一来源）

- `tabToken` 的唯一生成入口：**extension background -> `tab.init`**。
- content 与 start_extension **禁止**直接发送 `tab.init`、`tab.opened`。
- `tab.opened` 的唯一发送入口：**extension background**。
- 页面侧（content/start_extension）只能通过 `RPA_ENSURE_BOUND_TOKEN` 申请已绑定 token。

## 2. 运行时对象

- agent: `pageRegistry` 维护 `tokenToPage`、`tokenToTab`、`workspaces`。
- extension background: `RouterState` 维护 `tabState`、`tokenToScope`、`windowToWorkspace`。
- 绑定目标：每个 `tabToken` 必须映射到唯一 `(workspaceId, tabId)`。

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
2. background `ensureBoundTabToken` 处理：
- 先尝试 `state` / `preferredToken` / `GET_TOKEN`。
- 无 token 时由 background 发 `tab.init` 生成，并 `SET_TOKEN` 回写页面。
- 解析 workspace（`tokenScope -> window mapping -> active workspace -> workspace.list`）。
- 发 `tab.opened` 完成 agent 绑定；必须拿到 `tabId` 才算成功。
3. 返回 `{ tabToken, workspaceId, tabId }` 给页面。
4. 页面拿到绑定结果后，才允许发 `tab.ping/tab.report/workflow.*`。

## 5. chrome://newtab 阶段规则

- `chrome://newtab` 阶段不发送生命周期动作。
- `ensureBoundTabToken` 在该阶段直接返回不可用（null），调用方不得继续发送业务 action。

## 6. agent 侧严格语义

- `resolveActionTarget` 解析 token 失败时，返回 `ERR_BAD_ARGS`。
- 未知 token 不做降级、不吞错。
- `tab.opened` 由 `bindTabOpenedAction` 专门处理，并执行 claim/bind。

## 7. 关键失败定义

- `resolve_scope_from_token.miss`：agent 未找到 token->scope 映射。
- `tab.opened.defer_claim`：agent 尚未完成 token page 绑定，`tab.opened` 暂未拿到 `tabId`。

## 8. 详细通信图

### 8.1 分层拓扑

```mermaid
flowchart LR
  subgraph PAGE["Page Context"]
    C["content/start_extension"]
  end

  subgraph BG["Extension Background"]
    R["cmd_router"]
    L["life.ensureBoundTabToken"]
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
  L --> M{"tabId returned?"}
  M -- no --> N["strict failure"]
  M -- yes --> O["upsert token scope"]
  O --> P["return bound token/scope"]
```

### 8.3 ACTION 入口

```mermaid
flowchart TD
  A["ACTION ingress"] --> B{"workspace/pageless?"}
  B -- yes --> C["direct route"]
  B -- no --> D["ensureTabToken(sender tab)"]
  D --> E{"token resolved?"}
  E -- no --> F["failed: tab token unavailable"]
  E -- yes --> G["inject scope/tabToken"]
  C --> H["send to agent"]
  G --> H
  H --> I["agent reply"]
  I --> J["applyReplyProjection"]
  J --> K["update tokenToScope/window mapping"]
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
- `src/runtime/action_target.ts`
- `src/actions/workspace.ts`
