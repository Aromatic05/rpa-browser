import { getNodeAttrs, normalizeText } from './runtime_store';
import type { FinalEntityRecord, SnapshotResult } from './types';

type EntityOutputRecord = {
    id: string;
    entity_id?: string;
    node_id: string;
    type: 'region' | 'group';
    kind: string;
    name?: string;
    business_tag?: string;
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
    source: entity.source,
    item_ids: entity.itemIds,
    key_slot: entity.keySlot,
});

export const buildNodeSummary = (snapshot: SnapshotResult, nodeId: string) => {
    const node = snapshot.nodeIndex[nodeId];
    if (!node) return null;
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
    primary_key_candidates: Array<{
        columns: string[];
        unique: boolean;
        duplicate_count: number;
    }>;
    recommended_primary_key?: string[];
};

export const buildTableMeta = (snapshot: SnapshotResult, tableNodeId: string): TableMeta | null => {
    const tableNode = snapshot.nodeIndex[tableNodeId];
    if (!tableNode || normalizeText(tableNode.role) !== 'table') return null;

    const rowNodeIds: string[] = [];
    const headerRows: string[] = [];
    walkDescendants(tableNode, (node) => {
        const role = normalizeText(node.role);
        if (role !== 'row') return;
        const cells = node.children.filter((child) => normalizeText(child.role) === 'cell');
        const headers = node.children.filter((child) => normalizeText(child.role) === 'columnheader');
        if (headers.length > 0) {
            headerRows.push(node.id);
            return;
        }
        if (cells.length > 0) {
            rowNodeIds.push(node.id);
        }
    });

    const headers = resolveHeaders(snapshot, headerRows, rowNodeIds);
    const rows = rowNodeIds.map((rowId) => extractRowValues(snapshot, rowId)).filter((row) => row.length > 0);
    const columnCount = Math.max(headers.length, rows.reduce((max, row) => Math.max(max, row.length), 0));
    const normalizedHeaders = headers.length > 0 ? headers : Array.from({ length: columnCount }, (_, index) => `col_${index + 1}`);

    const candidates: TableMeta['primary_key_candidates'] = [];
    for (let columnIndex = 0; columnIndex < normalizedHeaders.length; columnIndex += 1) {
        const values = rows.map((row) => normalizeText(row[columnIndex] || '')).filter(Boolean);
        if (values.length === 0) continue;
        const uniqueCount = new Set(values).size;
        const duplicateCount = values.length - uniqueCount;
        candidates.push({
            columns: [normalizedHeaders[columnIndex]],
            unique: duplicateCount === 0,
            duplicate_count: duplicateCount,
        });
    }

    const recommended = resolveRecommendedPrimaryKey(rows, normalizedHeaders);
    if (recommended && !candidates.some((item) => item.columns.length === recommended.length && item.columns.every((col, i) => col === recommended[i]))) {
        const duplicateCount = countTupleDuplicates(rows, normalizedHeaders.map((_, index) => index).slice(0, recommended.length));
        candidates.push({
            columns: recommended,
            unique: duplicateCount === 0,
            duplicate_count: duplicateCount,
        });
    }

    return {
        row_count: rows.length,
        column_count: columnCount,
        headers: normalizedHeaders,
        primary_key_candidates: candidates,
        recommended_primary_key: recommended || undefined,
    };
};

const walkDescendants = (node: SnapshotResult['root'], visitor: (node: SnapshotResult['root']) => void) => {
    for (const child of node.children) {
        visitor(child);
        walkDescendants(child, visitor);
    }
};

const resolveHeaders = (snapshot: SnapshotResult, headerRows: string[], rowNodeIds: string[]): string[] => {
    for (const rowId of headerRows) {
        const headers = extractHeaders(snapshot, rowId);
        if (headers.length > 0) return headers;
    }
    if (rowNodeIds.length === 0) return [];
    const firstRow = extractRowValues(snapshot, rowNodeIds[0]);
    return firstRow.map((_, index) => `col_${index + 1}`);
};

const extractHeaders = (snapshot: SnapshotResult, rowNodeId: string): string[] => {
    const row = snapshot.nodeIndex[rowNodeId];
    if (!row) return [];
    return row.children
        .filter((child) => normalizeText(child.role) === 'columnheader')
        .map((cell) => readNodeText(cell))
        .map((value, index) => value || `col_${index + 1}`);
};

const extractRowValues = (snapshot: SnapshotResult, rowNodeId: string): string[] => {
    const row = snapshot.nodeIndex[rowNodeId];
    if (!row) return [];
    return row.children
        .filter((child) => normalizeText(child.role) === 'cell')
        .map((cell) => readNodeText(cell) || '');
};

const readNodeText = (node: SnapshotResult['root']): string => {
    if (node.name) return normalizeText(node.name) || '';
    if (typeof node.content === 'string') return normalizeText(node.content) || '';
    return '';
};

const resolveRecommendedPrimaryKey = (rows: string[][], headers: string[]): string[] | null => {
    if (rows.length === 0 || headers.length === 0) return null;
    for (let width = 1; width <= Math.min(3, headers.length); width += 1) {
        const indices = Array.from({ length: width }, (_, index) => index);
        const duplicateCount = countTupleDuplicates(rows, indices);
        if (duplicateCount === 0) {
            return indices.map((index) => headers[index]);
        }
    }
    const best = findBestSingleColumn(rows);
    if (best < 0) return null;
    return [headers[best]];
};

const countTupleDuplicates = (rows: string[][], indices: number[]): number => {
    const tuples = rows
        .map((row) => indices.map((index) => normalizeText(row[index] || '')).join('||'))
        .filter(Boolean);
    if (tuples.length === 0) return 0;
    return tuples.length - new Set(tuples).size;
};

const findBestSingleColumn = (rows: string[][]): number => {
    let bestIndex = -1;
    let bestDuplicates = Number.POSITIVE_INFINITY;
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const duplicates = countTupleDuplicates(rows, [columnIndex]);
        if (duplicates < bestDuplicates) {
            bestDuplicates = duplicates;
            bestIndex = columnIndex;
        }
    }
    return bestIndex;
};

const pickNodeDebugAttrs = (attrs: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!attrs) return undefined;
    const keys = ['id', 'name', 'type', 'role', 'href', 'src', 'aria-label', 'placeholder'];
    const out: Record<string, string> = {};
    for (const key of keys) {
        const value = normalizeText(attrs[key]);
        if (!value) continue;
        out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
};
