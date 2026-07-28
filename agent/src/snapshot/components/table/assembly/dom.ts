import type { Evidence, ObservationNodeId, PageObservation } from '../../../observation/model/contracts';
import { resolveSemanticRole } from '../../../observation/model/semantic';
import type { LogicalTableRoot, TablePartKind, TableParts } from '../model/contracts';

const ATOMIC_TABLE_ROLES = new Set(['row', 'cell', 'gridcell', 'columnheader', 'rowheader']);

export const findLogicalTableRoots = (observation: PageObservation): LogicalTableRoot[] => {
    const frameworkRoots = orderedNodeIds(observation)
        .filter((nodeId) => isElementRoot(observation, nodeId) || isAntRoot(observation, nodeId));
    const frameworkRootSet = new Set(frameworkRoots);
    const roots: LogicalTableRoot[] = frameworkRoots.map((rootNodeId) => {
        const framework = isElementRoot(observation, rootNodeId) ? 'element' as const : 'ant' as const;
        return {
            rootNodeId,
            hostNodeId: findFrameworkHost(observation, rootNodeId),
            framework,
            evidence: [evidence(`table.root.${framework}`, 'strong', 'adapter', [rootNodeId])],
        };
    });

    for (const nodeId of orderedNodeIds(observation)) {
        if (frameworkRootSet.has(nodeId) || isInsideFrameworkRoot(observation, nodeId, frameworkRootSet)) {continue;}
        const node = observation.nodes[nodeId];
        if (!node) {continue;}
        const role = lower(resolveSemanticRole(observation, nodeId).value);
        if (ATOMIC_TABLE_ROLES.has(role)) {continue;}
        if (node.tag === 'table') {
            roots.push({
                rootNodeId: nodeId,
                framework: 'native',
                evidence: [evidence('table.root.native', 'exact', 'dom', [nodeId])],
            });
            continue;
        }
        if ((role === 'table' || role === 'grid' || role === 'treegrid')
            && hasDirectOwnedRow(observation, nodeId, frameworkRootSet)) {
            roots.push({
                rootNodeId: nodeId,
                framework: 'aria',
                evidence: [evidence('table.root.aria', 'exact', 'a11y', [nodeId], { role })],
            });
        }
    }
    return roots.sort((left, right) => compareNodeOrder(observation, left.rootNodeId, right.rootNodeId));
};

export const buildTableParts = (
    observation: PageObservation,
    root: LogicalTableRoot,
): TableParts => {
    const physicalTableNodeIds = root.framework === 'native'
        ? [root.rootNodeId]
        : descendants(observation, root.rootNodeId).filter((nodeId) => observation.nodes[nodeId]?.tag === 'table');
    const nodeIdsByKind: Partial<Record<TablePartKind, ObservationNodeId[]>> = {};
    for (const tableNodeId of physicalTableNodeIds) {
        const kind = classifyPhysicalTable(observation, root, tableNodeId);
        (nodeIdsByKind[kind] ??= []).push(tableNodeId);
    }
    return { physicalTableNodeIds, nodeIdsByKind };
};

export const canonicalHeaderPartIds = (root: LogicalTableRoot, parts: TableParts): ObservationNodeId[] => {
    if (root.framework === 'native' || root.framework === 'aria') {return [root.rootNodeId];}
    const header = [...(parts.nodeIdsByKind.header ?? [])];
    return header.length > 0 ? header : [root.rootNodeId];
};

export const canonicalBodyPartIds = (root: LogicalTableRoot, parts: TableParts): ObservationNodeId[] => {
    if (root.framework === 'native' || root.framework === 'aria') {return [root.rootNodeId];}
    const body = [...(parts.nodeIdsByKind.body ?? [])];
    return body.length > 0 ? body : [root.rootNodeId];
};

export const fixedHeaderPartIds = (parts: TableParts): ObservationNodeId[] => [
    ...(parts.nodeIdsByKind['fixed-left-header'] ?? []),
    ...(parts.nodeIdsByKind['fixed-right-header'] ?? []),
];

export const fixedBodyPartIds = (parts: TableParts): ObservationNodeId[] => [
    ...(parts.nodeIdsByKind['fixed-left-body'] ?? []),
    ...(parts.nodeIdsByKind['fixed-right-body'] ?? []),
];

export const directOwnedRows = (
    observation: PageObservation,
    ownerRootId: ObservationNodeId,
    partNodeId: ObservationNodeId,
    allRootIds: ReadonlySet<ObservationNodeId>,
): ObservationNodeId[] => descendantsOrSelf(observation, partNodeId)
    .filter((nodeId) => isRowNode(observation, nodeId))
    .filter((nodeId) => nearestLogicalRoot(observation, nodeId, allRootIds) === ownerRootId)
    .filter((nodeId) => !isHeaderRow(observation, nodeId) && !isFooterRow(observation, nodeId))
    .sort((left, right) => compareNodeOrder(observation, left, right));

export const headerRows = (
    observation: PageObservation,
    ownerRootId: ObservationNodeId,
    partNodeIds: readonly ObservationNodeId[],
    allRootIds: ReadonlySet<ObservationNodeId>,
): ObservationNodeId[] => unique(partNodeIds.flatMap((partNodeId) => descendantsOrSelf(observation, partNodeId)
    .filter((nodeId) => isRowNode(observation, nodeId))
    .filter((nodeId) => nearestLogicalRoot(observation, nodeId, allRootIds) === ownerRootId)
    .filter((nodeId) => isHeaderRow(observation, nodeId))))
    .sort((left, right) => compareNodeOrder(observation, left, right));

export const rowCellNodeIds = (
    observation: PageObservation,
    rowNodeId: ObservationNodeId,
    allRootIds: ReadonlySet<ObservationNodeId>,
    ownerRootId: ObservationNodeId,
): ObservationNodeId[] => (observation.children[rowNodeId] ?? [])
    .filter((nodeId) => isCellNode(observation, nodeId))
    .filter((nodeId) => nearestLogicalRoot(observation, nodeId, allRootIds) === ownerRootId);

export const footerRows = (
    observation: PageObservation,
    ownerRootId: ObservationNodeId,
    parts: TableParts,
    allRootIds: ReadonlySet<ObservationNodeId>,
): ObservationNodeId[] => unique([
    ...(parts.nodeIdsByKind.footer ?? []).flatMap((partId) => descendantsOrSelf(observation, partId)
        .filter((nodeId) => isRowNode(observation, nodeId))),
    ...descendantsOrSelf(observation, ownerRootId)
        .filter((nodeId) => isRowNode(observation, nodeId))
        .filter((nodeId) => isFooterRow(observation, nodeId)),
]).filter((nodeId) => nearestLogicalRoot(observation, nodeId, allRootIds) === ownerRootId)
    .sort((left, right) => compareNodeOrder(observation, left, right));

export const findPaginationNodes = (
    observation: PageObservation,
    root: LogicalTableRoot,
    logicalRoots: readonly LogicalTableRoot[],
): { nodeIds: ObservationNodeId[]; ambiguous: boolean } => {
    const scopeNodeId = root.hostNodeId ?? observation.parents[root.rootNodeId] ?? root.rootNodeId;
    const candidates = descendantsOrSelf(observation, scopeNodeId).filter((nodeId) => isPaginationNode(observation, nodeId));
    if (candidates.length === 0) {return { nodeIds: [], ambiguous: false };}
    const competingRoots = logicalRoots.filter((candidate) => candidate.rootNodeId !== root.rootNodeId
        && isDescendantOrSelf(observation, candidate.rootNodeId, scopeNodeId));
    return { nodeIds: candidates, ambiguous: competingRoots.length > 0 };
};

export const descendants = (observation: PageObservation, rootNodeId: ObservationNodeId): ObservationNodeId[] => {
    const output: ObservationNodeId[] = [];
    const stack = [...(observation.children[rootNodeId] ?? [])].reverse();
    while (stack.length > 0) {
        const nodeId = stack.pop()!;
        output.push(nodeId);
        stack.push(...[...(observation.children[nodeId] ?? [])].reverse());
    }
    return output;
};

export const descendantsOrSelf = (observation: PageObservation, rootNodeId: ObservationNodeId): ObservationNodeId[] =>
    [rootNodeId, ...descendants(observation, rootNodeId)];

export const nearestLogicalRoot = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    allRootIds: ReadonlySet<ObservationNodeId>,
): ObservationNodeId | undefined => {
    let current: ObservationNodeId | undefined = nodeId;
    while (current) {
        if (allRootIds.has(current)) {return current;}
        current = observation.parents[current];
    }
    return undefined;
};

export const isDescendantOrSelf = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    ancestorId: ObservationNodeId,
): boolean => {
    let current: ObservationNodeId | undefined = nodeId;
    while (current) {
        if (current === ancestorId) {return true;}
        current = observation.parents[current];
    }
    return false;
};

export const compareNodeOrder = (
    observation: PageObservation,
    left: ObservationNodeId,
    right: ObservationNodeId,
): number => (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
    - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER);

export const classTokens = (observation: PageObservation, nodeId: ObservationNodeId): string[] =>
    (observation.attributes[nodeId]?.class ?? '').split(/\s+/).filter(Boolean);

export const nodeText = (observation: PageObservation, nodeId: ObservationNodeId): string => unique(
    descendantsOrSelf(observation, nodeId)
        .map((candidateId) => observation.text[candidateId]?.replace(/\s+/g, ' ').trim())
        .filter((value): value is string => Boolean(value)),
).join(' ');

export const evidence = (
    code: string,
    strength: Evidence['strength'],
    source: Evidence['source'],
    nodeIds: ObservationNodeId[],
    detail?: Record<string, unknown>,
): Evidence => ({ code, strength, source, nodeIds, detail });

const classifyPhysicalTable = (
    observation: PageObservation,
    root: LogicalTableRoot,
    tableNodeId: ObservationNodeId,
): TablePartKind => {
    if (root.framework === 'native') {return 'body';}
    const ancestorTokens = ancestorIds(observation, tableNodeId, root.rootNodeId)
        .flatMap((nodeId) => classTokens(observation, nodeId));
    const isHeader = ancestorTokens.some(isHeaderPartToken);
    const isBody = ancestorTokens.some(isBodyPartToken);
    if (ancestorTokens.some(isFooterPartToken)) {return 'footer';}
    if (ancestorTokens.some(isFixedRightPartToken)) {return isHeader ? 'fixed-right-header' : 'fixed-right-body';}
    if (ancestorTokens.some(isFixedLeftPartToken)) {return isHeader ? 'fixed-left-header' : 'fixed-left-body';}
    if (isHeader) {return 'header';}
    if (isBody) {return 'body';}
    return 'unknown';
};

const findFrameworkHost = (observation: PageObservation, rootNodeId: ObservationNodeId): ObservationNodeId | undefined => {
    let current = observation.parents[rootNodeId];
    while (current) {
        const role = lower(resolveSemanticRole(observation, current).value);
        if (role === 'table' || classTokens(observation, current).some((token) => /card|panel/.test(token))) {
            return current;
        }
        current = observation.parents[current];
    }
    return undefined;
};

const hasDirectOwnedRow = (
    observation: PageObservation,
    rootNodeId: ObservationNodeId,
    frameworkRoots: ReadonlySet<ObservationNodeId>,
): boolean => descendants(observation, rootNodeId).some((nodeId) =>
    isRowNode(observation, nodeId)
    && !isInsideFrameworkRoot(observation, nodeId, frameworkRoots));

const isInsideFrameworkRoot = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    frameworkRoots: ReadonlySet<ObservationNodeId>,
): boolean => {
    let current = observation.parents[nodeId];
    while (current) {
        if (frameworkRoots.has(current)) {return true;}
        current = observation.parents[current];
    }
    return false;
};

const isElementRoot = (observation: PageObservation, nodeId: ObservationNodeId): boolean =>
    classTokens(observation, nodeId).includes('el-table');

const isAntRoot = (observation: PageObservation, nodeId: ObservationNodeId): boolean =>
    classTokens(observation, nodeId).includes('ant-table-wrapper');

const isRowNode = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const role = explicitRole(observation, nodeId);
    return observation.nodes[nodeId]?.tag === 'tr' || role === 'row';
};

const isCellNode = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const role = explicitRole(observation, nodeId);
    const tag = observation.nodes[nodeId]?.tag;
    return tag === 'td' || tag === 'th' || role === 'cell' || role === 'gridcell'
        || role === 'columnheader' || role === 'rowheader';
};

const isHeaderRow = (observation: PageObservation, rowNodeId: ObservationNodeId): boolean => {
    let current: ObservationNodeId | undefined = rowNodeId;
    while (current) {
        if (observation.nodes[current]?.tag === 'thead') {return true;}
        current = observation.parents[current];
    }
    return (observation.children[rowNodeId] ?? []).some((nodeId) => {
        const role = explicitRole(observation, nodeId);
        return observation.nodes[nodeId]?.tag === 'th' || role === 'columnheader';
    });
};

const isFooterRow = (observation: PageObservation, rowNodeId: ObservationNodeId): boolean => {
    let current: ObservationNodeId | undefined = rowNodeId;
    while (current) {
        const tag = observation.nodes[current]?.tag;
        if (tag === 'tfoot') {return true;}
        if (classTokens(observation, current).some(isFooterPartToken)) {return true;}
        current = observation.parents[current];
    }
    return false;
};

const isHeaderPartToken = (token: string): boolean => [
    'el-table__header',
    'el-table__header-wrapper',
    'el-table__fixed-header-wrapper',
    'el-table__fixed-right-header-wrapper',
    'ant-table-header',
    'ant-table-thead',
].includes(token);

const isBodyPartToken = (token: string): boolean => [
    'el-table__body',
    'el-table__body-wrapper',
    'el-table__fixed-body-wrapper',
    'el-table__fixed-right-body-wrapper',
    'ant-table-body',
    'ant-table-content',
    'ant-table-tbody',
].includes(token);

const isFooterPartToken = (token: string): boolean => [
    'el-table__footer',
    'el-table__footer-wrapper',
    'ant-table-summary',
    'ant-table-tfoot',
].includes(token);

const isFixedRightPartToken = (token: string): boolean => [
    'el-table__fixed-right',
    'el-table__fixed-right-patch',
    'ant-table-fixed-right',
].includes(token);

const isFixedLeftPartToken = (token: string): boolean => [
    'el-table__fixed',
    'ant-table-fixed-left',
].includes(token);

const isPaginationNode = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const tokens = classTokens(observation, nodeId);
    if (tokens.some((token) => token === 'el-pagination' || token === 'ant-pagination')) {return true;}
    const attrs = observation.attributes[nodeId] ?? {};
    const role = lower(resolveSemanticRole(observation, nodeId).value);
    return role === 'navigation' && /pag(e|ination)/i.test(`${attrs['aria-label'] ?? ''} ${nodeText(observation, nodeId)}`);
};

const explicitRole = (observation: PageObservation, nodeId: ObservationNodeId): string => lower(
    observation.attributes[nodeId]?.role
    ?? observation.accessibility[nodeId]?.role
    ?? observation.runtimeState[nodeId]?.role,
);

const ancestorIds = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    stopNodeId: ObservationNodeId,
): ObservationNodeId[] => {
    const output: ObservationNodeId[] = [];
    let current: ObservationNodeId | undefined = nodeId;
    while (current) {
        output.push(current);
        if (current === stopNodeId) {break;}
        current = observation.parents[current];
    }
    return output;
};

const orderedNodeIds = (observation: PageObservation): ObservationNodeId[] =>
    Object.keys(observation.nodes).sort((left, right) => compareNodeOrder(observation, left, right));

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const lower = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
