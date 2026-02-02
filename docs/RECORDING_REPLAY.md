# 录制与回放

## 录制（extension 侧）

录制已调整为“轻量捕获 + 回传 agent”，入口与实现位于 `extension/src/record/*`：

- 捕获事件：`event_capture.ts`（click/input/change/keydown/scroll/navigate）
- 目标描述：`target_descriptor.ts`（生成可序列化 TargetDescriptor）
- 录制管理：`recorder.ts`（仅转发事件，不做推理）
- 本地缓存：`record_store.ts`（仅内存，逐步废弃）

录制输出的核心数据是 `RawEvent`：

```
{
  type: "click" | "input" | "change" | "keydown" | "scroll" | "navigate",
  ts: number,
  url: string,
  target?: {
    tag: string,
    id?: string,
    nameAttr?: string,
    typeAttr?: string,
    roleAttr?: string,
    ariaLabel?: string,
    text?: string,
    selector?: string,
    inputValue?: string
  },
  value?: string,
  key?: { code: string; key: string; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean },
  scroll?: { x: number; y: number }
}
```

说明：

- extension 不再生成 `RecordedStep`，也不做 a11y 推理。
- selector 只做轻量、保守的描述（避免复杂定位）。
- 事件通过 background -> ws 发送到 agent：`record.event`。

## 回放（agent 侧）

回放统一进入 `runSteps`，由 agent 完成：

1. extension 捕获 `RawEvent` -> background 发送 `record.event`。
2. agent 侧将事件解析为 Step（click/fill/select_option/press_key/scroll/goto）。
3. 元素类操作通过 `trace.page.snapshotA11y` 获取树并解析 hint/候选。
4. 失败时返回结构化错误（`ERR_NOT_FOUND/ERR_AMBIGUOUS/ERR_TIMEOUT` 等）。

## 说明

- 录制端职责收敛到“采集 + 转发”，降低复杂度与不稳定性。
- 事件合并（例如 click + input => fill）与去重逻辑全部在 agent 侧完成。
