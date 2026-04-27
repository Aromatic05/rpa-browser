import { getNodeAttr, getNodeContent, normalizeText } from './runtime_store';
import type { SnapshotResult, UnifiedNode } from './types';

export type TableModelCell = {
    nodeId: string;
    value: string;
    interactiveNodeIds: string[];
};

export type TableModelRow = {
    nodeId: string;
    cells: TableModelCell[];
};

export type TableModelPrimaryKeyCandidate = {
    columns: string[];
    unique: boolean;
    duplicateCount: number;
};

export type TableStructureModel = {
    tableNodeId: string;
    headers: string[];
    headerNodeIds: Array<string | undefined>;
    rows: TableModelRow[];
    columnCount: number;
    columnCellNodeIdsByHeader: Record<string, string[] | undefined>;
    primaryKeyCandidates: TableModelPrimaryKeyCandidate[];
    recommendedPrimaryKey?: string[];
};

export const buildTableStructureModel = (snapshot: SnapshotResult, tableNodeId: string): TableStructureModel | null => {
    const tableNode = snapshot.nodeIndex[tableNodeId];
    if (!tableNode || !isTableRole(tableNode.role)) {return null;}

    const rowNodes = collectRowNodes(tableNode);
    const headerRows = rowNodes.filter((row) => getHeaderCells(row).length > 0);
    const bodyRows = rowNodes.filter((row) => getDataCells(row).length > 0);

    const headers = resolveHeaders(snapshot, headerRows, bodyRows);
    const rows = bodyRows.map((row) => buildRowModel(row)).filter((row) => row.cells.length > 0);
    const columnCount = Math.max(headers.length, rows.reduce((max, row) => Math.max(max, row.cells.length), 0));
    const normalizedHeaders = headers.length > 0 ? headers : Array.from({ length: columnCount }, (_, index) => `col_${index + 1}`);
    const headerNodeIds = resolveHeaderNodeIds(snapshot, headerRows, normalizedHeaders);

    const columnCellNodeIdsByHeader: Record<string, string[] | undefined> = {};
    for (let columnIndex = 0; columnIndex < normalizedHeaders.length; columnIndex += 1) {
        const header = normalizedHeaders[columnIndex];
        const cellIds = rows.map((row) => row.cells[columnIndex]?.nodeId).filter((value): value is string => Boolean(value));
        columnCellNodeIdsByHeader[header] = cellIds.length > 0 ? cellIds : undefined;
    }

    const primaryKeyCandidates = buildPrimaryKeyCandidates(rows, normalizedHeaders);
    const recommendedPrimaryKey = resolveRecommendedPrimaryKey(rows, normalizedHeaders) || undefined;
    if (
        recommendedPrimaryKey &&
        !primaryKeyCandidates.some(
            (item) =>
                item.columns.length === recommendedPrimaryKey.length &&
                item.columns.every((column, index) => column === recommendedPrimaryKey[index]),
        )
    ) {
        const indices = recommendedPrimaryKey.map((_, index) => index);
        primaryKeyCandidates.push({
            columns: recommendedPrimaryKey,
            unique: countTupleDuplicates(rows, indices) === 0,
            duplicateCount: countTupleDuplicates(rows, indices),
        });
    }

    return {
        tableNodeId,
        headers: normalizedHeaders,
        headerNodeIds,
        rows,
        columnCount,
        columnCellNodeIdsByHeader,
        primaryKeyCandidates,
        recommendedPrimaryKey,
    };
};

const collectRowNodes = (tableNode: UnifiedNode): UnifiedNode[] => {
    const rows: UnifiedNode[] = [];
    walkDescendants(tableNode, (node) => {
        if (isRowRole(node.role)) {
            rows.push(node);
        }
    });
    return rows;
};

const getHeaderCells = (row: UnifiedNode): UnifiedNode[] => {
    return row.children.filter((child) => isHeaderRole(child.role));
};

const getDataCells = (row: UnifiedNode): UnifiedNode[] => {
    const direct = row.children.filter((child) => isCellRole(child.role));
    if (direct.length > 0) {return direct;}
    return row.children.filter((child) => !isRowRole(child.role));
};

const resolveHeaders = (
    snapshot: SnapshotResult,
    headerRows: UnifiedNode[],
    bodyRows: UnifiedNode[],
): string[] => {
    for (const row of headerRows) {
        const headers = getHeaderCells(row)
            .map((cell) => readNodeText(cell))
            .map((value, index) => value || `col_${index + 1}`);
        if (headers.length > 0) {return headers;}
    }

    if (bodyRows.length === 0) {return [];}
    const firstValues = getDataCells(bodyRows[0]).map((cell) => readNodeText(cell));
    return firstValues.map((_, index) => `col_${index + 1}`);
};

const resolveHeaderNodeIds = (
    _snapshot: SnapshotResult,
    headerRows: UnifiedNode[],
    headers: string[],
): Array<string | undefined> => {
    for (const row of headerRows) {
        const cells = getHeaderCells(row);
        if (cells.length === 0) {continue;}
        return headers.map((_, index) => cells[index]?.id);
    }
    return headers.map(() => undefined);
};

const buildRowModel = (row: UnifiedNode): TableModelRow => {
    const dataCells = getDataCells(row);
    return {
        nodeId: row.id,
        cells: dataCells.map((cell) => ({
            nodeId: cell.id,
            value: readNodeText(cell),
            interactiveNodeIds: collectInteractiveNodeIds(cell),
        })),
    };
};

const collectInteractiveNodeIds = (node: UnifiedNode): string[] => {
    const ids: string[] = [];
    const stack = [node];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {break;}
        if (isInteractiveNode(current)) {
            ids.push(current.id);
        }
        for (let index = current.children.length - 1; index >= 0; index -= 1) {
            stack.push(current.children[index]);
        }
    }
    return ids;
};

const buildPrimaryKeyCandidates = (
    rows: TableModelRow[],
    headers: string[],
): TableModelPrimaryKeyCandidate[] => {
    const candidates: TableModelPrimaryKeyCandidate[] = [];
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
        const values = rows
            .map((row) => normalizeText(row.cells[columnIndex]?.value || ''))
            .filter((value): value is string => Boolean(value));
        if (values.length === 0) {continue;}
        const uniqueCount = new Set(values).size;
        const duplicateCount = values.length - uniqueCount;
        candidates.push({
            columns: [headers[columnIndex]],
            unique: duplicateCount === 0,
            duplicateCount,
        });
    }
    return candidates;
};

const resolveRecommendedPrimaryKey = (
    rows: TableModelRow[],
    headers: string[],
): string[] | null => {
    if (rows.length === 0 || headers.length === 0) {return null;}
    for (let width = 1; width <= Math.min(3, headers.length); width += 1) {
        const indices = Array.from({ length: width }, (_, index) => index);
        const duplicateCount = countTupleDuplicates(rows, indices);
        if (duplicateCount === 0) {
            return indices.map((index) => headers[index]);
        }
    }
    const best = findBestSingleColumn(rows);
    if (best < 0) {return null;}
    return [headers[best]];
};

const countTupleDuplicates = (rows: TableModelRow[], indices: number[]): number => {
    const tuples = rows
        .map((row) => indices.map((index) => normalizeText(row.cells[index]?.value || '')).join('||'))
        .filter(Boolean);
    if (tuples.length === 0) {return 0;}
    return tuples.length - new Set(tuples).size;
};

const findBestSingleColumn = (rows: TableModelRow[]): number => {
    let bestIndex = -1;
    let bestDuplicates = Number.POSITIVE_INFINITY;
    const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const duplicates = countTupleDuplicates(rows, [columnIndex]);
        if (duplicates < bestDuplicates) {
            bestDuplicates = duplicates;
            bestIndex = columnIndex;
        }
    }
    return bestIndex;
};

const readNodeText = (node: UnifiedNode): string => {
    if (node.name) {return normalizeText(node.name) || '';}
    if (typeof node.content === 'string') {return normalizeText(node.content) || '';}
    return normalizeText(getNodeContent(node)) || '';
};

const walkDescendants = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    for (const child of node.children) {
        visitor(child);
        walkDescendants(child, visitor);
    }
};

const isTableRole = (role: string): boolean => {
    const normalized = normalizeLower(role);
    return normalized === 'table' || normalized === 'grid' || normalized === 'treegrid';
};

const isRowRole = (role: string): boolean => {
    return normalizeLower(role) === 'row';
};

const isHeaderRole = (role: string): boolean => {
    const normalized = normalizeLower(role);
    return normalized === 'columnheader' || normalized === 'rowheader';
};

const isCellRole = (role: string): boolean => {
    const normalized = normalizeLower(role);
    return normalized === 'cell' || normalized === 'gridcell' || normalized === 'columnheader' || normalized === 'rowheader';
};

const isInteractiveNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio' || role === 'menuitem' || role === 'switch') {
        return true;
    }
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') {return true;}
    return false;
};

const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase() || '';
