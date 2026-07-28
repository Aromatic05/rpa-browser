# Snapshot V2 Stage 2 Handoff

## 状态

- 阶段：Stage 2 — Atomic Control 与可执行 Locator
- 结果：**accepted**
- 基线提交：`dc903b5 feat(snapshot): establish v2 stage1 observation foundation`
- 当前实现：尚未提交，保留在既有迁移工作区中
- 下一阶段：Stage 3 可以依赖本阶段冻结的 `ControlIndex`、`RelationIndex` 和 `LocatorIndex`

Stage 2 不恢复 `agent/src/runner/steps/executors/snapshot/`，不建立 V1/V2 bridge，也不把仓库整体 typecheck 作为本阶段门槛。`capture_resolve`、query、record、checkpoint 等剩余消费者按后续阶段迁移。

## 冻结 contracts

### Control

- `ControlComponent`
- `ControlIndex`
- `ControlCollectorRegistry`
- `ControlKind`
- `ControlCapability`
- `ControlState`
- `ControlOption`
- `ControlInvariantValidation`
- `AssemblyStatus` 与 inherited `ObservationCompleteness`

支持的 atomic parts：

- input、textarea、button、link、date-like
- native select
- radio group、checkbox group
- custom select
- popup/listbox/options

### Locator

- `CanonicalLocator`
- `LocatorIndex`
- `LocatorScopePath`
- `ExecutableLocatorResolution`
- stale、unresolved、ambiguous、resolved 互斥结果

canonical locator 只使用：

- scope-local unique `id`
- scope-local unique `data-testid`
- scope-local unique `name + tag`
- canonical structural path

不使用文本定位、首个候选、global ID fallback 或 first-popup fallback。

## Control assembly

### Registry

默认 collector 顺序固定：

1. radio groups
2. checkbox groups
3. custom selects
4. native selects
5. popup/options
6. atomic controls

registry 拒绝重复 collector ID。所有 collector 读取同一份 immutable `PageObservation`、`RelationIndex` 与 `LocatorIndex`，只输出唯一 `ControlIndex`。

### Grouping

- radio 的同名合并受 form、fieldset、role group/radiogroup、form-item 和显式 group boundary 限制。
- checkbox 不跨显式 group、安全容器或 form boundary 合并。
- duplicate control ref 产生包含 kind/root/owner 的 ambiguity diagnostic，并清空 executable capability。

### Custom select

- closed custom select 为 `partial`，只声明 `open_popup`。
- 打开后等待同一 control ref 在新 capture revision 中组装为 `complete`。
- popup ownership 只来自 exact typed relation。
- 多 popup 或重复 target 返回 `ambiguous`，不选择第一个。
- Element Plus 的语义 combobox input 与 executable wrapper trigger 分离。
- Ant Design 的零盒 A11y option 与可点击 virtual option 通过同一 dropdown 内的等长 document-order 映射连接；不是文本扫描。
- custom select 保持单值选择合同，与 V1 协议行为一致。

### Capability

- disabled control 不声明 executable capability。
- readonly input/textarea/date-like 可以 focus，但不声明 fill。
- disabled option 在 action 前返回 unresolved，不执行页面动作。
- partial observation/control 不声明依赖缺失事实的 capability。
- 每个 executable control 至少有一个 resolved canonical locator。

## Production interaction migration

以下 target-based action 已切到 V2 ControlIndex/LocatorIndex：

- `browser.click`
- `browser.fill`
- `browser.type`
- `browser.select_option`
- `browser.hover`
- target `browser.scroll`
- targeted `browser.press_key`
- `browser.drag_and_drop`
- element `browser.take_screenshot`

这些 executor 不再导入：

- `resolve_target`
- V1 `snapshot/core`
- V1 `snapshot/pipeline`
- candidate loop
- compressed snapshot control semantics

显式 selector 必须唯一并可映射到 exact canonical identity；否则返回 not-found、ambiguous 或 unresolved。页面滚动、无 target 键盘输入和坐标鼠标仍是非 target 操作，不需要 ControlIndex。

`browser.capture_resolve` 仍是旧解析入口，属于 Stage 5 消费方切换范围，不是第二套 ControlIndex。

## Post-action verification

已通过重新 capture 验证：

- native select
- radio group
- checkbox group
- custom select

验证失败返回 `ERR_ASSERTION_FAILED`，不会把动作已发出等同于成功。custom select 只接受显式 selected/aria-selected/checked 事实，不接受 trigger 文本或 focused option 的隐式 A11y selected。checkbox group 任一后续动作失败时恢复原始 checked 状态。

## 真实浏览器验收

覆盖：

- Element Plus Select closed → open → exact option → selected state
- Ant Design Select portal、虚拟语义 option 与视觉 option 映射
- 多个 custom select 无 exact target 时 ambiguity 且零点击
- iframe 与 open shadow root locator execution
- stale target 和 duplicate target ambiguity
- native select、radio、checkbox
- click、fill、type、hover、target scroll、target press-key
- element screenshot
- drag-and-drop

## 测试

执行：

```text
pnpm -C agent typecheck:snapshot
pnpm -C agent test:snapshot
pnpm -C agent snapshot:v2:stage2-baseline
```

结果：

```text
snapshot typecheck: pass
snapshot tests:     60 pass / 0 fail
stage2 baseline:    pass
```

仓库整体 typecheck 仍会报告尚未迁移消费者对已删除 V1 Snapshot 的引用；该诊断不通过恢复 V1 实现消除。

## 基线

文件：

```text
docs/Development/reports/SnapshotV2Stage2Baseline.json
```

固定语料：10 fixtures × 50 iterations。

```text
input nodes:                         267
controls:                             28
executable controls:                  24
executable without resolved locator:   0
locators:                            265
resolved locators:                   264
unresolved locators:                   1
control invariant failures:            0
```

唯一 unresolved locator 位于明确 unavailable 的 iframe scope；它保留 unresolved diagnostic，不退回全局 selector。

```text
locator build: p50 0.029 ms, p95 0.617 ms
control build: p50 0.024 ms, p95 0.138 ms
```

具体数值以 JSON 基线文件为准，重新运行时会更新 timing。

## Stage 3 输入边界

Stage 3 只能通过以下结构组装 fields 与 form ownership：

```text
PageObservation
RelationIndex
ControlIndex
LocatorIndex
```

禁止 Stage 3：

- 重新扫描 raw DOM 建立另一套 controls
- 复制 radio/checkbox grouping
- 复制 custom-select popup ownership
- 从文本或第一个 popup 推断 control
- 恢复 V1 `runner/snapshot/control`
