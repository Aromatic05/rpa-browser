import type {
    AnalysisDiagnostic,
    ObservationNodeId,
    PageObservation,
} from '../../../observation/model/contracts';
import type { RelationEdge, RelationIndex } from '../../../indexes/relation/contracts';
import type { ControlComponent, ControlIndex } from '../../control/model/contracts';
import type {
    TableCell,
    TableCellEditorRelation,
} from '../model/contracts';
import { evidence, isDescendantOrSelf } from './dom';

export type CellEditorBuildResult = {
    editors: TableCellEditorRelation[];
    diagnostics: AnalysisDiagnostic[];
};

const EDITOR_RELATION_KINDS = new Set<RelationEdge['kind']>(['controls-target', 'owns']);
const NON_EDITOR_TARGET_ROLES = new Set(['listbox', 'menu', 'tree']);
const EDITOR_CONTROL_KINDS = new Set<ControlComponent['kind']>([
    'input',
    'textarea',
    'native_select',
    'radio_group',
    'checkbox_group',
    'custom_select',
    'date_like',
]);

export const buildCellEditors = (
    observation: PageObservation,
    relations: RelationIndex,
    controls: ControlIndex,
    cells: Record<string, TableCell>,
): CellEditorBuildResult => {
    const editors: TableCellEditorRelation[] = [];
    const diagnostics: AnalysisDiagnostic[] = [];
    const orderedCells = Object.values(cells).sort((left, right) =>
        (observation.documentOrder[left.nodeId] ?? Number.MAX_SAFE_INTEGER)
        - (observation.documentOrder[right.nodeId] ?? Number.MAX_SAFE_INTEGER));

    for (const edge of relations.edges) {
        if (!EDITOR_RELATION_KINDS.has(edge.kind)) {continue;}
        const cell = orderedCells.find((candidate) =>
            isDescendantOrSelf(observation, edge.sourceNodeId, candidate.nodeId));
        if (!cell || sourceIsCustomSelect(controls, edge.sourceNodeId)) {continue;}
        const externalTargets = edge.targetNodeIds.filter((targetNodeId) =>
            !isDescendantOrSelf(observation, targetNodeId, cell.nodeId));
        if (edge.status === 'resolved' && externalTargets.length === 0) {continue;}
        if (externalTargets.some((targetNodeId) => NON_EDITOR_TARGET_ROLES.has(targetRole(observation, targetNodeId)))) {
            continue;
        }

        const matchedControls = unique(externalTargets.flatMap((targetNodeId) =>
            controlsWithinTarget(observation, controls, targetNodeId)
                .filter((control) => EDITOR_CONTROL_KINDS.has(control.kind))
                .map((control) => control.id)));
        if (edge.status === 'resolved' && matchedControls.length === 0) {continue;}
        const status: TableCellEditorRelation['status'] = edge.status === 'ambiguous'
            ? 'ambiguous'
            : edge.status === 'resolved' && matchedControls.length > 0
                ? 'resolved'
                : 'unresolved';
        const editorEvidence = [
            ...edge.evidence,
            evidence('table.editor.idref-owner', 'exact', 'dom', [edge.sourceNodeId, ...externalTargets], {
                relationKind: edge.kind,
                cellId: cell.id,
            }),
        ];
        editors.push({
            cellId: cell.id,
            status,
            sourceNodeIds: [edge.sourceNodeId],
            portalNodeIds: externalTargets,
            controlIds: matchedControls,
            evidence: editorEvidence,
        });
        if (status === 'resolved') {
            cell.controlIds = unique([...cell.controlIds, ...matchedControls]);
            continue;
        }
        diagnostics.push({
            code: status === 'ambiguous'
                ? 'table.editor.target.ambiguous'
                : 'table.editor.target.unresolved',
            severity: status === 'ambiguous' ? 'warning' : 'info',
            stage: 'table-editor',
            status: status === 'ambiguous' ? 'ambiguous' : 'partial',
            nodeIds: [edge.sourceNodeId, ...externalTargets],
            evidence: editorEvidence,
            message: status === 'ambiguous'
                ? `cell editor target is ambiguous: ${cell.id}`
                : `cell editor target or control is unavailable: ${cell.id}`,
        });
    }
    return { editors, diagnostics };
};

const controlsWithinTarget = (
    observation: PageObservation,
    controls: ControlIndex,
    targetNodeId: ObservationNodeId,
): ControlComponent[] => Object.values(controls.controls)
    .filter((control) => [
        control.rootNodeId,
        control.controlNodeId,
        ...control.memberNodeIds,
    ].filter((nodeId): nodeId is ObservationNodeId => Boolean(nodeId))
        .some((nodeId) => isDescendantOrSelf(observation, nodeId, targetNodeId)));

const sourceIsCustomSelect = (controls: ControlIndex, sourceNodeId: ObservationNodeId): boolean =>
    (controls.byNodeId[sourceNodeId] ?? [])
        .map((controlId) => controls.controls[controlId])
        .some((control) => control?.kind === 'custom_select');

const targetRole = (observation: PageObservation, nodeId: ObservationNodeId): string =>
    (observation.attributes[nodeId]?.role
        ?? observation.accessibility[nodeId]?.role
        ?? observation.runtimeState[nodeId]?.role
        ?? '').trim().toLowerCase();

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
