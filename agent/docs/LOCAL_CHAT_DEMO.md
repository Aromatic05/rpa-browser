# 本地 Chat Demo

本 Demo 提供一个本地网页 UI，通过工具调用驱动真实浏览器（Playwright）执行任务，并将工具事件与最终答案回显到网页。

## 启动方式

```
pnpm -C agent dev:demo
```

浏览器访问：

```
http://127.0.0.1:17334
```

## 页面区域说明

- **Settings**：配置 LLM
  - `apiBase`：OpenAI-compatible API 基础地址（可包含 `/v1`，系统会自动补齐路径）
  - `apiKey`：仅保存到本地配置文件，页面与日志均只显示脱敏（只露末尾 4 位）
  - `model`、`temperature`、`maxTokens`
  - **Debug LLM**：发送一条最小请求，用于验证 LLM API 是否可用（会显示延迟和返回文本）

- **Environment**：Workspace 状态与准备
  - `Prepare Workspace`：创建（或复用）一个内部 workspace（tabToken 不对外暴露）
  - 可选填写 URL 以自动打开页面

- **Chat**：对话区
  - 显示用户消息、助手最终回答
  - 折叠展示 Tool events（工具调用与结果）
  - 折叠展示 LLM replies（所有 assistant 消息，用于调试）

## API 接口（本地）

- `GET /api/config`：返回脱敏配置
- `PUT /api/config`：保存配置（apiKey 允许空；空则不覆盖）
- `POST /api/env/prepare`：准备 workspace，并可选跳转 URL
- `GET /api/env/status`：返回当前 workspace 公共信息
- `POST /api/chat`：执行工具调用循环，返回 `messages`、`toolEvents`、`finalAnswer`
- `POST /api/llm/debug`：最小 LLM 检测请求

## 工具能力（最小闭环）

工具调用默认作用于 **active workspace**，tabToken 不暴露给模型：

- `browser.goto { url }`
- `browser.snapshot { includeA11y?: boolean, maxNodes?: number }`
- `browser.click { target }`
- `browser.type { target, text, clearFirst?: boolean }`

说明：为了兼容部分模型对工具名的约束，工具名会在发送给 LLM 时做安全映射（仅字母/数字/`_`/`-`），执行时再映射回真实工具。

## 示例指令

```
帮我在 catos.info 网页上找到谷歌网盘下载链接
```

## 调试建议

1. 先点 **Debug LLM** 确认 API 可通。
2. 查看 Tool events 是否触发了 `browser.goto` / `browser.snapshot` 等。
3. 查看 LLM replies 折叠区，确认模型是否正确返回 tool calls。

## 常见问题

- **apiBase 不生效**：请确认 `GET /api/config` 返回的 apiBase 正确；若带 `/v1` 也可正常识别。
- **工具不触发**：模型可能不支持 function calling；尝试更换模型或确认 provider 支持 `tools`。
- **浏览器被关闭**：Playwright 使用可视化窗口运行，请保持窗口开启。
