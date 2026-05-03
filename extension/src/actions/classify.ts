import { isDerivedEventActionType, isReplyActionType } from './action_types.js';

const CONTROL_ACTIONS = new Set<string>([
    'workspace.list',
    'workspace.create',
    'workflow.list',
    'workflow.create',
    'workflow.open',
    'workflow.rename',
    'tab.init',
]);

const WORKSPACE_ACTIONS = new Set<string>([
    'workspace.setActive',
    'workspace.save',
    'workspace.restore',
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
    'workflow.status',
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
]);

export type RequestScopeKind = 'control' | 'workspace' | 'invalid';

export const classifyRequestAction = (actionType: string): RequestScopeKind => {
    if (CONTROL_ACTIONS.has(actionType)) {return 'control';}
    if (WORKSPACE_ACTIONS.has(actionType)) {return 'workspace';}
    return 'invalid';
};

export const isControlAction = (actionType: string): boolean => CONTROL_ACTIONS.has(actionType);
export const isWorkspaceAction = (actionType: string): boolean => WORKSPACE_ACTIONS.has(actionType);
export const isReplyAction = (actionType: string): boolean => isReplyActionType(actionType);
export const isEventAction = (actionType: string): boolean => isDerivedEventActionType(actionType);
