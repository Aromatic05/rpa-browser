import { isRequestActionType } from './action_types.js';
import type { Action } from './action_protocol.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const has = (value: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

export type EnvelopeOk = { ok: true; action: Action };
export type EnvelopeErr = { ok: false; code: string; message: string };

export const validateActionEnvelope = (incoming: unknown): EnvelopeOk | EnvelopeErr => {
    if (!isRecord(incoming)) {
        return { ok: false, code: 'ERR_BAD_ARGS', message: 'invalid action envelope' };
    }
    if (incoming.v !== 1) {
        return { ok: false, code: 'ERR_BAD_ARGS', message: 'invalid action envelope' };
    }
    const id = incoming.id;
    const type = incoming.type;
    if (typeof id !== 'string' || typeof type !== 'string') {
        return { ok: false, code: 'ERR_BAD_ARGS', message: 'invalid action envelope' };
    }
    if (
        has(incoming, 'scope')
        || has(incoming, 'workspaceId')
        || has(incoming, 'tabToken')
        || has(incoming, 'tabName')
        || has(incoming, 'tabId')
        || has(incoming, 'windowId')
        || has(incoming, 'chromeTabNo')
    ) {
        return { ok: false, code: 'ERR_BAD_ARGS', message: 'legacy address fields are not allowed' };
    }
    const payload = incoming.payload;
    if (
        isRecord(payload)
        && (
            has(payload, 'workspaceName')
            || has(payload, 'scope')
            || has(payload, 'workspaceId')
            || has(payload, 'tabToken')
            || has(payload, 'tabId')
        )
    ) {
        return { ok: false, code: 'ERR_BAD_ARGS', message: 'legacy address fields are not allowed in payload' };
    }
    if (!isRequestActionType(type)) {
        return { ok: false, code: 'ERR_BAD_ARGS', message: `unsupported command type '${type}'` };
    }
    return { ok: true, action: incoming as Action };
};
