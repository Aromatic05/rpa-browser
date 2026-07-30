import type { TableComponent, TableSnapshot } from '../../components/table/model/contracts';
import type { ObservationNodeId } from '../../observation/model/contracts';
import type {
    EntityRuleQueryBinding,
    EntityRuleQueryKeyHint,
    EntityRuleQueryPlan,
    QueryPlanDiagnostic,
} from './contracts';
import {
    cardinality,
    cardinalityDiagnostic,
    descendants,
    isActiveNode,
    matchCommonNodeAttributes,
    normalize,
    normalizeLower,
    nodeContainsAll,
    orderedNodeIds,
    structureDiagnostic,
    unique,
} from './shared';

export const executeTableQueryPlan = (
    plan: EntityRuleQueryPlan,
    snapshot: TableSnapshot,
): { byRuleId: Record<string, EntityRuleQueryBinding>; diagnostics: QueryPlanDiagnostic[] } => {
    const byRuleId: Record<string, EntityRuleQueryBinding> = {};
    const diagnostics: QueryPlanDiagnostic[] = [];
    const paginationNodeIds = buildResolvedPaginationNodeSet(snapshot);
    for (const step of plan.steps) {
        const within = step.withinRuleId ? byRuleId[step.withinRuleId] : undefined;
        const allowedNodeIds = step.withinRuleId ? buildWithinNodeSet(snapshot, within) : undefined;
        const contained = step.containsRuleId ? byRuleId[step.containsRuleId] : undefined;
        const containedNodeIds = step.containsRuleId && contained?.ok ? contained.matchedNodeIds : [];
        const matchedComponentIds: string[] = [];
        const matchedNodeIds: ObservationNodeId[] = [];
        const structuralDiagnostics: QueryPlanDiagnostic[] = [];
        if (step.source === 'node') {
            for (const nodeId of orderedNodeIds(snapshot.observation)) {
                if (!isActiveNode(snapshot.observation, nodeId)) {continue;}
                if (allowedNodeIds && !allowedNodeIds.has(nodeId)) {continue;}
                if (step.containsRuleId && !nodeContainsAll(snapshot.observation, nodeId, containedNodeIds)) {continue;}
                if (matchesNode(snapshot, nodeId, step, paginationNodeIds)) {matchedNodeIds.push(nodeId);}
            }
        } else {
            for (const table of orderedTables(snapshot)) {
                const rootNodeId = table.location.structuralRootNodeId;
                if (!isActiveNode(snapshot.observation, rootNodeId)) {continue;}
                if (allowedNodeIds && !allowedNodeIds.has(rootNodeId)) {continue;}
                if (step.containsRuleId && !nodeContainsAll(snapshot.observation, rootNodeId, containedNodeIds)) {continue;}
                if (!matchesTable(snapshot, table, step)) {continue;}
                matchedComponentIds.push(table.id);
                matchedNodeIds.push(rootNodeId);
                if (table.status !== 'complete') {
                    structuralDiagnostics.push(structureDiagnostic(
                        plan.profileName,
                        step,
                        'table-component',
                        table.status,
                        [rootNodeId],
                        table.evidence,
                    ));
                }
            }
        }
        const matchedRowIds = step.source === 'node'
            ? rowsForNodes(snapshot, matchedNodeIds)
            : unique(matchedComponentIds.flatMap((componentId) =>
                snapshot.tables.tables[componentId].body.visibleRows.map((row) => row.id)));
        const matchedColumnIds = step.source === 'node'
            ? columnsForNodes(snapshot, matchedNodeIds)
            : unique(matchedComponentIds.flatMap((componentId) =>
                snapshot.tables.tables[componentId].columns.map((column) => column.id)));
        const count = step.source === 'node' ? matchedNodeIds.length : matchedComponentIds.length;
        const binding: EntityRuleQueryBinding = {
            planStepId: step.planStepId,
            ruleId: step.ruleId,
            domain: 'table',
            source: step.source,
            expect: step.expect,
            targetKind: step.source === 'node' ? 'node' : 'table-component',
            matchedComponentIds,
            matchedNodeIds: unique(matchedNodeIds),
            matchedFieldIds: [],
            matchedActionIds: [],
            matchedRowIds,
            matchedColumnIds,
            cardinality: cardinality(step.expect, count),
            ok: false,
        };
        binding.ok = binding.cardinality.status === 'satisfied' && structuralDiagnostics.length === 0;
        byRuleId[step.ruleId] = binding;
        diagnostics.push(...structuralDiagnostics);
        const cardinalityFailure = cardinalityDiagnostic(plan.profileName, step, binding);
        if (cardinalityFailure) {diagnostics.push(cardinalityFailure);}
    }
    return { byRuleId, diagnostics };
};

const matchesTable = (
    snapshot: TableSnapshot,
    table: TableComponent,
    step: EntityRuleQueryPlan['steps'][number],
): boolean => {
    if (step.match.kind && step.match.kind !== 'table') {return false;}
    const rootNodeId = table.location.structuralRootNodeId;
    const attributes = snapshot.observation.attributes[rootNodeId] ?? {};
    if (!matchCommonNodeAttributes(snapshot.observation, rootNodeId, step, false)) {return false;}
    if (step.match.idEquals && normalize(attributes.id) !== normalize(step.match.idEquals)) {return false;}
    if (step.match.nameContains
        && !normalizeLower(tableName(snapshot, table)).includes(normalizeLower(step.match.nameContains))) {
        return false;
    }
    if (step.match.relation === 'pagination' && table.pagination?.status !== 'resolved') {return false;}
    if (step.match.keyHint && !matchesKeyHint(table, step.match.keyHint)) {return false;}
    return true;
};

const matchesNode = (
    snapshot: TableSnapshot,
    nodeId: ObservationNodeId,
    step: EntityRuleQueryPlan['steps'][number],
    paginationNodeIds: ReadonlySet<ObservationNodeId>,
): boolean => {
    if (step.match.kind || step.match.keyHint) {return false;}
    if (step.match.relation === 'pagination' && !paginationNodeIds.has(nodeId)) {return false;}
    return matchCommonNodeAttributes(snapshot.observation, nodeId, step, true);
};

const matchesKeyHint = (table: TableComponent, keyHint: EntityRuleQueryKeyHint): boolean => {
    const headerText = normalizeLower(table.columns.map((column) => column.name).join(' '));
    const headerNeedles = (keyHint.headerContainsAll ?? []).map(normalizeLower).filter(Boolean);
    if (!headerNeedles.every((needle) => headerText.includes(needle))) {return false;}
    const candidates = table.suggestions
        .filter((suggestion) => suggestion.kind === 'primary-key-candidate')
        .flatMap((suggestion) => table.columns
            .filter((column) => column.id === suggestion.value)
            .flatMap((column) => [column.id, column.name]));
    const candidateText = normalizeLower(candidates.join(' '));
    return (keyHint.primaryKeyCandidatesContains ?? [])
        .map(normalizeLower)
        .filter(Boolean)
        .every((needle) => candidateText.includes(needle));
};

const buildResolvedPaginationNodeSet = (snapshot: TableSnapshot): ReadonlySet<ObservationNodeId> => {
    const output = new Set<ObservationNodeId>();
    for (const table of Object.values(snapshot.tables.tables)) {
        if (table.pagination?.status !== 'resolved') {continue;}
        for (const nodeId of table.pagination.nodeIds) {
            output.add(nodeId);
            descendants(snapshot.observation, nodeId).forEach((descendantId) => output.add(descendantId));
        }
    }
    return output;
};

const buildWithinNodeSet = (
    snapshot: TableSnapshot,
    binding: EntityRuleQueryBinding | undefined,
): Set<ObservationNodeId> => {
    if (!binding?.ok) {return new Set();}
    const output = new Set<ObservationNodeId>();
    binding.matchedNodeIds.forEach((nodeId) => {
        output.add(nodeId);
        descendants(snapshot.observation, nodeId).forEach((descendantId) => output.add(descendantId));
    });
    binding.matchedComponentIds.forEach((componentId) => {
        const table = snapshot.tables.tables[componentId];
        output.add(table.location.structuralRootNodeId);
        descendants(snapshot.observation, table.location.structuralRootNodeId)
            .forEach((nodeId) => output.add(nodeId));
        table.body.visibleRows.forEach((row) => output.add(row.nodeId));
        if (table.pagination?.status === 'resolved') {
            table.pagination.nodeIds.forEach((nodeId) => {
                output.add(nodeId);
                descendants(snapshot.observation, nodeId).forEach((descendantId) => output.add(descendantId));
            });
        }
    });
    return output;
};

const rowsForNodes = (snapshot: TableSnapshot, nodeIds: readonly ObservationNodeId[]): string[] => {
    const nodeSet = new Set(nodeIds);
    return Object.values(snapshot.tables.rows)
        .filter((row) => nodeSet.has(row.nodeId)
            || row.cellIds.some((cellId) => nodeSet.has(snapshot.tables.cells[cellId].nodeId)))
        .map((row) => row.id);
};

const columnsForNodes = (snapshot: TableSnapshot, nodeIds: readonly ObservationNodeId[]): string[] => {
    const nodeSet = new Set(nodeIds);
    return Object.values(snapshot.tables.columns)
        .filter((column) => column.sourceNodeIds.some((nodeId) => nodeSet.has(nodeId)))
        .map((column) => column.id);
};

const tableName = (snapshot: TableSnapshot, table: TableComponent): string => {
    const rootNodeId = table.location.structuralRootNodeId;
    const attributes = snapshot.observation.attributes[rootNodeId] ?? {};
    return [
        attributes['aria-label'],
        attributes.name,
        attributes.id,
        table.columns.map((column) => column.name).join(' '),
    ].filter(Boolean).join(' ');
};

const orderedTables = (snapshot: TableSnapshot): TableComponent[] => Object.values(snapshot.tables.tables)
    .sort((left, right) => (snapshot.observation.documentOrder[left.location.structuralRootNodeId] ?? Number.MAX_SAFE_INTEGER)
        - (snapshot.observation.documentOrder[right.location.structuralRootNodeId] ?? Number.MAX_SAFE_INTEGER));
