import type { Action } from './action_protocol';

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseActionEnvelope = (action: Action): Action => {
    const envelope = action as Record<string, unknown>;
    if ('scope' in envelope) {
        throw new Error('legacy action address fields are not allowed: scope');
    }
    if ('tabToken' in envelope) {
        throw new Error('legacy action address fields are not allowed: tabToken');
    }
    if ('tabName' in envelope) {
        throw new Error('legacy action address fields are not allowed: tabName');
    }

    if (!isObjectRecord(action.payload)) {
        return action;
    }

    if ('scope' in action.payload) {
        throw new Error('legacy payload address fields are not allowed: scope');
    }

    return action;
};
