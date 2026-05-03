import { replyAction, type Action } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { ControlPlaneResult } from '../runtime/control';
import type { RuntimeWorkspace } from '../runtime/workspace_registry';
import type { WorkspaceServiceStartResult, WorkspaceServiceStopResult, WorkspaceServiceStatusResult } from '../runtime/service/types';

export type McpControlInput = {
    action: Action;
    workspace: RuntimeWorkspace;
};

export type McpControl = {
    handle: (action: Action, workspace: RuntimeWorkspace) => Promise<ControlPlaneResult>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export const createMcpControl = (getLifecycle: (workspace: RuntimeWorkspace) => { start: (serviceName: 'mcp') => Promise<WorkspaceServiceStartResult>; stop: (serviceName: 'mcp') => Promise<WorkspaceServiceStopResult>; status: (serviceName: 'mcp') => WorkspaceServiceStatusResult }): McpControl => ({
    async handle(action, workspace) {
        const payload = isRecord(action.payload) ? action.payload : {};
        if (typeof payload.workspaceName === 'string' && payload.workspaceName.trim().length > 0) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'mcp actions do not accept payload.workspaceName');
        }

        const lifecycle = getLifecycle(workspace);

        if (action.type === 'mcp.start') {
            const result = await lifecycle.start('mcp');
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
            const result = await lifecycle.stop('mcp');
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
            const result = lifecycle.status('mcp');
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
});
