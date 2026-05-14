# 运行指南

## 启动模式

### 有头模式（headed）

默认启动方式，浏览器窗口可见：

```bash
# 构建扩展并启动 agent
pnpm dev

# 或仅启动 agent（需提前构建扩展）
pnpm -C agent dev
```

### 无头模式（headless）

浏览器在后台运行，不显示窗口：

```bash
# 方式一：内置 headless 脚本
pnpm dev:headless

# 方式二：手动指定环境变量
RPA_HEADLESS=true pnpm dev
```

无头模式下扩展加载依赖 `channel: 'chromium'` 选项。如果扩展未正常加载，确认 Playwright 使用的是完整 Chromium 而非 headless shell。

---

## 可配置的环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RPA_HEADLESS` | `false` | `true` 时启用无头模式 |
| `RPA_BROWSER_MODE` | `extension` | `extension` — 扩展模式（默认）；`cdp` — CDP 远程调试模式 |
| `RPA_USER_DATA_DIR` | `agent/.user-data` | Chromium 用户数据目录路径 |
| `RPA_START_URL` | `chrome://newtab/` | 浏览器启动后打开的起始页 |
| `RPA_WS_PORT` | `17333` | Agent WebSocket 服务端口 |
| `RPA_WS_TAP` | — | `1` 时启用 WebSocket 消息透传日志（调试用） |

### CDP 模式相关变量

`RPA_BROWSER_MODE=cdp` 时额外支持：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RPA_CDP_ENDPOINT` | — | CDP 端点地址（如 `ws://127.0.0.1:9222/devtools/...`），指定后跳过自动启动 |
| `RPA_CDP_PORT` | `9222` | 自动启动 Chrome 时的 CDP 端口 |
| `RPA_CDP_AUTO_LAUNCH` | `true` | `false` 时不自动启动 Chrome，必须通过 `RPA_CDP_ENDPOINT` 指定 |
| `RPA_CDP_USER_DATA_DIR` | `<RPA_USER_DATA_DIR>/cdp-browser` | CDP 模式的用户数据目录 |
| `RPA_CDP_CHROME_PATH` | — | 指定 Chrome 可执行文件路径 |

### 使用示例

```bash
# 自定义用户数据目录 + 无头模式
RPA_USER_DATA_DIR=/tmp/my-profile RPA_HEADLESS=true pnpm dev

# CDP 模式 + 自定义起始页
RPA_BROWSER_MODE=cdp RPA_START_URL=https://example.com pnpm dev

# 指定 Chrome 路径的 CDP 模式
RPA_BROWSER_MODE=cdp RPA_CDP_CHROME_PATH=/usr/bin/google-chrome pnpm dev
```

---

## 控制台交互（Control Eval）

控制台交互允许在 agent 运行时动态执行 JavaScript 代码，用于调试、探查运行状态或执行临时操作。

### 启用

启动 agent 时设置 `RPA_CONTROL_EVAL=1`：

```bash
RPA_CONTROL_EVAL=1 pnpm dev
```

不设置此变量时，所有 eval 请求会被拒绝并返回 `ERR_CONTROL_EVAL_DISABLED`。

### 命令行客户端

agent 自带 CLI 客户端 `pnpm control`，通过 Unix socket（Linux/macOS）或命名管道（Windows）连接到运行中的 agent：

```bash
# 内联执行 JavaScript
pnpm -C agent control --source "ctx.log('hello')"

# 从文件读取脚本执行
pnpm -C agent control --file ./script.js

# 指定 workspace
pnpm -C agent control --source "ctx.log(ctx.workspaceName)" --workspace my-ws

# 传入输入参数
pnpm -C agent control --source "return ctx.input.foo" --input '{"foo":"bar"}'

# 自定义超时（默认 10s）
pnpm -C agent control --source "await ctx.sleep(5000)" --timeout-ms 30000

# 连接到非默认端点
pnpm -C agent control --source "ctx.log('hi')" --endpoint /tmp/rpa-browser-1000/agent.sock
```

### 运行时上下文（ctx）

eval 脚本中可通过 `ctx` 对象访问以下能力：

| 属性/方法 | 类型 | 说明 |
|-----------|------|------|
| `ctx.deps` | `RunStepsDeps` | 步骤执行依赖（工作流上下文、页面注册器等） |
| `ctx.workspaceRegistry` | `WorkspaceRegistry` | workspace 注册表 |
| `ctx.config` | `RunnerConfig` | 运行时配置 |
| `ctx.dispatch(action)` | `(action) => Promise<Action>` | 分发 Action 到扩展 |
| `ctx.resolveWorkspace(name?)` | `(name?: string) => Workspace` | 解析 workspace 实例 |
| `ctx.runStep(step, workspaceName?)` | `(step, name?) => Promise<StepResult>` | 执行单个 Step |
| `ctx.runDsl(source, input?, workspaceName?)` | `(source, input?, name?) => Promise<unknown>` | 执行 DSL 源码 |
| `ctx.log(...args)` | `(...args) => void` | 输出日志（随响应返回） |
| `ctx.sleep(ms)` | `(ms: number) => Promise<void>` | 异步等待 |
| `ctx.state` | `Record<string, unknown>` | 跨 eval 调用共享的状态对象 |
| `ctx.input` | `unknown` | CLI `--input` 传入的参数 |

### 通信协议

控制协议基于 JSON 行协议（JSON Lines），通过 Unix socket 通信。

**请求格式：**

```json
{"id":"uuid","source":"ctx.log('hi')","workspaceName":"default","timeoutMs":10000}
```

**响应格式：**

```json
{"id":"uuid","ok":true,"result":null,"logs":["hi"]}
```

错误响应含 `error` 字段，包含 `code`、`name`、`message`、`stack`。

默认端点路径：
- Linux：`$XDG_RUNTIME_DIR/rpa-browser/agent.sock` 或 `/tmp/rpa-browser-<uid>/agent.sock`
- Windows：`\\.\pipe\rpa-browser-agent`
