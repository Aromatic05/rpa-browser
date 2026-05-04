import type { Action } from './action_protocol.js';
import { classifyActionType } from './action_types.js';

export type ActionRouteKind = 'control' | 'workspace' | 'reply' | 'event' | 'invalid';

const hasActionWorkspaceName = (action: Action): boolean =>
    typeof action.workspaceName === 'string' && action.workspaceName.trim().length > 0;

const hasPayloadWorkspaceName = (action: Action): boolean => {
    const payload = action.payload;
    if (!payload || typeof payload !== 'object') {return false;}
    const wn = (payload as Record<string, unknown>).workspaceName;
    return typeof wn === 'string' && wn.trim().length > 0;
};

export const isReplyAction = (action: Action): boolean => classifyActionType(action.type) === 'reply';

export const isEventAction = (action: Action): boolean => classifyActionType(action.type) === 'event';

export const isControlAction = (action: Action): boolean =>
    classifyActionType(action.type) === 'command' && !hasActionWorkspaceName(action);

export const isWorkspaceAction = (action: Action): boolean =>
    classifyActionType(action.type) === 'command' && hasActionWorkspaceName(action);

export const classifyActionRoute = (action: Action): ActionRouteKind => {
    if (isReplyAction(action)) {return 'reply';}
    if (isEventAction(action)) {return 'event';}

    const kind = classifyActionType(action.type);
    if (kind !== 'command') {return 'invalid';}

    const actionWN = hasActionWorkspaceName(action);
    const payloadWN = hasPayloadWorkspaceName(action);

    if (actionWN && payloadWN) {return 'invalid';}

    if (actionWN) {return 'workspace';}
    return 'control';
};
