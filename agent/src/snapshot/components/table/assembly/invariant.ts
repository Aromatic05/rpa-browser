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
        if (!observation.nodes[table.location.structuralRootNodeId]) {
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
                const cell = index.cells[cellId];
                if (!cell) {
                    add('table.cell.index-missing', `cell is missing from CellIndex: ${cellId}`, [row.nodeId]);
                    continue;
                }
                if (!columnIds.has(cell.columnId)) {
                    add('table.cell.column-missing', `cell references unknown column: ${cell.id}`, [cell.nodeId]);
                }
                for (const controlId of cell.controlIds) {
                    if (!controls.controls[controlId]) {
                        add('table.cell.control-missing', `cell references unknown control: ${controlId}`, [cell.nodeId]);
                    }
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
        }
        if (table.featureCover.uncoveredFeatures.length > 0) {
            add('table.feature-cover.incomplete', `required row features remain uncovered: ${table.id}`);
        }
    }
    diagnostics.push(...index.ownership.diagnostics);
    return { ok: diagnostics.length === 0, diagnostics };
};
