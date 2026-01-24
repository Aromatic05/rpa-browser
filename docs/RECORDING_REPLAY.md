# 录制与回放

## 录制

录制由注入脚本处理，见 `agent/src/record/recorder_payload.ts`。

捕获的事件（子集）：
- click
- input/change（不包含 select/checkbox/radio）
- check（checkbox/radio）
- select
- date
- paste/copy
- keydown
- scroll
- navigate（来自页面导航）

每个事件存储：
- `locatorCandidates`：按顺序的语义定位器列表 + CSS 回退
- `scopeHint`：`aside` | `header` | `main`

## 回放

回放使用自愈（self-heal）定位器解析：

1) 按顺序尝试每个候选（testid > role > label > placeholder > text > css）
2) 跳过计数为 0 或计数 > 1（不明确）的候选
3) 成功时：等待可见 -> scrollIntoView -> 执行动作
4) 失败时：将截图写入 `.artifacts/replay/<tabToken>/<ts>.png` 并包含证据

## 常见失败模式

- 动态类（`.active`、nth-of-type）：避免在 CSS 中使用；使用语义定位器。
- 隐藏菜单：录制时应包含打开菜单的操作步骤。
- Select 元素：仅通过 `select` 事件处理（忽略 input 事件）。
