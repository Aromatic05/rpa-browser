import type {
    AnalysisDiagnostic,
    AssemblyStatus,
    ObservationNodeId,
    PageObservation,
} from '../../../observation/model/contracts';
import { deepFreeze } from '../../../observation/model/freeze';
import { buildOwnershipIndex } from '../../../indexes/ownership/build';
import type { OwnershipEdge } from '../../../indexes/ownership/contracts';
import type {
    BuildTableSnapshotInput,
    LogicalTableRoot,
    TableCell,
    TableColumn,
    TableComponent,
    TableComponentIndex,
    TableFooterModel,
    TableRow,
    TableSnapshot,
} from '../model/contracts';
import { buildControlSlots } from './control_slots';
import { buildCellEditors } from './editors';
import {
    buildTableParts,
    canonicalBodyPartIds,
    canonicalHeaderPartIds,
    evidence,
    findLogicalTableRoots,
    findPaginationNodes,
    footerRows,
    headerRows,
    rowCellNodeIds,
} from './dom';
import { buildFeatureCover } from './feature_cover';
import { buildHeader } from './header';
import { buildRowHierarchy } from './hierarchy';
import { buildTableMirrors } from './mirrors';
import { validateTableComponentIndex } from './invariant';
import { buildRows, mergeFixedRows } from './rows';

export const buildTableSnapshot = (input: BuildTableSnapshotInput): TableSnapshot => ({
    observation: input.observation,
    relations: input.relations,
    locators: input.locators,
    controls: input.controls,
    tables: buildTableComponentIndex(input),
});

export const buildTableComponentIndex = (input: BuildTableSnapshotInput): TableComponentIndex => {
    const logicalRoots = findLogicalTableRoots(input.observation);
    const allRootIds = new Set(logicalRoots.map((root) => root.rootNodeId));
    const tables: Record<string, TableComponent> = {};
    const rows: Record<string, TableRow> = {};
    const cells: Record<string, TableCell> = {};
    const columns: Record<string, TableColumn> = {};
    const diagnostics: AnalysisDiagnostic[] = [];

    for (const root of logicalRoots) {
        const assembled = assembleTable(input, root, logicalRoots, allRootIds);
        tables[assembled.component.id] = assembled.component;
        assembled.component.body.visibleRows.forEach((row) => {rows[row.id] = row;});
        assembled.component.columns.forEach((column) => {columns[column.id] = column;});
        Object.assign(cells, assembled.cells);
        diagnostics.push(...assembled.component.diagnostics);
    }

    const ownership = buildOwnershipIndex(buildTableOwnership(tables, rows, cells, columns));
    diagnostics.push(...ownership.diagnostics);
    const provisional: TableComponentIndex = {
        tables,
        rows,
        cells,
        columns,
        ownership,
        byNodeId: buildNodeIndex(tables, rows, cells, columns),
        diagnostics,
        validation: { ok: true, diagnostics: [] },
    };
    const validation = validateTableComponentIndex(provisional, input.observation, input.controls);
    diagnostics.push(...validation.diagnostics);
    return deepFreeze({ ...provisional, diagnostics, validation });
};

type AssembledTable = {
    component: TableComponent;
    cells: Record<string, TableCell>;
};

const assembleTable = (
    input: BuildTableSnapshotInput,
    root: LogicalTableRoot,
    logicalRoots: readonly LogicalTableRoot[],
    allRootIds: ReadonlySet<ObservationNodeId>,
): AssembledTable => {
    const { observation, controls } = input;
    const tableId = `table:${root.rootNodeId}`;
    const parts = buildTableParts(observation, root);
    const canonicalHeaderRows = headerRows(
        observation,
        root.rootNodeId,
        canonicalHeaderPartIds(root, parts),
        allRootIds,
    );
    const initialHeader = buildHeader(observation, tableId, root.rootNodeId, allRootIds, [{
        rowNodeIds: canonicalHeaderRows,
        columnOffset: 0,
    }]);
    const canonicalRows = buildRows(
        observation,
        controls,
        tableId,
        root.rootNodeId,
        allRootIds,
        initialHeader.columns,
        canonicalBodyPartIds(root, parts),
    );
    const canonicalColumnCount = canonicalRows.columns.length;
    const fixedRightHeaderRows = headerRows(
        observation,
        root.rootNodeId,
        parts.nodeIdsByKind['fixed-right-header'] ?? [],
        allRootIds,
    );
    const finalHeader = buildHeader(observation, tableId, root.rootNodeId, allRootIds, [
        { rowNodeIds: canonicalHeaderRows, columnOffset: 0 },
        { rowNodeIds: fixedRightHeaderRows, columnOffset: canonicalColumnCount },
    ]);
    const resolvedColumns = finalHeader.columns.length >= canonicalColumnCount
        ? finalHeader.columns
        : canonicalRows.columns;
    mergeFixedRows(
        observation,
        controls,
        tableId,
        root.rootNodeId,
        allRootIds,
        resolvedColumns,
        canonicalRows.rows,
        canonicalRows.cells,
        parts.nodeIdsByKind['fixed-right-body'] ?? [],
        canonicalColumnCount,
    );
    const editorModel = buildCellEditors(observation, input.relations, controls, canonicalRows.cells);
    const mirrorModel = buildTableMirrors(
        observation,
        root.rootNodeId,
        allRootIds,
        parts,
        canonicalRows.rows,
        canonicalRows.cells,
        resolvedColumns,
    );
    const featureCover = buildFeatureCover(canonicalRows.rows, canonicalRows.cells, controls);
    const controlModel = buildControlSlots(tableId, canonicalRows.rows, canonicalRows.cells, controls);
    const hierarchy = buildRowHierarchy(observation, canonicalRows.rows);
    const paginationNodes = findPaginationNodes(observation, root, logicalRoots);
    const localDiagnostics = [
        ...hierarchy.diagnostics,
        ...editorModel.diagnostics,
        ...mirrorModel.diagnostics,
    ];
    if (paginationNodes.ambiguous) {
        localDiagnostics.push({
            code: 'table.pagination.ambiguous-owner',
            severity: 'warning',
            stage: 'table-pagination',
            status: 'ambiguous',
            nodeIds: paginationNodes.nodeIds,
            evidence: [evidence('table.pagination.sibling', 'strong', 'adapter', paginationNodes.nodeIds)],
            message: 'pagination has more than one logical table owner in the same scope',
        });
    }
    const footer = buildFooter(observation, root.rootNodeId, parts, allRootIds);
    const rowWindow = buildRowWindow(observation, root.rootNodeId, canonicalRows.rows.length);
    const status = aggregateStatus(localDiagnostics, paginationNodes.ambiguous);
    const suggestions = primaryKeySuggestions(resolvedColumns, canonicalRows.rows, canonicalRows.cells);
    const geometryNodeIds = unique([
        root.hostNodeId,
        root.rootNodeId,
        ...parts.physicalTableNodeIds,
    ].filter((nodeId): nodeId is string => Boolean(nodeId)));

    return {
        cells: canonicalRows.cells,
        component: {
            id: tableId,
            status,
            location: {
                selectionScopeNodeId: input.selectionScopeNodeId,
                hostNodeId: root.hostNodeId,
                structuralRootNodeId: root.rootNodeId,
            },
            parts,
            header: finalHeader.header,
            columns: resolvedColumns,
            body: {
                visibleRows: canonicalRows.rows,
                representativeRowIds: featureCover.representativeRowIds,
                rowWindow,
            },
            featureCover,
            controlSlots: controlModel.slots,
            rowExceptions: controlModel.rowExceptions,
            editors: editorModel.editors,
            mirrors: mirrorModel.mirrors,
            hierarchy: hierarchy.hierarchy,
            footer,
            pagination: paginationNodes.nodeIds.length > 0 ? {
                status: paginationNodes.ambiguous ? 'ambiguous' : 'resolved',
                nodeIds: paginationNodes.nodeIds,
                evidence: [evidence('table.pagination.sibling', 'strong', 'adapter', paginationNodes.nodeIds)],
            } : undefined,
            geometry: geometryNodeIds
                .map((nodeId) => ({ nodeId, records: observation.geometry[nodeId] ?? [] }))
                .filter((fragment) => fragment.records.length > 0),
            suggestions,
            evidence: root.evidence,
            diagnostics: localDiagnostics,
        },
    };
};

const buildFooter = (
    observation: PageObservation,
    rootNodeId: ObservationNodeId,
    parts: ReturnType<typeof buildTableParts>,
    allRootIds: ReadonlySet<ObservationNodeId>,
): TableFooterModel | undefined => {
    const rowNodeIds = footerRows(observation, rootNodeId, parts, allRootIds);
    if (rowNodeIds.length === 0) {return undefined;}
    return {
        rowNodeIds,
        cellNodeIds: rowNodeIds.flatMap((rowNodeId) => rowCellNodeIds(observation, rowNodeId, allRootIds, rootNodeId)),
    };
};

const buildRowWindow = (
    observation: PageObservation,
    rootNodeId: ObservationNodeId,
    visibleCount: number,
): TableComponent['body']['rowWindow'] => {
    const attributes = observation.attributes[rootNodeId] ?? {};
    const totalCount = positiveInteger(attributes['aria-rowcount'] ?? attributes['data-total']);
    const startIndex = positiveInteger(attributes['aria-rowindex'] ?? attributes['data-start-index']);
    const virtualized = /virtual/i.test(attributes.class)
        || (totalCount !== undefined && totalCount > visibleCount);
    return {
        visibleCount,
        totalCount,
        startIndex,
        completeness: virtualized ? 'partial' : 'complete',
    };
};

const primaryKeySuggestions = (
    columns: readonly TableColumn[],
    rows: readonly TableRow[],
    cells: Readonly<Record<string, TableCell>>,
): TableComponent['suggestions'] => columns.flatMap((column) => {
    const columnCells = rows
        .map((row) => row.cellIds.map((cellId) => cells[cellId]).find((cell) => cell.columnId === column.id))
        .filter((cell): cell is TableCell => Boolean(cell));
    const values = columnCells.map((cell) => cell.text.trim()).filter(Boolean);
    const containsControls = columnCells.some((cell) => cell.controlIds.length > 0);
    if (containsControls || values.length < 2 || new Set(values).size !== values.length) {return [];}
    return [{
        kind: 'primary-key-candidate' as const,
        value: column.id,
        source: 'inferred' as const,
        evidence: [evidence('table.column.observed-unique', 'weak', 'dom', columnCells.map((cell) => cell.nodeId), {
            columnId: column.id,
        })],
    }];
});

const buildTableOwnership = (
    tables: Readonly<Record<string, TableComponent>>,
    rows: Readonly<Record<string, TableRow>>,
    cells: Readonly<Record<string, TableCell>>,
    columns: Readonly<Record<string, TableColumn>>,
): OwnershipEdge[] => {
    const edges: OwnershipEdge[] = [];
    for (const table of Object.values(tables)) {
        table.columns.forEach((column) => edges.push({
            owner: { kind: 'table', id: table.id },
            member: { kind: 'table-column', id: column.id },
            role: 'column',
            evidence: column.evidence,
        }));
        table.body.visibleRows.forEach((row) => edges.push({
            owner: { kind: 'table', id: table.id },
            member: { kind: 'table-row', id: row.id },
            role: 'row',
            evidence: row.evidence,
        }));
    }
    for (const row of Object.values(rows)) {
        row.cellIds.forEach((cellId) => {
            const cell = cells[cellId];
            edges.push({
                owner: { kind: 'table-row', id: row.id },
                member: { kind: 'table-cell', id: cell.id },
                role: `cell:${cell.columnId}`,
                evidence: cell.evidence,
            });
            edges.push({
                owner: { kind: 'table-row', id: row.id },
                member: { kind: 'node', id: cell.nodeId },
                role: `cell:${cell.columnId}`,
                evidence: cell.evidence,
            });
            edges.push({
                owner: { kind: 'table-cell', id: cell.id },
                member: { kind: 'node', id: cell.nodeId },
                role: 'node',
                evidence: cell.evidence,
            });
            cell.controlIds.forEach((controlId) => {
                edges.push({
                    owner: { kind: 'table-row', id: row.id },
                    member: { kind: 'control', id: controlId },
                    role: `cell-control:${cell.columnId}`,
                    evidence: cell.evidence,
                });
                edges.push({
                    owner: { kind: 'table-cell', id: cell.id },
                    member: { kind: 'control', id: controlId },
                    role: 'control',
                    evidence: cell.evidence,
                });
            });
        });
    }
    for (const table of Object.values(tables)) {
        for (const editor of table.editors) {
            if (editor.status !== 'resolved') {continue;}
            editor.controlIds.forEach((controlId) => edges.push({
                owner: { kind: 'table-cell', id: editor.cellId },
                member: { kind: 'control', id: controlId },
                role: 'editor',
                evidence: editor.evidence,
            }));
        }
    }
    for (const column of Object.values(columns)) {
        column.sourceNodeIds.forEach((nodeId) => edges.push({
            owner: { kind: 'table-column', id: column.id },
            member: { kind: 'node', id: nodeId },
            role: `header:${column.id}`,
            evidence: column.evidence,
        }));
    }
    return edges;
};

const buildNodeIndex = (
    tables: Readonly<Record<string, TableComponent>>,
    rows: Readonly<Record<string, TableRow>>,
    cells: Readonly<Record<string, TableCell>>,
    columns: Readonly<Record<string, TableColumn>>,
): Readonly<Record<ObservationNodeId, readonly string[]>> => {
    const result: Record<string, string[]> = {};
    const add = (nodeId: string | undefined, id: string) => {
        if (!nodeId) {return;}
        (result[nodeId] ??= []).push(id);
    };
    Object.values(tables).forEach((table) => {
        add(table.location.structuralRootNodeId, table.id);
        add(table.location.hostNodeId, table.id);
        table.parts.physicalTableNodeIds.forEach((nodeId) => { add(nodeId, table.id); });
        table.pagination?.nodeIds.forEach((nodeId) => { add(nodeId, table.id); });
        table.editors.forEach((editor) => {
            editor.sourceNodeIds.forEach((nodeId) => { add(nodeId, editor.cellId); });
            editor.portalNodeIds.forEach((nodeId) => { add(nodeId, editor.cellId); });
        });
        table.mirrors.forEach((mirror) => { add(mirror.mirrorNodeId, mirror.canonicalId ?? table.id); });
    });
    Object.values(rows).forEach((row) => { add(row.nodeId, row.id); });
    Object.values(cells).forEach((cell) => { add(cell.nodeId, cell.id); });
    Object.values(columns).forEach((column) => { column.sourceNodeIds.forEach((nodeId) => { add(nodeId, column.id); }); });
    return result;
};

const aggregateStatus = (
    diagnostics: readonly AnalysisDiagnostic[],
    ambiguous: boolean,
): AssemblyStatus => {
    if (ambiguous || diagnostics.some((item) => item.status === 'ambiguous')) {return 'ambiguous';}
    if (diagnostics.some((item) => item.status === 'partial')) {return 'partial';}
    return 'complete';
};

const positiveInteger = (value: string | undefined): number | undefined => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
