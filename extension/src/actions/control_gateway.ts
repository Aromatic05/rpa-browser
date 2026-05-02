import type { Action } from '../shared/types.js';
import type { WsClient } from './ws_client.js';
import { mkRequestFailedReply } from './failure.js';

export const dispatchControlAction = async (action: Action, wsClient: WsClient): Promise<Action> => {
    if (typeof action.workspaceName === 'string' && action.workspaceName) {
        return mkRequestFailedReply(action.type, action.id, 'ERR_BAD_ARGS', 'control action must not carry workspaceName');
    }
    return await wsClient.sendAction(action);
};
