import type {
    AnnotatorCheckResult,
    AnnotatorOpenResult,
    AnnotatorPickResult,
    AnnotatorRecognizeResult,
    AnnotatorSaveResult,
    AnnotatorVisualizeResult,
    CanvasDraft,
    PickFingerprint,
    PickPurpose,
} from '../types.js';

export type AnnotatorReply = {
    type: string;
    payload?: unknown;
};

export type AnnotatorDispatch = (
    type: string,
    payload?: Record<string, unknown>,
) => Promise<AnnotatorReply>;

export type AnnotatorClient = {
    open: (payload: { tabName: string; url: string; profileName?: string }) => Promise<AnnotatorOpenResult>;
    pick: (payload: { fingerprint: PickFingerprint; purpose: PickPurpose }) => Promise<AnnotatorPickResult>;
    recognize: (payload: { canvasDraft?: CanvasDraft | null }) => Promise<AnnotatorRecognizeResult>;
    visualize: (payload: {canvasDraft: CanvasDraft}) => Promise<AnnotatorVisualizeResult>;
    check: (payload: { canvasDraft: CanvasDraft }) => Promise<AnnotatorCheckResult>;
    save: (payload: {
        canvasDraft: CanvasDraft;
        profileName: string;
        expectedRevision: string | null;
    }) => Promise<AnnotatorSaveResult>;
};

const unwrap = async <T>(promise: Promise<AnnotatorReply>): Promise<T> => {
    const reply = await promise;
    if (reply.type.endsWith('.failed')) {
        const errPayload = (reply.payload ?? {}) as Record<string, unknown>;
        const message = typeof errPayload.message === 'string' ? errPayload.message : reply.type;
        const code = typeof errPayload.code === 'string' ? errPayload.code : 'ERR_UNKNOWN';
        const error = new Error(message) as Error & { code: string };
        error.code = code;
        throw error;
    }
    return (reply.payload ?? null) as T;
};

export const createAnnotatorClient = (dispatch: AnnotatorDispatch): AnnotatorClient => ({
    open: (payload) => unwrap<AnnotatorOpenResult>(
        dispatch('entity_rules.annotator.open', canvasPayload(payload)),
    ),
    pick: (payload) => unwrap<AnnotatorPickResult>(
        dispatch('entity_rules.annotator.pick', canvasPayload(payload)),
    ),
    recognize: (payload) => unwrap<AnnotatorRecognizeResult>(
        dispatch('entity_rules.annotator.recognize', canvasPayload(payload)),
    ),
    visualize: (payload) => unwrap<AnnotatorVisualizeResult>(
        dispatch('entity_rules.annotator.visualize', canvasPayload(payload)),
    ),
    check: (payload) => unwrap<AnnotatorCheckResult>(
        dispatch('entity_rules.annotator.check', canvasPayload(payload)),
    ),
    save: (payload) => unwrap<AnnotatorSaveResult>(
        dispatch('entity_rules.annotator.save', canvasPayload(payload)),
    ),
});

const canvasPayload = (payload: object): Record<string, unknown> => ({
    annotatorProtocol: 'canvas-v1',
    ...payload,
});
