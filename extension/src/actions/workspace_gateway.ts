import type { Action } from './action_protocol.js';
import type { WsClient } from './ws_client.js';
import { mkRequestFailedReply } from './results.js';

export const dispatchWorkspaceAction = async (action: Action, wsClient: WsClient): Promise<Action> => {
    if (typeof action.workspaceName !== 'string' || !action.workspaceName) {
        return mkRequestFailedReply(action.type, action.id, 'ERR_BAD_ARGS', 'workspace action requires workspaceName');
    }
    return await wsClient.sendAction(action);
};
