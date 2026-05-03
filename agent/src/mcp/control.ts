import { replyAction, type Action } from '../actions/action_protocol';
import type { ControlPlaneResult } from '../runtime/control';
import type { RuntimeWorkspace } from '../runtime/workspace_registry';
import type { WorkspaceServiceLifecycle } from '../runtime/service';

export type McpControlInput = {
    action: Action;
    workspace: RuntimeWorkspace;
};

export type McpControl = {
    handle: (action: Action, workspace: RuntimeWorkspace) => Promise<ControlPlaneResult>;
};

export const createMcpControl = (getLifecycle: (workspace: RuntimeWorkspace) => WorkspaceServiceLifecycle): McpControl => ({
    async handle(action, workspace) {
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
