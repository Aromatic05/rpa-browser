import type {Action} from '../shared/types.js';
import type {
    AnnotatorActionSender,
    AnnotatorApplyReply,
    AnnotatorCheckReply,
    AnnotatorClient,
    AnnotatorPickReply,
    AnnotatorPoint,
    AnnotatorProjectionReply,
    AnnotatorSaveReply,
} from './contracts.js';

export const createAnnotatorClient = (sendAction: AnnotatorActionSender): AnnotatorClient => ({
    open: async (profileName) => await request<AnnotatorProjectionReply>(
        sendAction,
        'entity_rules.annotator.open',
        profileName ? {profileName} : {},
    ),
    pick: async (point) => await request<AnnotatorPickReply>(
        sendAction,
        'entity_rules.annotator.pick',
        {point: clonePoint(point)},
    ),
    recognize: async (profileName) => await request<AnnotatorProjectionReply>(
        sendAction,
        'entity_rules.annotator.recognize',
        profileName ? {profileName, refresh: true} : {refresh: true},
    ),
    visualize: async (profileName) => await request<AnnotatorProjectionReply>(
        sendAction,
        'entity_rules.annotator.visualize',
        profileName ? {profileName} : {},
    ),
    apply: async (payload) => await request<AnnotatorApplyReply>(
        sendAction,
        'entity_rules.annotator.apply',
        {
            draft: structuredClone(payload.draft),
            targetId: payload.targetId,
            semantic: structuredClone(payload.semantic),
        },
    ),
    check: async (draft) => await request<AnnotatorCheckReply>(
        sendAction,
        'entity_rules.annotator.check',
        {draft: structuredClone(draft)},
    ),
    save: async (draft) => await request<AnnotatorSaveReply>(
        sendAction,
        'entity_rules.annotator.save',
        {draft: structuredClone(draft)},
    ),
});

const request = async <T>(
    sendAction: AnnotatorActionSender,
    type: string,
    payload: Record<string, unknown>,
): Promise<T> => {
    const reply = await sendAction(type, {
        annotatorProtocol: 'projection-v1',
        ...payload,
    });
    if (reply.type.endsWith('.failed')) {
        throw new Error(readFailure(reply));
    }
    if (reply.type !== `${type}.result`) {
        throw new Error(`unexpected annotator reply type: ${reply.type}`);
    }
    if (!reply.payload || typeof reply.payload !== 'object' || Array.isArray(reply.payload)) {
        throw new Error(`annotator reply payload is invalid: ${type}`);
    }
    return structuredClone(reply.payload) as T;
};

const readFailure = (reply: Action): string => {
    const payload = reply.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return `annotator action failed: ${reply.type}`;
    }
    const message = (payload as Record<string, unknown>).message;
    return typeof message === 'string' && message.trim()
        ? message
        : `annotator action failed: ${reply.type}`;
};

const clonePoint = (point: AnnotatorPoint): AnnotatorPoint => ({x: point.x, y: point.y});
