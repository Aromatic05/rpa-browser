import type { Action } from '../shared/types.js';
import { deriveFailedActionType } from './action_types.js';

export const mkActionDispatchFailed = (replyTo: string | undefined, code: string, message: string): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type: 'action.dispatch.failed',
    replyTo,
    payload: { code, message },
    at: Date.now(),
});

export const mkRequestFailedReply = (requestType: string, requestId: string | undefined, code: string, message: string): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type: deriveFailedActionType(requestType),
    replyTo: requestId,
    payload: { code, message },
    at: Date.now(),
});
