import type { ControlIndex } from '../../control/model/contracts';
import type { FeatureCoverResult, TableCell, TableRow } from '../model/contracts';

export const buildFeatureCover = (
    rows: readonly TableRow[],
    cells: Readonly<Record<string, TableCell>>,
    controls: ControlIndex,
): FeatureCoverResult => {
    const featuresByRow = new Map(rows.map((row) => [row.id, rowFeatures(row, cells, controls)]));
    const requiredFeatures = new Set([...featuresByRow.values()].flatMap((features) => [...features]));
    const uncovered = new Set(requiredFeatures);
    const representativeRowIds: string[] = [];

    while (uncovered.size > 0) {
        const candidate = rows
            .filter((row) => !representativeRowIds.includes(row.id))
            .map((row) => ({
                row,
                newlyCovered: [...(featuresByRow.get(row.id) ?? [])].filter((feature) => uncovered.has(feature)),
            }))
            .sort((left, right) => right.newlyCovered.length - left.newlyCovered.length || left.row.index - right.row.index)[0];
        if (!candidate || candidate.newlyCovered.length === 0) {break;}
        representativeRowIds.push(candidate.row.id);
        candidate.newlyCovered.forEach((feature) => uncovered.delete(feature));
    }

    return {
        representativeRowIds,
        coveredFeatures: [...requiredFeatures].filter((feature) => !uncovered.has(feature)).sort(),
        uncoveredFeatures: [...uncovered].sort(),
    };
};

const rowFeatures = (
    row: TableRow,
    cells: Readonly<Record<string, TableCell>>,
    controls: ControlIndex,
): Set<string> => {
    const result = new Set<string>();
    const rowCells = row.cellIds.map((cellId) => cells[cellId]).filter(Boolean);
    result.add(`cell-count:${rowCells.length}`);
    if (row.selected !== undefined) {result.add(`selected:${row.selected}`);}
    if (row.expanded !== undefined) {result.add(`expanded:${row.expanded}`);}
    if (row.level !== undefined) {result.add(`level:${row.level}`);}
    for (const cell of rowCells) {
        result.add(`cell:${cell.columnIndex}:span:${cell.columnSpan}x${cell.rowSpan}`);
        const multiplicity = new Map<string, number>();
        cell.controlIds.forEach((controlId, position) => {
            const kind = controls.controls[controlId]?.kind ?? 'unknown';
            result.add(`control:${cell.columnIndex}:${position}:${kind}`);
            multiplicity.set(kind, (multiplicity.get(kind) ?? 0) + 1);
        });
        for (const [kind, count] of multiplicity) {
            result.add(`control-count:${cell.columnIndex}:${kind}:${Math.min(count, 4)}`);
        }
    }
    return result;
};
