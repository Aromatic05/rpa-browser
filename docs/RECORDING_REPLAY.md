# 录制与回放

## 录制（extension 侧）

录制已重写为“直接输出 Step”的结构化流程，入口与实现位于 `extension/src/record/*`：

- 捕获事件：`event_capture.ts`
- 构建定位：`locator_builder.ts`（优先 role/name/text）
- 事件归一化：`event_normalize.ts`（输出 `RecordedStep`）
- 本地缓存：`record_store.ts`

录制输出的核心数据是 `RecordedStep`：

```
{
  id: string,
  name: "browser.goto" | "browser.snapshot" | "browser.click" | "browser.fill",
  args: {
    a11yNodeId?: string,
    a11yHint?: { role?: string; name?: string; text?: string },
    url?: string,
    value?: string
  },
  meta: { ts, tabToken, workspaceId?, source: "record" }
}
```

说明：

- 录制时优先写入 `role/name` 作为 `a11yHint`，稳定性高于 CSS/坐标。
- `a11yNodeId` 在录制侧通常不可直接获取，因此默认以 `a11yHint` 为主。
- 录制数据先缓存于 `record_store`，可用于离线重试与回放。

## 回放（agent 侧）

回放不再走旧的 locatorCandidates 链路，而是统一进入 `runSteps`：

1. `record.replay` -> 扩展发送 `steps.run`。
2. `agent/src/runner/run_steps.ts` 统一执行 Step。
3. 元素类操作通过 `trace.page.snapshotA11y` 获取树并解析 `a11yHint`。
4. 失败时返回结构化错误（`ERR_NOT_FOUND/ERR_AMBIGUOUS/ERR_TIMEOUT` 等）。

## 常见失败模式（更新）

- 页面可访问性信息缺失：`a11yHint` 无法匹配，导致 `ERR_NOT_FOUND`。
- 文本歧义：多个元素匹配 `role/name`，返回 `ERR_AMBIGUOUS`。
- 动态菜单未展开：需要录制“打开菜单”的前置步骤。

## 说明

- 旧的 locatorCandidates/self-heal 逻辑已收敛，不再作为默认链路。
- 录制与回放统一在 Step 模型上，便于 trace 观测与后续演进。
