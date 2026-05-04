import type { Action } from './action_protocol';
import { classifyActionType } from './action_types';

export type ActionRouteKind = 'control' | 'workspace' | 'reply' | 'event' | 'invalid';

const CONTROL_ACTIONS = new Set<string>([
    'workspace.list',
    'workspace.create',
    'workspace.setActive',
    'workflow.list',
    'workflow.create',
    'workflow.open',
    'workflow.rename',
    'tab.init',
]);

const WORKSPACE_ACTIONS = new Set<string>([
    'tab.list',
    'tab.create',
    'tab.close',
    'tab.setActive',
    'tab.opened',
    'tab.report',
    'tab.activated',
    'tab.closed',
    'tab.ping',
    'tab.reassign',
    'record.start',
    'record.stop',
    'record.get',
    'record.save',
    'record.load',
    'record.clear',
    'record.list',
    'record.event',
    'play.start',
    'play.stop',
    'dsl.get',
    'dsl.save',
    'dsl.test',
    'dsl.run',
    'task.run.start',
    'task.run.push',
    'task.run.poll',
    'task.run.checkpoint',
    'task.run.halt',
    'task.run.suspend',
    'task.run.continue',
    'task.run.flush',
    'task.run.resume',
    'checkpoint.list',
    'checkpoint.get',
    'checkpoint.save',
    'checkpoint.delete',
    'entity_rules.list',
    'entity_rules.get',
    'entity_rules.save',
    'entity_rules.delete',
    'mcp.start',
    'mcp.stop',
    'mcp.status',
]);

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
    classifyActionType(action.type) === 'command' && CONTROL_ACTIONS.has(action.type);

export const isWorkspaceAction = (action: Action): boolean =>
    classifyActionType(action.type) === 'command' && WORKSPACE_ACTIONS.has(action.type);

export const classifyActionRoute = (action: Action): ActionRouteKind => {
    if (isReplyAction(action)) {return 'reply';}
    if (isEventAction(action)) {return 'event';}

    const kind = classifyActionType(action.type);
    if (kind !== 'command') {return 'invalid';}

    const actionWN = hasActionWorkspaceName(action);
    const payloadWN = hasPayloadWorkspaceName(action);

    if (actionWN && payloadWN) {return 'invalid';}

    if (CONTROL_ACTIONS.has(action.type)) {
        if (actionWN) {return 'invalid';}
        return 'control';
    }

    if (WORKSPACE_ACTIONS.has(action.type)) {
        if (!actionWN) {return 'invalid';}
        if (payloadWN) {return 'invalid';}
        return 'workspace';
    }

    return 'invalid';
};
