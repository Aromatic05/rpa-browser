import type { ControlIndex } from '../../control/model/contracts';
import type {
    CellControlSlot,
    TableCell,
    TableRow,
    TableRowException,
} from '../model/contracts';
import { evidence } from './dom';

const MAX_STRUCTURAL_SLOT_BUCKETS = 4;

export type ControlSlotBuildResult = {
    slots: CellControlSlot[];
    rowExceptions: TableRowException[];
};

export const buildControlSlots = (
    tableId: string,
    rows: readonly TableRow[],
    cells: Readonly<Record<string, TableCell>>,
    controls: ControlIndex,
): ControlSlotBuildResult => {
    const occurrences = new Map<string, Array<{
        rowId: string;
        controlId: string;
        nodeId: string;
        columnId: string;
        structuralPosition: number;
        kind: NonNullable<typeof controls.controls[string]>['kind'];
    }>>();
    for (const row of rows) {
        for (const cellId of row.cellIds) {
            const cell = cells[cellId];
            cell.controlIds.forEach((controlId, structuralPosition) => {
                if (structuralPosition >= MAX_STRUCTURAL_SLOT_BUCKETS) {return;}
                const control = controls.controls[controlId];
                const key = `${cell.columnId}|${structuralPosition}|${control.kind}`;
                const bucket = occurrences.get(key) ?? [];
                bucket.push({
                    rowId: row.id,
                    controlId,
                    nodeId: control.controlNodeId ?? control.rootNodeId,
                    columnId: cell.columnId,
                    structuralPosition,
                    kind: control.kind,
                });
                occurrences.set(key, bucket);
            });
        }
    }

    const slottedControlIds = new Set<string>();
    const slots: CellControlSlot[] = [];
    for (const [key, bucket] of occurrences) {
        const distinctRows = new Set(bucket.map((item) => item.rowId));
        if (distinctRows.size < 2) {continue;}
        bucket.forEach((item) => slottedControlIds.add(item.controlId));
        const exemplar = bucket[0];
        slots.push({
            id: `${tableId}:slot:${key}`,
            columnId: exemplar.columnId,
            structuralPosition: exemplar.structuralPosition,
            controlKind: exemplar.kind,
            occurrenceCount: bucket.length,
            exemplarNodeIds: unique(bucket.map((item) => item.nodeId)).slice(0, 3),
            controlIds: bucket.map((item) => item.controlId),
        });
    }

    const rowExceptions = rows.flatMap((row) => {
        const controlIds = row.cellIds
            .flatMap((cellId) => cells[cellId].controlIds)
            .filter((controlId) => !slottedControlIds.has(controlId));
        if (controlIds.length === 0) {return [];}
        const nodeIds = controlIds
            .map((controlId) => controls.controls[controlId].rootNodeId)
            .filter((nodeId): nodeId is string => Boolean(nodeId));
        return [{
            rowId: row.id,
            controlIds,
            evidence: [evidence('table.row.control-exception', 'strong', 'dom', nodeIds)],
        }];
    });
    return { slots, rowExceptions };
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
