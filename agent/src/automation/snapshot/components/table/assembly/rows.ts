import type { ObservationNodeId, PageObservation } from '../../../observation/model/contracts';
import type { ControlComponent, ControlIndex } from '../../control/model/contracts';
import type { TableCell, TableColumn, TableRow } from '../model/contracts';
import {
    directOwnedRows,
    evidence,
    isDescendantOrSelf,
    nodeText,
    rowCellNodeIds,
} from './dom';
import { ensureColumnCount } from './header';

export type RowBuildResult = {
    rows: TableRow[];
    cells: Record<string, TableCell>;
    columns: TableColumn[];
};

export const buildRows = (
    observation: PageObservation,
    controls: ControlIndex,
    tableId: string,
    ownerRootId: ObservationNodeId,
    allRootIds: ReadonlySet<ObservationNodeId>,
    columns: TableColumn[],
    canonicalPartNodeIds: readonly ObservationNodeId[],
): RowBuildResult => {
    const rowNodeIds = unique(canonicalPartNodeIds.flatMap((partNodeId) =>
        directOwnedRows(observation, ownerRootId, partNodeId, allRootIds)));
    const maximumCellCount = measureColumnCount(
        observation,
        rowNodeIds,
        allRootIds,
        ownerRootId,
    );
    const resolvedColumns = ensureColumnCount(tableId, columns, maximumCellCount);
    const cells: Record<string, TableCell> = {};
    const occupancy: boolean[][] = [];
    const rows = rowNodeIds.map((rowNodeId, index) => buildRow(
        observation,
        controls,
        tableId,
        ownerRootId,
        allRootIds,
        resolvedColumns,
        rowNodeId,
        index,
        0,
        cells,
        occupancy,
    ));
    return { rows, cells, columns: resolvedColumns };
};

export const mergeFixedRows = (
    observation: PageObservation,
    controls: ControlIndex,
    tableId: string,
    ownerRootId: ObservationNodeId,
    allRootIds: ReadonlySet<ObservationNodeId>,
    columns: TableColumn[],
    rows: TableRow[],
    cells: Record<string, TableCell>,
    partNodeIds: readonly ObservationNodeId[],
    columnOffset: number,
): void => {
    const fixedRowNodeIds = unique(partNodeIds.flatMap((partNodeId) =>
        directOwnedRows(observation, ownerRootId, partNodeId, allRootIds)));
    const rowsByKey = new Map(rows.filter((row) => row.key).map((row) => [row.key!, row]));
    const occupancy: boolean[][] = [];
    fixedRowNodeIds.forEach((fixedRowNodeId, index) => {
        const key = rowKey(observation, fixedRowNodeId);
        const targetRow = (key ? rowsByKey.get(key) : undefined) ?? rows.at(index);
        if (!targetRow) {return;}
        const fixedCellNodeIds = rowCellNodeIds(observation, fixedRowNodeId, allRootIds, ownerRootId);
        appendCells(
            observation,
            controls,
            targetRow,
            allRootIds,
            ownerRootId,
            columns,
            fixedCellNodeIds,
            columnOffset,
            cells,
            index,
            occupancy,
        );
    });
};

const buildRow = (
    observation: PageObservation,
    controls: ControlIndex,
    tableId: string,
    ownerRootId: ObservationNodeId,
    allRootIds: ReadonlySet<ObservationNodeId>,
    columns: TableColumn[],
    rowNodeId: ObservationNodeId,
    index: number,
    columnOffset: number,
    cells: Record<string, TableCell>,
    occupancy: boolean[][],
): TableRow => {
    const attributes = observation.attributes[rowNodeId] ?? {};
    const row: TableRow = {
        id: `${tableId}:row:${rowNodeId}`,
        nodeId: rowNodeId,
        tableId,
        index,
        key: rowKey(observation, rowNodeId),
        cellIds: [],
        selected: booleanAttribute(attributes['aria-selected'] ?? attributes.selected),
        expanded: booleanAttribute(attributes['aria-expanded']),
        level: positiveInteger(attributes['aria-level']),
        evidence: [evidence('table.row.canonical', 'exact', 'dom', [rowNodeId], { index })],
        diagnostics: [],
    };
    appendCells(
        observation,
        controls,
        row,
        allRootIds,
        ownerRootId,
        columns,
        rowCellNodeIds(observation, rowNodeId, allRootIds, ownerRootId),
        columnOffset,
        cells,
        index,
        occupancy,
    );
    return row;
};

const appendCells = (
    observation: PageObservation,
    controls: ControlIndex,
    row: TableRow,
    allRootIds: ReadonlySet<ObservationNodeId>,
    ownerRootId: ObservationNodeId,
    columns: TableColumn[],
    cellNodeIds: readonly ObservationNodeId[],
    columnOffset: number,
    cells: Record<string, TableCell>,
    rowIndex: number,
    occupancy: boolean[][],
): void => {
    occupancy[rowIndex] ??= [];
    let columnIndex = columnOffset;
    for (const cellNodeId of cellNodeIds) {
        while (occupancy[rowIndex][columnIndex]
            || row.cellIds.some((cellId) => cells[cellId].columnIndex === columnIndex)) {
            columnIndex += 1;
        }
        const attributes = observation.attributes[cellNodeId] ?? {};
        const columnSpan = positiveInteger(attributes.colspan) ?? 1;
        const rowSpan = positiveInteger(attributes.rowspan) ?? 1;
        const column = columns.at(columnIndex);
        if (!column) {break;}
        const controlIds = controlsInCell(observation, controls, cellNodeId, allRootIds, ownerRootId)
            .map((control) => control.id);
        const cellId = `${row.id}:cell:${columnIndex}:${cellNodeId}`;
        cells[cellId] = {
            id: cellId,
            rowId: row.id,
            columnId: column.id,
            nodeId: cellNodeId,
            columnIndex,
            columnSpan,
            rowSpan,
            text: nodeText(observation, cellNodeId),
            controlIds,
            evidence: [evidence('table.cell.canonical', 'exact', 'dom', [cellNodeId], { columnIndex })],
        };
        row.cellIds.push(cellId);
        occupy(occupancy, rowIndex, columnIndex, rowSpan, columnSpan);
        columnIndex += columnSpan;
    }
};

const controlsInCell = (
    observation: PageObservation,
    controls: ControlIndex,
    cellNodeId: ObservationNodeId,
    allRootIds: ReadonlySet<ObservationNodeId>,
    ownerRootId: ObservationNodeId,
): ControlComponent[] => Object.values(controls.controls)
    .filter((control) => control.memberNodeIds.some((nodeId) => isDescendantOrSelf(observation, nodeId, cellNodeId))
        || isDescendantOrSelf(observation, control.rootNodeId, cellNodeId))
    .filter((control) => nearestRoot(observation, control.rootNodeId, allRootIds) === ownerRootId)
    .sort((left, right) => (observation.documentOrder[left.rootNodeId] ?? Number.MAX_SAFE_INTEGER)
        - (observation.documentOrder[right.rootNodeId] ?? Number.MAX_SAFE_INTEGER));

const nearestRoot = (
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

const measureColumnCount = (
    observation: PageObservation,
    rowNodeIds: readonly ObservationNodeId[],
    allRootIds: ReadonlySet<ObservationNodeId>,
    ownerRootId: ObservationNodeId,
): number => {
    const occupancy: boolean[][] = [];
    let maximumColumn = 0;
    rowNodeIds.forEach((rowNodeId, rowIndex) => {
        occupancy[rowIndex] ??= [];
        let columnIndex = 0;
        for (const cellNodeId of rowCellNodeIds(observation, rowNodeId, allRootIds, ownerRootId)) {
            while (occupancy[rowIndex][columnIndex]) {columnIndex += 1;}
            const attributes = observation.attributes[cellNodeId] ?? {};
            const columnSpan = positiveInteger(attributes.colspan) ?? 1;
            const rowSpan = positiveInteger(attributes.rowspan) ?? 1;
            occupy(occupancy, rowIndex, columnIndex, rowSpan, columnSpan);
            columnIndex += columnSpan;
            maximumColumn = Math.max(maximumColumn, columnIndex);
        }
    });
    return maximumColumn;
};

const occupy = (
    occupancy: boolean[][],
    rowStart: number,
    columnStart: number,
    rowSpan: number,
    columnSpan: number,
): void => {
    for (let rowIndex = rowStart; rowIndex < rowStart + rowSpan; rowIndex += 1) {
        occupancy[rowIndex] ??= [];
        for (let columnIndex = columnStart; columnIndex < columnStart + columnSpan; columnIndex += 1) {
            occupancy[rowIndex][columnIndex] = true;
        }
    }
};

const rowKey = (observation: PageObservation, rowNodeId: ObservationNodeId): string | undefined => {
    const attributes = observation.attributes[rowNodeId] ?? {};
    const candidates: Array<string | undefined> = [
        attributes['data-row-key'],
        attributes['row-key'],
        attributes.key,
        attributes['aria-rowindex'],
    ];
    return candidates.map((value) => value?.trim()).find(Boolean);
};

const positiveInteger = (value: string | undefined): number | undefined => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const booleanAttribute = (value: string | undefined): boolean | undefined => {
    if (value === undefined) {return undefined;}
    return value === '' || value.toLowerCase() === 'true';
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
