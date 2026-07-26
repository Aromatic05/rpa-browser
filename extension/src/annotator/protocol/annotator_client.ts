import type {
    AnnotatorCheckResult,
    AnnotatorOpenResult,
    AnnotatorPickResult,
    AnnotatorRecognizeResult,
    AnnotatorSaveResult,
    CanvasDraft,
    PickFingerprint,
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
    open: (payload: { workspaceName: string; tabName: string; url: string }) => Promise<AnnotatorOpenResult>;
    pick: (payload: { fingerprint: PickFingerprint }) => Promise<AnnotatorPickResult>;
    recognize: (payload: { canvasDraft?: CanvasDraft | null }) => Promise<AnnotatorRecognizeResult>;
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
        dispatch('entity_rules.annotator.open', payload as unknown as Record<string, unknown>),
    ),
    pick: (payload) => unwrap<AnnotatorPickResult>(
        dispatch('entity_rules.annotator.pick', payload as unknown as Record<string, unknown>),
    ),
    recognize: (payload) => unwrap<AnnotatorRecognizeResult>(
        dispatch('entity_rules.annotator.recognize', payload as unknown as Record<string, unknown>),
    ),
    check: (payload) => unwrap<AnnotatorCheckResult>(
        dispatch('entity_rules.annotator.check', payload as unknown as Record<string, unknown>),
    ),
    save: (payload) => unwrap<AnnotatorSaveResult>(
        dispatch('entity_rules.annotator.save', payload as unknown as Record<string, unknown>),
    ),
});
