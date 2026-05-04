import type { Action } from './action_protocol.js';
import type { WsClient } from './ws_client.js';
import { validateActionEnvelope } from './envelope.js';
import { classifyActionRoute } from './classify.js';
import { dispatchControlAction } from './control_gateway.js';
import { dispatchWorkspaceAction } from './workspace_gateway.js';
import { mkActionDispatchFailed, mkRequestFailedReply } from './results.js';

export const dispatchActionRequest = async (incoming: unknown, wsClient: WsClient): Promise<Action> => {
    const envelope = validateActionEnvelope(incoming);
    if (!envelope.ok) {
        const replyTo = typeof (incoming as { id?: unknown } | null | undefined)?.id === 'string'
            ? (incoming as { id: string }).id
            : undefined;
        return mkActionDispatchFailed(replyTo, envelope.code, envelope.message);
    }

    const action = envelope.action;
    const scope = classifyActionRoute(action);
    if (scope === 'control') {
        return await dispatchControlAction(action, wsClient);
    }
    if (scope === 'workspace') {
        return await dispatchWorkspaceAction(action, wsClient);
    }
    return mkRequestFailedReply(action.type, action.id, 'ERR_BAD_ARGS', `unsupported request action '${action.type}'`);
};
