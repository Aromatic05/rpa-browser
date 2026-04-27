import { getNodeAttrs, normalizeText } from './runtime_store';
import { buildTableStructureModel } from './table_model';
import type { FinalEntityRecord, SnapshotResult } from './types';

type EntityOutputRecord = {
    id: string;
    entity_id?: string;
    node_id: string;
    type: 'region' | 'group';
    kind: string;
    name?: string;
    business_tag?: string;
    business_name?: string;
    primary_key?: {
        field_key: string;
        columns?: string[];
        source?: string;
    };
    columns?: Array<{
        field_key: string;
        name?: string;
        kind?: string;
        source?: string;
        column_index?: number;
        header_node_id?: string;
        actions?: Array<{
            action_intent: string;
            text?: string;
        }>;
    }>;
    source: 'auto' | 'overlay_add';
    item_ids?: string[];
    key_slot?: number;
};

export const toEntityOutputRecord = (entity: FinalEntityRecord): EntityOutputRecord => ({
    id: entity.id,
    entity_id: entity.entityId,
    node_id: entity.nodeId,
    type: entity.type,
    kind: entity.kind,
    name: entity.name,
    business_tag: entity.businessTag,
    business_name: entity.businessName,
    primary_key: entity.primaryKey
        ? {
            field_key: entity.primaryKey.fieldKey,
            columns: entity.primaryKey.columns ? [...entity.primaryKey.columns] : undefined,
            source: entity.primaryKey.source,
        }
        : undefined,
    columns: entity.columns?.map((column) => ({
        field_key: column.fieldKey,
        name: column.name,
        kind: column.kind,
        source: column.source,
        column_index: column.columnIndex,
        header_node_id: column.headerNodeId,
        actions: column.actions?.map((action) => ({
            action_intent: action.actionIntent,
            text: action.text,
        })),
    })),
    source: entity.source,
    item_ids: entity.itemIds,
    key_slot: entity.keySlot,
});

export const buildNodeSummary = (snapshot: SnapshotResult, nodeId: string) => {
    const node = snapshot.nodeIndex[nodeId];
    if (!node) {return null;}
    const attrs = getNodeAttrs(node);
    const debugAttrs = pickNodeDebugAttrs(attrs);
    return {
        node_id: nodeId,
        role: node.role,
        name: normalizeText(node.name),
        bbox: snapshot.bboxIndex[nodeId],
        attrs: debugAttrs,
    };
};

type TableMeta = {
    row_count: number;
    column_count: number;
    headers: string[];
    row_nodes: string[];
    cell_nodes_by_row: Record<string, string[] | undefined>;
    column_cells: Record<string, string[] | undefined>;
    primary_key_candidates: Array<{
        columns: string[];
        unique: boolean;
        duplicate_count: number;
    }>;
    recommended_primary_key?: string[];
};

export const buildTableMeta = (snapshot: SnapshotResult, tableNodeId: string): TableMeta | null => {
    const model = buildTableStructureModel(snapshot, tableNodeId);
    if (!model) {return null;}

    return {
        row_count: model.rows.length,
        column_count: model.columnCount,
        headers: [...model.headers],
        row_nodes: model.rows.map((row) => row.nodeId),
        cell_nodes_by_row: Object.fromEntries(model.rows.map((row) => [row.nodeId, row.cells.map((cell) => cell.nodeId)])),
        column_cells: { ...model.columnCellNodeIdsByHeader },
        primary_key_candidates: model.primaryKeyCandidates.map((item) => ({
            columns: [...item.columns],
            unique: item.unique,
            duplicate_count: item.duplicateCount,
        })),
        recommended_primary_key: model.recommendedPrimaryKey ? [...model.recommendedPrimaryKey] : undefined,
    };
};

const pickNodeDebugAttrs = (attrs: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!attrs) {return undefined;}
    const keys = ['id', 'name', 'type', 'role', 'href', 'src', 'aria-label', 'placeholder'];
    const out: Record<string, string> = {};
    for (const key of keys) {
        const value = normalizeText(attrs[key]);
        if (!value) {continue;}
        out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
};
