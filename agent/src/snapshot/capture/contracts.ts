import type {
    AccessibilityRecord,
    AnalysisDiagnostic,
    CaptureNodeId,
    ObservationCompleteness,
    ObservationIdentity,
    Rect,
    RectTransform,
    RuntimeStateRecord,
    TreeScopeId,
    TreeScopeKind,
    TreeScopeStatus,
} from '../observation/contracts';

export type RawCaptureMetadata = {
    schemaVersion: 1;
    source: 'browser-live' | 'fixed-fixture';
    capturedAt: string;
    pageUrl?: string;
    framework?: string;
    frameworkVersion?: string;
};

export type RawCapturedActivity = {
    hiddenByStyle: boolean;
    inert: boolean;
    ariaExposed?: boolean;
    selfHasBox: boolean;
    rendered: boolean;
};

export type RawCapturedNode = {
    captureId: CaptureNodeId;
    scopeId: TreeScopeId;
    parentCaptureId?: CaptureNodeId;
    childCaptureIds: CaptureNodeId[];
    tag: string;
    attributes: Record<string, string>;
    ownText?: string;
    backendNodeId?: string;
    runtimeStateToken?: string;
    geometry?: Rect;
    geometrySource?: 'dom-snapshot' | 'live-dom' | 'cdp';
    activity: RawCapturedActivity;
    frameMetrics?: {
        contentX: number;
        contentY: number;
        contentWidth: number;
        contentHeight: number;
    };
};

export type RawCapturedScope = {
    id: TreeScopeId;
    kind: TreeScopeKind;
    parentScopeId?: TreeScopeId;
    hostCaptureId?: CaptureNodeId;
    rootCaptureId: CaptureNodeId;
    status: TreeScopeStatus;
    unavailableReason?: string;
    transformToParent?: RectTransform;
    completeness?: ObservationCompleteness;
    viewport?: {
        width: number;
        height: number;
    };
};

export type RawPageCapture = {
    identity: ObservationIdentity;
    metadata: RawCaptureMetadata;
    completeness: ObservationCompleteness;
    scopes: RawCapturedScope[];
    nodes: RawCapturedNode[];
    accessibility: AccessibilityRecord[];
    runtimeState: Readonly<Record<string, RuntimeStateRecord | undefined>>;
    diagnostics: AnalysisDiagnostic[];
};

export type RawPageCaptureResult = {
    capture: RawPageCapture;
    cleanup: () => Promise<void>;
};
