import {replyAction} from '../../interface/actions/action_protocol';
import {ActionError, ERROR_CODES, type ErrorCode} from '../../interface/actions/results';
import type {ControlPlaneResult} from '../../automation/runtime/control_plane';
import type {WorkspaceRouterInput} from '../../automation/runtime/workspace/router';
import type {
    WorkspaceServiceStartResult,
    WorkspaceServiceStatusResult,
    WorkspaceServiceStopResult,
} from '../../automation/runtime/service/types';
import {AgentRequestError, parseAgentRunRequest} from '../execution/request';
import {
    InteractionConcurrencyError,
    InteractionStateError,
    InteractionValidationError,
} from '../interaction';
import type {AgentRunRequest, AgentRunResult} from '../execution/types';
import {ActivityConflictError, SessionCancelledError} from './session/manager';
import type {SessionRetentionPolicy} from './session/store';
import type {WorkspaceAgentService} from './runtime';
import {
    dispatchProductCommand,
    ProductCommandError,
    type ProductController,
} from '../product';

export type AgentControl = {
    start: () => Promise<WorkspaceServiceStartResult>;
    stop: () => Promise<WorkspaceServiceStopResult>;
    status: () => WorkspaceServiceStatusResult;
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
    /** Task-centric product control surface. */
    product: ProductController;
};

const requireBoundId = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `${name} is required`);
    }
    return value.trim();
};

const requireRevision = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'revision must be a non-negative integer');
    }
    return value;
};

const toInteractionActionError = (error: unknown): ActionError => {
    if (error instanceof InteractionValidationError) {
        return new ActionError(ERROR_CODES.ERR_BAD_ARGS, error.message);
    }
    if (error instanceof InteractionConcurrencyError) {
        return new ActionError(ERROR_CODES.ERR_STALE, error.message);
    }
    if (error instanceof InteractionStateError) {
        return new ActionError(ERROR_CODES.ERR_BAD_STATE, error.message);
    }
    throw error;
};

const PRODUCT_COMMAND_ACTION_CODES: Record<string, ErrorCode> = {
    ERR_STALE: ERROR_CODES.ERR_STALE,
    ERR_ACTIVITY_CONFLICT: ERROR_CODES.ERR_CONFLICT,
    ERR_BAD_ARGS: ERROR_CODES.ERR_BAD_ARGS,
    ERR_NOT_FOUND: ERROR_CODES.ERR_NOT_FOUND,
};

/** Preserves product semantics inside the Action failure envelope: the
 *  original product code travels in `details` next to the mapped Action code. */
const toProductActionError = (error: unknown): ActionError => {
    if (error instanceof ProductCommandError) {
        return new ActionError(
            PRODUCT_COMMAND_ACTION_CODES[error.code] ?? ERROR_CODES.ERR_BAD_ARGS,
            error.message,
            {productCode: error.code},
        );
    }
    if (error instanceof ActivityConflictError) {
        return new ActionError(ERROR_CODES.ERR_CONFLICT, error.message, {productCode: error.code});
    }
    if (error instanceof SessionCancelledError) {
        return new ActionError(ERROR_CODES.ERR_BAD_STATE, error.message, {productCode: error.code});
    }
    return toInteractionActionError(error);
};

const parseRetentionPolicy = (payload: unknown): SessionRetentionPolicy => {
    const value = (payload ?? {}) as Record<string, unknown>;
    const policy: SessionRetentionPolicy = {};
    if (value.maxAgeMs !== undefined) {
        if (typeof value.maxAgeMs !== 'number' || !Number.isFinite(value.maxAgeMs) || value.maxAgeMs < 0) {
            throw new AgentRequestError('maxAgeMs must be a non-negative number');
        }
        policy.maxAgeMs = value.maxAgeMs;
    }
    if (value.maxCount !== undefined) {
        if (typeof value.maxCount !== 'number' || !Number.isInteger(value.maxCount) || value.maxCount < 0) {
            throw new AgentRequestError('maxCount must be a non-negative integer');
        }
        policy.maxCount = value.maxCount;
    }
    return policy;
};

export const createAgentControl = (service: WorkspaceAgentService): AgentControl => ({
    start: () => service.start(),
    stop: () => service.stop(),
    status: () => service.status(),
    run: (request) => service.run(request),
    product: service.product,
    handle: async ({action}) => {
        switch (action.type) {
            case 'agent.start': {
                const result = await service.start();
                return {reply: replyAction(action, result), events: []};
            }
            case 'agent.stop': {
                const result = await service.stop();
                return {reply: replyAction(action, result), events: []};
            }
            case 'agent.status': {
                return {reply: replyAction(action, service.status()), events: []};
            }
            case 'agent.run': {
                try {
                    const result = await service.run(parseAgentRunRequest(action.payload));
                    return {reply: replyAction(action, result), events: []};
                } catch (error) {
                    if (error instanceof AgentRequestError) {
                        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, error.message);
                    }
                    throw error;
                }
            }
            case 'agent.sessions.start': {
                try {
                    const snapshot = service.sessions.start(parseAgentRunRequest(action.payload));
                    return {reply: replyAction(action, snapshot), events: []};
                } catch (error) {
                    if (error instanceof AgentRequestError) {
                        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, error.message);
                    }
                    throw error;
                }
            }
            case 'agent.sessions.list': {
                return {reply: replyAction(action, {sessions: service.sessions.list()}), events: []};
            }
            case 'agent.sessions.status': {
                const {sessionId} = (action.payload ?? {}) as {sessionId?: string};
                const snapshot = service.sessions.status((sessionId || '').trim());
                if (!snapshot) {
                    throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `session not found: ${sessionId}`);
                }
                return {reply: replyAction(action, snapshot), events: []};
            }
            case 'agent.sessions.cancel': {
                const {sessionId} = (action.payload ?? {}) as {sessionId?: string};
                const targetId = (sessionId || '').trim();
                if (!targetId) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'sessionId is required');
                }
                const snapshot = service.sessions.cancel(targetId);
                if (!snapshot) {
                    throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `session not found: ${targetId}`);
                }
                return {reply: replyAction(action, snapshot), events: []};
            }
            case 'agent.sessions.report': {
                const {sessionId} = (action.payload ?? {}) as {sessionId?: string};
                const targetId = (sessionId || '').trim();
                if (!targetId) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'sessionId is required');
                }
                const report = service.sessions.report(targetId);
                if (!report) {
                    throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `session report not found: ${targetId}`);
                }
                return {reply: replyAction(action, report), events: []};
            }
            case 'agent.sessions.prune': {
                try {
                    const policy = parseRetentionPolicy(action.payload);
                    const pruned = service.sessions.prune(policy);
                    return {reply: replyAction(action, {pruned}), events: []};
                } catch (error) {
                    if (error instanceof AgentRequestError) {
                        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, error.message);
                    }
                    throw error;
                }
            }
            case 'agent.interactions.list': {
                const {sessionId} = (action.payload ?? {}) as {sessionId?: string};
                const targetId = requireBoundId(sessionId, 'sessionId');
                const interactions = service.sessions.listInteractions(targetId);
                if (interactions === null) {
                    throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `session not found: ${targetId}`);
                }
                return {reply: replyAction(action, {interactions}), events: []};
            }
            case 'agent.interactions.get': {
                const {sessionId, interactionId} = (action.payload ?? {}) as {
                    sessionId?: string;
                    interactionId?: string;
                };
                const targetId = requireBoundId(sessionId, 'sessionId');
                const targetInteractionId = requireBoundId(interactionId, 'interactionId');
                const record = service.sessions.getInteraction(targetId, targetInteractionId);
                if (!record) {
                    throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `interaction not found: ${targetInteractionId}`);
                }
                return {reply: replyAction(action, record), events: []};
            }
            case 'agent.interactions.approve': {
                const {sessionId, interactionId, revision, approvedBy} = (action.payload ?? {}) as {
                    sessionId?: string;
                    interactionId?: string;
                    revision?: number;
                    approvedBy?: string;
                };
                const targetId = requireBoundId(sessionId, 'sessionId');
                const targetInteractionId = requireBoundId(interactionId, 'interactionId');
                const approvedActor = requireBoundId(approvedBy, 'approvedBy');
                const expectedRevision = requireRevision(revision);
                try {
                    const decided = await service.sessions.approveInteraction(
                        targetId,
                        targetInteractionId,
                        expectedRevision,
                        approvedActor,
                    );
                    if (!decided) {
                        throw new ActionError(
                            ERROR_CODES.ERR_NOT_FOUND,
                            `interaction not found for session: ${targetInteractionId}`,
                        );
                    }
                    return {reply: replyAction(action, decided), events: []};
                } catch (error) {
                    if (error instanceof ActionError) {throw error;}
                    throw toInteractionActionError(error);
                }
            }
            case 'agent.interactions.deny': {
                const {sessionId, interactionId, revision, deniedBy, reason} = (action.payload ?? {}) as {
                    sessionId?: string;
                    interactionId?: string;
                    revision?: number;
                    deniedBy?: string;
                    reason?: string;
                };
                const targetId = requireBoundId(sessionId, 'sessionId');
                const targetInteractionId = requireBoundId(interactionId, 'interactionId');
                const deniedActor = requireBoundId(deniedBy, 'deniedBy');
                const denyReason = requireBoundId(reason, 'reason');
                const expectedRevision = requireRevision(revision);
                try {
                    const decided = await service.sessions.denyInteraction(
                        targetId,
                        targetInteractionId,
                        expectedRevision,
                        deniedActor,
                        denyReason,
                    );
                    if (!decided) {
                        throw new ActionError(
                            ERROR_CODES.ERR_NOT_FOUND,
                            `interaction not found for session: ${targetInteractionId}`,
                        );
                    }
                    return {reply: replyAction(action, decided), events: []};
                } catch (error) {
                    if (error instanceof ActionError) {throw error;}
                    throw toInteractionActionError(error);
                }
            }
            case 'agent.product': {
                try {
                    const data = await dispatchProductCommand(service.product, action.payload);
                    return {reply: replyAction(action, data), events: []};
                } catch (error) {
                    if (error instanceof ActionError) {throw error;}
                    throw toProductActionError(error);
                }
            }
            default:
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported agent action: ${action.type}`);
        }
    },
});
