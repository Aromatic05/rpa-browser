import crypto from 'node:crypto';
import type { Action } from '../actions/action_protocol';
import type { ActionHandlerResult } from '../actions/execute';
import type { ControlRouterContext } from './router';

export type ControlActionDispatcher = {
    dispatch(action: Action): Promise<ActionHandlerResult>;
};

let controlActionDispatcher: ControlActionDispatcher | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const badRequest = (message: string): Error =>
    Object.assign(new Error(message), { code: 'ERR_CONTROL_BAD_REQUEST' });

export const setControlActionDispatcher = (dispatcher: ControlActionDispatcher): void => {
    controlActionDispatcher = dispatcher;
};

export const clearControlActionDispatcher = (): void => {
    controlActionDispatcher = null;
};

export const callActionFromControl = async (
    params: unknown,
    _ctx: ControlRouterContext,
): Promise<unknown> => {
    if (!controlActionDispatcher) {
        throw Object.assign(new Error('control action dispatcher not configured'), { code: 'ERR_CONTROL_INTERNAL' });
    }
    if (!isRecord(params) || typeof params.type !== 'string' || params.type.length === 0) {
        throw badRequest('action.call requires a non-empty type');
    }
    if ('scope' in params || 'tabToken' in params || 'workspaceId' in params || 'tabId' in params) {
        throw badRequest('legacy action address fields are not allowed');
    }
    const action: Action = {
        v: 1,
        id: crypto.randomUUID(),
        type: params.type,
        ...(typeof params.workspaceName === 'string' ? { workspaceName: params.workspaceName } : {}),
        ...(Object.prototype.hasOwnProperty.call(params, 'payload') ? { payload: params.payload } : {}),
        ...(typeof params.traceId === 'string' ? { traceId: params.traceId } : {}),
        at: Date.now(),
    };

    return await controlActionDispatcher.dispatch(action);
};
