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
import type {WorkspaceAgentService} from './runtime';

export type AgentControl = {
    start: () => Promise<WorkspaceServiceStartResult>;
    stop: () => Promise<WorkspaceServiceStopResult>;
    status: () => WorkspaceServiceStatusResult;
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
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
            default:
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported agent action: ${action.type}`);
        }
    },
});
