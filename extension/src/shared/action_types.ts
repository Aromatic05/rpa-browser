export const REQUEST_ACTION_TYPES = {
    WORKSPACE_LIST: 'workspace.list',
    WORKSPACE_CREATE: 'workspace.create',
    WORKSPACE_SET_ACTIVE: 'workspace.setActive',
    WORKSPACE_SAVE: 'workspace.save',
    WORKSPACE_RESTORE: 'workspace.restore',

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

const FIXED_EVENT_ACTION_TYPES = {
    WORKSPACE_CHANGED: 'workspace.changed',
    WORKSPACE_SYNC: 'workspace.sync',
    TAB_BOUND: 'tab.bound',

    PLAY_STARTED: 'play.started',
    PLAY_STEP_STARTED: 'play.step.started',
    PLAY_STEP_FINISHED: 'play.step.finished',
    PLAY_PROGRESS: 'play.progress',
    PLAY_COMPLETED: 'play.completed',
    PLAY_FAILED: 'play.failed',
    PLAY_CANCELED: 'play.canceled',
} as const;

export const ACTION_TYPES = { ...REQUEST_ACTION_TYPES, ...FIXED_EVENT_ACTION_TYPES } as const;

export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];
export type RequestActionType = (typeof REQUEST_ACTION_TYPES)[keyof typeof REQUEST_ACTION_TYPES];
export type ActionMessageKind = 'command' | 'reply' | 'event' | 'invalid';

const requestTypes = new Set<string>(Object.values(REQUEST_ACTION_TYPES));
const fixedEventTypes = new Set<string>(Object.values(FIXED_EVENT_ACTION_TYPES));
const domainPrefixes = new Set<string>([
    ...Object.values(REQUEST_ACTION_TYPES).map((type) => type.split('.')[0]),
    'action',
]);

const SEGMENT_RE = /^[a-z][a-zA-Z0-9]*$/;
const resultOrFailureTypeRe = /^([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+)\.(result|failed)$/;
const eventTypeRe = /^([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*)\.(started|progress|completed|canceled|event)$/;
const stepEventTypeRe = /^([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*)\.step\.(started|finished)$/;

const hasAllowedPrefix = (domain: string) => {
    const first = domain.split('.')[0] || '';
    return domainPrefixes.has(first);
};

const isNamedDomain = (domain: string) => domain.split('.').every((part) => SEGMENT_RE.test(part));

export const isRequestActionType = (value: string): value is RequestActionType => requestTypes.has(value);

export const isReplyActionType = (value: string) => {
    const match = value.match(resultOrFailureTypeRe);
    if (!match) {return false;}
    return isRequestActionType(match[1]);
};

export const isDerivedEventActionType = (value: string) => {
    if (fixedEventTypes.has(value)) {return true;}
    const eventMatch = value.match(eventTypeRe);
    if (eventMatch) {
        const domain = eventMatch[1];
        return isNamedDomain(domain) && hasAllowedPrefix(domain);
    }
    const stepMatch = value.match(stepEventTypeRe);
    if (!stepMatch) {return false;}
    const domain = stepMatch[1];
    return isNamedDomain(domain) && hasAllowedPrefix(domain);
};

export const isDispatchActionType = (value: string): value is ActionType | string =>
    isRequestActionType(value) || isReplyActionType(value) || isDerivedEventActionType(value);

export const classifyActionType = (value: string): ActionMessageKind => {
    if (isRequestActionType(value)) {return 'command';}
    if (isReplyActionType(value)) {return 'reply';}
    if (isDerivedEventActionType(value)) {return 'event';}
    return 'invalid';
};

export const deriveFailedActionType = (requestType: string) =>
    isRequestActionType(requestType) ? `${requestType}.failed` : 'action.dispatch.failed';
