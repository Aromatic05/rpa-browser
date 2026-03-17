export const ACTION_TYPES = {
    WORKSPACE_LIST: 'workspace.list',
    WORKSPACE_CREATE: 'workspace.create',
    WORKSPACE_SET_ACTIVE: 'workspace.setActive',
    WORKSPACE_SAVE: 'workspace.save',
    WORKSPACE_RESTORE: 'workspace.restore',
    WORKSPACE_CHANGED: 'workspace.changed',
    WORKSPACE_SYNC: 'workspace.sync',

    TAB_INIT: 'tab.init',
    TAB_LIST: 'tab.list',
    TAB_CREATE: 'tab.create',
    TAB_CLOSE: 'tab.close',
    TAB_SET_ACTIVE: 'tab.setActive',
    TAB_OPENED: 'tab.opened',
    TAB_REPORTED: 'tab.report',
    TAB_ACTIVATED: 'tab.activated',
    TAB_CLOSED: 'tab.closed',
    TAB_PING: 'tab.ping',
    TAB_BOUND: 'tab.bound',
    TAB_REASSIGN: 'tab.reassign',

    RECORD_START: 'record.start',
    RECORD_STOP: 'record.stop',
    RECORD_GET: 'record.get',
    RECORD_CLEAR: 'record.clear',
    RECORD_LIST: 'record.list',
    RECORD_EVENT: 'record.event',
    PLAY_START: 'play.start',
    PLAY_STOP: 'play.stop',

    TASK_RUN_START: 'task.run.start',
    TASK_RUN_PUSH: 'task.run.push',
    TASK_RUN_POLL: 'task.run.poll',
    TASK_RUN_CHECKPOINT: 'task.run.checkpoint',
    TASK_RUN_HALT: 'task.run.halt',
    TASK_RUN_SUSPEND: 'task.run.suspend',
    TASK_RUN_CONTINUE: 'task.run.continue',
    TASK_RUN_FLUSH: 'task.run.flush',
    TASK_RUN_RESUME: 'task.run.resume',
} as const;

export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];

export const isActionType = (value: string): value is ActionType =>
    Object.values(ACTION_TYPES).includes(value as ActionType);
