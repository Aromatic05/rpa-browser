import type {
    AnalysisDiagnostic,
    AssemblyStatus,
    Evidence,
    ObservationNodeId,
    PageObservation,
} from '../../../observation/model/contracts';
import type { RelationIndex } from '../../../indexes/relation/contracts';
import type { LocatorIndex } from '../../../indexes/locator/contracts';
import type { OwnershipIndex } from '../../../indexes/ownership/contracts';
import type { ControlIndex, ControlKind } from '../../control/model/contracts';
import type { ComponentLocation, GeometryFragment, SemanticSuggestion } from '../../shared/contracts';

export type TablePartKind =
    | 'header'
    | 'body'
    | 'fixed-left-header'
    | 'fixed-left-body'
    | 'fixed-right-header'
    | 'fixed-right-body'
    | 'footer'
    | 'unknown';

export type TableParts = {
    physicalTableNodeIds: ObservationNodeId[];
    nodeIdsByKind: Readonly<Partial<Record<TablePartKind, readonly ObservationNodeId[]>>>;
};

export type TableHeaderCell = {
    id: string;
    nodeId: ObservationNodeId;
    name: string;
    rowIndex: number;
    columnStart: number;
    columnSpan: number;
    rowSpan: number;
    parentCellId?: string;
    childCellIds: string[];
    evidence: Evidence[];
};

export type TableHeaderModel = {
    rowCount: number;
    cells: Readonly<Record<string, TableHeaderCell>>;
    rootCellIds: string[];
    leafColumnIds: string[];
};

export type TableColumn = {
    id: string;
    index: number;
    name: string;
    headerCellIds: string[];
    sourceNodeIds: ObservationNodeId[];
    evidence: Evidence[];
};

export type TableCell = {
    id: string;
    rowId: string;
    columnId: string;
    nodeId: ObservationNodeId;
    columnIndex: number;
    columnSpan: number;
    rowSpan: number;
    text: string;
    controlIds: string[];
    evidence: Evidence[];
};

export type TableRow = {
    id: string;
    nodeId: ObservationNodeId;
    tableId: string;
    index: number;
    key?: string;
    cellIds: string[];
    selected?: boolean;
    expanded?: boolean;
    level?: number;
    evidence: Evidence[];
    diagnostics: AnalysisDiagnostic[];
};

export type TableBodyModel = {
    visibleRows: TableRow[];
    representativeRowIds: string[];
    rowWindow: {
        visibleCount: number;
        totalCount?: number;
        startIndex?: number;
        completeness: 'complete' | 'partial' | 'unknown';
    };
};

export type CellControlSlot = {
    id: string;
    columnId: string;
    structuralPosition: number;
    controlKind: ControlKind;
    occurrenceCount: number;
    exemplarNodeIds: ObservationNodeId[];
    controlIds: string[];
};

export type TableRowException = {
    rowId: string;
    controlIds: string[];
    evidence: Evidence[];
};

export type TableCellEditorRelation = {
    cellId: string;
    status: 'resolved' | 'ambiguous' | 'unresolved';
    sourceNodeIds: ObservationNodeId[];
    portalNodeIds: ObservationNodeId[];
    controlIds: string[];
    evidence: Evidence[];
};

export type TableMirrorRelation = {
    kind: 'row' | 'cell' | 'column';
    partKind: 'fixed-left-header' | 'fixed-left-body' | 'fixed-right-header' | 'fixed-right-body';
    mirrorNodeId: ObservationNodeId;
    canonicalId?: string;
    status: 'resolved' | 'ambiguous' | 'unresolved';
    evidence: Evidence[];
};

export type TableRowHierarchy = {
    parentRowIdByRowId: Readonly<Record<string, string | undefined>>;
    levelByRowId: Readonly<Record<string, number | undefined>>;
    source: 'aria-level' | 'explicit-tree-relation' | 'unknown';
};

export type TableFooterModel = {
    rowNodeIds: ObservationNodeId[];
    cellNodeIds: ObservationNodeId[];
};

export type PaginationRelation = {
    status: 'resolved' | 'ambiguous';
    nodeIds: ObservationNodeId[];
    evidence: Evidence[];
};

export type FeatureCoverResult = {
    representativeRowIds: string[];
    coveredFeatures: string[];
    uncoveredFeatures: string[];
};

export type TableInvariantValidation = {
    ok: boolean;
    diagnostics: readonly AnalysisDiagnostic[];
};

export type TableComponent = {
    id: string;
    status: AssemblyStatus;
    location: ComponentLocation;
    parts: TableParts;
    header: TableHeaderModel;
    columns: TableColumn[];
    body: TableBodyModel;
    featureCover: FeatureCoverResult;
    controlSlots: CellControlSlot[];
    rowExceptions: TableRowException[];
    editors: TableCellEditorRelation[];
    mirrors: TableMirrorRelation[];
    hierarchy?: TableRowHierarchy;
    footer?: TableFooterModel;
    pagination?: PaginationRelation;
    geometry: GeometryFragment[];
    suggestions: SemanticSuggestion[];
    evidence: Evidence[];
    diagnostics: AnalysisDiagnostic[];
};

export type TableComponentIndex = {
    tables: Readonly<Record<string, TableComponent>>;
    rows: Readonly<Record<string, TableRow>>;
    cells: Readonly<Record<string, TableCell>>;
    columns: Readonly<Record<string, TableColumn>>;
    ownership: OwnershipIndex;
    byNodeId: Readonly<Record<ObservationNodeId, readonly string[]>>;
    diagnostics: readonly AnalysisDiagnostic[];
    validation: TableInvariantValidation;
};

export type TableSnapshot = {
    observation: PageObservation;
    relations: RelationIndex;
    locators: LocatorIndex;
    controls: ControlIndex;
    tables: TableComponentIndex;
};

export type BuildTableSnapshotInput = {
    observation: PageObservation;
    relations: RelationIndex;
    locators: LocatorIndex;
    controls: ControlIndex;
    selectionScopeNodeId?: ObservationNodeId;
};

export type LogicalTableRoot = {
    rootNodeId: ObservationNodeId;
    hostNodeId?: ObservationNodeId;
    framework: 'native' | 'aria' | 'element' | 'ant';
    evidence: Evidence[];
};
