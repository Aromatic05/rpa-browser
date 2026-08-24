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
    handle: async ({action, workspace}) => {
        switch (action.type) {
            case 'agent.start': {
                const result = await workspace.agent.start();
                return {reply: replyAction(action, result), events: []};
            }
            case 'agent.stop': {
                const result = await workspace.agent.stop();
                return {reply: replyAction(action, result), events: []};
            }
            case 'agent.status': {
                return {reply: replyAction(action, workspace.agent.status()), events: []};
            }
            case 'agent.run': {
                try {
                    const result = await workspace.agent.run(parseAgentRunRequest(action.payload));
                    return {reply: replyAction(action, result), events: []};
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
