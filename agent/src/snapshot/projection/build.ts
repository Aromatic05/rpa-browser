import {resolveSemanticRole} from '../observation/model/semantic';
import type {ObservationNodeId, PageObservation} from '../observation/model/contracts';
import type {PageSnapshotSessionEntry} from '../session/contracts';
import {buildSnapshotContentRef} from './content';
import type {
    SnapshotProjection,
    SnapshotProjectionBuildResult,
    SnapshotProjectionCollectionReport,
    SnapshotProjectionFilter,
    SnapshotProjectionForm,
    SnapshotProjectionNode,
    SnapshotProjectionOptions,
    SnapshotProjectionTable,
} from './contracts';

export const buildSnapshotProjection = (
    entry: PageSnapshotSessionEntry,
    options: SnapshotProjectionOptions = {},
): SnapshotProjectionBuildResult => {
    const depth = options.depth ?? -1;
    if (!Number.isInteger(depth) || depth < -1) {
        return {
            ok: false,
            error: {code: 'ERR_BAD_ARGS', message: 'snapshot depth must be an integer greater than or equal to -1'},
        };
    }

    const observation = entry.capture.control.observation;
    const containNodeIds = resolveContainNodeIds(entry, options.contain);
    if (!containNodeIds) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: `snapshot contain target not found: ${options.contain}`,
                details: {contain: options.contain},
            },
        };
    }
    const candidateNodeIds = collectScopedNodeIds(observation, containNodeIds, depth);
    const includedNodeIds = selectIncludedNodeIds(entry, candidateNodeIds, containNodeIds, options.filter);
    const roots = containNodeIds
        .filter((nodeId) => includedNodeIds.has(nodeId))
        .map((nodeId) => buildNode(entry, nodeId, includedNodeIds));
    const filterSignature = buildSnapshotProjectionFilterSignature(options.filter);
    const snapshotId = buildProjectionSnapshotId(entry, containNodeIds, depth, filterSignature);
    const forms = buildForms(entry, includedNodeIds);
    const tables = buildTables(entry, includedNodeIds, options);
    const nodeCollection: SnapshotProjectionCollectionReport = {
        kind: 'nodes',
        collectionId: 'observation.nodes',
        total: candidateNodeIds.size,
        included: includedNodeIds.size,
        omitted: Math.max(0, candidateNodeIds.size - includedNodeIds.size),
        policy: collectionPolicy(options),
    };

    return {
        ok: true,
        projection: {
            schemaVersion: 2,
            meta: {
                snapshotId,
                pageEpoch: entry.identity.pageEpoch,
                captureRevision: entry.identity.captureRevision,
                pageUrl: entry.pageUrl,
                refreshReason: entry.refreshReason,
                mode: 'full',
                containNodeIds: [...containNodeIds],
                depth,
                filterSignature,
                totalNodeCount: candidateNodeIds.size,
                includedNodeCount: includedNodeIds.size,
                changedNodeCount: 0,
                changedComponentIds: [],
                removedNodeKeys: [],
            },
            roots,
            components: {forms, tables},
            semantics: buildSemanticBindings(entry),
            collections: [nodeCollection, ...tables.map((table) => table.rowCollection)],
            diagnostics: collectDiagnostics(entry),
        },
    };
};

export const buildSnapshotProjectionBaselineKey = (projection: SnapshotProjection): string => [
    projection.meta.containNodeIds.join(','),
    projection.meta.depth,
    projection.meta.filterSignature,
].join('|');

export const buildSnapshotProjectionFilterSignature = (
    filter: SnapshotProjectionFilter | undefined,
): string => {
    if (!filter) {return '{}';}
    const roles = Array.isArray(filter.role) ? [...filter.role] : filter.role ? [filter.role] : [];
    roles.sort((left, right) => left.localeCompare(right));
    const normalized: Record<string, unknown> = {};
    if (filter.interactive !== undefined) {normalized.interactive = filter.interactive;}
    if (roles.length > 0) {normalized.role = roles;}
    if (filter.text?.trim()) {normalized.text = filter.text.trim();}
    return JSON.stringify(normalized);
};

const resolveContainNodeIds = (
    entry: PageSnapshotSessionEntry,
    contain: string | undefined,
): ObservationNodeId[] | undefined => {
    const observation = entry.capture.control.observation;
    if (!contain) {
        const scopes = new Map(Object.entries(observation.scopes.scopes));
        return observation.scopes.rootScopeIds
            .map((scopeId) => scopes.get(scopeId)?.rootNodeId)
            .filter((nodeId): nodeId is string => typeof nodeId === 'string');
    }
    if (new Map(Object.entries(observation.nodes)).has(contain)) {return [contain];}
    const form = new Map(Object.entries(entry.capture.form.forms.forms)).get(contain);
    if (form) {return [form.location.structuralRootNodeId];}
    const table = new Map(Object.entries(entry.capture.table.tables.tables)).get(contain);
    if (table) {return [table.location.structuralRootNodeId];}
    const control = new Map(Object.entries(entry.capture.control.controls.controls)).get(contain)
        ?? Object.values(entry.capture.control.controls.controls).find((item) => item.ref === contain);
    return control ? [control.rootNodeId] : undefined;
};

const collectScopedNodeIds = (
    observation: PageObservation,
    rootNodeIds: readonly ObservationNodeId[],
    depth: number,
): Set<ObservationNodeId> => {
    const result = new Set<ObservationNodeId>();
    const visit = (nodeId: ObservationNodeId, currentDepth: number) => {
        if (result.has(nodeId)) {return;}
        result.add(nodeId);
        if (depth !== -1 && currentDepth >= depth) {return;}
        for (const childId of observation.children[nodeId] ?? []) {visit(childId, currentDepth + 1);}
    };
    rootNodeIds.forEach((nodeId) => {visit(nodeId, 0);});
    return result;
};

const selectIncludedNodeIds = (
    entry: PageSnapshotSessionEntry,
    candidateNodeIds: ReadonlySet<ObservationNodeId>,
    rootNodeIds: readonly ObservationNodeId[],
    filter: SnapshotProjectionFilter | undefined,
): Set<ObservationNodeId> => {
    if (!filter) {return new Set(candidateNodeIds);}
    const matches = new Set<ObservationNodeId>();
    for (const nodeId of candidateNodeIds) {
        if (matchesFilter(entry, nodeId, filter)) {matches.add(nodeId);}
    }
    const included = new Set<ObservationNodeId>();
    const rootSet = new Set(rootNodeIds);
    const observation = entry.capture.control.observation;
    for (const nodeId of matches) {
        let current: ObservationNodeId | undefined = nodeId;
        const visited = new Set<ObservationNodeId>();
        while (current && candidateNodeIds.has(current) && !visited.has(current)) {
            visited.add(current);
            included.add(current);
            if (rootSet.has(current)) {break;}
            current = observation.parents[current];
        }
    }
    return included;
};

const matchesFilter = (
    entry: PageSnapshotSessionEntry,
    nodeId: ObservationNodeId,
    filter: SnapshotProjectionFilter,
): boolean => {
    const observation = entry.capture.control.observation;
    const roles = Array.isArray(filter.role) ? filter.role : filter.role ? [filter.role] : [];
    if (roles.length > 0) {
        const role = normalize(resolveSemanticRole(observation, nodeId).value);
        if (!roles.some((candidate) => normalize(candidate) === role)) {return false;}
    }
    if (filter.text?.trim()) {
        const haystack = normalize(readSearchText(observation, nodeId));
        if (!haystack.includes(normalize(filter.text))) {return false;}
    }
    if (filter.interactive !== undefined && isInteractive(entry, nodeId) !== filter.interactive) {return false;}
    return true;
};

const readSearchText = (observation: PageObservation, nodeId: ObservationNodeId): string => {
    const values: string[] = [];
    const visit = (current: ObservationNodeId) => {
        const a11y = observation.accessibility[current];
        const runtime = observation.runtimeState[current];
        values.push(
            observation.text[current] ?? '',
            a11y?.name ?? '',
            a11y?.value ?? '',
            runtime?.value ?? '',
            runtime?.popupSelectedText ?? '',
        );
        for (const childId of observation.children[current] ?? []) {visit(childId);}
    };
    visit(nodeId);
    return values.filter(Boolean).join(' ');
};

const isInteractive = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): boolean => {
    const controls = new Map(Object.entries(entry.capture.control.controls.controls));
    return (entry.capture.control.controls.byNodeId[nodeId] ?? [])
        .map((controlId) => controls.get(controlId))
        .some((control) => control !== undefined && control.capabilities.length > 0);
};

const buildNode = (
    entry: PageSnapshotSessionEntry,
    nodeId: ObservationNodeId,
    includedNodeIds: ReadonlySet<ObservationNodeId>,
): SnapshotProjectionNode => {
    const observation = entry.capture.control.observation;
    const node = observation.nodes[nodeId];
    const attrs = observation.attributes[nodeId] ?? {};
    const runtime = observation.runtimeState[nodeId];
    const identity = new Map(Object.entries(observation.domIdentity)).get(nodeId);
    return {
        nodeId,
        scopeId: node.scopeId,
        tag: node.tag,
        role: resolveSemanticRole(observation, nodeId).value,
        name: clean(observation.accessibility[nodeId]?.name ?? attrs['aria-label']),
        text: clean(observation.text[nodeId]),
        contentRef: buildSnapshotContentRef(entry, nodeId),
        attributes: Object.keys(attrs).length > 0 ? {...attrs} : undefined,
        runtimeState: runtime ? {...runtime} : undefined,
        activity: {...observation.activity[nodeId]},
        identity: {
            backendNodeId: identity?.backendNodeId,
            runtimeIdentityToken: identity?.runtimeIdentityToken,
        },
        controlIds: [...(entry.capture.control.controls.byNodeId[nodeId] ?? [])],
        componentIds: unique([
            ...(entry.capture.form.forms.byNodeId[nodeId] ?? []),
            ...(entry.capture.table.tables.byNodeId[nodeId] ?? []),
        ]),
        children: (observation.children[nodeId] ?? [])
            .filter((childId) => includedNodeIds.has(childId))
            .map((childId) => buildNode(entry, childId, includedNodeIds)),
    };
};

const buildForms = (
    entry: PageSnapshotSessionEntry,
    includedNodeIds: ReadonlySet<ObservationNodeId>,
): SnapshotProjectionForm[] => Object.values(entry.capture.form.forms.forms)
    .filter((form) => formProjectionNodeIds(form).some((nodeId) => includedNodeIds.has(nodeId)))
    .map((form) => ({
        id: form.id,
        rootNodeId: form.location.structuralRootNodeId,
        hostNodeId: form.location.hostNodeId,
        selectionScopeNodeId: form.location.selectionScopeNodeId,
        status: form.status,
        boundaryKind: form.boundaryKind,
        fields: form.fields.map((field) => ({
            id: field.id,
            anchorNodeId: field.anchorNodeId,
            controlIds: [...field.controlIds],
            required: field.required,
            status: field.status,
            labelNodeIds: [...field.labelNodeIds],
            errorNodeIds: [...field.errorNodeIds],
        })),
        actions: form.actions.map((action) => ({
            id: action.id,
            nodeId: action.nodeId,
            controlId: action.controlId,
            structuralRole: action.structuralRole,
        })),
        groups: form.groups.map((group) => ({
            id: group.id,
            rootNodeId: group.rootNodeId,
            fieldIds: [...group.fieldIds],
        })),
        validation: {
            ok: form.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
            diagnosticCount: form.diagnostics.length,
        },
    }));

const formProjectionNodeIds = (form: PageSnapshotSessionEntry['capture']['form']['forms']['forms'][string]) => unique([
    form.location.structuralRootNodeId,
    form.location.hostNodeId,
    form.location.selectionScopeNodeId,
    ...form.fields.flatMap((field) => field.memberNodeIds),
    ...form.actions.map((action) => action.nodeId),
    ...form.groups.flatMap((group) => [group.rootNodeId, ...group.labelNodeIds]),
].filter((nodeId): nodeId is string => Boolean(nodeId)));

const buildTables = (
    entry: PageSnapshotSessionEntry,
    includedNodeIds: ReadonlySet<ObservationNodeId>,
    options: SnapshotProjectionOptions,
): SnapshotProjectionTable[] => Object.values(entry.capture.table.tables.tables)
    .filter((table) => tableProjectionNodeIds(entry, table.id).some((nodeId) => includedNodeIds.has(nodeId)))
    .map((table) => {
        const rows = table.body.visibleRows
            .filter((row) => includedNodeIds.has(row.nodeId))
            .map((row) => ({
                id: row.id,
                nodeId: row.nodeId,
                index: row.index,
                key: row.key,
                selected: row.selected,
                expanded: row.expanded,
                level: row.level,
                cells: row.cellIds
                    .map((cellId) => new Map(Object.entries(entry.capture.table.tables.cells)).get(cellId))
                    .filter((cell): cell is NonNullable<typeof cell> =>
                        cell !== undefined && includedNodeIds.has(cell.nodeId))
                    .map((cell) => ({
                        id: cell.id,
                        nodeId: cell.nodeId,
                        columnId: cell.columnId,
                        text: cell.text,
                        controlIds: [...cell.controlIds],
                    })),
            }));
        const rowCollection: SnapshotProjectionCollectionReport = {
            kind: 'table-rows',
            collectionId: table.id,
            total: table.body.visibleRows.length,
            included: rows.length,
            omitted: Math.max(0, table.body.visibleRows.length - rows.length),
            policy: collectionPolicy(options),
        };
        return {
            id: table.id,
            rootNodeId: table.location.structuralRootNodeId,
            hostNodeId: table.location.hostNodeId,
            selectionScopeNodeId: table.location.selectionScopeNodeId,
            status: table.status,
            columns: table.columns.map((column) => ({
                id: column.id,
                index: column.index,
                name: column.name,
                sourceNodeIds: [...column.sourceNodeIds],
            })),
            rows,
            rowCollection,
            controlSlots: table.controlSlots.map((slot) => ({
                id: slot.id,
                columnId: slot.columnId,
                controlKind: slot.controlKind,
                occurrenceCount: slot.occurrenceCount,
                controlIds: [...slot.controlIds],
            })),
            rowExceptions: table.rowExceptions.map((item) => ({
                rowId: item.rowId,
                controlIds: [...item.controlIds],
            })),
            pagination: table.pagination
                ? {status: table.pagination.status, nodeIds: [...table.pagination.nodeIds]}
                : undefined,
            validation: {
                ok: table.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
                diagnosticCount: table.diagnostics.length,
            },
        };
    });

const tableProjectionNodeIds = (entry: PageSnapshotSessionEntry, tableId: string): ObservationNodeId[] => {
    const table = new Map(Object.entries(entry.capture.table.tables.tables)).get(tableId);
    if (!table) {return [];}
    return unique([
        table.location.structuralRootNodeId,
        table.location.hostNodeId,
        table.location.selectionScopeNodeId,
        ...table.parts.physicalTableNodeIds,
        ...table.body.visibleRows.map((row) => row.nodeId),
        ...table.body.visibleRows.flatMap((row) => {
            const cells = new Map(Object.entries(entry.capture.table.tables.cells));
            return row.cellIds
                .map((cellId) => cells.get(cellId)?.nodeId)
                .filter((nodeId): nodeId is string => typeof nodeId === 'string');
        }),
        ...table.columns.flatMap((column) => column.sourceNodeIds),
        ...(table.pagination?.nodeIds ?? []),
    ].filter((nodeId): nodeId is string => Boolean(nodeId)));
};

const buildSemanticBindings = (entry: PageSnapshotSessionEntry) => Object.values(entry.semanticBindingsByProfile)
    .flatMap((bindings) => Object.values(bindings.byId))
    .map((binding) => ({
        id: binding.id,
        profileName: binding.profileName,
        origin: binding.origin,
        disposition: binding.disposition,
        status: binding.status,
        domain: binding.domain,
        nodeIds: [...binding.target.nodeIds],
        componentIds: [...binding.target.componentIds],
        annotation: cloneRecord(binding.annotation),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

const collectDiagnostics = (entry: PageSnapshotSessionEntry) => [
    ...entry.capture.control.observation.diagnostics,
    ...entry.capture.control.locators.diagnostics,
    ...entry.capture.control.controls.diagnostics,
    ...entry.capture.form.forms.diagnostics,
    ...entry.capture.table.tables.diagnostics,
    ...Object.values(entry.semanticBindingsByProfile).flatMap((bindings) => bindings.diagnostics),
].map((diagnostic) => ({
    ...diagnostic,
    nodeIds: [...diagnostic.nodeIds],
    evidence: diagnostic.evidence.map((item) => ({...item, nodeIds: [...item.nodeIds]})),
}));

const buildProjectionSnapshotId = (
    entry: PageSnapshotSessionEntry,
    containNodeIds: readonly ObservationNodeId[],
    depth: number,
    filterSignature: string,
): string => `projection:${entry.identity.pageEpoch}:${entry.identity.captureRevision}:${hashString(
    `${containNodeIds.join(',')}|${depth}|${filterSignature}`,
)}`;

const collectionPolicy = (
    options: SnapshotProjectionOptions,
): SnapshotProjectionCollectionReport['policy'] => {
    if (options.filter) {return 'projection-filter';}
    if ((options.depth ?? -1) !== -1) {return 'depth-limit';}
    if (options.contain) {return 'contain-scope';}
    return 'full';
};

const hashString = (value: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
};

const normalize = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
const clean = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const cloneRecord = (value: Record<string, unknown>): Record<string, unknown> =>
    structuredClone(value);
