# Record 模块架构

Record 模块负责把用户在浏览器页面上的真实交互，转换成可以保存、回放、调试的 `Step` 数据。

它的核心目标不是记录所有底层 DOM 事件，而是把用户行为整理成稳定、可回放的自动化步骤。当前模块分为四层：

```text
capture -> pipeline -> enhancement -> control
             |
             v
        normalizer
```

当前代码中的完整流水线是：

```text
capture/payload
  -> capture/recorder
  -> pipeline/input
  -> pipeline/step
  -> enhancement/queue
  -> enhancement/build
  -> pipeline/order
  -> control save/play
```

## 1. capture：页面事件采集层

capture 层运行在“页面事件采集”边界上。

它负责把浏览器页面里的用户操作采集成原始 RecorderEvent，但不负责判断这些事件最终应该变成什么高级 Step。

### 文件职责

`capture/recorder.ts`
- 负责把 payload 注入页面。
- 负责建立 Playwright binding。
- 负责接收页面侧发回来的 RecorderEvent。
- 负责开启和关闭页面录制运行时。

`capture/payload/`
- 运行在浏览器页面内。
- 监听 click、input、change、select、check、keydown、paste、scroll 等 DOM 事件。
- 生成原始 RecorderEvent。

### 边界要求

capture 层只提供事实，不解释业务语义。

允许做：
- 采集事件类型
- 采集 selector
- 采集 a11y hint
- 采集 target attrs
- 采集 target state
- 采集 locator candidates

不允许做：
- 不识别 custom_select
- 不识别 datepicker
- 不识别 upload
- 不生成 Step
- 不写 browser.select_option
- 不写 kind / controlRef

也就是说，页面侧 payload 只负责告诉 Node 侧“用户点了哪里、改了什么值”，不负责判断“这是一个下拉框选择行为”。

## 2. pipeline：Node 侧录制主流水线

pipeline 层是录制主流程。

它接收 RecorderEvent，维护录制状态，把事件转换成 Step，并把 Step 写入当前 workspace 的未保存录制中。

### 文件职责

`pipeline/input.ts`
- 录制输入边界。
- 接收 record.event 传入的 raw RecorderEvent 或 StepUnion。
- 区分 raw event 和已构造 Step。
- 处理 first-tab goto 的输入边界。
- 转发给 pipeline/step。

`pipeline/state.ts`
- 录制运行时状态。
- 包括 RecordingState、createRecordingState。
- 维护 recordingEnabled、recordings、recordingEnhancements、recordingManifests。
- 维护 workspaceUnsavedRecording、lastNavigateTs、lastClickTs、lastScrollY。
- 维护 pendingEnhancements、pendingFillEvents、replaying、replayCancel。

`pipeline/manifest.ts`
- 录制 manifest。
- 维护 RecordingManifest、tab manifest、workspace saved snapshot。
- 负责 recording bundle、tab 记录、workspace 快照相关逻辑。

`pipeline/pending.ts`
- 录制中的 pending 事件队列。
- 当前主要管理 pendingFillEvents。
- input/change/paste/date 这类填充事件会先进入 pending 队列。
- 在 click、navigate、stop、save 等边界上 flush 成最终 fill step。

`pipeline/step.ts`
- 事件到 Step 的主转换逻辑。
- 包括 createStep、buildResolveFromEvent、toStep。
- 包括 appendWorkspaceRecordingEvent、appendWorkspaceRecordingStep。
- 负责把 Step 写入 recordings。
- 负责触发 enhancement queue。

`pipeline/order.ts`
- 保存前的 step 顺序整理。
- 处理导航事件和用户动作之间的顺序关系。
- 保证 tab 生命周期事件和 goto 的相对顺序稳定。

`pipeline/replay_state.ts`
- 只维护录制状态中的 replay 标记。
- 包括 beginReplay、endReplay、cancelReplay。
- 不包含真正的 replayRecording 执行逻辑。

### 当前 event -> step 行为

当前 `pipeline/step.ts` 中的 toStep(event) 仍然保持现有行为：

- navigate -> browser.goto
- click    -> browser.click
- input    -> browser.fill
- change   -> browser.fill
- date     -> browser.fill
- select   -> browser.select_option
- check    -> browser.click
- keydown  -> browser.press_key
- paste    -> browser.fill
- scroll   -> browser.scroll

这次结构拆分不改变这些映射。

其中 check -> browser.click 是后续任务三要处理的问题，不在本次拆分中修改。

## 3. normalizer：事件语义归一层

normalizer 是后续任务三的插入点。

它的职责是把低级 RecorderEvent 归一成更高层的 Step。例如：

- radio change     -> browser.select_option
- checkbox changes -> browser.select_option
- custom select trigger click + option click -> browser.select_option

当前本次重构只建立目录边界，不接入主流程，不实现选择控件归一。

### 当前文件

`normalizer/types.ts`
- 后续 normalizer 输入输出类型的位置。

`normalizer/index.ts`
- 后续 normalizeRecorderEvent 的统一入口位置。

`normalizer/select_option.ts`
- 后续 select_option 录制归一规则的位置。

### 边界要求

normalizer 允许做：
- 读取 RecorderEvent
- 读取 snapshot/controlIndex
- 生成 Step
- 声明事件已被高层 step 吸收
- 维护必要的短期 pending session

normalizer 不允许做：
- 不修改 StepArgsMap
- 不把 kind 写入 step args
- 不把 controlRef 写入 step args
- 不把 searchText 写入 step args
- 不把 timeout 写入 step args
- 不实现完整插件系统
- 不在 payload 中重复识别复杂组件

后续 select_option normalizer 输出的 step 只能是：

`browser.select_option { nodeId? selector? resolveId? values }`

## 4. enhancement：Step 增强信息层

enhancement 是录制主流程的 sidecar。

它不决定事件是否被录制，也不决定 Step 类型。它只在 Step 入队后，异步补充回放所需的增强信息。

### 文件职责

`enhancement/queue.ts`
- 管理异步 enhancement 任务。
- 启动 startRecordedStepEnrichment。
- 保存每个 step 的 RecordedStepEnhancement。
- 提供 awaitRecordingEnhancements。
- 管理 pendingEnhancements 生命周期。

`enhancement/build.ts`
- 构建 RecordedStepEnhancement。
- 生成 snapshot 信息。
- 生成 target fingerprint。
- 生成 entityBindings。
- 生成 resolveHint 和 resolvePolicy。

### sidecar 边界

enhancement 是异步增强，不是主流程决策。

它可以：
- 捕获 snapshot
- 查找目标节点
- 生成 resolveHint
- 记录 entity binding
- 记录 target fingerprint

它不可以：
- 改变 step.name
- 改变 step.args
- 决定 click 是否要变成 select_option
- 影响 appendWorkspaceRecordingEvent 是否 accepted

如果 enhancement 失败，主录制流程不应该因此中断。

## 5. control：录制控制面

`control.ts` 是 action 控制面，负责处理外部请求：

- record.start
- record.stop
- record.get
- record.save
- record.clear
- record.list
- record.event
- play.start
- play.stop

它不负责 DOM 事件采集，也不负责 event -> step 映射。

保存录制时，`control.ts` 会等待 enhancement 完成，然后根据需要把 stepResolves 写入 recording artifact。

## 6. recording.ts：稳定门面

`recording.ts` 是 record pipeline 的稳定公共入口。

外部模块仍然从这里导入录制相关 API，例如：

- createRecordingState
- appendWorkspaceRecordingEvent
- appendWorkspaceRecordingStep
- enableWorkspaceRecording
- disableWorkspaceRecording
- getWorkspaceUnsavedRecordingBundle
- normalizeRecordingStepOrder
- awaitRecordingEnhancements
- ensureRecorder

`recording.ts` 的职责是维持外部 API 稳定，而不是承载全部实现。

内部实现已经拆入：

- capture/
- pipeline/
- enhancement/
- normalizer/

## 7. RecorderEvent 与 Step 的边界

RecorderEvent 是采集层输出的原始事实。

它描述：
- 用户触发了什么事件
- 事件发生在哪个 selector
- 事件携带什么 value / checked / key
- 事件目标有什么 attrs / state / a11y hint

Step 是回放层消费的稳定语义。

它描述：
- 浏览器应该执行什么动作
- 动作的目标是什么
- 动作参数是什么

二者关系：

- RecorderEvent 是事实输入
- Step 是回放语义输出
- normalizer 和 pipeline/step 负责把前者变成后者
- enhancement 负责给后者补充回放提示

## 8. 当前不做的事情

本次 record 结构重构不做以下事情：

- 不实现 select_option normalizer
- 不实现 datepicker
- 不实现 upload
- 不实现 tabs
- 不实现 pagination
- 不引入完整插件系统
- 不修改 StepArgsMap
- 不修改 RecorderEvent 字段
- 不修改 payload 采集行为
- 不修改 replayRecording
- 不修改 record.save 产物格式

后续任务三可以在 `pipeline/step.ts` 中接入 `normalizer/index.ts`，并首先实现 `normalizer/select_option.ts`。

## 9. browser.select_option 的协议边界

browser.select_option 的 step args 必须保持最小语义：

- nodeId?
- selector?
- resolveId?
- values

禁止加入：

- kind
- controlRef
- searchText
- timeout

原因：

- kind 是 snapshot/controlIndex 的识别结果，不是外部协议输入。
- controlRef 是 snapshot 内部索引引用，不应写入录制产物。
- searchText 当前没有实现搜索型选择。
- timeout 属于统一 waitPolicy，不属于 step 语义参数。

录制侧可以读取 snapshot/controlIndex 来判断用户行为，但最终保存的 step 不得泄漏这些内部字段。

## 10. 后续任务三的接入点

任务三的目标是把选择类行为录成 browser.select_option。

建议接入位置：

`pipeline/step.ts`
- appendWorkspaceRecordingEvent
  - -> 现有 nav / scroll / value / fill pending 处理
  - -> normalizer/index.ts
  - -> 命中则写入 normalizer 生成的 step
  - -> 未命中则继续走 toStep(event)

第一版 normalizer 只处理：

- native_select
- radio_group
- checkbox_group
- custom_select

不做：

- searchable_select
- custom_multi_select
- datepicker
- upload
- tabs
- pagination

## 11. 架构原则

Record 模块后续修改必须遵守：

- capture 只采集事件
- pipeline 只组织录制流水线
- normalizer 只做事件语义归一
- enhancement 只做 Step 增强信息
- control 只处理外部 action
- recording.ts 只作为稳定门面

任何组件语义识别都应该优先复用 snapshot/controlIndex，不应该在 payload 中重新写一套 DOM 组件识别逻辑。
