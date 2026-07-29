# Snapshot 与实体识别 V2 分阶段实施计划

## 1. 文档状态

本文是 Snapshot、实体识别、entity_rules、annotator 与 runtime query 的实施计划，不是概念草案。

当前状态：**阶段 1 至阶段 5 已验收；Checkpoint 5A、5B、5C、5D 均 accepted。QueryPlan、SemanticBindings、PageSession、confirmed selection、SnapshotProjection、RuntimeQuery、SemanticDiff、record/checkpoint/query/assert/entity 与 annotator 消费方均已进入生产路径。`browser.snapshot` 支持 overview/interaction/annotation/debug/full 五种 V2 projection mode；extension 只发送事件、坐标与 draft，并渲染 agent 返回的 canonical geometry。生产代码中已无 V1 snapshot、entity overlay、旧 session cache、V1 compress、extension DOM entity recovery 或双 entity_rules matcher 调用点。下一阶段是阶段 6 的死代码删除与发行级验收。**

归档基线：

- tag：`archive/snapshot-entity-recognition-v1`
- commit：`9c9a9b0d14e1ab4c82ec3d116a355f7f1a7c4ac6`
- 归档用途：历史追溯、失败样例提取、回归测试迁移和差异调查
- 禁止用途：继续扩展 V1、复制旧 candidate/compress 架构、建立长期 V1/V2 双运行时

阶段状态：

| 阶段 | 名称 | 状态 | 主要退出产物 |
| --- | --- | --- | --- |
| 1 | Canonical Observation 与 Relation 基础层 | accepted | 不可变事实层、scope、identity、relations、quotient、实验报告 |
| 2 | Atomic Control 与可执行 Locator | accepted | 唯一 ControlIndex、control 状态机、canonical locator |
| 3 | FormComponent 组装与表单规则迁移 | accepted | FormComponent、ownership、artifact/profile selection 与真实页面 runtime matcher |
| 4 | TableComponent 组装与表格规则迁移 | accepted | logical table、canonical row/cell、mirror/editor、table rule runtime |
| 5 | SemanticBindings、Projection 与消费方切换 | accepted | 新 snapshot/query/annotator/session/diff 全链路 |
| 6 | V1 删除与发行级验收 | pending | 无 V1 runtime、完整真实页面验收、文档一致 |

只有当前阶段通过退出门槛后，下一阶段才允许开始。某个阶段可以跨多次会话实施，但不得同时开始后续阶段。

当前工程边界：

- `pnpm --filter ./agent test:snapshot`：120/120 通过（含五种 projection mode、PageSession、action/locator 与真实浏览器用例）。
- `pnpm --filter ./agent test:entity-rules`：30/30 通过，包含真实 Element Plus/Ant Design annotator 页面。
- `pnpm --filter ./agent typecheck:snapshot`：0 项诊断。
- `pnpm --filter ./agent test:trace`：7/7 通过，真实浏览器 trace integrity 已切换到 V2 capture/projection/content ref。
- 生产代码中无 `runner/steps/executors/snapshot/*` V1 导入、`ruleEntityOverlay/businessEntityOverlay`、`latestSnapshot/snapshotSessionStore` 或 V1 compress 调用点。

## 2. 从 V1 与实验中冻结的结论

以下内容已经通过旧实现历史和真实页面实验得到充分证据，不再作为实施过程中的开放设计点。

### 2.1 必须保留的基础经验

- DOM/A11y/runtime state 优先使用浏览器提供的精确身份连接。
- 多个强匹配必须返回 ambiguous，不能选择第一个。
- 不同事实使用不同来源优先级，不能用统一 merge 规则覆盖所有数据。
- `UnifiedNode` 保持轻量，重数据进入 sidecar indexes。
- Control Registry、capability、duplicate ref 显式失败的设计继续保留。
- 节点可以同时属于多个 typed relations，不能压缩成一个 owner 字段。
- session dirty、refresh reason、refresh-in-flight 去重、base/overlay 分离继续保留。
- confirmed/manual 业务语义必须保护，失效时报告 invalidated，不能静默删除。
- 可执行目标从 canonical node 生成 locator，不能在执行时重新拼接模糊文本定位器。
- compound control 执行后必须验证状态变化。
- 真实页面 acceptance probe 和 decision report 是主要验收手段。

### 2.2 明确退休的 V1 设计

- region/group 双轨实体识别。
- 一个统一加权分数决定实体是否成立。
- candidate cap、table family limit、same-kind nested drop 等全局裁剪补丁。
- 在 identity 和 indexes 建立前修改、裁剪、压缩主树。
- 使用 LCA 代替真实 ownership。
- 使用文本关键词直接生成已确认业务语义。
- 全局 DOM ID map。
- 找不到 relation 时扫描“第一个框架 popup”。
- trigger-only control 仍宣称完整 `select_option` capability。
- `bbox=0` 等价于 hidden subtree。
- 静默删除重复 sibling 或低分节点。
- annotator 在 extension 中维护第二套 entity recognizer。
- diff 依赖压缩树 node ID 和 child set 作为业务语义身份。
- extension 根据 `kind=table` 重新寻找第一个 `<table>`。

### 2.3 稳定上层 ABI

本次重构尽量保持以下上层概念和协议稳定：

```text
UnifiedNode
nodeId
nodeIndex
entityIndex
controlIndex
locatorIndex
BrowserQueryResult
browser.snapshot
browser.query
Step / Checkpoint / DSL
```

允许内部类型、索引来源和投影实现整体替换。

硬约束：

- 不改变 `UnifiedNode` 的公开设计来承载 V2 全部事实。
- 最终 Step、Checkpoint 和 DSL 仍操作真实 node ID 或可解析到真实 node ID 的 typed target。
- locator 是否存在不得依赖节点是否被 snapshot presentation projection 输出。
- 不通过 runtime flag 长期切换 V1/V2。
- 当前重写不建立 V1/V2 shape bridge；新模块不得导入归档 V1 类型或实现。

## 3. 目标架构

最终数据流：

```text
PageCapture
    -> ScopeForest
    -> PageObservation
    -> PrimitiveIndexes
    -> RelationIndex
    -> CandidateEvidence
    -> candidate-local StructuralQuotientView
    -> InvariantValidator
    -> ControlIndex
    -> FormComponentIndex + TableComponentIndex
    -> SemanticBindings + SemanticSuggestions
    -> LocatorIndex
    -> SnapshotProjection
       AnnotatorProjection
       RuntimeQuery
       DebugProjection
       SemanticDiff
```

系统分为四层：

1. **页面事实层**：capture、scope、identity、attributes、text、A11y、runtime state、geometry。
2. **结构分析层**：relations、controls、forms、tables、ownership、component diagnostics。
3. **业务语义层**：entity_rules QueryPlan、confirmed/manual bindings、suggestions、invalidation。
4. **消费投影层**：snapshot、annotator、runtime query、debug、diff。

任何上层都不得修改下层事实。

## 4. 核心模型与不变量

### 4.1 PageEpoch 与 CaptureRevision

原计划中单一 `ObservationRevision` 不足以表达同一页面内多次重采集。

```ts
type PageEpochId = string;
type CaptureRevision = number;

type ObservationIdentity = {
    pageEpoch: PageEpochId;
    captureRevision: CaptureRevision;
};
```

规则：

- 新 document/navigation 创建新的 `PageEpochId`。
- 同一 document 内重渲染、筛选、分页、打开 popup 或 dialog，只增加 `CaptureRevision`。
- observation node ID 只在一个 capture revision 内有效。
- `backendNodeId`、临时 state token 等精确浏览器身份可以用于同一 page epoch 内重映射。
- 跨 page epoch 不执行自动 anchor 重映射。

### 4.2 ScopeForest

页面不是一个全局 DOM scope。

```ts
type TreeScope = {
    id: TreeScopeId;
    kind: 'document' | 'iframe' | 'open-shadow-root';
    parentScopeId?: TreeScopeId;
    hostNodeId?: ObservationNodeId;
    rootNodeId: ObservationNodeId;
    status: 'captured' | 'unavailable';
    unavailableReason?: string;
};

type ScopeForest = {
    scopes: Record<TreeScopeId, TreeScope>;
    rootScopeIds: TreeScopeId[];
};
```

规则：

- DOM ID 只在所属 tree scope 内解析。
- open shadow root 建立独立 scope；closed shadow root 只输出 unavailable diagnostic。
- iframe 建立独立 scope；无法采集时输出 unavailable diagnostic，不能假装为空页面。
- relation 只有在平台语义明确允许时才能跨 scope。
- 不存在全局 `id -> nodeId` 单值 map。
- `captured` scope 可以合法地产生零个 active candidate；这不是错误。
- `captured-but-empty` 与 `unavailable` 必须区分。
- iframe 中只有编辑器、占位页或尚未 materialize 的 preview 时，不得伪造业务实体。

### 4.3 PageObservation

```ts
type PageObservation = {
    identity: ObservationIdentity;
    scopes: ScopeForest;
    completeness: ObservationCompleteness;

    nodes: NodeIndex;
    parents: ParentIndex;
    children: ChildrenIndex;
    documentOrder: DocumentOrderIndex;

    attributes: AttributeIndex;
    text: TextIndex;
    accessibility: AccessibilityIndex;
    runtimeState: RuntimeStateIndex;
    geometry: GeometryIndex;
    activity: ActivityIndex;
    domIdentity: DomIdentityIndex;
    layers: LayerIndex;

    diagnostics: ObservationDiagnostic[];
};
```

```ts
type ObservationCompleteness = {
    dom: 'complete' | 'partial' | 'unavailable';
    a11y: 'complete' | 'partial' | 'unavailable';
    runtime: 'complete' | 'partial' | 'unavailable';
    geometry: 'complete' | 'partial' | 'unavailable';
};

type ActivityFacts = {
    hiddenByStyle: boolean;
    inert: boolean;
    ariaExposed?: boolean;
    selfHasBox: boolean;
    subtreeActive: boolean;
    rendered: boolean;
};

type GeometryRecord = {
    rect: Rect;
    space: 'scope-viewport' | 'top-css-viewport';
    scopeId: TreeScopeId;
    captureRevision: CaptureRevision;
    source: 'dom-snapshot' | 'live-dom' | 'cdp';
    frameTransform?: RectTransform;
};
```

不变量：

- observation 建成后不可变。
- canonical indexes 必须覆盖 capture 中所有可观测节点，不受 projection budget 影响。
- DOM parent、A11y ownership、visual layer、component ownership 是不同关系。
- 后续分析只引用 observation node ID，不复制和改写主树。
- 所有遍历顺序确定，结果不依赖对象枚举顺序。
- DOM 主结构 unavailable 时 observation 构建失败；A11y/runtime/geometry unavailable 时允许生成 partial observation。
- partial observation 不得用弱 heuristic 冒充缺失来源提供的同等事实。
- `selfHasBox=false` 只说明自身可折叠，不能停止对子树的遍历。
- 只有 proven style-hidden、inert 或等价强事实允许剪枝；controller state 只作解释和一致性验证。
- controller state 与实际 `subtreeActive/rendered` 冲突时输出 diagnostic，不能覆盖实际页面事实。
- 下游 control/component 必须继承其依赖事实的 completeness diagnostic。

### 4.3.1 Scope-aware geometry 与 locator scope path

iframe 和 open shadow root 不仅是索引 scope，也是 geometry 与执行定位 scope。

```ts
type LocatorScopePath = Array<
    | { kind: 'frame'; hostNodeId: ObservationNodeId }
    | { kind: 'shadow'; hostNodeId: ObservationNodeId }
>;
```

规则：

- scope 内 geometry 先以 `scope-viewport` 表达，再通过显式 frame transform 转为 `top-css-viewport`。
- geometry record 必须携带 scope、revision 和 source。
- 跨 iframe 的 annotator geometry 只能通过 transform 合成，不能直接相加局部坐标。
- locator 必须携带进入 frame/shadow scope 的路径；backend path 只在所属 scope 内有效。
- scope path 无法唯一解析时返回 unresolved/ambiguous，不能退回全页面文本搜索。

### 4.4 精确连接结果

```ts
type Resolution<T> =
    | { status: 'resolved'; value: T; evidence: Evidence[] }
    | { status: 'missing'; evidence: Evidence[] }
    | { status: 'ambiguous'; candidates: T[]; evidence: Evidence[] };
```

适用范围：

- DOM/A11y join。
- runtime state join。
- IDREF relation。
- page epoch 内 anchor remap。
- popup ownership。
- fixed/mirror mapping。
- locator execution target resolution。

禁止将 missing 和 ambiguous 合并成同一个 fallback 路径。

### 4.5 来源优先级

每类事实使用独立 policy：

| 事实 | 优先级 |
| --- | --- |
| 精确身份 | backend/CDP identity > capture transient token > revision-local node ID |
| 结构 | DOM/framework structure > strong A11y role > weak heuristic |
| accessible name | A11y computed name > explicit DOM label relation > local text |
| runtime state | runtime sampler > A11y state > static DOM attribute |
| geometry | 当前 revision 的 live DOM/CDP/DOMSnapshot，必须标注 source |
| 业务语义 | confirmed rule/manual > imported confirmed > inferred suggestion |

如果高优先级来源 ambiguous，不得退回低优先级来源伪造唯一结果。

### 4.6 RelationIndex

```ts
type RelationKind =
    | 'labelled-by'
    | 'described-by'
    | 'controls-target'
    | 'popup-owner'
    | 'owns'
    | 'form-owner'
    | 'framework-part'
    | 'visual-layer-member';

type RelationEdge = {
    kind: RelationKind;
    sourceNodeId: ObservationNodeId;
    targetNodeIds: ObservationNodeId[];
    status: 'resolved' | 'ambiguous' | 'unresolved';
    evidence: Evidence[];
};
```

规则：

- `aria-controls` 先产生 `controls-target`，再根据 source/target role 判断是否能派生 `popup-owner`。
- `aria-owns` 不是无条件 DOM reparent。
- framework adapter 只能增加 evidence 或 part relation，不能覆盖精确平台 relation。
- relation endpoint 即使不在当前结构投影视图，也必须保留 canonical node 引用。

### 4.7 CandidateEvidence 与 StructuralQuotientView

V2 先对局部区域建立离散候选证据，再按候选生成无损结构商视图。商视图不是每个 scope 一棵全局“重要节点树”。

```ts
type CandidateEvidence = {
    anchorNodeId: ObservationNodeId;
    scopeId: TreeScopeId;
    classification:
        | 'structural'
        | 'host'
        | 'part'
        | 'latent'
        | 'rejected'
        | 'ambiguous';
    evidence: Evidence[];
};

type QuotientNode = {
    nodeId: ObservationNodeId;
    projectionParentId?: ObservationNodeId;
    collapsedAncestorIds: ObservationNodeId[];
};

type StructuralQuotientView = {
    scopeId: TreeScopeId;
    candidateAnchorNodeId: ObservationNodeId;
    nodes: QuotientNode[];
};
```

CandidateEvidence 只决定候选类别、activity 状态和是否值得建立局部工作视图，不在阶段 1 组装 FormComponent 或 TableComponent。

用途：

- 折叠无语义 wrapper。
- 保留原 node ID、document order 和 provenance。
- 简化 control/form/table 的局部遍历。
- 对每个 active/latent candidate 建立有界局部工作集。

禁止：

- 删除 relation endpoint。
- 修改 observation parent index。
- 根据 node budget 丢失事实。
- 将 zero-box wrapper 视为 hidden subtree。
- 将 representative nodes 当作 canonical 全量事实。
- 为 rejected candidate 建立无界工作视图。
- 重新退化为 scope 级全局重要节点树。

### 4.8 SessionAnchor 与 PersistentLocator

```ts
type SessionAnchor = {
    pageEpoch: PageEpochId;
    captureRevision: CaptureRevision;
    nodeId: ObservationNodeId;
    backendNodeId?: number;
    transientToken?: string;
};

type AnchorRemapResult =
    | { status: 'exact'; anchor: SessionAnchor }
    | { status: 'stale'; reason: string }
    | { status: 'ambiguous'; candidates: SessionAnchor[]; reason: string };

type PersistentLocator = {
    plan: LocatorPlan;
    expectedCardinality: 'unique' | 'one_or_more';
};
```

规则：

- 当前编辑会话使用 `SessionAnchor`。
- 同一 page epoch 内仅允许使用 exact backend identity 或稳定 runtime identity 重映射。
- class、text、相似路径不能用于 anchor remap。
- 无法精确重映射时返回 stale 或 ambiguous。
- 保存 artifact 时才编译 `PersistentLocator`。
- recognize 不得替换用户确认的 selection anchor。

### 4.9 Component location

用户选择范围、逻辑 host 与真实结构根必须分开。

```ts
type ComponentLocation = {
    selectionScopeNodeId?: ObservationNodeId;
    hostNodeId?: ObservationNodeId;
    structuralRootNodeId: ObservationNodeId;
};
```

例如：

- 外层 Card：host 或 selection scope。
- `.el-table` / `.ant-table-wrapper`：table structural root。
- 内部 `<table>`：physical part。
- sibling pagination：owned relation，不要求在 structural root 子树中。

recognize 可以在 selection scope 内发现更准确的 structural root，但不能偷偷改变用户确认的 selection scope。

### 4.10 Evidence、状态和 diagnostics

```ts
type Evidence = {
    code: string;
    strength: 'exact' | 'strong' | 'weak';
    source: 'platform' | 'dom' | 'a11y' | 'runtime' | 'adapter' | 'geometry';
    nodeIds: ObservationNodeId[];
    detail?: Record<string, unknown>;
};

type AssemblyStatus = 'complete' | 'partial' | 'ambiguous' | 'rejected';

type AnalysisDiagnostic = {
    code: string;
    severity: 'info' | 'warning' | 'error';
    stage: string;
    status?: AssemblyStatus;
    nodeIds: ObservationNodeId[];
    evidence: Evidence[];
    message: string;
};
```

数值 confidence 只允许作为同一合法类别内部的排序提示，不能作为结构真假的最终依据。

每个主要 pass 必须运行独立的 `InvariantValidator`，而不是只依赖测试代码检查不变量：

```ts
type InvariantValidationResult = {
    ok: boolean;
    diagnostics: AnalysisDiagnostic[];
};

type PassResult<T> = {
    value: T;
    diagnostics: AnalysisDiagnostic[];
    validation: InvariantValidationResult;
};
```

至少验证：

- quotient retained node 无 orphan，projection parent 无环。
- relation endpoint 存在且 scope 合法。
- canonical node/index 不受 projection 影响。
- ownership 在同一层级、同一 role 下满足唯一性。
- executable target 存在于 canonical nodeIndex 并拥有 locator 或明确 unresolved。
- row/column alignment 与 mirror mapping 无冲突。
- active component 不依赖 latent-only required part。

### 4.11 ControlComponent

```ts
type ControlComponent = {
    id: ControlComponentId;
    kind: ControlKind;
    status: AssemblyStatus;
    rootNodeId: ObservationNodeId;
    controlNodeId?: ObservationNodeId;
    triggerNodeId?: ObservationNodeId;
    popupNodeId?: ObservationNodeId;
    optionNodeIds: ObservationNodeId[];
    capabilities: ControlCapability[];
    state: ControlState;
    evidence: Evidence[];
    diagnostics: AnalysisDiagnostic[];
};
```

规则：

- closed custom select 可以是 `partial`，popup/options 未 materialize 不等于 control 不存在。
- 只有具备当前动作所需部件的 control 才能声明对应 capability。
- `partial` custom select 可以声明 open capability，但不能直接声明可执行 option selection。
- 打开 popup 后重新 capture，control 可在新 revision 中成为 `complete`。
- first-popup scan、global consumed-popup heuristic 禁止进入正式路径。
- duplicate control ID/ref 是错误，不允许后者覆盖前者。

### 4.12 FormComponent

```ts
type FormComponent = {
    id: FormComponentId;
    status: AssemblyStatus;
    location: ComponentLocation;
    fields: FormField[];
    actions: FormAction[];
    groups: FormGroup[];
    geometry: GeometryFragment[];
    evidence: Evidence[];
    diagnostics: AnalysisDiagnostic[];
};

type FormField = {
    id: FormFieldId;
    controlIds: ControlComponentId[];
    primaryControlId?: ControlComponentId;
    labelNodeIds: ObservationNodeId[];
    descriptionNodeIds: ObservationNodeId[];
    errorNodeIds: ObservationNodeId[];
    groupId?: FormGroupId;
    required?: boolean;
};
```

不变量：

- 一个 field 至少有一个 control。
- composite field 使用 `controlIds[]`，不能压成单 control。
- 同一 form、同一 ownership role 下，一个 control 只有一个 owner field。
- 同一 physical node 可以同时参与 control、field、form 和 A11y relations。
- label evidence 顺序：label/for、aria-labelledby、fieldset/legend、framework Form.Item、局部容器、geometry 弱证据。
- action 的结构事实与业务 intent suggestion 分开。
- portal popup 归属 control，不按 DOM ancestry 错归 form。
- dialog 内 form boundary 不被外层页面 form/card 吞并。

Form 采用自底向上的消费式归约，而不是全局 common-ancestor 或 geometry clustering：

```ts
type FormReductionState = {
    unclaimedFields: FormFieldDraft[];
    localActions: StructuralActionDraft[];
    completedForms: FormComponent[];
    diagnostics: AnalysisDiagnostic[];
};

type BottomUpReducer<T> = (
    nodeId: ObservationNodeId,
    childResults: T[],
    context: ReductionContext,
) => T;
```

归约规则：

- field/control/action 从子节点按 canonical document order 向上汇总。
- 到达显式 `<form>` 前，不在其内部提前归约子字段岛。
- 到达 active dialog 前，不在其内部提前归约子字段岛。
- 显式 form 消费其子树内尚未归属的 fields/actions。
- active dialog 可以消费局部多字段岛并形成 form-like component。
- 紧凑、有标签、具备局部 action 的字段岛可以归约；被消费字段不再向更大祖先传播。
- popup `role=listbox` 不是 field anchor。
- button-only 容器、极端 action/field 比例的文档容器不能升级为 form。
- 未成功归约的 residual field/control 保持 standalone，不强迫每个 control 拥有 FormComponent。

### 4.13 TableComponent

```ts
type TableComponent = {
    id: TableComponentId;
    status: AssemblyStatus;
    location: ComponentLocation;
    parts: TableParts;
    header: TableHeaderModel;
    columns: TableColumn[];
    body: TableBodyModel;
    controlSlots: CellControlSlot[];
    hierarchy?: TableRowHierarchy;
    footer?: TableFooterModel;
    pagination?: PaginationRelation;
    geometry: GeometryFragment[];
    evidence: Evidence[];
    diagnostics: AnalysisDiagnostic[];
};

type TableBodyModel = {
    visibleRows: TableRow[];
    representativeRowIds: TableRowId[];
    rowWindow: {
        visibleCount: number;
        totalCount?: number;
        startIndex?: number;
        completeness: 'complete' | 'partial' | 'unknown';
    };
};

type CellControlSlot = {
    columnId: TableColumnId;
    structuralPosition: number;
    controlKind: ControlKind;
    occurrenceCount: number;
    exemplarNodeIds: ObservationNodeId[];
};

type TableRowHierarchy = {
    parentRowIdByRowId: Record<TableRowId, TableRowId | undefined>;
    levelByRowId: Record<TableRowId, number | undefined>;
    source: 'aria-level' | 'explicit-tree-relation' | 'unknown';
};

type FeatureCoverResult = {
    representativeRowIds: TableRowId[];
    coveredFeatures: string[];
    uncoveredFeatures: string[];
};
```

不变量：

- 每个 table component 必须有 canonical body 或明确 partial diagnostic。
- framework wrapper 下的 header/body/fixed/footer 是 parts，不是独立竞争实体。
- outer host、structural root、physical `<table>` part 必须区分。
- row/cell/columnheader 等 atomic node 永远不能成为 table root。
- fixed clone 映射到 canonical row/column，不产生重复业务列或 action。
- fixed-right 独有 action 必须映射到 canonical action column，无法唯一映射时 ambiguous。
- summary/footer 属于同一 component。
- pagination 通过 typed ownership relation 绑定；两个可能 owner 时必须 ambiguous。
- virtualized table 只能报告当前 row window，不能伪造总行数。
- 多级 header、colspan/rowspan 先构建 header tree，再产生 leaf columns。
- observed uniqueness 只能产生 primary-key suggestion，不能直接确认业务主键。
- canonical rows 全部保留在 RowIndex；FeatureCover 只选择 assembler 工作集和 projection 代表行。
- FeatureCover 提取 cell count/role、column position、span、selected/expanded/level、control role 和有限 multiplicity，贪心覆盖全部结构特征后停止。
- representative row 是特征证据，不是永久 row class；特征未覆盖时必须 diagnostic。
- 只有跨至少两行在同一 column/relative position 重复的 control 才形成 CellControlSlot。
- 单行内大量 links/controls 不枚举成大量 slot；one-off control 保留为 row exception。
- CellControlSlot 不是业务 row action；actionIntent 必须由规则或用户确认。
- treegrid hierarchy 使用 canonical document order 和显式 `aria-level`/tree relation；没有证据时保持 unknown/flat。
- 不根据 indentation wrapper 猜确定层级；非法 level jump 产生 diagnostic。
- editable cell control 归属 canonical cell；portal editor 通过 typed relation 关联，closed/open revision 可以分别为 partial/complete。

### 4.14 OwnershipIndex

Ownership 需要支持 node、control 和组件内部对象之间的嵌套关系。

```ts
type OwnershipEndpoint =
    | { kind: 'node'; id: ObservationNodeId }
    | { kind: 'control'; id: ControlComponentId }
    | { kind: 'form-field'; id: FormFieldId }
    | { kind: 'form'; id: FormComponentId }
    | { kind: 'table-row'; id: TableRowId }
    | { kind: 'table-column'; id: TableColumnId }
    | { kind: 'table'; id: TableComponentId };

type OwnershipEdge = {
    owner: OwnershipEndpoint;
    member: OwnershipEndpoint;
    role: string;
    evidence: Evidence[];
};
```

不存在全局“每个节点只有一个 owner”的约束。只在同一层级、同一 ownership role 中要求唯一。

### 4.15 SemanticBindings 与 SemanticSuggestions

```ts
type SemanticBindings = {
    forms: Record<FormComponentId, FormBusinessBinding | undefined>;
    tables: Record<TableComponentId, TableBusinessBinding | undefined>;
    nodes: Record<ObservationNodeId, NodeBusinessBinding[] | undefined>;
    diagnostics: BindingDiagnostic[];
};
```

规则：

- agent 是唯一规则执行器。
- entity_rules 针对已经组装的 component 或 canonical node 执行。
- framework adapter 不生成 fieldKey、actionIntent、primaryKey。
- inferred suggestion 可以刷新。
- confirmed/manual binding 不被识别器覆盖。
- confirmed target 消失时输出 invalidated。
- extension 不执行 `PersistentTargetDraft` 查询。

### 4.16 Projection 与显式 omission

内部事实层不等于 `browser.snapshot` 输出。

Projection mode：

- `overview`：组件概要、schema、代表性行、页面结构。
- `interaction`：scope 内所有可执行 control 和当前状态。
- `annotation`：component、binding、geometry fragments。
- `debug`：parts、evidence、rejection、mapping、relations。
- `full`：受协议限制的完整投影。
- `diff`：component/state 级变化投影。

```ts
type OmissionRecord = {
    total: number;
    included: number;
    omitted: number;
    policy: string;
};
```

规则：

- projection 不影响 recognition、query、locator 和 execution。
- forms 保留全部 fields、state、validation 和 actions。
- tables 保留完整 schema、state、action template、pagination；数据行可以按策略抽样。
- row sample 优先覆盖 first/last/selected/error/changed/query-matched 和结构特征。
- repeated collection 必须报告 omission。
- actionable control 不得因通用 node budget 静默消失。
- overlay/dialog 是高优先级投影对象。

### 4.17 Diff correlation 不是 identity

```ts
type ProjectionCorrelationKey = {
    kind: string;
    scopeKey: string;
    structuralSignature: string;
    persistentLocatorHint?: string;
};
```

规则：

- node identity 仍然 revision-scoped。
- diff 只做 best-effort projection correlation。
- correlation 可以参考 stable DOM id、role/name/path、component signature、table schema、form field signature。
- correlation ambiguous 时回退 full，不伪造精确 diff。
- semantic diff 优先表达 component/state 变化，而不是压缩树 child set 变化。

## 5. 目录与模块边界

目录只在对应阶段创建，不提前制造空壳。

```text
agent/src/snapshot/
├── capture/
├── observation/
│   ├── model.ts
│   ├── build.ts
│   ├── identity.ts
│   ├── scope.ts
│   ├── completeness.ts
│   ├── activity.ts
│   ├── indexes.ts
│   ├── geometry.ts
│   └── query.ts
├── relation/
│   ├── model.ts
│   ├── resolve_idref.ts
│   ├── resolve_a11y.ts
│   ├── candidate.ts
│   └── quotient.ts
├── component/
│   ├── core/
│   │   ├── evidence.ts
│   │   ├── ownership.ts
│   │   ├── diagnostics.ts
│   │   └── invariant_validator.ts
│   ├── control/
│   ├── form/
│   │   └── reducer.ts
│   └── table/
│       ├── feature_cover.ts
│       ├── control_slots.ts
│       └── hierarchy.ts
├── semantic/
│   ├── query_plan/
│   ├── binding/
│   └── suggestion/
├── projection/
│   ├── snapshot/
│   ├── annotator/
│   ├── debug/
│   └── diff/
└── session/
    ├── page_epoch/
    └── selection/

packages/annotator-contract/
├── draft.ts
├── geometry.ts
├── protocol.ts
├── selection.ts
└── diagnostics.ts
```

模块依赖方向：

```text
capture
  -> observation
  -> relation
  -> component/core
  -> control
  -> form/table
  -> semantic
  -> projection/session consumers
```

禁止反向依赖：

- observation 不依赖 component。
- component 不依赖 entity_rules artifact。
- semantic 不修改 component。
- extension 不依赖 agent 内部 recognizer 文件。
- projection 不成为 query 的事实来源。

## 6. 分阶段迁移方法

### 6.1 每阶段统一执行顺序

每个阶段必须按以下顺序执行：

1. 冻结阶段输入、输出类型和错误语义。
2. 先增加会失败的真实验收与必要的纯算法单元测试。
3. 实现最小完整阶段路径。
4. 建立本阶段新模块的唯一入口与独立验收。
5. 尚未具备等价 V2 能力的调用方继续保留，不提前删除或用兼容壳伪造完成。
6. 完整 V2 消费链完成后统一切换，并在最终清理阶段删除旧调用方和实现细节测试。
7. 生成阶段报告并通过退出门槛。

禁止“先实现，最后补测试”。

### 6.2 重写隔离纪律

当前实现不建立 `V2 -> V1 result shape` bridge，也不建立 V1 fallback。

迁移期间必须满足：

- `agent/src/snapshot/` 不导入归档 V1 snapshot/entity-rule 类型或实现。
- 尚未迁移的 runner、record、select-option、checkpoint、DSL 和协议调用方暂时保留。
- 只有在对应 V2 capability、query、projection 和 locator 已完成真实验收后，才迁移该调用方。
- 不通过 stub、空结果或旧 shape adapter 让未完成链路表面通过。
- 完整消费链验收完成后，再统一删除旧调用方及其实现细节测试。

### 6.3 阶段交接包

每阶段结束必须留下可供下一位实施者直接继续的交接信息：

```text
阶段名称与状态
本阶段冻结的 contracts
生产入口切换情况
删除的 V1 入口
新增验收与测试文件
实际执行命令和结果
真实页面报告路径
性能/工作量基线
未解决问题及其分类
当前 git status / diff 范围
下一阶段入口检查结果
```

“未解决问题”必须分类为：

- 真实 bug
- 安全加固
- 崩溃恢复
- 掉电耐久性
- 架构或产品设计
- 运维与诊断增强
- 尚未完成的产品目标

不能把尚未完成的阶段目标写成“非阻塞优化”。

### 6.4 阻塞规则

出现以下任一情况，阶段不得验收：

- required fixture 依赖 first-match 或 fuzzy fallback 才通过。
- ambiguous 被静默转成 resolved。
- canonical node/index 因 projection/compression 缺失。
- extension 和 agent 对同一实体给出不同 root/ownership。
- 新旧生产入口并存且由 flag 选择。
- 真实浏览器验收未运行，只运行了合成字符串测试。
- diagnostics 不能说明失败发生在哪个 relation、part、component 或 QueryPlan。
- 对已确认语义进行静默覆盖或删除。

## 7. 验收语料与测试治理

### 7.1 基础真实页面语料

现有 mock 继续作为基础：

- Element list form。
- Element create form。
- Element table + sibling pagination。
- Ant list form。
- Ant create form。
- Ant table + sibling pagination。
- Ant Modal portal。
- 动态筛选、分页和重渲染。
- 重复任务/状态 collection。

阶段内按需要增加真实 framework fixture：

- Element fixed-left/fixed-right。
- Ant fixed/sticky。
- 至少一个旧版 Element 或 Ant clone-based fixed fixture。
- summary/footer。
- multi-level header、colspan、rowspan、merged cell。
- expandable/nested/tree table。
- virtualization、loading、empty。
- row selection、responsive hidden column。
- editable cell 与 portal popup editor。
- dialog form、Form.List、date range 和 composite field。
- 打开的 Select popup portal。
- 同一卡片内两个 table 和 ambiguous pagination。
- open shadow root 内重复 DOM ID。
- iframe scope，包括 captured-but-empty frame。
- zero-box wrapper 下 active descendants。

不得为了让识别器容易通过而给 fixture 增加生产页面不会存在的专用标记。

验收输入分为两类：

- 固定版本 fixture/capture：作为 correctness gate，必须记录来源 URL、采集日期、framework version 和 logical truth。
- 实时公开网页：只作为 smoke/compatibility report；网页升级导致结构计数变化时不得直接制造随机回归失败。

本地固定 fixture 是退出门槛，live smoke 不能替代固定 fixture，也不能作为唯一正确性证据。

### 7.2 Unit 测试边界

Unit 只用于确定性纯算法：

- identity 和 deterministic collision handling。
- scope-local ID lookup。
- activity facts 与 partial observation completeness。
- scope geometry conversion 与 locator scope path。
- relation resolution。
- CandidateEvidence 分类。
- candidate-local quotient provenance、orphan 和环检测。
- BottomUpReducer 的消费/停止条件。
- FeatureCover 最小代表集与完整特征覆盖。
- header tree 和 column alignment。
- CellControlSlot 跨行对齐。
- treegrid hierarchy 的 document-order 栈算法。
- mirror mapping。
- ownership uniqueness rules。
- InvariantValidator。
- QueryPlan 编译与执行。
- projection row cover 和 omission。
- correlation ambiguity。

禁止只断言 class 字符串命中，而不验证结构不变量。

### 7.3 Integration 测试边界

Integration 验证模块协作：

```text
raw fixture -> observation
observation -> relations -> controls
controls -> forms
observation/relations -> tables
components -> semantic bindings
observation + analysis + binding -> projections
session refresh -> remap/stale/diff
```

### 7.4 Browser/E2E 验收边界

以下行为必须在真实浏览器中验收，不能由手写 `UnifiedNode` 代替：

- portal popup/dialog。
- fixed/sticky table。
- virtualization。
- live geometry、scroll、zoom。
- shadow root scope。
- iframe scope。
- framework 重渲染后的 identity/remap。
- select_option 打开 popup、重新 capture、选择、状态验证。
- annotator 点击、确认、保存、重开、runtime query。

### 7.5 旧回归案例迁移

以下 V1 回归案例必须迁移成 V2 结构不变量：

- row/cell 不得提升为 table root。
- pagination 不得成为 standalone list entity。
- pagination 必须归属正确 table 或报告 ambiguous。
- heading-heavy wrapper 不得吞掉内部 table。
- listitem 数量不能单独证明 list。
- 多个 table family 必须全部保留。
- icon-like 列不是强主键证据。
- radio/checkbox 不得跨安全 boundary 合并。
- dropdown/options 不得独立成为 select root。
- duplicate control ref 必须失败。
- dirty interaction 不能复用 stale state。
- confirmed/manual binding 不被覆盖。
- repeated row action 允许 `one_or_more`。
- stale page/profile 阻止保存。
- compound control 执行后验证状态。

旧的“nested table 总是只保留 inner table”不能原样迁移。新规则是检查 direct row/cell ownership，真实 outer table 和 nested inner table可以同时成立。

### 7.6 性能与复杂度验收

阶段 1 记录统一基线：

- 每个 pass 的 node/edge visit 数。
- capture、observation、relation、candidate、quotient 的 p50/p95。
- peak retained node/index count。
- fixture 输入规模。
- active/latent/rejected/ambiguous candidate 数量。
- candidate-local quotient size 的 max/p50/p95。
- collapsed path 最大深度。
- projection-parent fan-out。
- orphan retained node 数，必须为 0。
- union ratio；该指标只作辅助，不能替代最大局部工作集。

之后各阶段：

- 新 pass 必须报告工作集规模。
- 禁止在每个节点内再次全树扫描。
- 同一基线语料 p95 不得无说明地回退超过 20%。
- 超过预算必须先定位 pass，再决定优化，不允许通过丢节点掩盖问题。

## 8. 阶段 1：Canonical Observation 与 Relation 基础层

### 8.1 目标

建立与 V1 region/candidate/compress 无关的页面事实层，为所有后续阶段提供唯一输入。

### 8.2 入口条件

- 归档 tag 可访问。
- 当前 capture、runtime state sampler、DOM/A11y collector 可读。
- 当前 mock 页面可启动。
- 不要求 Form/Table recognizer 已存在。

### 8.3 范围

本阶段只完成：

- `PageEpoch` 与 `CaptureRevision`。
- `ScopeForest`。
- 不可变 `PageObservation` 与 `ObservationCompleteness`。
- primitive indexes。
- exact DOM/A11y/runtime joins。
- `ActivityFacts` 与 active/latent consistency diagnostics。
- scope-local IDREF relation。
- scope-aware geometry frame 和 locator scope path contract。
- `CandidateEvidence` 分类。
- candidate-local `StructuralQuotientView`。
- `InvariantValidator` 基础设施。
- observation/relation/candidate/quotient diagnostics。
- recognition replay benchmark 和 baseline report。

本阶段不完成：

- control recognition。
- form/table assembly。
- entity_rules binding。
- final lossy snapshot compression。
- annotator migration。

### 8.4 先行失败验收

在实现前增加并确认失败：

1. 同一 backend identity 的唯一 DOM/A11y join 成功；多个强候选返回 ambiguous。
2. runtime state 使用独立 exact runtime identity 连接；清理在成功和异常路径恢复页面原属性。
3. A11y/runtime/geometry 任一可选来源失败时生成 partial observation 和 diagnostic，不伪造完整事实。
4. 两个 shadow scope 使用相同 DOM ID 时各自解析正确节点。
5. `aria-controls` 在 target 为 table/tabpanel 时只产生 controls-target，不误判 popup。
6. zero-box wrapper 下 active descendant 仍存在于 observation 和 quotient。
7. rendered/subtree activity 与 tab/expanded controller state 冲突时保留实际 activity 并报告 diagnostic。
8. proven hidden/inert subtree 为 latent；canonical nodes 仍保留。
9. 1、1.25、1.5、2 倍 zoom/scale 输出统一 css-viewport。
10. iframe 内 geometry 能通过 scope transform 转成 top-css-viewport。
11. frame/shadow locator 带 scope path；scope path ambiguous 时不退回全局文本定位。
12. observation 经过 relation、candidate、quotient 和 debug projection 后保持结构与 indexes 不变。
13. 同一 page epoch 二次 capture 增加 revision；新 document 创建新 epoch。
14. anchor 只在 exact backend identity 或稳定 runtime identity 可重映射时成功，否则 stale/ambiguous。
15. structural/host/part/latent/rejected/ambiguous candidate 分类有确定证据。
16. quotient 按 candidate 建立，relation endpoint 即使折叠祖先路径仍可解析。
17. candidate-local work set 有界、orphan 为 0，不产生 scope 级全局重要节点树。
18. captured iframe 可以合法没有 candidate/active entity，并与 unavailable scope 区分。

### 8.5 实施顺序

1. 冻结 identity、scope、completeness、activity、geometry、relation、candidate、quotient 和 diagnostic contracts，并固定真实 fixture truth。
2. 改造 capture 和 canonical indexes，完成采集顺序、partial failure、cleanup、document order 与 source precedence join。
3. 建立 scope-local IDREF、typed relations、activity consistency、frame transform 和 locator scope path。
4. 建立 CandidateEvidence、candidate-local quotient 与 InvariantValidator，验证 endpoint、orphan、环和 canonical 完整性。
5. 建立 observation replay benchmark 和 baseline report，记录 decision、local work set、timing 与固定/live 输入来源。
6. 发布 `agent/src/snapshot/` 内部唯一 V2 事实层 API；不建立 V1-compatible tree bridge。该项不等于仓库生产入口切换，生产切换门槛仍必须单独满足。

### 8.6 交付物

- `agent/src/snapshot/observation/`：model、analysis、capture、replay 四个同层次模块。
- `agent/src/snapshot/indexes/`：relation、locator、ownership 三个索引模块。
- `agent/src/snapshot/components/`：shared、control、form 组件模块。
- `agent/src/snapshot/rules/`：model、matching、runtime 规则模块；阶段 1 不实现规则业务逻辑。
- CandidateEvidence、StructuralQuotient 和 InvariantValidator 基础模块。
- raw capture fixtures 与固定版本元数据。
- observation replay helper。
- observation/relation/candidate/quotient debug report。
- browser acceptance fixture：shadow scope、captured-without-candidate iframe、zero-box active descendants、typed IDREF、activity mismatch、scope geometry。
- 阶段 1 baseline report，包含 candidate-local work-set 指标。

### 8.7 退出门槛

必须全部满足：

- Element、Ant、native 页面可以生成 complete 或有明确原因的 partial observation。
- canonical indexes 不依赖 region/candidate/compress。
- exact join、missing、ambiguous 三种结果均有验收。
- scope-local ID resolution 在重复 ID fixture 中正确。
- captured scope without candidate、unavailable scope 与 active candidate 结果可区分；前者不是新的 scope status。
- activity facts、controller mismatch 和 zero-box descendant 行为通过浏览器验收。
- scope geometry 与 locator scope path 通过 iframe/shadow fixture。
- CandidateEvidence 分类稳定，所有 quotient 都是 candidate-local。
- quotient orphan 为 0，最大局部工作集记录在报告中。
- PageEpoch/CaptureRevision 行为通过浏览器验收。
- observation 不被后续 pass 修改，InvariantValidator 通过。
- 生产 capture/fusion 只有一个入口。
- 旧 path-key runtime fusion、全局 DOM-ID 连接和等价 fallback 已删除。
- 阶段报告包含节点数、edge 数、candidate 分类、局部工作集和 p50/p95。

当前验收结果：

- 核心实现、25 项 Snapshot 测试和 10 个固定/浏览器 fixture 已通过。
- 仓库整体类型检查仍因未迁移调用方引用已删除 V1 模块而失败；这是当前迁移状态的显式诊断，不通过恢复 V1 实现消除。
- “生产 capture/fusion 只有一个入口”属于 Stage 5 消费方切换门槛。
- “旧 runtime 已删除”属于 Stage 6 清理门槛，不阻塞 Stage 2。

### 8.8 交接重点

下一阶段只依赖：

```text
PageObservation
RelationIndex
CandidateEvidence
candidate-local StructuralQuotientView
InvariantValidator
Observation query helpers
```

下一阶段不得直接读取 raw DOM/A11y tree。

## 9. 阶段 2：Atomic Control 与可执行 Locator

### 9.1 目标

建立唯一 ControlIndex，并让基础交互从 canonical nodes 和 locators 执行，不再依赖压缩 snapshot 或文本 fallback。

### 9.2 入口条件

- 阶段 1 已验收。
- observation、relations、quotient contracts 冻结。
- Stage 2 实现直接消费 V2 facts；不要求未迁移的其他生产消费者已经切换。

### 9.3 范围

首批 controls：

- input、textarea、button、link。
- native select。
- radio group、checkbox group。
- custom select。
- date-like atomic control。
- popup/listbox/options parts。

本阶段同时完成：

- canonical locator index。
- frame/shadow `LocatorScopePath` 执行。
- control capability、assembly status 与 observation completeness 传播。
- select_option 对新 ControlIndex 的切换。
- post-action verification。

本阶段不完成：

- FormComponent。
- TableComponent。
- 业务 fieldKey/actionIntent。

### 9.4 先行失败验收

1. 原生 input/select 从 canonical node 产生 locator，不依赖 presentation tree。
2. duplicate control ref 直接失败并包含 kind/root/owner diagnostic。
3. 同 name radio 不跨 form-item/form boundary 合并。
4. checkbox group 不跨显式 group 或安全容器合并。
5. custom select 使用 exact controls/popup relation 时组装 complete。
6. closed select 无 popup/options 时组装 partial，不宣称 select-option capability。
7. 打开 popup 后重新 capture，同一 control 在新 revision 中成为 complete。
8. 多个 select/popup 无 exact ownership 时返回 ambiguous，不选择第一个。
9. option node 自身拥有 executable locator。
10. iframe/shadow 内 control 的 locator 能通过 scope path 执行到正确节点。
11. scope path unavailable/ambiguous 时明确失败，不退回全页面文本或第一个 frame。
12. partial observation 导致缺失 runtime/A11y 事实时，control 继承 diagnostic 且不暴露依赖该事实的 capability。
13. select_option 不使用 `:has-text(...)` fallback，执行后验证选中状态。
14. value、data-value、DOM ID 大小写不被归一化破坏。
15. stale/ambiguous locator 返回明确错误，不执行模糊点击。

### 9.5 实施顺序

1. 冻结 ControlComponent、assembly status、capability、locator 和 inherited completeness contracts，并将 registry 输入迁到 observation/relation。
2. 迁移 native controls、radio/checkbox groups，保留安全 grouping boundary 和原始属性值。
3. 实现 typed custom-select 的 closed/open、partial/complete/ambiguous 组装，不允许 first-popup fallback。
4. 从 canonical nodes 建立 LocatorIndex 与 frame/shadow scope path executor，并运行 InvariantValidator。
5. 切换 select_option 和基础 interaction consumer，完成重新 capture 与 post-action verification。
6. 删除 compressed-snapshot collector、global popup scan、trigger-only executable compatibility 和 text fallback。

### 9.6 交付物

- 新 `ControlIndex`。
- Control Registry 和 collectors。
- canonical `LocatorIndex` 与 scope path executor。
- typed custom-select parts/relations。
- select_option 新执行路径。
- control diagnostics/debug projection，包括 inherited completeness。
- 真实 browser tests：Ant/Element Select portal、多个 select、closed/open transition、iframe/shadow control execution。

### 9.7 退出门槛

- production 中只存在一套 ControlIndex。
- select_option 不读取 V1 control semantics。
- required control fixtures 无 first-popup、global-ID 或 text fallback。
- 每个 executable control 都有 canonical locator 和合法 scope path；没有 locator 时显式 unresolved。
- partial control 和 partial observation 不暴露不具备的 capability。
- iframe/shadow locator 不存在全局 first-match fallback。
- control InvariantValidator 无 executable-target/locator conflict。
- post-action verification 覆盖 native select、radio、checkbox 和 custom select。
- 旧 trigger-only executable custom-select 路径已删除。

当前验收结果：

- 当前全量 Snapshot V2 测试 101 项全部通过。
- Element Plus 与 Ant Design Select 真实组件验收通过。
- custom select post-action verification 只接受显式 selected/aria-selected/checked 事实，不再接受 trigger 文本或焦点造成的隐式 A11y selected。
- checkbox group 在执行前解析全部 canonical locator，并在中途失败时恢复原始 checked 状态。
- 10 个固定/浏览器 fixture 的 control/locator 基线通过，control invariant failure 为 0。
- 28 个 controls 中 23 个可执行；其余 control 因 partial/ambiguous facts 明确不可执行，executable-without-resolved-locator 为 0。
- 唯一 unresolved locator 位于显式 unavailable scope，不存在全局 fallback。
- click、fill、type、select_option、hover、target scroll、target press-key、drag-and-drop 和 element screenshot 已切到 V2 canonical locator。
- structural locator 和 frame/shadow scope path 在执行前通过 backend/runtime identity 精确重映射；节点被替换时返回 stale，不按相同外观或旧 scope 序号重新绑定。
- Control ref 优先使用 page-epoch + backend/runtime identity，iframe/shadow 顺序变化不会把旧 ref 绑定到其他 control。
- native select 支持 optgroup 与 multiple；select 不再同时被收集为 popup。
- radio 按非空 name、form owner 和安全边界分组；checkbox 只在显式 group boundary 内组装。
- runtime 或 A11y facts 为 partial/unavailable 时，atomic control 继承 partial diagnostic 且不暴露 capability。
- `capture_resolve` 仍属于 Stage 5 消费方切换，不构成第二套 ControlIndex。
- 因此阶段 2 状态为 accepted；这不代表阶段 3 的 entity_rules 生产链已经完成。

### 9.8 交接重点

阶段 3 只能通过 ControlIndex 和 RelationIndex 构建 fields，不能重新扫描 raw DOM 或复制 control collector。

## 10. 阶段 3：FormComponent 组装与表单规则迁移

### 10.1 目标

从 controls、relations 和 boundaries 组装完整 FormComponent，并切换表单 entity_rules 到新结构。

### 10.2 入口条件

- 阶段 2 已验收。
- production interaction 使用唯一 ControlIndex/LocatorIndex。
- control status/capability contracts 冻结。

### 10.3 范围

- FormProposal 只收集候选范围，不直接确认业务实体。
- `BottomUpReducer<FormReductionState>`。
- label、description、error、group relations。
- composite field。
- form/dialog boundary。
- structural actions。
- standalone/residual field policy。
- ComponentLocation。
- form SemanticSuggestion。
- 现有表单规则通过单向 component-target bridge 解析到 FormComponent；本阶段不重写 matcher 语义。

### 10.4 先行失败验收

1. label/for、aria-labelledby、fieldset/legend 正确建立 field。
2. Element Form.Item 和 Ant Form.Item 作为 strong adapter evidence，但不覆盖平台 relation。
3. 一个 date range 或 prefix+input 形成一个 field、多个 controlIds。
4. 同一 form、同一 role 下 control owner 唯一。
5. control 不跨 form/dialog boundary 被外部 form 吞并。
6. portal popup 归 control，不成为外部 form field。
7. button-only 容器不能单凭按钮存在成为 form。
8. 用户 selection scope 是 Card 时，structural root 可以是内部 form，但 selection scope 保留。
9. submit/reset 结构事实与 search/save-draft/cancel suggestion 分离。
10. 显式 form 内部字段不会被提前拆成多个局部 form-like island。
11. active dialog 内字段先由 dialog boundary 消费，不向 body 继续传播。
12. popup listbox 不成为 field anchor。
13. DataTables search/page-size 和文档 utility control 保持 standalone/table-toolbar，不伪造 form。
14. 紧邻但无共同局部 boundary 的字段不因 geometry proximity 被合并。
15. residual field/control 可以没有 FormComponent owner。
16. 现有 form rule 经 bridge 只能解析到 FormComponent/canonical node，不再读取 V1 region/group。
17. bridge 保持现有 artifact 的 unique/one_or_more 行为，并把结构失败定位到 component/field。
18. bridge 不产生新的业务语义，也不吞掉 ambiguous structure diagnostic。

### 10.5 实施顺序

1. 冻结 FormComponent、FormField、FormGroup、FormReductionState、ownership contracts 和真实 form fixture truth。
2. 从 typed relations 和 ControlIndex 组装 label/description/error、composite field 与 group。
3. 实现 BottomUpReducer 的 canonical-order 汇总、explicit form/dialog 消费、局部 island 停止条件和 residual field policy。
4. 组装 structural actions、ComponentLocation、candidate classification 和 SemanticSuggestions，保持结构事实与业务 intent 分离。
5. 运行 InvariantValidator，并增加唯一单向 form component-target bridge，让现有 matcher 只接收 component/canonical node target。
6. 切换表单结构生产入口并删除 V1 form region/group/LCA ownership；不得保留第二套 form matcher。

阶段 3 bridge 删除阶段：Checkpoint 5A。

### 10.6 交付物

- `FormComponentIndex`。
- `BottomUpReducer<FormReductionState>`。
- standalone/residual field index。
- `OwnershipIndex` 的 form 部分。
- native/Element/Ant form adapter hints。
- form diagnostics/debug report，包括字段消费路径和停止原因。
- form component-target bridge。
- real fixtures：list/create/dialog/composite/Form.List/date range、DataTables toolbar、文档 utility controls。

### 10.7 退出门槛

- 现有 Element/Ant list/create forms 全部通过真实浏览器验收。
- FormComponent 不依赖 V1 region/group/entityIndex。
- `FormField.controlIds[]` 覆盖 composite fixture。
- BottomUpReducer 在 explicit form、dialog、局部 island 和 residual controls 上通过验收。
- 没有全局 common-ancestor/geometry clustering 生产路径。
- form InvariantValidator 无 ownership conflict。
- form rule 的结构目标解析只使用新组件路径，matcher 语义仍由现有唯一实现承担。
- V1 form recognition 和 form LCA ownership 已删除，没有第二套 form matcher。
- extension 尚未切换，但 agent 输出已包含完整 form visual binding input。

当前验收结果：

- 当前全量 Snapshot V2 测试 101 项全部通过；entity_rules 集成测试 11 项全部通过。
- Element Plus 与 Ant Design 的 list、create、dialog、Form.List 和 date-range 页面通过精确浏览器验收；字段、composite、required、actions、residual 均使用固定预期，不再只检查下限。
- Stage 3 baseline 使用 4 个被 Git 跟踪的代码生成紧凑语料，不依赖 `agent/tests/fixtures/form-v2/` 的本地大型 capture。
- 紧凑语料 × 50 iterations：47 nodes、4 forms、8 fields、1 composite field、2 residual fields、5 owned actions、1 residual action、22 ownership edges，exact truth error 为 0。
- DataTables search/page-size residual 行为由紧凑确定性 toolbar signature 保护；完整官方页面 capture 仅作为本地探索材料，不参与 CI/baseline。
- `FormProposal`、`BottomUpReducer<FormReductionState>`、reduction trace、ComponentLocation、structural action 与 SemanticSuggestion contracts 已冻结。
- form bridge 只接收 FormComponent/canonical node，保留 `unique`/`one_or_more`，不构造 V1 region/group entity，也不生成业务 binding。
- fieldset 以 label/for、wrapping label、aria-label 和 aria-labelledby 区分独立字段；仅在没有独立字段证据时使用 legend 组装 composite field。
- active dialog 可以消费单字段表单；无效或 unresolved `form` owner 产生 Form 层 diagnostic。
- form bridge 在匹配前拒绝 duplicate ruleId、unknown/cyclic within 和空 match，并按依赖拓扑执行前向 within。
- form bridge 保留既有 matcher 的 name/placeholder/subtree text 与 `unique`/`one_or_more` 语义；ambiguous/partial FormComponent 不得产生成功 binding。
- workspace entity_rules 已完成 artifact save/load、profile list/get、explicit/auto/inherit selection 与 strict missing-profile failure。
- `EntityRulesRuntime.executePage` 从同一次 ControlSnapshot 构建 Form/Table snapshots，并在真实浏览器页面执行选中的 form/table profiles；disabled 路径不触发页面采集。
- runtime matcher 保留 profile、rule binding、annotation 和 diagnostics；mixed domain、未知条件、missing snapshot 均显式失败，不回退 V1 recognizer。
- 阶段 3 状态为 accepted。runner/snapshot/query/session 等最终消费方切换归属阶段 5，不属于阶段 3 退出条件。

### 10.8 交接重点

阶段 4 不允许把 generic repeated group 复用为 table model。表格只共享 evidence、ownership、diagnostics 基础设施。

## 11. 阶段 4：TableComponent 组装与表格规则迁移

### 11.1 目标

建立一个逻辑 table 对应多个 DOM/framework parts 的强类型模型，并切换表格 entity_rules 到新结构。

### 11.2 入口条件

- 阶段 3 已验收，包括 entity_rules artifact、profile selection 与 runtime matcher 生产链。
- component core、ownership、semantic suggestion contracts 已稳定。
- form 和 control production path 已切换。

### 11.3 范围

- native semantic table。
- Element Table。
- Ant Table。
- host/root/physical parts 分类。
- header tree、leaf columns。
- canonical RowIndex 与 FeatureCover 代表工作集。
- visible rows、cells、CellControlSlot、row exceptions 和业务 row-action binding 边界。
- treegrid hierarchy sidecar。
- fixed/sticky/mirror mapping。
- summary/footer。
- pagination ownership。
- virtualization row window。
- editable cell 与 portal editor ownership。
- table SemanticSuggestion。
- 现有表格规则通过单向 component-target bridge 解析到 TableComponent；本阶段不重写 matcher 语义。

### 11.4 先行失败验收

1. Element benchmark 中 23 个 `.el-table` 对应 23 个 TableComponent，而不是 64 个 physical `<table>`。
2. outer Card `role=table` 只作为 host/selection scope，不与内部 structural root 重复成 entity。
3. row、cell、columnheader、`tr/td/th` 永远不成为 table root。
4. header/body/fixed-left/fixed-right/footer 正确聚类成一个 component。
5. fixed clone 不产生重复 columns/rows/actions。
6. fixed-right 独有 action 映射到 canonical action column。
7. Ant fixed/sticky/summary 正确组装。
8. 多级 header、colspan/rowspan 形成 header tree 和正确 leaf columns。
9. nested table 依据 direct row/cell ownership 判断，允许真实 outer/inner 同时存在。
10. sibling pagination 绑定正确 table；同一 scope 内两个可能 owner 时 ambiguous。
11. top/bottom 两组 pagination 可以归属同一 table，不互相覆盖。
12. virtualized table 报告 partial rowWindow，不伪造总数。
13. loading/empty table 保留 schema 和状态。
14. row selection、responsive hidden column 不破坏 canonical column alignment。
15. observed uniqueness 只产生 primary-key suggestion。
16. FeatureCover 覆盖全部定义结构特征，代表行数量不随总行数线性增长。
17. canonical RowIndex 仍包含全部当前可见行，代表行不成为 query 真值。
18. Wikipedia/文档表中的重复链接只形成结构 slot 或普通 cell control，不自动成为业务 row action。
19. 单行包含大量 links/controls 时不产生线性数量的 CellControlSlot。
20. one-off control 保留为 row exception，row action template 与个别例外均可表达和定位。
21. W3C treegrid 使用 canonical document order 恢复 parent edges；无 aria-level 的 grid 保持 hierarchy unknown。
22. 非法 level jump 产生 diagnostic，不修正成猜测层级。
23. editable cell 和 portal editor 正确归 canonical cell；closed/open revision 的 partial/complete 状态明确。
24. 至少一个旧版 clone-based fixed fixture 通过 mirror mapping。

### 11.5 实施顺序

1. 冻结 TableComponent、parts、header/columns、RowIndex、rowWindow、CellControlSlot、hierarchy contracts 和 logical-table truth。
2. 实现 native table direct ownership、header tree、FeatureCover、CellControlSlot、row exceptions、treegrid hierarchy 和 editable-cell ownership 基线。
3. 实现 Element root/parts、fixed/mirror、summary 和 pagination 组装。
4. 实现 Ant root/parts、sticky/fixed、summary 和 pagination，并用旧版 clone-based fixture 验证通用 mirror mapper。
5. 完成 cluster-before-assembly、canonical row/cell/action mapping 和 InvariantValidator，所有歧义保持显式。
6. 增加唯一单向 table component-target bridge，切换生产入口并删除 V1 table region/group/candidate/key/model 路径。

阶段 4 bridge 删除阶段：Checkpoint 5A。

### 11.6 交付物

- `TableComponentIndex`。
- table parts/header/body/footer/pagination models。
- canonical RowIndex、FeatureCover、CellControlSlot 和 hierarchy sidecar。
- native/Element/Ant adapters。
- current 与旧版 clone-based fixed fixtures。
- mirror mapping 和 column alignment。
- editable-cell/portal-editor ownership。
- table diagnostics/debug report，包括 feature coverage、slot/exceptions 和 hierarchy evidence。
- table component-target bridge。
- required real browser fixtures。

### 11.7 退出门槛

- logical table count 与 truth collector 完全一致。
- required fixtures 中 duplicate table/column/row action 数为 0。
- FeatureCover 无未覆盖 required feature，局部代表工作集有界。
- canonical RowIndex 与 representative rows 明确分离。
- CellControlSlot、row exception 和业务 action binding 不混用。
- treegrid hierarchy 有证据则正确、无证据则 unknown。
- editable cell/popup editor ownership 通过真实浏览器验收。
- ambiguous pagination/fixed mapping 不被静默解决。
- table InvariantValidator 无 row/column/slot/hierarchy/mirror conflict。
- table rule 的结构目标解析只使用新 TableComponent，matcher 语义仍由现有唯一实现承担。
- `SAME_KIND_NEST_DROP`、`TABLE_PER_FAMILY_LIMIT`、row-level promotion、pagination-list suppression 等 V1 补丁不再参与生产路径。
- table locator 和 action target 来自 canonical nodes。

当前验收结果：

- 当前全量 Snapshot V2 测试 101 项全部通过；entity_rules 集成测试 11 项全部通过。
- 真实 Element Plus 页面包含 23 个 `.el-table`，组装结果严格为 23 个 TableComponent；DOM physical `<table>` 数量高于逻辑表数量，但不会重复产生 entity。
- 真实 Ant Design sticky/fixed/summary/pagination 页面组装为一个 TableComponent，top/bottom pagination 归属同一逻辑表。
- native、Element、Ant、多级 header、nested table、treegrid、virtualized row window、footer、pagination ambiguity、FeatureCover 与 CellControlSlot 均有确定性验收。
- canonical RowIndex 保存全部当前可见行，FeatureCover 只保存有界代表行；二者不混用。
- 旧版 Element clone-based fixed fixture 将 fixed-left row/cell 映射到 canonical row/cell，fixed-right 独有 action 只形成一个 canonical action column 和一个重复 control slot。
- mirror mapper 优先使用 exact row key；重复 row key 明确返回 ambiguous，不按位置选择第一个。只有双方无 key 且行数相等时才允许带 weak evidence 的序号映射。
- editable cell 只通过 exact `aria-controls`/`aria-owns` IDREF 建立 portal editor ownership；不根据 class、文本或邻近关系猜测。
- 真实浏览器 closed/open editor revision 验证同一 page epoch 下 capture revision 递增，table 从 partial/unresolved 转为 complete/resolved，并将 editor control 归属 canonical cell。
- custom-select 的外置 listbox 保持 control-owned，不会误分类为 cell editor；重复 portal ID 返回 ambiguous，两个 control 均不会附着到 canonical cell。
- table component-target bridge 与 entity_rules runtime matcher 已贯通；table `relation=pagination` 和 keyHint 只消费 typed TableComponent facts。
- 阶段 4 状态为 accepted。SemanticBindings、最终 Projection、runner/query/annotator/session/diff 消费方切换仍属于阶段 5。

### 11.8 交接重点

阶段 5 接收已经稳定的 Control/Form/Table indexes。阶段 5 不再新增结构识别算法，只做业务语义、session 和消费投影切换。

## 12. 阶段 5：SemanticBindings、Projection 与消费方切换

本阶段内容较多，但属于同一次生产切换。为了可接力，分为四个内部 checkpoint；它们不是可并行阶段，必须按顺序完成。

### 12.1 目标

让 entity_rules、session selection、snapshot、query、annotator 和 diff 全部消费 V2 facts/components，并删除对应 V1 生产入口。

### 12.2 入口条件

- 阶段 4 已验收。
- production 已有唯一 Control/Form/Table indexes。
- 结构识别不再依赖 V1。

### 12.3 Checkpoint 5A：SemanticBindings 与 QueryPlan

先行验收：

- 同一规则在 check、save、runtime query 中使用同一 QueryPlan 语义。
- unique/multiple/missing/ambiguous 指向具体 component、field/column/action 和 plan step。
- 旧 artifact 可以 importer/compiler 进入新 runtime，但不调用 V1 recognizer。
- inferred、confirmed、manual、ignored、invalidated 生命周期正确。
- actionIntent、fieldKey、primaryKey 只有规则确认或用户确认后进入 binding。

交付：

- locator/entity rule compiler。
- QueryPlan executor。
- SemanticBindings 和 SemanticSuggestions。
- protective merge。
- 旧 artifact importer。

Checkpoint 退出：

- agent 只有一套规则 matcher。
- `ruleEntityOverlay/businessEntityOverlay` 不再作为生产事实源。
- 阶段 3/4 的 form/table component-target bridge 已删除，QueryPlan 直接消费 components 和 canonical nodes。

当前实施状态：

- 已完成：统一 QueryPlan compiler/executor，check/save/runtime 共享同一语义。
- 已完成：SemanticBindings、SemanticSuggestions、inferred/confirmed/manual/ignored/invalidated 生命周期与 protective merge。
- 已完成：V1 entity_rules artifact importer；V2 publication validation 仍保持严格。
- 已完成：阶段 3/4 component-target bridge 与旧 matcher 目录删除。
- 已完成：`capture_resolve` 直接消费 PageSession 的 canonical observation、LocatorIndex 与 active SemanticBindings。
- 已完成：无生产调用者的旧 `resolve_target` 删除；生产代码中无 `ruleEntityOverlay/businessEntityOverlay` 引用。
- Checkpoint 5A 状态：accepted。

### 12.4 Checkpoint 5B：Page session 与 selection

先行验收：

- 同一 page epoch 内筛选、分页、打开 dialog 后 exact anchor 可重映射。
- exact identity 消失时 stale。
- 多个 exact candidate 时 ambiguous。
- navigation/new document 后旧 anchor 失效。
- recognize 不改变 confirmed selection scope。
- dirty interaction、navigation 和 explicit refresh 使用不同且可诊断的 refresh reason。
- 并发 refresh 只采集一次。

交付：

- PageEpoch session store。
- CaptureRevision lifecycle。
- SessionAnchor remap。
- selection state。
- base observation/analysis/bindings composition。

Checkpoint 退出：

- `CanvasDraft.target` 不再承担当前会话节点身份。
- URL 不再是唯一 page identity。

当前实施状态：

- 已完成：PageEpoch/CaptureRevision session store，clean reuse 与 missing/dirty/navigation/explicit refresh reason。
- 已完成：同 URL 并发 refresh 去重；导航发生于在途 refresh 时等待后重新判定并采集新文档。
- 已完成：exact anchor 在同 epoch 重映射，跨 epoch stale，重复 exact identity 返回 ambiguous。
- 已完成：PageSession composition 对 SemanticBindings 执行 protective merge。
- 已完成：runner 注入 PageSession，写操作 dirty policy 与单次 Control/Form/Table/entity_rules capture bundle。
- 已完成：confirmed selection state 与 selection scope 进入 PageSession；recognize 只读重映射，不改写确认 anchor。
- 已完成：entity/query/assert/checkpoint/record/capture_resolve/get_content 等消费方全部切换到 V2 PageSession。
- 已完成：URL 仅作为 navigation freshness 信号，page identity 使用 PageEpoch/CaptureRevision 与 exact anchor identity。
- Checkpoint 5B 状态：accepted。

### 12.5 Checkpoint 5C：SnapshotProjection、RuntimeQuery 与 SemanticDiff

先行验收：

- overview/interaction/annotation/debug/full 模式行为明确。
- full/contain/depth/filter 能从 canonical indexes 生成。
- forms 不丢字段或 validation state。
- tables 保留 schema、actions、pagination，并报告行 omission。
- repeated collection 报告 `{total,included,omitted,policy}`。
- interaction mode 不因 budget 删除 actionable control。
- component state change 产生 semantic diff。
- correlation ambiguous 时回退 full。
- query 返回 canonical node/component target，不读取 presentation tree。

交付：

- SnapshotProjection。
- RuntimeQuery adapter。
- DebugProjection。
- SemanticDiff。
- recognition-driven compression/row cover。

Checkpoint 退出：

- stage 1 从未建立 `PageObservation -> V1-compatible tree` bridge。
- V1 compress 不再是 snapshot/query/recognition 的生产依赖。

当前实施状态：

- 已完成：SnapshotProjection 直接消费 canonical observation、Control/Form/Table indexes 与 SemanticBindings。
- 已完成：overview/interaction/annotation/debug/full 五种 mode；interaction mode 显式保护全部 executable controls。
- 已完成：overview 使用 FeatureCover 进行 recognition-driven row cover，并以 `{total,included,omitted,policy}` 报告省略。
- 已完成：full/contain/depth/filter、Form validation、Table schema/actions/pagination 与 component geometry projection。
- 已完成：SemanticDiff 使用 exact identity correlation；ambiguous/navigation/no-baseline 明确回退 full。
- 已完成：mode-scoped diff baseline、epoch-bound content ref、V2 RuntimeQuery adapter 与 DebugProjection。
- 已完成：生产代码无 V1 presentation tree、compress、entity view 或旧 snapshot cache 依赖。
- Checkpoint 5C 状态：accepted。

### 12.6 Checkpoint 5D：AnnotatorProjection 与 extension 切换

先行验收：

- 点击由 agent 解析为 SessionAnchor。
- 标注框来自 agent component/binding geometry fragments。
- live DOM geometry 只更新当前 visual rendering，不改变 structural identity。
- outer host、selection scope、structural root 可以分别展示。
- confirmed entity/field/column/action 在 recognize 后不被重选。
- check/save/reopen/runtime query 完整链路通过。
- 页面重渲染后 exact remap 或明确 stale/ambiguous。

交付：

- 共享 `annotator-contract`。
- AnnotatorProjection。
- extension 新 state/protocol。
- live geometry remap 只接受 canonical binding。

Checkpoint 退出：

- extension 删除 `resolveEntityElement()`、tag/class/text entity recovery 和等价 DOM matcher。
- extension 不执行 entity_rules。
- agent 与 extension 不再维护两套 entity root/ownership。

当前实施状态：

- 已完成：仓库级共享 `annotator-contract`，agent 与 extension 使用同一 projection/draft/validation 协议。
- 已完成：点击只上传 top CSS viewport 坐标，由 agent canonical observation geometry 解析为 SessionAnchor；selector/element recovery payload 被拒绝。
- 已完成：AnnotatorProjection 分离 selection scope、outer host、structural root、field、form action、table control-slot action、row、column、control 与 semantic binding。
- 已完成：open/pick/recognize/visualize/check/save/reopen 全部经过 PageSession、QueryPlan 与 SemanticBindings。
- 已完成：check 不写盘；save 仅在同一 QueryPlan 验证成功后持久化，无效 draft 不覆盖既有 profile。
- 已完成：extension client/session/panel/overlay 只发送 Action、编辑 draft、捕获坐标并渲染 agent geometry，不导入 QueryPlan 或 entity_rules 执行器。
- 已完成：scroll、resize 与 visual viewport 事件只触发 agent visualize；agent 显式重采集 geometry，不改变 structural identity。
- 已完成：同一 canonical DOM 节点移动后 exact anchor 保持 resolved；节点替换后明确 stale；ambiguous exact identity 由 PageSession 既有验收覆盖。
- 已完成：真实 Element Plus 与 Ant Design 页面验证 form field、submit action、table slot action、Ant dialog host、canonical picking 与 recognize 后 selection 保持。
- 已完成：生产源码无 `resolveEntityElement()`、extension DOM entity matcher、V1 annotator picking/recognize 或重复 entity root/ownership 调用点。
- Checkpoint 5D 状态：accepted。

### 12.7 阶段 5 总退出门槛

- browser.snapshot、browser.query、annotator、check/save/runtime query 全部走 V2。
- V1 entity view、annotator picking/recognize、overlay matcher 不再有生产调用点。
- snapshot projection omission 显式。
- diff correlation ambiguous 时不伪造局部 diff。
- selection 生命周期在 same-epoch/new-epoch fixture 中通过。
- extension 只负责事件、编辑 UI、geometry rendering 和 diagnostics 展示。

当前验收结果：

- browser.snapshot、browser.query、record、checkpoint、assert、entity、annotator、check/save/runtime query 均使用 V2 PageSession/canonical indexes。
- Snapshot：120/120；entity_rules/annotator：30/30；trace：7/7；extension typecheck 与完整测试通过。
- `typecheck:snapshot` 为 0 项诊断，相关新增源码严格 lint 为 0。
- Stage 5 状态：accepted。

### 12.8 交接重点

阶段 6 不再实现新功能，只删除死代码、补发行矩阵、修复真实验收暴露的阻塞 bug。

## 13. 阶段 6：V1 删除与发行级验收

### 13.1 目标

结束迁移，保证主分支没有 V1 runtime、fallback、重复协议和幽灵兼容规则。

### 13.2 入口条件

- 阶段 5 已验收。
- 全部 production consumer 已切换 V2。
- 所有临时 bridge 已有零调用证明。

### 13.3 删除范围

- V1 region/group entity pipeline。
- V1 candidate scoring/select/prune chain。
- V1 LCA ownership。
- V1 table key/model/family-limit/nested-drop 路径。
- pre-index mutating compression 生产路径。
- V1 stable-id fallback 依赖的 projection identity。
- V1 scoped diff。
- V1 annotator picking/recognize DOM recovery。
- `FinalEntityView` 单节点实体模型。
- deprecated `businessEntityOverlay` 和重复 overlay 类型。
- extension DOM 二次规则执行器。
- agent/extension 重复协议类型。
- trigger-only executable custom-select compatibility。
- 只验证旧实现细节、不再保护产品行为的测试。

### 13.4 发行级真实验收矩阵

必须覆盖：

- native HTML form/table。
- Element list/create form。
- Ant list/create form。
- Element table：fixed-left/right、summary、pagination。
- Ant table：fixed/sticky、summary、pagination。
- 至少一个旧版 clone-based fixed table。
- multi-level header、span/merged cell。
- expandable/nested/tree table。
- virtualization、loading、empty。
- editable cell 与 portal popup editor。
- dialog、portal、opened select popup。
- 同 scope 多个 select/popup。
- 同 host 多个 table 与 ambiguous pagination。
- shadow root 重复 ID。
- iframe scope、scope geometry、locator execution 和 captured-without-candidate iframe。
- partial observation source failure。
- zero-box active descendants 与 controller/activity mismatch。
- zoom、scroll、visual viewport。
- filter、pagination、modal open/close、rerender。
- SessionAnchor exact remap/stale/ambiguous。
- entity_rules import/check/save/reopen/runtime query。
- browser.snapshot overview/interaction/full/contain/filter/diff。
- Step、Checkpoint、DSL 对 form/table/control 的真实动作和断言。

### 13.5 发行诊断验收

每次失败至少可以定位到：

```text
page epoch / capture revision / scope
canonical node identity
relation resolution
control/component status
host / structural root / part
ownership decision
adapter/evidence
QueryPlan step
locator resolution
projection omission/correlation
```

不得只输出“未找到实体”或“selector failed”。

### 13.6 性能验收

- 对阶段 1 冻结语料重新生成 p50/p95 和 work-set report。
- 相比阶段 1 基线，新增完整 analysis/projection 的成本有分 pass 说明。
- 不存在明显 O(N²) 全树重扫。
- 不通过删除 canonical nodes 降低指标。
- cache 以 pass input/hash 为边界，不缓存可变压缩树。

### 13.7 退出门槛

- 主分支无 V1 runtime 入口。
- 无 V1 fallback、runtime flag 或双 matcher。
- `git grep` 和依赖图证明旧模块无生产引用。
- required browser matrix 全部通过。
- 文档、contracts、实现和测试一致。
- V1 只能通过归档 tag 查看。
- 未完成的 required fixture 为 0。

## 14. 可观测性与阶段报告

### 14.1 Observation report

至少包含：

```text
page epoch
capture revision
scope count/status，并单独报告 captured-without-candidate 与 unavailable
observation completeness by source
node count by scope
DOM/A11y/runtime join resolved/missing/ambiguous
IDREF relation counts
activity facts 与 controller mismatch
zero-box node count and active descendants
geometry source/space/frame transforms
candidate classification counts
candidate-local quotient max/p50/p95
collapsed path depth / projection-parent fan-out / orphan count
per-pass node/edge visits
p50/p95 timing
```

### 14.2 Control report

```text
control kind/status
root/control/trigger/popup/options
capabilities
relation evidence
duplicate/ambiguous decisions
locator source / scope path
inherited observation completeness
InvariantValidator result
post-action verification result
```

### 14.3 Form report

```text
selection scope / host / structural root
field count
controlIds per field
label/description/error relations
groups/actions
bottom-up reduction consume/stop trace
standalone/residual fields
ownership conflicts
InvariantValidator result
suggestions vs confirmed bindings
rejected/ambiguous proposals
```

### 14.4 Table report

```text
selection scope / host / structural root
physical parts by type
canonical header/body/footer
header tree and leaf columns
visible row window / canonical row count
FeatureCover selected rows and uncovered features
CellControlSlot / one-off row exceptions / business action bindings
row hierarchy evidence and invalid level jumps
fixed/mirror mappings
editable-cell / popup-editor ownership
row action mappings
pagination ownership
virtualization completeness
InvariantValidator result
rejected/ambiguous proposals
```

### 14.5 Projection report

```text
mode
input component counts
included/omitted records
row cover reasons
interactive target count
correlation matches/ambiguous/full fallback
diff component/state changes
```

## 15. Adapter 纪律

Adapter 允许：

- 发现 framework structural root。
- 标注 physical part 类型。
- 提供 framework-specific strong/weak evidence。
- 提供稳定的局部结构 hint。

Adapter 禁止：

- 生成业务 fieldKey/actionIntent/primaryKey。
- 修改用户 selection。
- 直接保存 entity_rules。
- 覆盖 exact platform relation。
- 返回第一个全局 popup/table 作为结果。
- 为通过 fixture 添加站点专用 hardcode。
- 自行裁剪完整 component model。

首批 adapter：

- native controls/form/table。
- Element Form/Table/Select。
- Ant Form/Table/Select。

## 16. 迁移纪律

1. 不在 V1 上增加任何结构识别能力。
2. 每阶段测试先于实现。
3. 完整 V2 消费链完成前，不删除尚未迁移的调用方；最终切换后统一清理。
4. 不使用 runtime flag 长期切换实现。
5. 不为旧测试实现 fallback；对应 V2 产品行为验收完成后再删除旧实现细节测试。
6. 不擅自修改 entity_rules artifact 发布契约；必要修改必须在阶段 5 的 contract 评审中明确。
7. 结构识别失败输出 diagnostics，不选择首个候选。
8. confirmed/manual binding 不被自动识别覆盖。
9. SessionAnchor 只允许 exact remap。
10. snapshot projection 不得成为 query 或 locator 的事实源。
11. StructuralQuotient 必须是 candidate-local，不得重新建立 scope 级全局重要节点树。
12. Form 不使用全局 common-ancestor/geometry clustering，Table 不使用固定位置或完整 signature 枚举代表行。
13. 当前阶段未验收时，不开始后续阶段。
14. 各阶段只建立新模块唯一入口；仓库级生产切换集中在完整消费链具备后执行。

## 17. 阶段 1 的实际工作单

第一轮实施只允许完成以下工作：

1. 冻结 identity、scope、completeness、activity、geometry、relation、candidate、quotient 和 diagnostic contracts。
2. 提取带版本元数据的 raw fixtures，并增加 shadow、captured-without-candidate iframe、zero-box、activity mismatch、typed IDREF 和 scope geometry browser fixtures。
3. 实现 PageEpoch/CaptureRevision、ScopeForest、immutable indexes、partial observation、exact joins 和 activity facts。
4. 实现 scope-local relations、frame transforms、locator scope path、CandidateEvidence、candidate-local quotient 和 InvariantValidator。
5. 建立 observation replay benchmark、decision report、局部工作集和性能基线。
6. 切换唯一 capture/fusion 入口并通过全部退出门槛，不开始 Control/Form/Table 实现。

阶段 1 明确不做：

- ControlIndex。
- FormAssembler。
- TableAssembler。
- entity_rules 迁移。
- annotator UI 改造。
- final snapshot compression。

## 18. 标准交接记录模板

每阶段完成时在任务记录中提交以下内容：

```markdown
# Snapshot V2 Stage N Handoff

## 状态
- 阶段：
- 结果：accepted / blocked / failed
- 当前分支与 commit：
- 工作区状态：

## 冻结 contracts
-

## 生产入口
- 新入口：
- 已删除旧入口：
- 尚存 bridge 及删除阶段：

## 测试先行证据
- 首先新增的失败验收：
- 实现后通过的测试：
- 实际命令与结果：

## 真实页面报告
- fixture：
- report 路径：
- logical truth / actual：
- ambiguous / rejected：

## 性能与工作集
- node/edge count：
- candidate counts：
- candidate-local work-set max/p50/p95：
- orphan/fan-out/collapsed-depth：
- pass visits：
- p50/p95：
- 相对基线：

## 未解决问题
- 分类：
- 是否阻塞下一阶段：
- 证据：

## 下一阶段入口检查
- [ ] 本阶段退出门槛全部满足
- [ ] 下一阶段只依赖已冻结产物
- [ ] 无 runtime flag 或 V1 fallback
- [ ] 无未报告的工作区修改
```

该模板用于保证不同会话和实施者之间可以直接接力，而不是依赖口头上下文恢复项目状态。
