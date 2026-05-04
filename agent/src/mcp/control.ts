import { replyAction, type Action } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { ControlPlaneResult } from '../runtime/control_plane';
import type { RuntimeWorkspace } from '../runtime/workspace/workspace';
import type {
    WorkspaceService,
    WorkspaceServiceStartResult,
    WorkspaceServiceStopResult,
    WorkspaceServiceStatusResult,
} from '../runtime/service/types';

export type McpControlInput = {
    action: Action;
    workspace: RuntimeWorkspace;
};

export type McpControl = {
    start: () => Promise<WorkspaceServiceStartResult>;
    stop: () => Promise<WorkspaceServiceStopResult>;
    status: () => WorkspaceServiceStatusResult;
    handle: (action: Action, workspace: RuntimeWorkspace) => Promise<ControlPlaneResult>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export const createMcpControl = (service: WorkspaceService): McpControl => {
    const start = () => service.start();
    const stop = () => service.stop();
    const status = () => service.status();

    return {
        start,
        stop,
        status,

        async handle(action, _workspace) {
            const payload = isRecord(action.payload) ? action.payload : {};
            if (typeof payload.workspaceName === 'string' && payload.workspaceName.trim().length > 0) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'mcp actions do not accept payload.workspaceName');
            }

            if (action.type === 'mcp.start') {
                const result = await start();
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

            if (action.type === 'mcp.stop') {
                const result = await stop();
                return {
                    reply: replyAction(action, {
                        workspaceName: result.workspaceName,
                        serviceName: result.serviceName,
                        status: result.status,
                    }),
                    events: [],
                };
            }

            if (action.type === 'mcp.status') {
                const result = status();
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

            throw new Error(`unsupported mcp action: ${action.type}`);
        },
    };
};
