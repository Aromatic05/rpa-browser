# RPA Extension Demo

一个最小可运行的“浏览器录制/回放”Demo：
- Chrome Extension (MV3) 负责 UI、tabToken 绑定、发指令
- Agent (Node + Playwright) 负责打开 Chromium、注入 recorder、执行录制与回放
- 扩展与 Agent 通过 WebSocket `ws://127.0.0.1:17333` 通信

## 项目结构

```
agent/                       # Node + Playwright + WS server
  src/
    index.ts                 # 入口：WS 命令路由、会话管理
    runtime/                 # Chromium context、page registry、tabToken 绑定
    record/                  # 录制：注入 recorder、事件归档
      recorder.ts            # 注入器（installRecorder）
      recorder_payload.ts    # 注入脚本字符串（页面内监听事件）
      recording.ts           # 录制状态与存储
    play/                    # 回放：按记录执行步骤
    runner/                  # 执行动作（click/type/scroll/navigate...）
extension/                   # Chrome Extension (MV3)
  src/
    content.ts               # 注入悬浮球 UI、tabToken 上报
    sw.ts                    # Service Worker：与 agent 通过 WS 通信
    panel.ts                 # side panel（保留）
  dist/                      # 构建产物（加载到 Chrome 的扩展目录）
```

## 环境要求

- Node.js LTS
- pnpm

## 安装依赖

```
pnpm install
```

## 构建扩展并启动 Agent

方式一（推荐：一键）：

```
pnpm -C extension demo
```

方式二（分步）：

```
pnpm -C extension build
pnpm -C agent dev
```

Agent 启动后会自动用 Playwright 打开 Chromium，并加载 `extension/dist`。

## 在浏览器里加载扩展

1. 打开 Chrome/Chromium 的扩展管理页
2. 开启 **开发者模式**
3. 点击 **Load unpacked**
4. 选择本项目的 `extension/dist` 目录

## 使用步骤（MVP）

1. 在任意非受限页面打开浏览器（如 https://catos.info）
2. 右上角出现 **RPA 悬浮球**，点击展开面板
3. 点击 **Start Recording**，开始录制
4. 手动点击/输入/滚动页面
5. 点击 **Stop Recording**
6. 点击 **Show Recording** 查看录制事件
7. 点击 **Replay Recording** 在当前 tab 回放

## Debug 提示

- 扩展前端日志（页面 console）：
  - `[RPA] HELLO` / `[RPA] send command` / `[RPA] response`
- Service Worker 日志：
  - `ws open/send/message/close` / `onMessage`
- Agent 日志：
  - `[RPA:agent] record event` / `recording start/stop`

## 常见问题

- **点击/滚动未录制**
  - 确认扩展已加载 `extension/dist` 最新构建
  - 确认页面 console 没有 `__name is not defined` 报错
- **没有看到悬浮球**
  - 确认扩展已加载、页面非受限（如 chrome://）

## 备注

- 扩展只负责 UI 和指令发起，不直接执行自动化
- Agent 负责真实自动化与录制回放逻辑
