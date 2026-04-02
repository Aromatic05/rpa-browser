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
    return compress(tree);
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
- `types.ts`：最小必要类型（`RawData/UnifiedNode/NodeGraph/SemanticNode/SnapshotResult/NodeTier`）。
- `collect.ts`：采集原始数据，调用 trace 基础能力。
- `fusion.ts`：DOM 与 A11y 融合骨架。
- `spatial.ts`：顶层子树空间重排与噪声层占位判定。
- `regions.ts`：区域检测骨架（返回普通节点数组）。
- `process_region.ts`：区域处理主链（实体识别/树构建/语义标记/LCA/tier/压缩）。
- `lca.ts`：弱语义节点最近业务实体归因骨架。
- `compress.ts`：按 tier 删除/折叠/摘要骨架。
- `relations.ts`：跨层跨区域关系链接骨架。
- `stable_id.ts`：稳定 ID 生成骨架。
- `build_snapshot.ts`：输出结构构建骨架。

## 6. 当前占位、后续待实现

以下内容目前均为轻量占位：
- 真实 DOM+A11y 融合策略。
- 空间重排与噪声层判定规则。
- 业务区域检测规则。
- LCA 归因、上下文扫描、tier 分级细则。
- 复杂压缩与摘要策略。
- 全局关系链接规则。

## 7. 为什么 `getA11yTree/getDomTree` 下沉到 trace

`trace` 是 runner 的基础观测与原子能力层。`getA11yTree/getDomTree` 放在 `trace` 后：
- 复用范围更广，不只服务 snapshot。
- snapshot 保持“编排层”定位，减少底层采集耦合。
- 后续可在 trace 层统一处理缓存、观测、兼容性细节。

## 8. Layer/Region 类型系统收缩说明

实现层未引入额外 `Layer/SpatialLayers/Region` 类型系统。
- “空间层”通过 `NodeGraph.root.children` 顶层并列子树表达。
- “业务区域”直接使用普通节点子树表达。
- 保留概念与流程位置，但类型系统保持克制。
