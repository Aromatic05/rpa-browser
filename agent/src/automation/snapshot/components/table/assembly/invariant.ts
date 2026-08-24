import type { AnalysisDiagnostic, PageObservation } from '../../../observation/model/contracts';
import type { ControlIndex } from '../../control/model/contracts';
import type { TableComponentIndex, TableInvariantValidation } from '../model/contracts';

export const validateTableComponentIndex = (
    index: TableComponentIndex,
    observation: PageObservation,
    controls: ControlIndex,
): TableInvariantValidation => {
    const diagnostics: AnalysisDiagnostic[] = [];
    const add = (code: string, message: string, nodeIds: string[] = []) => diagnostics.push({
        code,
        severity: 'error',
        stage: 'table-invariant',
        status: 'ambiguous',
        nodeIds,
        evidence: [],
        message,
    });

    for (const table of Object.values(index.tables)) {
        if (!Object.hasOwn(observation.nodes, table.location.structuralRootNodeId)) {
            add('table.root.missing', `table root is missing: ${table.id}`);
        }
        const columnIds = new Set(table.columns.map((column) => column.id));
        if (columnIds.size !== table.columns.length) {
            add('table.column.duplicate', `table has duplicate columns: ${table.id}`);
        }
        for (const row of table.body.visibleRows) {
            if (index.rows[row.id] !== row) {
                add('table.row.index-missing', `canonical row is missing from RowIndex: ${row.id}`, [row.nodeId]);
            }
            for (const cellId of row.cellIds) {
                if (!Object.hasOwn(index.cells, cellId)) {
                    add('table.cell.index-missing', `cell is missing from CellIndex: ${cellId}`, [row.nodeId]);
                    continue;
                }
                const cell = index.cells[cellId];
                if (!columnIds.has(cell.columnId)) {
                    add('table.cell.column-missing', `cell references unknown column: ${cell.id}`, [cell.nodeId]);
                }
                for (const controlId of cell.controlIds) {
                    if (!Object.hasOwn(controls.controls, controlId)) {
                        add('table.cell.control-missing', `cell references unknown control: ${controlId}`, [cell.nodeId]);
                    }
                }
            }
        }
        for (const editor of table.editors) {
            if (!Object.hasOwn(index.cells, editor.cellId)) {
                add('table.editor.cell-missing', `editor references unknown cell: ${editor.cellId}`, editor.sourceNodeIds);
                continue;
            }
            if (editor.status === 'resolved' && editor.controlIds.length === 0) {
                add('table.editor.control-empty', `resolved editor has no controls: ${editor.cellId}`, editor.portalNodeIds);
            }
            for (const controlId of editor.controlIds) {
                if (!Object.hasOwn(controls.controls, controlId)) {
                    add('table.editor.control-missing', `editor references unknown control: ${controlId}`, editor.portalNodeIds);
                }
            }
        }
        for (const mirror of table.mirrors) {
            if (mirror.status !== 'resolved' || !mirror.canonicalId) {continue;}
            const exists = mirror.kind === 'row'
                ? Boolean(index.rows[mirror.canonicalId])
                : mirror.kind === 'cell'
                    ? Boolean(index.cells[mirror.canonicalId])
                    : Boolean(index.columns[mirror.canonicalId]);
            if (!exists) {
                add('table.mirror.canonical-missing', `mirror references unknown canonical ${mirror.kind}: ${mirror.canonicalId}`, [mirror.mirrorNodeId]);
            }
        }
        const rowIdByControlId = new Map<string, string>();
        for (const row of table.body.visibleRows) {
            for (const cellId of row.cellIds) {
                for (const controlId of index.cells[cellId].controlIds) {
                    rowIdByControlId.set(controlId, row.id);
                }
            }
        }
        for (const slot of table.controlSlots) {
            if (slot.occurrenceCount < 2) {
                add('table.slot.under-repeated', `slot must repeat across rows: ${slot.id}`);
            }
            if (!columnIds.has(slot.columnId)) {
                add('table.slot.column-missing', `slot references unknown column: ${slot.id}`);
            }
            const occurrenceCountByRow = new Map<string, number>();
            for (const controlId of slot.controlIds) {
                const rowId = rowIdByControlId.get(controlId);
                if (!rowId) {
                    add('table.slot.control-row-missing', `slot control is not owned by a canonical row: ${controlId}`);
                    continue;
                }
                occurrenceCountByRow.set(rowId, (occurrenceCountByRow.get(rowId) ?? 0) + 1);
            }
            if ([...occurrenceCountByRow.values()].some((count) => count > 1)) {
                add('table.slot.multiple-per-row', `slot merges different relative positions within a row: ${slot.id}`);
            }
        }
        if (table.featureCover.uncoveredFeatures.length > 0) {
            add('table.feature-cover.incomplete', `required row features remain uncovered: ${table.id}`);
        }
    }
    diagnostics.push(...index.ownership.diagnostics);
    return { ok: diagnostics.length === 0, diagnostics };
};
