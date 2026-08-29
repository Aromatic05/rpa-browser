import {replyAction} from '../../interface/actions/action_protocol';
import {ActionError, ERROR_CODES} from '../../interface/actions/results';
import type {ControlPlaneResult} from '../../automation/runtime/control_plane';
import type {WorkspaceRouterInput} from '../../automation/runtime/workspace/router';
import type {
    WorkspaceServiceStartResult,
    WorkspaceServiceStatusResult,
    WorkspaceServiceStopResult,
} from '../../automation/runtime/service/types';
import {AgentRequestError, parseAgentRunRequest} from '../execution/request';
import type {AgentRunRequest, AgentRunResult} from '../execution/types';
import type {SessionRetentionPolicy} from './session/store';
import type {WorkspaceAgentService} from './runtime';

export type AgentControl = {
    start: () => Promise<WorkspaceServiceStartResult>;
    stop: () => Promise<WorkspaceServiceStopResult>;
    status: () => WorkspaceServiceStatusResult;
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
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
            default:
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported agent action: ${action.type}`);
        }
    },
});
