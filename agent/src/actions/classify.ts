import type { Action } from './action_protocol';
import { classifyActionType } from './action_types';

export type ActionRouteKind = 'control' | 'workspace' | 'reply' | 'event' | 'invalid';
const WORKSPACE_ONLY_PREFIXES = ['checkpoint.', 'entity_rules.', 'mcp.'];
const isWorkspaceOnlyType = (type: string): boolean => WORKSPACE_ONLY_PREFIXES.some((prefix) => type.startsWith(prefix));

export const isReplyAction = (action: Action): boolean => classifyActionType(action.type) === 'reply';

export const isEventAction = (action: Action): boolean => classifyActionType(action.type) === 'event';

export const isControlAction = (action: Action): boolean =>
    classifyActionType(action.type) === 'command' && !action.workspaceName && !isWorkspaceOnlyType(action.type);

export const isWorkspaceAction = (action: Action): boolean =>
    classifyActionType(action.type) === 'command' && typeof action.workspaceName === 'string' && action.workspaceName.trim().length > 0;

export const classifyActionRoute = (action: Action): ActionRouteKind => {
    if (isReplyAction(action)) {return 'reply';}
    if (isEventAction(action)) {return 'event';}
    if (isControlAction(action)) {return 'control';}
    if (isWorkspaceAction(action)) {return 'workspace';}
    return 'invalid';
};
