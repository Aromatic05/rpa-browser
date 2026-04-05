# Snapshot 骨架设计说明

## 1. 为什么旧的单文件 snapshot executor 不适合继续扩展

旧的 `snapshot.ts` 主要只做 `trace.page.getInfo` 与 `trace.page.snapshotA11y` 的薄封装，职责过于集中在单文件，后续要扩展 DOM/A11y 融合、空间重排、区域处理、跨层关系等阶段时，代码会快速耦合并难以维护。

## 2. 新 snapshot 模块目标

本次目标是“框架级骨架”：
- 先把大模块拆成清晰子文件与接口。
- 保留主流程调用链与伪代码对应关系。
- 只做最小可编译占位，不实现复杂算法。

## 3. 主流程调用链

`executeBrowserSnapshot -> generateSemanticSnapshot`

`generateSemanticSnapshot` 内部链路：
- `collectRawData(page)`
- `fuseDomAndA11y(domTree, a11yTree)`
- `buildSpatialLayers(graph)`
- `detectRegions(node)` + `processRegion(node)`
- `linkGlobalRelations(root)`
- `assignStableIds(root)`
- `buildSnapshot(root)`

`processRegion` 当前固定顺序：
- `detectBusinessEntities`
- `buildTree`
- `markStrongSemantics`
- `applyLCA`
- `rankTiers`
- `compress`
- `finalizeLabel`

## 4. 伪代码原文

```ts
class SemanticPerceiver {
  generate(page: Page) {
    // 1. 采集原始观察：DOM、A11y、基础 bbox、focus、可见性
    const raw = collect(page);

    // 2. DOM + A11y 融合：把浏览器底层 role/name 语义注入统一节点图
    const graph = fuseDomAndA11y(raw.domTree, raw.a11yTree);

    // 3. 空间分层：先把主文档流和浮层/弹窗/菜单拆开
    const layers = buildSpatialLayers(graph);

    // 4. 创建虚拟根，先挂主内容层
    const root = virtualRoot();
    root.children.push(layers.mainBody);

    // 5. 过滤明显噪声层，再挂有效 overlay
    for (const layer of layers.overlays) {
      if (isNoiseLayer(layer)) continue;
      root.children.push(layer);
    }

    // 6. 每个空间层内部再做业务区域划分和语义处理
    for (const layer of root.children) {
      const regions = detectRegions(layer);

      for (const region of regions) {
        const tree = processRegion(region);
        if (tree) replaceRegion(layer, region, tree);
      }
    }

    // 7. 处理跨层/跨区域关系：label、controls、opens、closes、belongs_to
    linkGlobalRelations(root, layers);

    // 8. 最后生成稳定 ID，避免压缩前后身份漂移
    assignStableIds(root);

    // 9. 输出 snapshot
    return buildSnapshot(root);
  }

  processRegion(region: Region) {
    // 1. 先识别业务实体：form、field group、table、row、card、dialog
    const entities = detectBusinessEntities(region);

    // 2. 建立区域初始树
    const tree = buildTree(region);

    // 3. 标记强语义节点：input、button、link、checkbox、label、error
    markStrongSemantics(tree);

    // 4. 对弱语义节点做 LCA 归因，把控件挂到正确业务实体上
    applyLCA(tree, entities);

    // 5. 节点价值分级：A 必留，B 桥接，C 可折叠，D 可删除
    rankTiers(tree);

    // 6. 按 tier 压缩树
    const compressed = compress(tree);

    // 7. 压缩后轻量语义收口（迁移/校正，不重跑完整识别）
    return compressed ? finalizeLabel(compressed) : null;
  }

  applyLCA(tree: Node, entities: Node[]) {
    forEachNode(tree, (node) => {
      // 只处理弱语义但重要的交互节点，比如 icon button、输入框、行内动作
      if (!isWeakSemanticNode(node)) return;

      // 往上找最近业务实体，作为局部语义宿主
      const entity = findNearestEntity(node, entities);
      if (!entity) return;

      // 在实体内部扫描标题、label、列头、行头、邻近文本
      const context = scanEntityContext(entity, node);

      // 把上下文语义挂回节点
      attachContext(node, entity, context);
    });
  }

  compress(node: Node): Node | null {
    // 先递归压缩子节点
    node.children = node.children
      .map(child => compress(child))
      .filter(Boolean);

    // D 类节点直接删除：script/style/svg/path/纯装饰噪声
    if (isDeleteTier(node)) return null;

    // C 类无意义壳层折叠：把有效子节点往上提
    if (isCollapsibleShell(node)) return liftChildren(node);

    // 对复杂但低价值子树做摘要，而不是全量保留
    if (shouldSummarize(node)) return summarize(node);

    // A/B 类节点保留
    return node;
  }

  fuseDomAndA11y(domTree: DomTree, a11yTree: A11yTree) {
    // 以 DOM 为骨架，把 A11y 的 role/name/state 融合进节点
    // 目标是减少纯 DOM 启发式，直接利用浏览器底层语义解析结果
    return unifiedGraph;
  }

  buildSpatialLayers(graph: NodeGraph) {
    // 按空间语义先拆层：
    // mainBody = 主文档流
    // overlays = dialog / drawer / dropdown / popover / fixed widget 等浮层
    // 这样主内容和遮挡层不会混在同一棵业务树里
    return { mainBody, overlays };
  }

  isNoiseLayer(layer: Layer) {
    // 对边缘小挂件、广告、追踪器、客服入口做低成本噪声判定
    // 空间特征：小、靠边、不覆盖主区域
    // 语义特征：缺乏 button/link/textbox/dialog 等强交互语义
    return maybeNoise;
  }
}
```

## 5. 各文件职责

- `snapshot.ts`：模块入口与主流程串联。
- `types.ts`：最小必要类型（`RawData/UnifiedNode/NodeGraph/SnapshotResult/NodeTier`）。
- `collect.ts`：采集原始数据，调用 trace 基础能力。
- `fusion.ts`：DOM 与 A11y 融合骨架。
- `spatial.ts`：顶层子树空间重排与噪声层占位判定。
- `regions.ts`：区域检测骨架（返回普通节点数组）。
- `process_region.ts`：区域处理主链（实体识别/树构建/语义标记/LCA/tier/压缩）。
- `lca.ts`：弱语义节点最近业务实体归因骨架。
- `compress.ts`：结构压缩（删除/折叠/文本上浮 + 保守摘要）。
- `relations.ts`：跨层跨区域关系链接骨架。
- `stable_id.ts`：稳定 ID 生成骨架。
- `build_snapshot.ts`：输出结构构建骨架。

## 6. 第二阶段填充项（Stage2）

在不改变主流程骨架的前提下，当前已填充：

- `buildSpatialLayers(graph)`：轻量空间分层（主内容与 overlay 顶层重排）
- `isNoiseLayer(layer)`：保守噪声判定（小尺寸 + 靠边 + 无交互）
- `detectBusinessEntities(region)`：最小业务实体识别（form/table/row/dialog/list item/card）

其余阶段仍保持占位并持续被调用。

## 7. 第三阶段填充项（Stage3）

在不改变主流程骨架的前提下，当前新增：

- `applyLCA(tree, entities)`：最小可用 LCA 归因
- `markStrongSemantics(tree)`：基础强语义标记（button/textbox/checkbox/link）
- `detectBusinessEntities(region)`：补充 `entityId/entityType`（form/row/card/dialog/list_item）

LCA 当前直接把语义挂在节点 `attrs` 上，不引入复杂结构：

- `entityId`
- `fieldLabel`
- `actionIntent`
- `actionTargetId`

## 8. LCA 简化设计说明

为什么使用“最近 business entity”：

- 局部语义通常在最近业务边界内最稳定（例如 form、row、card、dialog、list item）
- 先做最近实体归因，可以避免把跨区域文本错误挂到节点上
- 对第一版能力来说实现成本低、行为可预期

简化版流程：

1. 只处理关键节点（输入类控件、按钮、链接、行内动作、搜索筛选控件）
2. 向上找到最近实体（form/row/card/dialog/list_item）
3. 在实体内按优先级找上下文（显式 label、邻近文本、section 标题、表头/行头）
4. 挂载 `fieldLabel/actionIntent/actionTargetId/entityId`

示例：

- `textbox`（在 `form` 内）可获得 `fieldLabel=Email` 与 `entityId=entity:form-1`
- `button`（在 `row` 内）可获得 `actionIntent=delete` 与 `actionTargetId=entity:row-1`

## 9. 当前占位、后续待实现

以下内容目前仍为轻量占位：
- 真实 DOM+A11y 融合策略。
- 复杂空间重排与完整噪声层规则。
- 业务区域检测细则。
- 复杂 LCA 场景（跨表格多列关联、复杂视觉邻近匹配、多语言意图细分）。
- 完整 tier 分级细则。
- 激进压缩与复杂摘要策略（当前仅保守压缩）。
- 全局关系链接规则。

LCA 当前限制（明确）：

- 不是完美匹配，优先保证稳定和保守
- 复杂布局中“左侧/上方”判断只做低成本近似
- `actionIntent` 依赖关键词启发，覆盖范围有限

## 10. 第四阶段返工项（Stage4）

第四阶段的目标不是继续堆补丁，而是“收口重构”：

- 撤销 `SemanticNode`，统一到 `UnifiedNode`
- `detectBusinessEntities` 从“找节点”升级为“识别结构并回写到树”
- `applyLCA` 优先消费结构化字段，再退化到邻近文本
- 在树上形成最小结构化语义（表单/表格/通用实体）

### 10.1 为什么撤销 `SemanticNode`

- 之前存在两棵平行树（`UnifiedNode` 与 `SemanticNode`），语义和结构会漂移。
- 实体识别与 LCA 结果如果只在中间树里，后续阶段很难保持一致。
- 用单一 `UnifiedNode` 承载结构 + 语义，数据流更稳定，也更容易调试。

### 10.2 为什么把结构语义直接写回 `UnifiedNode`

- `processRegion` 之后的模块（LCA/compress/relations/stable_id）都能直接消费同一批字段。
- viewer 和测试可以直接观察最终树，不依赖隐式中间对象。
- 降低跨阶段同步成本，减少“识别结果丢失”。

### 10.3 detectBusinessEntities 返工后支持结构

- 表单结构：`form` / `field_group` / `field` / `submit_area`
- 表格结构：`table` / `row` / `cell` / `header_cell`
- 通用结构：`dialog` / `list_item` / `card` / `section`

识别结果会反标注回树（节点字段 + `attrs`）：

- `entityId`
- `entityType`
- `parentEntityId`
- `fieldLabel`
- `tableRole`
- `formRole`

### 10.4 LCA 如何消费结构化字段

LCA 顺序：

1. 先读目标节点已有结构字段（`fieldLabel/formRole/tableRole/entityId`）
2. 再找最近实体（树上已有 `entityId/entityType`）
3. 在实体内优先查 `header_cell/row/section` 等结构提示
4. 最后退化到邻近文本扫描

结果继续直接回写：

- `fieldLabel`
- `actionIntent`
- `actionTargetId`
- `entityId`

## 11. 为什么 `getA11yTree/getDomTree` 下沉到 trace

`trace` 是 runner 的基础观测与原子能力层。`getA11yTree/getDomTree` 放在 `trace` 后：
- 复用范围更广，不只服务 snapshot。
- snapshot 保持“编排层”定位，减少底层采集耦合。
- 后续可在 trace 层统一处理缓存、观测、兼容性细节。

## 12. Layer/Region 类型系统收缩说明

实现层未引入额外 `Layer/SpatialLayers/Region` 类型系统。
- “空间层”通过 `NodeGraph.root.children` 顶层并列子树表达。
- “业务区域”直接使用普通节点子树表达。
- 保留概念与流程位置，但类型系统保持克制。

## 13. Compress 阶段（当前实现）

### 13.1 在 pipeline 中的位置

`compress` 固定在 `processRegion` 内，并且发生在 `applyLCA` 之后：

`detectBusinessEntities -> buildTree -> markStrongSemantics -> applyLCA -> rankTiers -> compress -> finalizeLabel`

这样可以保证：
- `compress` 能消费实体标记（`entityId/entityType/formRole/tableRole`）
- `compress` 能消费 LCA 结果（`fieldLabel/actionIntent/actionTargetId`）
- 不会在语义归因之前过早丢节点

### 13.2 删除规则（保守）

当前会直接删除：
- 标签为 `script/style/svg/path` 的节点
- 纯装饰噪声叶子（无文本、无交互、无目标，且角色/类名明显装饰）
- 明显空壳节点（无文本、无子节点、无交互、无关键语义）

保护条件优先：
- 交互节点、结构节点、实体节点、LCA 已标注节点、关键状态节点不会被删

### 13.3 折叠规则（壳层上提）

当前可折叠壳层主要是：
- 非交互、非强语义、无关键状态的 `div/span/p` 这类包装节点
- tier 为 `C` 且本身无关键语义的节点
- 叶子文本壳（仅在父节点可接收文本时折叠）

折叠行为：
- 保留其有效子节点
- 子节点上提到父节点
- 当前壳层移除

### 13.4 文本上浮为何放在 compress

当前不做“压缩前全树文本聚合”。

文本只在以下场景发生上浮：
- 子节点被删除
- 子节点被折叠

上浮规则是轻量且保守的：
- 仅短文本（轻文本）参与上浮
- URL/超长混合文本不会无脑拼接给父节点
- 优先给可接收文本的语义父节点（例如 button/link/field 等）

这样可以减少“先聚合再误传染”的问题，避免把大段噪声文本提前扩散到上层节点。

### 13.5 当前保守边界

当前 `compress` 仍保持保守，不做：
- 激进跨层重写
- 高风险的语义节点合并
- 复杂摘要重排（仅保留极简占位摘要）

目标是先稳定“删噪 + 去壳 + 按需上浮文本”，再逐步扩展更复杂策略。

## 14. finalizeLabel 阶段（压缩后最终语义收口）

### 14.1 为什么 compress 后还需要 finalizeLabel

`compress` 会触发节点删除、壳层折叠、文本上浮，导致：
- 旧标注仍挂在已不合适的节点上
- 强语义节点（button/link/field 等）的最终文本承载发生变化
- `parentEntityId/actionTargetId` 可能指向压缩后不再存在的实体

所以需要在压缩后的最终树上做一次轻量收口，保证语义挂载点与引用一致。

### 14.2 为什么 finalizeLabel 不是第二轮完整 detect/LCA

`finalizeLabel` 的目标是“轻量修正”，不是重算：
- 不重跑 `detectBusinessEntities`
- 不重跑 `applyLCA`
- 不做全树新识别，不引入新树或复杂上下文类型

它只消费压缩后的现有字段与局部邻近信息，做低成本迁移和纠偏。

### 14.3 职责边界

`finalizeLabel` 只做：
- 语义承载节点文本归一化（button/link/input/textarea/select/row/card/dialog/field 等）
- 轻量语义迁移（被压缩影响的挂载点迁到最近保留节点）
- 局部重判（action 文本与意图、fieldLabel 缺失补全、容器标题收口）
- 引用修复（`parentEntityId/actionTargetId` 指向当前树中仍存在节点）

`finalizeLabel` 不做：
- locator 生成
- 新的大规模启发式识别
- 第二轮完整语义引擎

### 14.4 当前主要修正字段

- `fieldLabel`
- `entityId`
- `entityType`
- `parentEntityId`
- `actionIntent`
- `actionTargetId`

### 14.5 为什么放在 compress 后、linkGlobalRelations 前

- 放在 `compress` 后：才能看到最终承载结构，避免在压缩前迁移到即将被折叠/删除的节点。
- 放在 `linkGlobalRelations` 前：先把局部语义与引用收口，再做跨层关系链接，降低关系链接的悬空引用风险。
