import type { Action } from '../shared/types.js';
import { deriveFailedActionType, type RequestActionType } from './action_types.js';

export type { Action };

export const replyAction = (request: Action<RequestActionType>, payload?: unknown, type?: string): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type: type ?? `${request.type}.result`,
    workspaceName: request.workspaceName,
    payload,
    at: Date.now(),
    replyTo: request.id,
});

export const failedAction = (
    request: Pick<Action, 'id' | 'type' | 'workspaceName'>,
    code: string,
    message: string,
    details?: unknown,
    failedType?: string,
): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type: failedType ?? deriveFailedActionType(request.type),
    workspaceName: request.workspaceName,
    payload: details === undefined ? { code, message } : { code, message, details },
    at: Date.now(),
    replyTo: request.id,
});
