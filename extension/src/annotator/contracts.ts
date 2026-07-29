import type {Action} from '../shared/types.js';
import type {
    AnnotatorAnchor,
    AnnotatorCheckPayload,
    AnnotatorCheckReply,
    AnnotatorComponent,
    AnnotatorDiagnostic,
    AnnotatorDraft,
    AnnotatorOpenPayload,
    AnnotatorPickPayload,
    AnnotatorPickReply,
    AnnotatorPoint,
    AnnotatorProjection,
    AnnotatorProjectionReply,
    AnnotatorRecognizePayload,
    AnnotatorRect,
    AnnotatorSavePayload,
    AnnotatorSaveReply,
    AnnotatorSelection,
    AnnotatorSemanticBinding,
    AnnotatorTarget,
    AnnotatorTargetKind,
    AnnotatorValidation,
    AnnotatorVisualizePayload,
} from '../../../shared/annotator-contract/index.js';

export type {
    AnnotatorAnchor,
    AnnotatorCheckPayload,
    AnnotatorCheckReply,
    AnnotatorComponent,
    AnnotatorDiagnostic,
    AnnotatorDraft,
    AnnotatorOpenPayload,
    AnnotatorPickPayload,
    AnnotatorPickReply,
    AnnotatorPoint,
    AnnotatorProjection,
    AnnotatorProjectionReply,
    AnnotatorRecognizePayload,
    AnnotatorRect,
    AnnotatorSavePayload,
    AnnotatorSaveReply,
    AnnotatorSelection,
    AnnotatorSemanticBinding,
    AnnotatorTarget,
    AnnotatorTargetKind,
    AnnotatorValidation,
    AnnotatorVisualizePayload,
};

export type AnnotatorActionSender = (
    type: string,
    payload?: Record<string, unknown>,
) => Promise<Action>;

export type AnnotatorClient = {
    open: (profileName?: string) => Promise<AnnotatorProjectionReply>;
    pick: (point: AnnotatorPoint) => Promise<AnnotatorPickReply>;
    recognize: (profileName?: string) => Promise<AnnotatorProjectionReply>;
    visualize: (profileName?: string) => Promise<AnnotatorProjectionReply>;
    check: (draft: AnnotatorDraft) => Promise<AnnotatorCheckReply>;
    save: (draft: AnnotatorDraft) => Promise<AnnotatorSaveReply>;
};

export type AnnotatorOverlayPort = {
    render: (projection: AnnotatorProjection) => void;
    startPicking: () => void;
    stopPicking: () => void;
    dispose: () => void;
};

export type AnnotatorSessionStatus = 'idle' | 'loading' | 'ready' | 'checking' | 'saving' | 'error';

export type AnnotatorSessionState = {
    status: AnnotatorSessionStatus;
    profileName: string;
    draft?: AnnotatorDraft;
    projection?: AnnotatorProjection;
    validation?: AnnotatorValidation;
    error?: string;
};

export type AnnotatorSession = {
    getState: () => AnnotatorSessionState;
    setDraft: (draft: AnnotatorDraft) => void;
    open: (profileName?: string) => Promise<void>;
    recognize: () => Promise<void>;
    visualize: () => Promise<void>;
    pick: (point: AnnotatorPoint) => Promise<void>;
    check: (draft?: AnnotatorDraft) => Promise<void>;
    save: (draft?: AnnotatorDraft) => Promise<void>;
    startPicking: () => void;
    stopPicking: () => void;
    dispose: () => void;
};
