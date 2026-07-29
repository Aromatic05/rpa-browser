import type {
    AnnotatorComponent,
    AnnotatorProjection,
    AnnotatorRect,
    AnnotatorSelection,
    AnnotatorTarget,
    AnnotatorTargetKind,
} from './contracts';
import type {ObservationNodeId} from '../observation/model/contracts';
import type {PageSessionSelection, PageSnapshotSessionEntry} from '../session/contracts';

export const buildAnnotatorProjection = (
    entry: PageSnapshotSessionEntry,
    selection: PageSessionSelection = {status: 'none'},
): AnnotatorProjection => {
    const components: AnnotatorComponent[] = [
        ...Object.values(entry.capture.form.forms.forms).map((form) => ({
            id: form.id,
            domain: 'form' as const,
            status: form.status,
            selectionScopeNodeId: form.location.selectionScopeNodeId,
            hostNodeId: form.location.hostNodeId,
            structuralRootNodeId: form.location.structuralRootNodeId,
            fieldIds: form.fields.map((field) => field.id),
            actionIds: form.actions.map((action) => action.id),
            rowIds: [],
            columnIds: [],
        })),
        ...Object.values(entry.capture.table.tables.tables).map((table) => ({
            id: table.id,
            domain: 'table' as const,
            status: table.status,
            selectionScopeNodeId: table.location.selectionScopeNodeId,
            hostNodeId: table.location.hostNodeId,
            structuralRootNodeId: table.location.structuralRootNodeId,
            fieldIds: [],
            actionIds: [],
            rowIds: table.body.visibleRows.map((row) => row.id),
            columnIds: table.columns.map((column) => column.id),
        })),
    ];
    const targets: AnnotatorTarget[] = [];
    const addTarget = (input: Omit<AnnotatorTarget, 'geometry'>): void => {
        const nodeIds = unique(input.nodeIds);
        if (nodeIds.length === 0) {return;}
        targets.push({...input, nodeIds, geometry: geometryForNodes(entry, nodeIds)});
    };

    if (selection.status === 'resolved') {
        addTarget({
            id: 'selection:confirmed',
            kind: 'selection-scope',
            nodeIds: [selection.nodeId],
            status: selection.status,
        });
    }

    for (const form of Object.values(entry.capture.form.forms.forms)) {
        addLocationTargets(addTarget, 'form', form.id, form.location);
        for (const field of form.fields) {
            addTarget({
                id: `field:${field.id}`,
                kind: 'field',
                domain: 'form',
                componentId: form.id,
                memberId: field.id,
                nodeIds: unique([
                    field.anchorNodeId,
                    ...field.memberNodeIds,
                    ...field.labelNodeIds,
                    ...field.errorNodeIds,
                ]),
                status: field.status,
                label: readNodeLabel(entry, field.labelNodeIds[0] ?? field.anchorNodeId),
            });
        }
        for (const action of form.actions) {
            addTarget({
                id: `action:${action.id}`,
                kind: 'action',
                domain: 'form',
                componentId: form.id,
                memberId: action.id,
                nodeIds: [action.nodeId],
                label: readNodeLabel(entry, action.nodeId),
            });
        }
    }

    const cells = new Map(Object.entries(entry.capture.table.tables.cells));
    for (const table of Object.values(entry.capture.table.tables.tables)) {
        addLocationTargets(addTarget, 'table', table.id, table.location);
        for (const row of table.body.visibleRows) {
            addTarget({
                id: `row:${row.id}`,
                kind: 'row',
                domain: 'table',
                componentId: table.id,
                memberId: row.id,
                nodeIds: unique([
                    row.nodeId,
                    ...row.cellIds.map((cellId) => cells.get(cellId)?.nodeId)
                        .filter((nodeId): nodeId is string => typeof nodeId === 'string'),
                ]),
                status: row.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'partial' : 'complete',
                label: row.key,
            });
        }
        for (const column of table.columns) {
            addTarget({
                id: `column:${column.id}`,
                kind: 'column',
                domain: 'table',
                componentId: table.id,
                memberId: column.id,
                nodeIds: [...column.sourceNodeIds],
                label: column.name,
            });
        }
        for (const slot of table.controlSlots) {
            addTarget({
                id: `action:${slot.id}`,
                kind: 'action',
                domain: 'table',
                componentId: table.id,
                memberId: slot.id,
                nodeIds: [...slot.exemplarNodeIds],
                status: slot.occurrenceCount > 0 ? 'complete' : 'partial',
                label: readNodeLabel(entry, slot.exemplarNodeIds[0]),
            });
        }
    }

    for (const control of Object.values(entry.capture.control.controls.controls)) {
        addTarget({
            id: `control:${control.id}`,
            kind: 'control',
            memberId: control.id,
            nodeIds: unique([
                control.rootNodeId,
                control.controlNodeId,
                control.triggerNodeId,
                control.popupNodeId,
                ...control.optionNodeIds,
                ...control.memberNodeIds,
            ].filter((nodeId): nodeId is string => typeof nodeId === 'string')),
            status: control.status,
            label: control.ref,
        });
    }

    const semanticBindings = Object.values(entry.semanticBindingsByProfile)
        .flatMap((bindings) => Object.values(bindings.byId))
        .map((binding) => {
            addTarget({
                id: `semantic:${binding.id}`,
                kind: 'semantic-binding',
                domain: binding.domain,
                componentId: binding.target.componentIds[0],
                memberId: binding.id,
                nodeIds: [...binding.target.nodeIds],
                status: binding.status,
                label: readString(binding.annotation.businessTag)
                    ?? readString(binding.annotation.fieldKey)
                    ?? readString(binding.annotation.actionIntent),
            });
            return {
                id: binding.id,
                profileName: binding.profileName,
                ruleId: binding.ruleId,
                origin: binding.origin,
                disposition: binding.disposition,
                status: binding.status,
                nodeIds: [...binding.target.nodeIds],
                componentIds: [...binding.target.componentIds],
                annotation: structuredClone(binding.annotation),
            };
        })
        .sort((left, right) => left.id.localeCompare(right.id));

    const suggestions = Object.values(entry.semanticSuggestionsByProfile)
        .flatMap((value) => value.items)
        .map((suggestion) => ({
            id: suggestion.id,
            kind: suggestion.kind,
            value: suggestion.value,
            componentId: suggestion.componentId,
            nodeId: suggestion.nodeId,
            memberId: suggestion.memberId,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));

    const diagnostics = [
        ...entry.capture.control.observation.diagnostics,
        ...entry.capture.control.controls.diagnostics,
        ...entry.capture.form.forms.diagnostics,
        ...entry.capture.table.tables.diagnostics,
        ...Object.values(entry.semanticBindingsByProfile).flatMap((bindings) => bindings.diagnostics),
    ].map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        nodeIds: [...diagnostic.nodeIds],
    }));

    return {
        schemaVersion: 1,
        identity: {...entry.identity},
        pageUrl: entry.pageUrl,
        selection: toAnnotatorSelection(selection),
        components,
        targets: targets.sort(compareTargets),
        semanticBindings,
        suggestions,
        diagnostics,
    };
};

const addLocationTargets = (
    addTarget: (input: Omit<AnnotatorTarget, 'geometry'>) => void,
    domain: 'form' | 'table',
    componentId: string,
    location: {
        selectionScopeNodeId?: ObservationNodeId;
        hostNodeId?: ObservationNodeId;
        structuralRootNodeId: ObservationNodeId;
    },
): void => {
    const add = (kind: Extract<AnnotatorTargetKind, 'selection-scope' | 'host' | 'structural-root'>, nodeId?: string) => {
        if (!nodeId) {return;}
        addTarget({
            id: `${kind}:${componentId}`,
            kind,
            domain,
            componentId,
            nodeIds: [nodeId],
        });
    };
    add('selection-scope', location.selectionScopeNodeId);
    add('host', location.hostNodeId);
    add('structural-root', location.structuralRootNodeId);
};

const geometryForNodes = (
    entry: PageSnapshotSessionEntry,
    nodeIds: readonly ObservationNodeId[],
): AnnotatorRect[] => {
    const seen = new Set<string>();
    const result: AnnotatorRect[] = [];
    for (const nodeId of nodeIds) {
        const records = entry.capture.control.observation.geometry[nodeId] ?? [];
        const preferred = records.filter((record) => record.space === 'top-css-viewport');
        for (const record of preferred.length > 0 ? preferred : records) {
            const rect = record.rect;
            const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
            if (seen.has(key)) {continue;}
            seen.add(key);
            result.push({...rect});
        }
    }
    return result;
};

const readNodeLabel = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined => {
    const observation = entry.capture.control.observation;
    const value = new Map(Object.entries(observation.accessibility)).get(nodeId)?.name
        ?? observation.text[nodeId]
        ?? new Map(Object.entries(observation.attributes)).get(nodeId)?.['aria-label'];
    if (!value) {return undefined;}
    return value.replace(/\s+/g, ' ').trim() || undefined;
};

const toAnnotatorSelection = (selection: PageSessionSelection): AnnotatorSelection => {
    if (selection.status === 'none') {return {status: 'none'};}
    if (selection.status === 'resolved') {
        return {status: 'resolved', anchor: {...selection.anchor}, nodeId: selection.nodeId};
    }
    if (selection.status === 'ambiguous') {
        return {
            status: 'ambiguous',
            anchor: {...selection.anchor},
            candidateNodeIds: [...selection.candidateNodeIds],
        };
    }
    return {status: 'stale', anchor: {...selection.anchor}};
};

const compareTargets = (left: AnnotatorTarget, right: AnnotatorTarget): number =>
    targetKindOrder(left.kind) - targetKindOrder(right.kind) || left.id.localeCompare(right.id);

const targetKindOrder = (kind: AnnotatorTargetKind): number => [
    'selection-scope',
    'host',
    'structural-root',
    'field',
    'action',
    'row',
    'column',
    'control',
    'semantic-binding',
].indexOf(kind);

const readString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
