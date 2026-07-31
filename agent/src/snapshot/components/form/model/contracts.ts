import type {
    AnalysisDiagnostic,
    AssemblyStatus,
    Evidence,
    ObservationNodeId,
    PageObservation,
} from '../../../observation/model/contracts';
import type { RelationIndex } from '../../../indexes/relation/contracts';
import type { ComponentLocation, GeometryFragment, SemanticSuggestion } from '../../shared/contracts';
import type { ControlIndex } from '../../control/model/contracts';
import type { LocatorIndex } from '../../../indexes/locator/contracts';
import type { OwnershipIndex } from '../../../indexes/ownership/contracts';

export type FormBoundaryKind = 'explicit-form' | 'adapter-form' | 'dialog' | 'local-island';

export type FormField = {
    id: string;
    status: AssemblyStatus;
    anchorNodeId: ObservationNodeId;
    controlIds: string[];
    primaryControlId?: string;
    labelNodeIds: ObservationNodeId[];
    descriptionNodeIds: ObservationNodeId[];
    errorNodeIds: ObservationNodeId[];
    memberNodeIds: ObservationNodeId[];
    groupId?: string;
    required?: boolean;
    evidence: Evidence[];
    diagnostics: AnalysisDiagnostic[];
};

export type FormGroup = {
    id: string;
    rootNodeId: ObservationNodeId;
    labelNodeIds: ObservationNodeId[];
    fieldIds: string[];
    evidence: Evidence[];
};

export type FormAction = {
    id: string;
    controlId: string;
    nodeId: ObservationNodeId;
    structuralRole: 'submit' | 'reset' | 'button' | 'link';
    suggestions: SemanticSuggestion[];
    evidence: Evidence[];
};

export type FormProposal = {
    rootNodeId: ObservationNodeId;
    boundaryKind: FormBoundaryKind;
    fieldIds: string[];
    actionIds: string[];
    evidence: Evidence[];
};

export type FormReductionTraceRecord = {
    nodeId: ObservationNodeId;
    outcome: 'formed' | 'propagated' | 'residual' | 'skipped';
    reason: string;
    fieldIds: string[];
    actionIds: string[];
    formId?: string;
};

export type FormComponent = {
    id: string;
    status: AssemblyStatus;
    boundaryKind: FormBoundaryKind;
    location: ComponentLocation;
    fields: FormField[];
    actions: FormAction[];
    groups: FormGroup[];
    geometry: GeometryFragment[];
    suggestions: SemanticSuggestion[];
    evidence: Evidence[];
    diagnostics: AnalysisDiagnostic[];
};

export type FormReductionState = {
    unclaimedFieldIds: string[];
    localActionIds: string[];
    completedFormIds: string[];
    diagnostics: AnalysisDiagnostic[];
};

export type FormInvariantValidation = {
    ok: boolean;
    diagnostics: readonly AnalysisDiagnostic[];
};

export type FormComponentIndex = {
    forms: Readonly<Record<string, FormComponent>>;
    fields: Readonly<Record<string, FormField>>;
    groups: Readonly<Record<string, FormGroup>>;
    actions: Readonly<Record<string, FormAction>>;
    residualFieldIds: string[];
    residualActionIds: string[];
    ownership: OwnershipIndex;
    byNodeId: Readonly<Record<ObservationNodeId, readonly string[]>>;
    reductionTrace: FormReductionTraceRecord[];
    diagnostics: readonly AnalysisDiagnostic[];
    validation: FormInvariantValidation;
};

export type FormSnapshot = {
    observation: PageObservation;
    relations: RelationIndex;
    locators: LocatorIndex;
    controls: ControlIndex;
    forms: FormComponentIndex;
};

export type BuildFormSnapshotInput = {
    observation: PageObservation;
    relations: RelationIndex;
    locators: LocatorIndex;
    controls: ControlIndex;
    selectionScopeNodeId?: ObservationNodeId;
};

export type ReductionContext = {
    observation: PageObservation;
};

export type BottomUpReducer<T> = (
    nodeId: ObservationNodeId,
    childResults: T[],
    context: ReductionContext,
) => T;
