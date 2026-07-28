import type {
    AnalysisDiagnostic,
    AssemblyStatus,
    Evidence,
    ObservationCompleteness,
    ObservationNodeId,
    PageObservation,
    RelationIndex,
    Resolution,
    TreeScopeId,
} from '../observation/contracts';
import type { LocatorIndex } from '../locator/contracts';
import type { ControlCollectorRegistry } from './registry';

export type ControlKind =
    | 'input'
    | 'textarea'
    | 'button'
    | 'link'
    | 'native_select'
    | 'radio_group'
    | 'checkbox_group'
    | 'custom_select'
    | 'date_like'
    | 'popup'
    | 'option';

export type SelectOptionControlKind = 'native_select' | 'radio_group' | 'checkbox_group' | 'custom_select';

export type ControlCapability =
    | 'click'
    | 'focus'
    | 'fill'
    | 'toggle'
    | 'open_popup'
    | 'select_option';

export type ControlOption = {
    nodeId: ObservationNodeId;
    semanticNodeId?: ObservationNodeId;
    value: string;
    label: string;
    text?: string;
    ariaLabel?: string;
    title?: string;
    dataValue?: string;
    dataKey?: string;
    selected: boolean;
    disabled: boolean;
};

export type ControlState = {
    expanded?: boolean;
    multiple?: boolean;
    disabled: boolean;
    readonly: boolean;
    focused: boolean;
    checked?: boolean;
    selectedValues: string[];
    selectedLabels: string[];
};

export type ControlComponent = {
    id: string;
    ref: string;
    kind: ControlKind;
    status: AssemblyStatus;
    scopeId: TreeScopeId;
    rootNodeId: ObservationNodeId;
    ownerNodeId?: ObservationNodeId;
    controlNodeId?: ObservationNodeId;
    triggerNodeId?: ObservationNodeId;
    popupNodeId?: ObservationNodeId;
    optionNodeIds: ObservationNodeId[];
    memberNodeIds: ObservationNodeId[];
    capabilities: ControlCapability[];
    state: ControlState;
    options: ControlOption[];
    inheritedCompleteness: ObservationCompleteness;
    locatorIds: string[];
    evidence: Evidence[];
    diagnostics: AnalysisDiagnostic[];
};

export type ControlInvariantValidation = {
    ok: boolean;
    diagnostics: readonly AnalysisDiagnostic[];
};

export type ControlIndex = {
    controls: Readonly<Record<string, ControlComponent>>;
    byNodeId: Readonly<Record<ObservationNodeId, readonly string[]>>;
    byRef: Readonly<Record<string, readonly string[]>>;
    diagnostics: readonly AnalysisDiagnostic[];
    validation: ControlInvariantValidation;
};

export type ControlSnapshot = {
    observation: PageObservation;
    relations: RelationIndex;
    locators: LocatorIndex;
    controls: ControlIndex;
};

export type BuildControlSnapshotInput = {
    observation: PageObservation;
    relations: RelationIndex;
    locators: LocatorIndex;
    registry?: ControlCollectorRegistry;
};

export type ControlRefResolution = Resolution<ControlComponent>;

export type SelectOptionRequest = {
    kind: SelectOptionControlKind;
    values: string[];
    controlRef?: string;
    nodeId?: ObservationNodeId;
    selector?: string;
};

export type SelectOptionActionResult =
    | {
        ok: true;
        controlRef: string;
        selectedValues: string[];
        selectedLabels: string[];
        captureRevision: number;
    }
    | {
        ok: false;
        code: 'ERR_BAD_ARGS' | 'ERR_NOT_FOUND' | 'ERR_AMBIGUOUS' | 'ERR_STALE' | 'ERR_UNRESOLVED' | 'ERR_ASSERTION_FAILED';
        message: string;
        details?: Record<string, unknown>;
    };

export type AtomicActionErrorCode =
    | 'ERR_BAD_ARGS'
    | 'ERR_NOT_FOUND'
    | 'ERR_AMBIGUOUS'
    | 'ERR_STALE'
    | 'ERR_UNRESOLVED'
    | 'ERR_TIMEOUT'
    | 'ERR_ASSERTION_FAILED'
    | 'ERR_INTERNAL';

export type AtomicActionFailure = {
    ok: false;
    code: AtomicActionErrorCode;
    message: string;
    details?: Record<string, unknown>;
};

export type AtomicActionSuccess = {
    ok: true;
    nodeId: ObservationNodeId;
    controlRef?: string;
    captureRevision: number;
};

export type AtomicActionResult = AtomicActionSuccess | AtomicActionFailure;

export type AtomicActionTargetRequest = {
    nodeId?: ObservationNodeId;
    selector?: string;
    requiredCapabilities?: ControlCapability[];
};
