export const REQUEST_ACTION_TYPES = {
    WORKFLOW_LIST: 'workflow.list',
    WORKFLOW_CREATE: 'workflow.create',
    WORKFLOW_OPEN: 'workflow.open',
    WORKFLOW_RENAME: 'workflow.rename',
    DSL_GET: 'dsl.get',
    DSL_SAVE: 'dsl.save',
    DSL_TEST: 'dsl.test',
    DSL_RUN: 'dsl.run',

    WORKSPACE_LIST: 'workspace.list',
    WORKSPACE_CREATE: 'workspace.create',
    WORKSPACE_SET_ACTIVE: 'workspace.setActive',

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
    RECORD_SAVE: 'record.save',
    RECORD_LOAD: 'record.load',
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
    CHECKPOINT_LIST: 'checkpoint.list',
    CHECKPOINT_GET: 'checkpoint.get',
    CHECKPOINT_SAVE: 'checkpoint.save',
    CHECKPOINT_DELETE: 'checkpoint.delete',
    ENTITY_RULE_LIST: 'entity_rules.list',
    ENTITY_RULE_GET: 'entity_rules.get',
    ENTITY_RULE_SAVE: 'entity_rules.save',
    ENTITY_RULE_DELETE: 'entity_rules.delete',
    MCP_START: 'mcp.start',
    MCP_STOP: 'mcp.stop',
    MCP_STATUS: 'mcp.status',
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

export const isReplyActionType = (value: string): boolean => {
    const match = value.match(resultOrFailureTypeRe);
    if (!match) {return false;}
    return isRequestActionType(match[1]);
};

export const isDerivedEventActionType = (value: string): boolean => {
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

export const classifyActionType = (value: string): ActionMessageKind => {
    if (isRequestActionType(value)) {return 'command';}
    if (isReplyActionType(value)) {return 'reply';}
    if (isDerivedEventActionType(value)) {return 'event';}
    return 'invalid';
};
