import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import { replyAction } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type {
    WorkspaceService,
    WorkspaceServiceStartResult,
    WorkspaceServiceStopResult,
    WorkspaceServiceStatusResult,
} from '../runtime/service/types';

export type McpControl = {
    start: () => Promise<WorkspaceServiceStartResult>;
    stop: () => Promise<WorkspaceServiceStopResult>;
    status: () => WorkspaceServiceStatusResult;
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
};

export const createMcpControl = (service: WorkspaceService): McpControl => ({
    start: () => service.start(),
    stop: () => service.stop(),
    status: () => service.status(),

    handle: async (input) => {
        const { action, workspace } = input;

        switch (action.type) {
            case 'mcp.start': {
                const result = await workspace.mcp.start();
                return {
                    reply: replyAction(action, {
                        workspaceName: result.workspaceName,
                        serviceName: result.serviceName,
                        port: result.port,
                        status: result.status,
                    }),
                    events: [],
                };
            }

            case 'mcp.stop': {
                const result = await workspace.mcp.stop();
                return {
                    reply: replyAction(action, {
                        workspaceName: result.workspaceName,
                        serviceName: result.serviceName,
                        status: result.status,
                    }),
                    events: [],
                };
            }

            case 'mcp.status': {
                const result = workspace.mcp.status();
                return {
                    reply: replyAction(action, {
                        workspaceName: result.workspaceName,
                        serviceName: result.serviceName,
                        port: result.port,
                        status: result.status,
                    }),
                    events: [],
                };
            }

            default:
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported mcp action: ${action.type}`);
        }
    },
});
