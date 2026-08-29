import { ActionError, ERROR_CODES } from '../../../interface/actions/results';
import type { RuntimeWorkspace, WorkspaceState } from './workspace';

export type WorkspaceExecutionOwnerKind = 'agent' | 'mcp' | 'dsl' | 'runner' | 'recording' | 'control';

export type WorkspaceExecutionIntent = 'active' | 'paused';

export type WorkspaceExecutionLease = Readonly<{
    token: symbol;
    kind: WorkspaceExecutionOwnerKind;
    id: string;
    startedAt: number;
    intent: WorkspaceExecutionIntent;
}>;

export type WorkspaceExecutionOwnerInput = Partial<Pick<WorkspaceExecutionLease, 'kind' | 'id' | 'intent'>>;

export type WorkspaceExecutionRelease = (() => void) & Readonly<{
    token: symbol;
    isReleased: () => boolean;
}>;

export const workspaceExecutionOwnerKind = (actionType: string): WorkspaceExecutionOwnerKind => {
    if (actionType.startsWith('agent.')) {return 'agent';}
    if (actionType.startsWith('mcp.')) {return 'mcp';}
    if (actionType.startsWith('dsl.')) {return 'dsl';}
    if (actionType.startsWith('task.run.')) {return 'runner';}
    if (actionType.startsWith('record.') || actionType.startsWith('play.')) {return 'recording';}
    return 'control';
};

export const getWorkspaceState = (workspace: RuntimeWorkspace): WorkspaceState => workspace.state;

export const requireWorkspaceState = (
    workspace: RuntimeWorkspace,
    expected: WorkspaceState,
    actionType: string,
): void => {
    if (workspace.state !== expected) {
        throw new ActionError(ERROR_CODES.ERR_BAD_STATE, `${actionType} requires workspace state=${expected}, current=${workspace.state}`);
    }
};

export const enterWorkspaceState = (
    workspace: RuntimeWorkspace,
    next: WorkspaceState,
    actionType: string,
): void => {
    if (workspace.state !== 'idle') {
        throw new ActionError(ERROR_CODES.ERR_BAD_STATE, `${actionType} requires workspace state=idle, current=${workspace.state}`);
    }
    workspace.state = next;
    workspace.updatedAt = Date.now();
};

export const leaveWorkspaceState = (
    workspace: RuntimeWorkspace,
    expected: WorkspaceState,
    actionType: string,
): void => {
    if (workspace.state !== expected) {
        throw new ActionError(ERROR_CODES.ERR_BAD_STATE, `${actionType} requires workspace state=${expected}, current=${workspace.state}`);
    }
    workspace.state = 'idle';
    workspace.updatedAt = Date.now();
};

export const acquireWorkspaceExecution = (
    workspace: RuntimeWorkspace,
    actionType: string,
    owner: WorkspaceExecutionOwnerInput = {},
): WorkspaceExecutionRelease => {
    const kind = owner.kind ?? workspaceExecutionOwnerKind(actionType);
    const id = owner.id ?? actionType;
    const requestedIntent: WorkspaceExecutionIntent = owner.intent ?? 'active';
    const held = workspace.executionLease;
    if (held && (held.kind !== kind || held.id !== id || held.intent === 'active')) {
        throw new ActionError(
            ERROR_CODES.ERR_BAD_STATE,
            `${actionType} blocked by ${held.kind} execution owner ${held.id} (intent=${held.intent}, workspace=${workspace.name})`,
        );
    }
    if (!held) {
        requireWorkspaceState(workspace, 'idle', actionType);
    }
    const reactivating = held !== null;
    if (reactivating && requestedIntent !== 'active') {
        throw new ActionError(ERROR_CODES.ERR_BAD_STATE, `${actionType} cannot pause an already-held owner ${kind}:${id}`);
    }
    const token = held ? held.token : Symbol(actionType);
    if (!held) {
        workspace.executionOwner = token;
    }
    if (requestedIntent === 'active') {
        enterWorkspaceState(workspace, 'executing', actionType);
    }
    const base = held ?? { token, kind, id, startedAt: Date.now() };
    workspace.executionLease = Object.freeze({ ...base, kind, id, intent: requestedIntent });
    let released = false;
    const release = () => {
        if (released) {return;}
        released = true;
        if (workspace.executionOwner !== token) {return;}
        if (reactivating) {
            workspace.executionLease = Object.freeze({ ...base, kind, id, intent: 'paused' });
            if (workspace.state === 'executing') {
                leaveWorkspaceState(workspace, 'executing', actionType);
            }
            return;
        }
        workspace.executionOwner = null;
        workspace.executionLease = null;
        if (requestedIntent === 'active' && workspace.state === 'executing') {
            leaveWorkspaceState(workspace, 'executing', actionType);
        }
    };
    return Object.assign(release, {
        token,
        isReleased: () => released,
    });
};

export const getWorkspaceExecutionLease = (workspace: RuntimeWorkspace): WorkspaceExecutionLease | null =>
    workspace.executionLease;

const transitionWorkspaceExecutionIntent = (
    workspace: RuntimeWorkspace,
    token: symbol,
    intent: WorkspaceExecutionIntent,
    actionType: string,
): WorkspaceExecutionLease => {
    const lease = workspace.executionLease;
    if (lease?.token !== token) {
        const current = lease ? `${lease.kind}:${lease.id}` : 'none';
        throw new ActionError(ERROR_CODES.ERR_BAD_STATE, `${actionType} requires current execution owner, workspace=${workspace.name} current=${current}`);
    }
    const next = Object.freeze({ ...lease, intent });
    workspace.executionLease = next;
    return next;
};

export const pauseWorkspaceExecution = (
    workspace: RuntimeWorkspace,
    token: symbol,
): WorkspaceExecutionLease => transitionWorkspaceExecutionIntent(workspace, token, 'paused', 'execution.pause');

export const resumeWorkspaceExecution = (
    workspace: RuntimeWorkspace,
    token: symbol,
): WorkspaceExecutionLease => transitionWorkspaceExecutionIntent(workspace, token, 'active', 'execution.resume');

export const assertWorkspaceExecutionReplaceable = (
    workspace: RuntimeWorkspace,
    operation: string,
): void => {
    const lease = workspace.executionLease;
    if (!lease) {return;}
    throw new ActionError(
        ERROR_CODES.ERR_BAD_STATE,
        `${operation} blocked by ${lease.kind} execution owner ${lease.id} (intent=${lease.intent}, startedAt=${lease.startedAt}, workspace=${workspace.name})`,
    );
};

export const runWorkspaceExecution = async <T>(
    workspace: RuntimeWorkspace,
    actionType: string,
    run: () => Promise<T>,
    owner: WorkspaceExecutionOwnerInput = {},
): Promise<T> => {
    const release = acquireWorkspaceExecution(workspace, actionType, owner);
    try {
        return await run();
    } finally {
        release();
    }
};
