import type { ControlIndex } from '../../control/model/contracts';
import type {PageObservation} from '../../../observation/model/contracts';
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
    observation: PageObservation,
): ControlSlotBuildResult => {
    const occurrences = new Map<string, Array<{
        rowId: string;
        controlId: string;
        nodeId: string;
        columnId: string;
        structuralPosition: number;
        kind: NonNullable<typeof controls.controls[string]>['kind'];
        label?: string;
    }>>();
    for (const row of rows) {
        for (const cellId of row.cellIds) {
            const cell = cells[cellId];
            cell.controlIds.forEach((controlId, structuralPosition) => {
                if (structuralPosition >= MAX_STRUCTURAL_SLOT_BUCKETS) {return;}
                const control = controls.controls[controlId];
                const nodeId = control.controlNodeId ?? control.rootNodeId;
                const label = controlLabel(observation, nodeId);
                const key = `${cell.columnId}|${structuralPosition}|${control.kind}|${normalizeLabel(label)}`;
                const bucket = occurrences.get(key) ?? [];
                bucket.push({
                    rowId: row.id,
                    controlId,
                    nodeId,
                    columnId: cell.columnId,
                    structuralPosition,
                    kind: control.kind,
                    ...(label ? {label} : {}),
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
            ...(exemplar.label ? {label: exemplar.label} : {}),
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

const controlLabel = (observation: PageObservation, nodeId: string): string | undefined => {
    const accessibility = observation.accessibility[nodeId];
    const accessibilityName = accessibility === undefined ? undefined : accessibility.name;
    const value = accessibilityName
        || observation.attributes[nodeId]['aria-label']
        || observation.attributes[nodeId].title
        || observation.text[nodeId];
    if (!value) {return undefined;}
    return value.replace(/\s+/gu, ' ').trim() || undefined;
};

const normalizeLabel = (value: string | undefined): string =>
    value?.replace(/\s+/gu, '').toLocaleLowerCase() ?? '';
