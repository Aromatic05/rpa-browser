import type { ObservationNodeId, PageObservation } from '../../../observation/model/contracts';
import type { TableColumn, TableHeaderCell, TableHeaderModel } from '../model/contracts';
import { evidence, nodeText, rowCellNodeIds } from './dom';

export type HeaderBuildResult = {
    header: TableHeaderModel;
    columns: TableColumn[];
};

export const buildHeader = (
    observation: PageObservation,
    tableId: string,
    ownerRootId: ObservationNodeId,
    allRootIds: ReadonlySet<ObservationNodeId>,
    groups: ReadonlyArray<{ rowNodeIds: readonly ObservationNodeId[]; columnOffset: number }>,
): HeaderBuildResult => {
    const cells: Record<string, TableHeaderCell> = {};
    let rowCount = 0;
    let maximumColumn = 0;

    for (const group of groups) {
        const occupancy: boolean[][] = [];
        group.rowNodeIds.forEach((rowNodeId, localRowIndex) => {
            const rowIndex = localRowIndex;
            rowCount = Math.max(rowCount, localRowIndex + 1);
            occupancy[rowIndex] ??= [];
            let columnIndex = group.columnOffset;
            for (const cellNodeId of rowCellNodeIds(observation, rowNodeId, allRootIds, ownerRootId)) {
                while (occupancy[rowIndex][columnIndex]) {columnIndex += 1;}
                const attributes = observation.attributes[cellNodeId] ?? {};
                const columnSpan = positiveInteger(attributes.colspan) ?? 1;
                const rowSpan = positiveInteger(attributes.rowspan) ?? 1;
                const id = `${tableId}:header:${cellNodeId}`;
                cells[id] = {
                    id,
                    nodeId: cellNodeId,
                    name: nodeText(observation, cellNodeId),
                    rowIndex,
                    columnStart: columnIndex,
                    columnSpan,
                    rowSpan,
                    childCellIds: [],
                    evidence: [evidence('table.header.cell', 'exact', 'dom', [cellNodeId], {
                        rowIndex,
                        columnStart: columnIndex,
                        columnSpan,
                        rowSpan,
                    })],
                };
                for (let row = rowIndex; row < rowIndex + rowSpan; row += 1) {
                    occupancy[row] ??= [];
                    for (let column = columnIndex; column < columnIndex + columnSpan; column += 1) {
                        occupancy[row][column] = true;
                    }
                }
                columnIndex += columnSpan;
                maximumColumn = Math.max(maximumColumn, columnIndex);
            }
        });
    }

    const orderedCells = Object.values(cells).sort((left, right) =>
        left.rowIndex - right.rowIndex || left.columnStart - right.columnStart);
    for (const cell of orderedCells) {
        const parent = orderedCells
            .filter((candidate) => candidate.rowIndex < cell.rowIndex)
            .filter((candidate) => candidate.rowIndex + candidate.rowSpan === cell.rowIndex)
            .filter((candidate) => containsColumnRange(candidate, cell))
            .sort((left, right) => right.rowIndex - left.rowIndex || left.columnSpan - right.columnSpan).at(0);
        if (!parent) {continue;}
        cell.parentCellId = parent.id;
        parent.childCellIds.push(cell.id);
    }

    const columns: TableColumn[] = [];
    for (let index = 0; index < maximumColumn; index += 1) {
        const path = orderedCells
            .filter((cell) => cell.columnStart <= index && index < cell.columnStart + cell.columnSpan)
            .filter((cell) => cell.rowIndex + cell.rowSpan <= rowCount)
            .sort((left, right) => left.rowIndex - right.rowIndex);
        const leaf = [...path].reverse().find((cell) => cell.childCellIds.length === 0) ?? path.at(-1);
        const names = unique(path.map((cell) => cell.name).filter(Boolean));
        const id = `${tableId}:column:${index}`;
        columns.push({
            id,
            index,
            name: names.join(' / ') || `Column ${index + 1}`,
            headerCellIds: path.map((cell) => cell.id),
            sourceNodeIds: path.map((cell) => cell.nodeId),
            evidence: leaf
                ? [evidence('table.column.header-path', 'strong', 'dom', path.map((cell) => cell.nodeId), { index })]
                : [],
        });
    }

    return {
        header: {
            rowCount,
            cells,
            rootCellIds: orderedCells.filter((cell) => !cell.parentCellId).map((cell) => cell.id),
            leafColumnIds: columns.map((column) => column.id),
        },
        columns,
    };
};

export const ensureColumnCount = (
    tableId: string,
    columns: TableColumn[],
    count: number,
): TableColumn[] => {
    const result = [...columns];
    while (result.length < count) {
        const index = result.length;
        result.push({
            id: `${tableId}:column:${index}`,
            index,
            name: `Column ${index + 1}`,
            headerCellIds: [],
            sourceNodeIds: [],
            evidence: [],
        });
    }
    return result;
};

const containsColumnRange = (parent: TableHeaderCell, child: TableHeaderCell): boolean =>
    parent.columnStart <= child.columnStart
    && child.columnStart + child.columnSpan <= parent.columnStart + parent.columnSpan;

const positiveInteger = (value: string | undefined): number | undefined => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
