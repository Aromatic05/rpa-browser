import type {
    SnapshotProjection,
    SnapshotProjectionDiffResult,
    SnapshotProjectionNode,
} from './contracts';

export const diffSnapshotProjection = (
    current: SnapshotProjection,
    baseline: SnapshotProjection,
): SnapshotProjectionDiffResult => {
    if (current.meta.pageEpoch !== baseline.meta.pageEpoch) {
        return fullFallback(current, 'navigation');
    }
    const currentIndex = indexNodes(current.roots);
    const baselineIndex = indexNodes(baseline.roots);
    if (currentIndex.ambiguous || baselineIndex.ambiguous) {
        return fullFallback(current, 'correlation_ambiguous');
    }

    const changedKeys = new Set<string>();
    const removedNodeKeys: string[] = [];
    for (const [key, record] of currentIndex.byKey) {
        const previous = baselineIndex.byKey.get(key);
        if (!previous || nodeFingerprint(record.node) !== nodeFingerprint(previous.node)) {changedKeys.add(key);}
    }
    for (const key of baselineIndex.byKey.keys()) {
        if (!currentIndex.byKey.has(key)) {removedNodeKeys.push(key);}
    }

    const changedComponentIds = changedComponents(current, baseline);
    const changedNodeIds = new Set<string>();
    for (const key of changedKeys) {
        const nodeId = currentIndex.byKey.get(key)?.node.nodeId;
        if (nodeId) {changedNodeIds.add(nodeId);}
    }
    for (const componentId of changedComponentIds) {
        const rootNodeId = componentRootNodeId(current, componentId);
        if (rootNodeId) {changedNodeIds.add(rootNodeId);}
    }
    const retainedNodeIds = withAncestors(currentIndex, changedNodeIds);
    const roots = pruneRoots(current.roots, retainedNodeIds);
    const forms = current.components.forms.filter((form) => changedComponentIds.includes(form.id));
    const tables = current.components.tables.filter((table) => changedComponentIds.includes(table.id));
    const projection = structuredClone(current);
    projection.meta.mode = 'diff';
    projection.meta.baseSnapshotId = baseline.meta.snapshotId;
    projection.meta.diffSkipped = undefined;
    projection.meta.changedNodeCount = changedKeys.size + removedNodeKeys.length;
    projection.meta.changedComponentIds = changedComponentIds;
    projection.meta.removedNodeKeys = removedNodeKeys.sort();
    projection.meta.includedNodeCount = countNodes(roots);
    projection.roots = roots;
    projection.components = {forms, tables};
    projection.collections = projection.collections.map((collection) => ({
        ...collection,
        included: collection.kind === 'nodes'
            ? projection.meta.includedNodeCount
            : tables.find((table) => table.id === collection.collectionId)?.rows.length ?? 0,
        omitted: collection.kind === 'nodes'
            ? Math.max(0, collection.total - projection.meta.includedNodeCount)
            : Math.max(0, collection.total
                - (tables.find((table) => table.id === collection.collectionId)?.rows.length ?? 0)),
        policy: 'diff',
    }));
    return {mode: 'diff', projection};
};

export const fullSnapshotProjectionWithoutBaseline = (
    current: SnapshotProjection,
): SnapshotProjectionDiffResult => fullFallback(current, 'no_baseline');

const fullFallback = (
    current: SnapshotProjection,
    reason: NonNullable<SnapshotProjection['meta']['diffSkipped']>,
): SnapshotProjectionDiffResult => {
    const projection = structuredClone(current);
    projection.meta.mode = 'full';
    projection.meta.baseSnapshotId = undefined;
    projection.meta.diffSkipped = reason;
    projection.meta.changedNodeCount = 0;
    projection.meta.changedComponentIds = [];
    projection.meta.removedNodeKeys = [];
    return {mode: 'full', projection};
};

type IndexedNode = {
    node: SnapshotProjectionNode;
    parentNodeId?: string;
};

type NodeIndex = {
    byKey: Map<string, IndexedNode>;
    byNodeId: Map<string, IndexedNode>;
    ambiguous: boolean;
};

const indexNodes = (roots: readonly SnapshotProjectionNode[]): NodeIndex => {
    const byKey = new Map<string, IndexedNode>();
    const byNodeId = new Map<string, IndexedNode>();
    let ambiguous = false;
    const visit = (node: SnapshotProjectionNode, parentNodeId?: string) => {
        const record = {node, parentNodeId};
        const key = correlationKey(node);
        if (byKey.has(key)) {ambiguous = true;} else {byKey.set(key, record);}
        byNodeId.set(node.nodeId, record);
        node.children.forEach((child) => {visit(child, node.nodeId);});
    };
    roots.forEach((root) => {visit(root);});
    return {byKey, byNodeId, ambiguous};
};

const correlationKey = (node: SnapshotProjectionNode): string => {
    if (node.identity.backendNodeId) {return `backend:${node.identity.backendNodeId}`;}
    if (node.identity.runtimeIdentityToken) {return `runtime:${node.identity.runtimeIdentityToken}`;}
    return `node:${node.nodeId}`;
};

const nodeFingerprint = (node: SnapshotProjectionNode): string => JSON.stringify({
    scopeId: node.scopeId,
    tag: node.tag,
    role: node.role,
    name: node.name,
    text: node.text,
    attributes: node.attributes,
    runtimeState: node.runtimeState,
    activity: node.activity,
    controlIds: node.controlIds,
    componentIds: node.componentIds,
});

const changedComponents = (current: SnapshotProjection, baseline: SnapshotProjection): string[] => {
    const currentComponents = new Map<string, unknown>([
        ...current.components.forms.map((form) => [form.id, form] as const),
        ...current.components.tables.map((table) => [table.id, table] as const),
    ]);
    const baselineComponents = new Map<string, unknown>([
        ...baseline.components.forms.map((form) => [form.id, form] as const),
        ...baseline.components.tables.map((table) => [table.id, table] as const),
    ]);
    const changed = new Set<string>();
    for (const [id, component] of currentComponents) {
        const previous = baselineComponents.get(id);
        if (!previous || JSON.stringify(component) !== JSON.stringify(previous)) {changed.add(id);}
    }
    for (const id of baselineComponents.keys()) {
        if (!currentComponents.has(id)) {changed.add(id);}
    }
    return [...changed].sort();
};

const componentRootNodeId = (projection: SnapshotProjection, componentId: string): string | undefined =>
    projection.components.forms.find((form) => form.id === componentId)?.rootNodeId
    ?? projection.components.tables.find((table) => table.id === componentId)?.rootNodeId;

const withAncestors = (index: NodeIndex, nodeIds: ReadonlySet<string>): Set<string> => {
    const result = new Set<string>();
    for (const nodeId of nodeIds) {
        let current: string | undefined = nodeId;
        const visited = new Set<string>();
        while (current && !visited.has(current)) {
            visited.add(current);
            result.add(current);
            current = index.byNodeId.get(current)?.parentNodeId;
        }
    }
    return result;
};

const pruneRoots = (
    roots: readonly SnapshotProjectionNode[],
    retainedNodeIds: ReadonlySet<string>,
): SnapshotProjectionNode[] => roots
    .filter((root) => retainedNodeIds.has(root.nodeId))
    .map((root) => pruneNode(root, retainedNodeIds));

const pruneNode = (
    node: SnapshotProjectionNode,
    retainedNodeIds: ReadonlySet<string>,
): SnapshotProjectionNode => ({
    ...structuredClone(node),
    children: node.children
        .filter((child) => retainedNodeIds.has(child.nodeId))
        .map((child) => pruneNode(child, retainedNodeIds)),
});

const countNodes = (roots: readonly SnapshotProjectionNode[]): number => {
    let count = 0;
    const visit = (node: SnapshotProjectionNode) => {
        count += 1;
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return count;
};
