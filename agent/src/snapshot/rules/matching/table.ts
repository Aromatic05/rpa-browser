import type {
    AnalysisDiagnostic,
    ObservationNodeId,
    PageObservation,
} from '../../observation/model/contracts';
import { deepFreeze } from '../../observation/model/freeze';
import { resolveSemanticRole } from '../../observation/model/semantic';
import type { TableComponent, TableSnapshot } from '../../components/table/model/contracts';
import { cardinalitySatisfied } from './cardinality';
import type {
    TableComponentMatchRule,
    TableComponentRuleBinding,
    TableComponentRuleMatchResult,
} from '../model/contracts';

export const matchTableComponentRules = (
    snapshot: TableSnapshot,
    rules: readonly TableComponentMatchRule[],
): TableComponentRuleMatchResult => {
    const byRuleId: Record<string, TableComponentRuleBinding> = {};
    const diagnostics = validateRuleGraph(rules);
    if (diagnostics.length > 0) {
        rules.forEach((rule) => {byRuleId[rule.ruleId] ??= emptyBinding(rule);});
        return deepFreeze({ byRuleId, diagnostics });
    }

    const resolvedPaginationNodeIds = buildResolvedPaginationNodeSet(snapshot);
    for (const rule of orderRules(rules)) {
        const within = rule.within ? byRuleId[rule.within] : undefined;
        const allowedNodeIds = rule.within ? buildWithinNodeSet(snapshot, within) : undefined;
        const matchedComponentIds: string[] = [];
        const matchedNodeIds: ObservationNodeId[] = [];
        const structuralDiagnostics: AnalysisDiagnostic[] = [];

        if (rule.source === 'node') {
            for (const nodeId of orderedNodeIds(snapshot.observation)) {
                if (!isActiveNode(snapshot.observation, nodeId)) {continue;}
                if (allowedNodeIds && !allowedNodeIds.has(nodeId)) {continue;}
                if (matchesNode(snapshot, nodeId, rule, resolvedPaginationNodeIds)) {matchedNodeIds.push(nodeId);}
            }
        } else {
            for (const table of orderedTables(snapshot)) {
                const rootNodeId = table.location.structuralRootNodeId;
                if (!isActiveNode(snapshot.observation, rootNodeId)) {continue;}
                if (allowedNodeIds && !allowedNodeIds.has(rootNodeId)) {continue;}
                if (!matchesTable(snapshot, table, rule)) {continue;}
                matchedComponentIds.push(table.id);
                matchedNodeIds.push(rootNodeId);
                if (table.status !== 'complete') {
                    structuralDiagnostics.push(structureDiagnostic(rule, table));
                }
            }
        }

        const matchedRowIds = rule.source === 'node'
            ? rowsForNodes(snapshot, matchedNodeIds)
            : unique(matchedComponentIds.flatMap((componentId) =>
                snapshot.tables.tables[componentId]?.body.visibleRows.map((row) => row.id) ?? []));
        const matchedColumnIds = rule.source === 'node'
            ? columnsForNodes(snapshot, matchedNodeIds)
            : unique(matchedComponentIds.flatMap((componentId) =>
                snapshot.tables.tables[componentId]?.columns.map((column) => column.id) ?? []));
        const count = rule.source === 'node' ? matchedNodeIds.length : matchedComponentIds.length;
        const cardinalityOk = cardinalitySatisfied(rule.expect, count);
        const binding: TableComponentRuleBinding = {
            ruleId: rule.ruleId,
            source: rule.source,
            expect: rule.expect,
            matchedComponentIds,
            matchedRowIds,
            matchedColumnIds,
            matchedNodeIds: unique(matchedNodeIds),
            ok: cardinalityOk && structuralDiagnostics.length === 0,
        };
        byRuleId[rule.ruleId] = binding;
        diagnostics.push(...structuralDiagnostics);
        if (!cardinalityOk) {diagnostics.push(cardinalityDiagnostic(rule, binding));}
    }
    return deepFreeze({ byRuleId, diagnostics });
};

const matchesTable = (
    snapshot: TableSnapshot,
    table: TableComponent,
    rule: TableComponentMatchRule,
): boolean => {
    if (rule.match.kind && rule.match.kind !== 'table') {return false;}
    const rootNodeId = table.location.structuralRootNodeId;
    const attributes = snapshot.observation.attributes[rootNodeId] ?? {};
    if (!matchCommonNodeAttributes(snapshot.observation, rootNodeId, rule, false)) {return false;}
    if (rule.match.idEquals && normalize(attributes.id) !== normalize(rule.match.idEquals)) {return false;}
    if (rule.match.nameContains && !normalizeLower(tableName(snapshot, table)).includes(normalizeLower(rule.match.nameContains))) {
        return false;
    }
    if (rule.match.relation === 'pagination' && table.pagination?.status !== 'resolved') {return false;}
    if (rule.match.keyHint && !matchesKeyHint(table, rule.match.keyHint)) {return false;}
    return true;
};

const matchesNode = (
    snapshot: TableSnapshot,
    nodeId: ObservationNodeId,
    rule: TableComponentMatchRule,
    resolvedPaginationNodeIds: ReadonlySet<ObservationNodeId>,
): boolean => {
    if (rule.match.kind || rule.match.keyHint) {return false;}
    if (rule.match.relation === 'pagination' && !resolvedPaginationNodeIds.has(nodeId)) {return false;}
    return matchCommonNodeAttributes(snapshot.observation, nodeId, rule, true);
};

const matchCommonNodeAttributes = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    rule: TableComponentMatchRule,
    includeNameContains: boolean,
): boolean => {
    const attributes = observation.attributes[nodeId] ?? {};
    if (rule.match.idEquals && normalize(attributes.id) !== normalize(rule.match.idEquals)) {return false;}
    if (rule.match.nameEquals && normalize(attributes.name) !== normalize(rule.match.nameEquals)) {return false;}
    if (rule.match.roleEquals
        && normalizeLower(resolveSemanticRole(observation, nodeId).value) !== normalizeLower(rule.match.roleEquals)) {
        return false;
    }
    if (rule.match.classContains
        && !normalizeLower(attributes.class).includes(normalizeLower(rule.match.classContains))) {
        return false;
    }
    if (rule.match.textContains
        && !normalizeCompactLower(nodeSearchText(observation, nodeId, true)).includes(normalizeCompactLower(rule.match.textContains))) {
        return false;
    }
    if (rule.match.ariaContains) {
        const aria = normalizeLower([
            attributes['aria-label'],
            attributes['aria-labelledby'],
            attributes['aria-describedby'],
            attributes.title,
        ].filter(Boolean).join(' '));
        if (!aria.includes(normalizeLower(rule.match.ariaContains))) {return false;}
    }
    if (includeNameContains && rule.match.nameContains
        && !normalizeLower(nodeSearchText(observation, nodeId, false)).includes(normalizeLower(rule.match.nameContains))) {
        return false;
    }
    return true;
};

const matchesKeyHint = (
    table: TableComponent,
    keyHint: NonNullable<TableComponentMatchRule['match']['keyHint']>,
): boolean => {
    const headerText = normalizeLower(table.columns.map((column) => column.name).join(' '));
    const headerNeedles = (keyHint.headerContainsAll ?? []).map(normalizeLower).filter(Boolean);
    if (!headerNeedles.every((needle) => headerText.includes(needle))) {return false;}

    const candidateColumns = table.suggestions
        .filter((suggestion) => suggestion.kind === 'primary-key-candidate')
        .flatMap((suggestion) => table.columns
            .filter((column) => column.id === suggestion.value)
            .flatMap((column) => [column.id, column.name]));
    const candidateText = normalizeLower(candidateColumns.join(' '));
    const candidateNeedles = (keyHint.primaryKeyCandidatesContains ?? []).map(normalizeLower).filter(Boolean);
    return candidateNeedles.every((needle) => candidateText.includes(needle));
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

const buildWithinNodeSet = (
    snapshot: TableSnapshot,
    binding: TableComponentRuleBinding | undefined,
): Set<ObservationNodeId> => {
    if (!binding?.ok) {return new Set();}
    const output = new Set<ObservationNodeId>();
    binding.matchedNodeIds.forEach((nodeId) => {
        output.add(nodeId);
        descendants(snapshot.observation, nodeId).forEach((descendantId) => output.add(descendantId));
    });
    binding.matchedComponentIds.forEach((componentId) => {
        const table = snapshot.tables.tables[componentId];
        if (!table) {return;}
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
            || row.cellIds.some((cellId) => nodeSet.has(snapshot.tables.cells[cellId]?.nodeId)))
        .map((row) => row.id);
};

const columnsForNodes = (snapshot: TableSnapshot, nodeIds: readonly ObservationNodeId[]): string[] => {
    const nodeSet = new Set(nodeIds);
    return Object.values(snapshot.tables.columns)
        .filter((column) => column.sourceNodeIds.some((nodeId) => nodeSet.has(nodeId)))
        .map((column) => column.id);
};

const validateRuleGraph = (rules: readonly TableComponentMatchRule[]): AnalysisDiagnostic[] => {
    const diagnostics: AnalysisDiagnostic[] = [];
    const byId = new Map<string, TableComponentMatchRule>();
    for (const rule of rules) {
        if (byId.has(rule.ruleId)) {
            diagnostics.push(ruleDiagnostic('table.bridge.rule.duplicate', rule, `duplicate table bridge ruleId: ${rule.ruleId}`));
        } else {
            byId.set(rule.ruleId, rule);
        }
        if (!Object.values(rule.match).some((value) => typeof value === 'string' ? value.trim().length > 0 : Boolean(value))) {
            diagnostics.push(ruleDiagnostic('table.bridge.match.empty', rule, `table bridge rule has no match condition: ${rule.ruleId}`));
        }
    }
    for (const rule of rules) {
        if (rule.within && !byId.has(rule.within)) {
            diagnostics.push(ruleDiagnostic(
                'table.bridge.within.missing',
                rule,
                `table bridge within target does not exist: ${rule.ruleId} -> ${rule.within}`,
            ));
        }
    }
    const cycle = findWithinCycle(byId);
    if (cycle.length > 0) {
        const rule = byId.get(cycle[0]);
        if (rule) {
            diagnostics.push(ruleDiagnostic(
                'table.bridge.within.cycle',
                rule,
                `table bridge within cycle: ${cycle.join(' -> ')}`,
            ));
        }
    }
    return diagnostics;
};

const orderRules = (rules: readonly TableComponentMatchRule[]): TableComponentMatchRule[] => {
    const byId = new Map(rules.map((rule) => [rule.ruleId, rule]));
    const ordered: TableComponentMatchRule[] = [];
    const visited = new Set<string>();
    const visit = (rule: TableComponentMatchRule) => {
        if (visited.has(rule.ruleId)) {return;}
        if (rule.within) {
            const parent = byId.get(rule.within);
            if (parent) {visit(parent);}
        }
        visited.add(rule.ruleId);
        ordered.push(rule);
    };
    rules.forEach(visit);
    return ordered;
};

const findWithinCycle = (byId: ReadonlyMap<string, TableComponentMatchRule>): string[] => {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const path: string[] = [];
    const visit = (id: string): string[] => {
        if (visiting.has(id)) {
            const start = path.indexOf(id);
            return [...path.slice(Math.max(0, start)), id];
        }
        if (visited.has(id)) {return [];}
        visiting.add(id);
        path.push(id);
        const target = byId.get(id)?.within;
        const cycle = target && byId.has(target) ? visit(target) : [];
        path.pop();
        visiting.delete(id);
        visited.add(id);
        return cycle;
    };
    for (const id of byId.keys()) {
        const cycle = visit(id);
        if (cycle.length > 0) {return cycle;}
    }
    return [];
};

const orderedTables = (snapshot: TableSnapshot): TableComponent[] => Object.values(snapshot.tables.tables)
    .sort((left, right) => (snapshot.observation.documentOrder[left.location.structuralRootNodeId] ?? Number.MAX_SAFE_INTEGER)
        - (snapshot.observation.documentOrder[right.location.structuralRootNodeId] ?? Number.MAX_SAFE_INTEGER));

const orderedNodeIds = (observation: PageObservation): ObservationNodeId[] => Object.keys(observation.nodes)
    .sort((left, right) => (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
        - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER));

const descendants = (observation: PageObservation, rootNodeId: ObservationNodeId): ObservationNodeId[] => {
    const output: ObservationNodeId[] = [];
    const stack = [...(observation.children[rootNodeId] ?? [])].reverse();
    while (stack.length > 0) {
        const nodeId = stack.pop()!;
        output.push(nodeId);
        stack.push(...[...(observation.children[nodeId] ?? [])].reverse());
    }
    return output;
};

const nodeSearchText = (observation: PageObservation, nodeId: ObservationNodeId, includeDescendants: boolean): string => {
    const nodeIds = includeDescendants ? [nodeId, ...descendants(observation, nodeId)] : [nodeId];
    return nodeIds.map((id) => observation.text[id] ?? '').filter(Boolean).join(' ');
};

const isActiveNode = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const activity = observation.activity[nodeId];
    return Boolean(activity && activity.rendered && !activity.hiddenByStyle && !activity.inert
        && activity.subtreeActive && activity.ariaExposed !== false);
};

const emptyBinding = (rule: TableComponentMatchRule): TableComponentRuleBinding => ({
    ruleId: rule.ruleId,
    source: rule.source,
    expect: rule.expect,
    matchedComponentIds: [],
    matchedRowIds: [],
    matchedColumnIds: [],
    matchedNodeIds: [],
    ok: false,
});

const ruleDiagnostic = (
    code: string,
    rule: TableComponentMatchRule,
    message: string,
): AnalysisDiagnostic => ({
    code,
    severity: 'error',
    stage: 'table-bridge',
    status: 'rejected',
    nodeIds: [],
    evidence: [],
    message,
});

const structureDiagnostic = (
    rule: TableComponentMatchRule,
    table: TableComponent,
): AnalysisDiagnostic => ({
    code: 'table.bridge.structure.ambiguous',
    severity: 'error',
    stage: 'table-bridge',
    status: table.status,
    nodeIds: [table.location.structuralRootNodeId],
    evidence: table.evidence,
    message: `table bridge rule matched a non-complete structural target: ${rule.ruleId} (${table.status})`,
});

const cardinalityDiagnostic = (
    rule: TableComponentMatchRule,
    binding: TableComponentRuleBinding,
): AnalysisDiagnostic => {
    const count = rule.source === 'node' ? binding.matchedNodeIds.length : binding.matchedComponentIds.length;
    const multiple = rule.expect === 'unique' && count > 1;
    return {
        code: multiple ? 'table.bridge.cardinality.multiple' : 'table.bridge.cardinality.missing',
        severity: 'warning',
        stage: 'table-bridge',
        status: multiple ? 'ambiguous' : 'partial',
        nodeIds: binding.matchedNodeIds,
        evidence: [],
        message: `table bridge rule cardinality failed: ${rule.ruleId} expected ${rule.expect}, got ${count}`,
    };
};

const normalize = (value: string | undefined): string => (value ?? '').trim();
const normalizeLower = (value: string | undefined): string => normalize(value).toLowerCase();
const normalizeCompactLower = (value: string | undefined): string => normalizeLower(value).replace(/\s+/g, ' ');
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
