import type {
    AnalysisDiagnostic,
    ObservationNodeId,
    PageObservation,
} from '../../../observation/model/contracts';
import type {
    TableCell,
    TableColumn,
    TableMirrorRelation,
    TableParts,
    TableRow,
} from '../model/contracts';
import {
    directOwnedRows,
    evidence,
    headerRows,
    nodeText,
    rowCellNodeIds,
} from './dom';

export type TableMirrorBuildResult = {
    mirrors: TableMirrorRelation[];
    diagnostics: AnalysisDiagnostic[];
};

type FixedPartKind = TableMirrorRelation['partKind'];

export const buildTableMirrors = (
    observation: PageObservation,
    ownerRootId: ObservationNodeId,
    allRootIds: ReadonlySet<ObservationNodeId>,
    parts: TableParts,
    rows: readonly TableRow[],
    cells: Readonly<Record<string, TableCell>>,
    columns: readonly TableColumn[],
): TableMirrorBuildResult => {
    const mirrors: TableMirrorRelation[] = [];
    const diagnostics: AnalysisDiagnostic[] = [];
    for (const partKind of ['fixed-left-body', 'fixed-right-body'] as const) {
        const partNodeIds = parts.nodeIdsByKind[partKind] ?? [];
        const mirrorRows = unique(partNodeIds.flatMap((partNodeId) =>
            directOwnedRows(observation, ownerRootId, partNodeId, allRootIds)));
        const rowMappings = mapRows(observation, partKind, mirrorRows, rows);
        mirrors.push(...rowMappings);
        for (const mapping of rowMappings) {
            if (mapping.status !== 'resolved' || !mapping.canonicalId) {continue;}
            const canonicalRow = rows.find((row) => row.id === mapping.canonicalId);
            if (!canonicalRow) {continue;}
            const mirrorCellNodeIds = rowCellNodeIds(observation, mapping.mirrorNodeId, allRootIds, ownerRootId);
            if (partKind === 'fixed-right-body') {
                mirrorCellNodeIds.forEach((mirrorNodeId) => {
                    const canonicalCell = canonicalRow.cellIds
                        .map((cellId) => cells[cellId])
                        .find((cell) => cell.nodeId === mirrorNodeId);
                    if (canonicalCell) {
                        mirrors.push(resolvedMirror(partKind, 'cell', mirrorNodeId, canonicalCell.id, 'table.mirror.fixed-source'));
                    }
                });
                continue;
            }
            const canonicalCells = canonicalRow.cellIds
                .map((cellId) => cells[cellId])
                .filter((cell): cell is TableCell => Boolean(cell))
                .sort((left, right) => left.columnIndex - right.columnIndex);
            mirrorCellNodeIds.forEach((mirrorNodeId, index) => {
                const canonicalCell = canonicalCells.at(index);
                mirrors.push(canonicalCell
                    ? resolvedMirror(partKind, 'cell', mirrorNodeId, canonicalCell.id, 'table.mirror.position')
                    : unresolvedMirror(partKind, 'cell', mirrorNodeId));
            });
        }
    }

    for (const partKind of ['fixed-left-header', 'fixed-right-header'] as const) {
        const rowNodeIds = headerRows(
            observation,
            ownerRootId,
            parts.nodeIdsByKind[partKind] ?? [],
            allRootIds,
        );
        const headerCellNodeIds = rowNodeIds.flatMap((rowNodeId) =>
            rowCellNodeIds(observation, rowNodeId, allRootIds, ownerRootId));
        headerCellNodeIds.forEach((mirrorNodeId, index) => {
            const bySource = columns.find((column) => column.sourceNodeIds.includes(mirrorNodeId));
            const byName = unique(columns.filter((column) => normalize(column.name) === normalize(nodeText(observation, mirrorNodeId))));
            const canonicalColumn = bySource ?? (byName.length === 1 ? byName[0] : undefined)
                ?? (partKind === 'fixed-left-header' ? columns[index] : undefined);
            mirrors.push(canonicalColumn
                ? resolvedMirror(partKind, 'column', mirrorNodeId, canonicalColumn.id, bySource
                    ? 'table.mirror.fixed-source'
                    : 'table.mirror.header-name')
                : unresolvedMirror(partKind, 'column', mirrorNodeId));
        });
    }

    for (const mirror of mirrors) {
        if (mirror.status === 'resolved') {continue;}
        diagnostics.push({
            code: mirror.status === 'ambiguous' ? 'table.mirror.ambiguous' : 'table.mirror.unresolved',
            severity: mirror.status === 'ambiguous' ? 'warning' : 'info',
            stage: 'table-mirror',
            status: mirror.status === 'ambiguous' ? 'ambiguous' : 'partial',
            nodeIds: [mirror.mirrorNodeId],
            evidence: mirror.evidence,
            message: `fixed table mirror could not map to one canonical ${mirror.kind}`,
        });
    }
    return { mirrors, diagnostics };
};

const mapRows = (
    observation: PageObservation,
    partKind: FixedPartKind,
    mirrorRowNodeIds: readonly ObservationNodeId[],
    rows: readonly TableRow[],
): TableMirrorRelation[] => {
    const rowsByKey = new Map<string, TableRow[]>();
    rows.forEach((row) => {
        if (!row.key) {return;}
        const bucket = rowsByKey.get(row.key) ?? [];
        bucket.push(row);
        rowsByKey.set(row.key, bucket);
    });
    return mirrorRowNodeIds.map((mirrorNodeId, index) => {
        const key = rowKey(observation, mirrorNodeId);
        if (key) {
            const candidates = rowsByKey.get(key) ?? [];
            if (candidates.length === 1) {
                return resolvedMirror(partKind, 'row', mirrorNodeId, candidates[0].id, 'table.mirror.row-key');
            }
            if (candidates.length > 1) {
                return ambiguousMirror(partKind, 'row', mirrorNodeId, 'table.mirror.row-key-duplicate');
            }
            return unresolvedMirror(partKind, 'row', mirrorNodeId);
        }
        const canonicalRow = mirrorRowNodeIds.length === rows.length ? rows[index] : undefined;
        return canonicalRow
            ? resolvedMirror(partKind, 'row', mirrorNodeId, canonicalRow.id, 'table.mirror.row-order')
            : unresolvedMirror(partKind, 'row', mirrorNodeId);
    });
};

const resolvedMirror = (
    partKind: FixedPartKind,
    kind: TableMirrorRelation['kind'],
    mirrorNodeId: ObservationNodeId,
    canonicalId: string,
    code: string,
): TableMirrorRelation => ({
    kind,
    partKind,
    mirrorNodeId,
    canonicalId,
    status: 'resolved',
    evidence: [evidence(code, code.endsWith('row-order') ? 'weak' : 'strong', 'adapter', [mirrorNodeId], { canonicalId })],
});

const ambiguousMirror = (
    partKind: FixedPartKind,
    kind: TableMirrorRelation['kind'],
    mirrorNodeId: ObservationNodeId,
    code: string,
): TableMirrorRelation => ({
    kind,
    partKind,
    mirrorNodeId,
    status: 'ambiguous',
    evidence: [evidence(code, 'weak', 'adapter', [mirrorNodeId])],
});

const unresolvedMirror = (
    partKind: FixedPartKind,
    kind: TableMirrorRelation['kind'],
    mirrorNodeId: ObservationNodeId,
): TableMirrorRelation => ({
    kind,
    partKind,
    mirrorNodeId,
    status: 'unresolved',
    evidence: [evidence('table.mirror.unresolved', 'weak', 'adapter', [mirrorNodeId])],
});

const rowKey = (observation: PageObservation, rowNodeId: ObservationNodeId): string | undefined => {
    const attributes = observation.attributes[rowNodeId] ?? {};
    return ['data-row-key', 'row-key', 'key', 'aria-rowindex']
        .map((name) => attributes[name])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .find(Boolean);
};

const normalize = (value: string): string => value.trim().toLowerCase();
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
