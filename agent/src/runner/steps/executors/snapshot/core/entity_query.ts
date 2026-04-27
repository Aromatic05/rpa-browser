import { getNodeAttr, getNodeContent, normalizeText } from './runtime_store';
import { buildTableStructureModel, type TableModelCell, type TableStructureModel } from './table_model';
import type { BusinessBindingIndex, FinalEntityRecord, SnapshotResult, UnifiedNode } from './types';
import type { EntityKind } from './types';

type EntityQueryFilters = {
    kind?: EntityKind | EntityKind[];
    businessTag?: string | string[];
    query?: string;
};

export type ResolvedTableRow = {
    rowNodeId: string;
    cellNodeId: string;
    columnName: string;
    value: string;
};

export type ResolvedTableAction = {
    rowNodeId: string;
    cellNodeId: string;
    nodeId: string;
    actionIntent: string;
};

export const filterFinalEntities = (
    entities: FinalEntityRecord[],
    filters: EntityQueryFilters,
): FinalEntityRecord[] => {
    const kinds = normalizeKindFilter(filters.kind);
    const tags = normalizeTextSet(filters.businessTag);
    const query = normalizeText(filters.query)?.toLowerCase();

    return entities.filter((entity) => {
        if (kinds && !kinds.has(entity.kind)) {return false;}

        if (tags) {
            const businessTag = normalizeText(entity.businessTag);
            if (!businessTag || !tags.has(businessTag)) {return false;}
        }

        if (!query) {return true;}
        return matchesQuery(entity, query);
    });
};

export const buildBusinessBindingIndex = (entities: FinalEntityRecord[]): BusinessBindingIndex => {
    const fieldsByEntity: BusinessBindingIndex['fieldsByEntity'] = {};
    const actionsByEntity: BusinessBindingIndex['actionsByEntity'] = {};
    const columnsByEntity: BusinessBindingIndex['columnsByEntity'] = {};

    for (const entity of entities) {
        const fieldBindings = Object.fromEntries(
            (entity.formFields || []).map((field) => [
                field.fieldKey,
                {
                    fieldKey: field.fieldKey,
                    name: field.name,
                    controlNodeId: field.controlNodeId,
                    labelNodeId: field.labelNodeId,
                    kind: field.kind,
                },
            ]),
        );
        if (Object.keys(fieldBindings).length > 0) {
            fieldsByEntity[entity.id] = fieldBindings;
        }

        const actionBindings = Object.fromEntries(
            (entity.formActions || []).map((action) => [
                action.actionIntent,
                {
                    actionIntent: action.actionIntent,
                    nodeId: action.nodeId,
                    text: action.text,
                },
            ]),
        );
        if (Object.keys(actionBindings).length > 0) {
            actionsByEntity[entity.id] = actionBindings;
        }

        const columnBindings = Object.fromEntries(
            (entity.columns || []).map((column) => [
                column.fieldKey,
                {
                    fieldKey: column.fieldKey,
                    name: column.name,
                    kind: column.kind,
                    columnIndex: column.columnIndex,
                    headerNodeId: column.headerNodeId,
                },
            ]),
        );
        if (Object.keys(columnBindings).length > 0) {
            columnsByEntity[entity.id] = columnBindings;
        }
    }

    return {
        fieldsByEntity,
        actionsByEntity,
        columnsByEntity,
    };
};

export const resolveTableRowByPrimaryKey = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
    input: {
        fieldKey: string;
        value: string;
    },
): ResolvedTableRow | null => {
    const model = buildTableStructureModel(snapshot, entity.nodeId);
    if (!model) {return null;}
    const column = resolvePrimaryKeyColumn(entity, model, input.fieldKey);
    if (!column) {return null;}

    for (const row of model.rows) {
        const cell = row.cells[column.columnIndex];
        if (!cell) {continue;}
        if (normalizeLower(cell.value) !== normalizeLower(input.value)) {continue;}
        return {
            rowNodeId: row.nodeId,
            cellNodeId: cell.nodeId,
            columnName: column.header,
            value: cell.value,
        };
    }

    return null;
};

export const resolveTableRowAction = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
    input: {
        primaryKey: {
            fieldKey: string;
            value: string;
        };
        actionIntent: string;
    },
): ResolvedTableAction | null => {
    const model = buildTableStructureModel(snapshot, entity.nodeId);
    if (!model) {return null;}
    const row = resolveTableRowByPrimaryKey(snapshot, entity, input.primaryKey);
    if (!row) {return null;}

    const rowModel = model.rows.find((item) => item.nodeId === row.rowNodeId);
    if (!rowModel) {return null;}
    const actionColumn = resolveActionColumn(entity, model, input.actionIntent);
    if (!actionColumn) {return null;}
    const actionCell = rowModel.cells[actionColumn.columnIndex];
    if (!actionCell) {return null;}

    const preferred = pickActionNodeFromCell(snapshot, actionCell, actionColumn.actionText);
    if (!preferred) {return null;}

    return {
        rowNodeId: rowModel.nodeId,
        cellNodeId: actionCell.nodeId,
        nodeId: preferred.id,
        actionIntent: input.actionIntent,
    };
};

const resolvePrimaryKeyColumn = (
    entity: FinalEntityRecord,
    model: TableStructureModel,
    fieldKey: string,
): { columnIndex: number; header: string } | null => {
    const columns = entity.columns || [];
    const columnByField = columns.find((column) => column.fieldKey === fieldKey);
    if (columnByField) {
        const index = resolveColumnIndex(model, columnByField);
        if (index >= 0) {
            return { columnIndex: index, header: model.headers[index] || columnByField.name || fieldKey };
        }
    }

    const primaryKey = entity.primaryKey;
    if (primaryKey?.fieldKey === fieldKey && primaryKey.columns && primaryKey.columns.length > 0) {
        const index = model.headers.findIndex((header) => normalizeLower(header) === normalizeLower(primaryKey.columns?.[0]));
        if (index >= 0) {
            return { columnIndex: index, header: model.headers[index] };
        }
    }

    const fallback = model.headers.findIndex((header) => normalizeLower(header) === normalizeLower(fieldKey));
    if (fallback >= 0) {
        return { columnIndex: fallback, header: model.headers[fallback] };
    }

    return null;
};

const resolveActionColumn = (
    entity: FinalEntityRecord,
    model: TableStructureModel,
    actionIntent: string,
): { columnIndex: number; actionText?: string } | null => {
    for (const column of entity.columns || []) {
        if (column.kind !== 'action_column') {continue;}
        const action = (column.actions || []).find((item) => item.actionIntent === actionIntent);
        if (!action) {continue;}
        const index = resolveColumnIndex(model, column);
        if (index >= 0) {
            return {
                columnIndex: index,
                actionText: action.text,
            };
        }
    }
    return null;
};

const resolveColumnIndex = (
    model: TableStructureModel,
    column: { columnIndex?: number; name?: string },
): number => {
    if (typeof column.columnIndex === 'number' && column.columnIndex >= 0) {
        return column.columnIndex;
    }
    if (column.name) {
        const byName = model.headers.findIndex((header) => normalizeLower(header) === normalizeLower(column.name));
        if (byName >= 0) {return byName;}
    }
    return -1;
};

const pickActionNodeFromCell = (
    snapshot: SnapshotResult,
    cell: TableModelCell,
    actionText: string | undefined,
): UnifiedNode | null => {
    const interactiveNodes = cell.interactiveNodeIds
        .map((nodeId) => snapshot.nodeIndex[nodeId])
        .filter((node): node is UnifiedNode => Boolean(node));
    if (interactiveNodes.length === 0) {return null;}

    if (!actionText) {
        return interactiveNodes[0];
    }

    const normalizedActionText = normalizeLower(actionText);
    for (const node of interactiveNodes) {
        const haystack = [
            normalizeLower(readNodeTextRecursive(node)),
            normalizeLower(getNodeAttr(node, 'aria-label')),
            normalizeLower(getNodeAttr(node, 'class')),
        ].join(' ');
        if (haystack.includes(normalizedActionText)) {
            return node;
        }
    }

    return null;
};

const readNodeTextRecursive = (node: UnifiedNode): string => {
    const parts: string[] = [];
    const stack: UnifiedNode[] = [node];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {break;}
        const name = normalizeText(current.name);
        if (name) {parts.push(name);}
        if (typeof current.content === 'string') {
            const content = normalizeText(current.content);
            if (content) {parts.push(content);}
        }
        const runtimeContent = normalizeText(getNodeContent(current));
        if (runtimeContent) {parts.push(runtimeContent);}
        for (let index = current.children.length - 1; index >= 0; index -= 1) {
            stack.push(current.children[index]);
        }
    }
    return normalizeText(parts.join(' ')) || '';
};

const matchesQuery = (entity: FinalEntityRecord, query: string): boolean => {
    const haystack = [
        entity.id,
        entity.entityId,
        entity.nodeId,
        entity.kind,
        entity.type,
        entity.name,
        entity.businessTag,
        entity.businessName,
        entity.primaryKey?.fieldKey,
        ...(entity.primaryKey?.columns || []),
        ...(entity.columns || []).flatMap((column) => [column.fieldKey, column.name || '']),
    ]
        .map((value) => normalizeText(String(value || ''))?.toLowerCase())
        .filter((value): value is string => Boolean(value));

    return haystack.some((value) => value.includes(query));
};

const normalizeKindFilter = (kind?: EntityKind | EntityKind[]): Set<EntityKind> | null => {
    if (!kind) {return null;}
    if (Array.isArray(kind)) {
        const normalized = kind.filter((item): item is EntityKind => Boolean(item));
        return normalized.length > 0 ? new Set(normalized) : null;
    }
    return new Set([kind]);
};

const normalizeTextSet = (input?: string | string[]): Set<string> | null => {
    if (!input) {return null;}
    const values = Array.isArray(input) ? input : [input];
    const normalized = values
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value));
    return normalized.length > 0 ? new Set(normalized) : null;
};

const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase().replace(/\s+/g, '') || '';
