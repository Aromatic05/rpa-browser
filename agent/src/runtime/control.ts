import crypto from 'node:crypto';
import { replyAction, type Action } from '../actions/action_protocol';
import { ActionError } from '../actions/failure';
import { ERROR_CODES } from '../actions/error_codes';
import { createWorkflowOnFs, listWorkflowNames, loadWorkflowFromFs, renameWorkflowOnFs } from '../workflow';

export type ControlPlaneResult = { reply: Action; events: Action[] };

export type RuntimeControlInput = {
    action: Action;
    workspaceRegistry: any;
};

const randomName = () => crypto.randomUUID();

export const handleRuntimeControlAction = async (input: RuntimeControlInput): Promise<ControlPlaneResult> => {
    const { action, workspaceRegistry } = input;

    switch (action.type) {
        case 'workspace.list': {
            const active = workspaceRegistry.getActiveWorkspace();
            return {
                reply: replyAction(action, {
                    workspaces: workspaceRegistry.listWorkspaces().map((workspace: any) => ({
                        workspaceName: workspace.name,
                        activeTabName: workspace.tabRegistry.getActiveTab()?.name ?? null,
                        tabCount: workspace.tabRegistry.listTabs().length,
                        createdAt: workspace.createdAt,
                        updatedAt: workspace.updatedAt,
                    })),
                    activeWorkspaceName: active?.name ?? null,
                }),
                events: [],
            };
        }
        case 'workspace.create': {
            const payload = (action.payload ?? {}) as { workspaceName?: string };
            const workspaceName = (payload.workspaceName || '').trim() || randomName();
            const workflow = createWorkflowOnFs(workspaceName);
            const workspace = workspaceRegistry.createWorkspace(workspaceName, workflow);
            return { reply: replyAction(action, { workspaceName: workspace.name, tabName: null }), events: [] };
        }
        case 'tab.init': {
            return { reply: replyAction(action, { workspaceName: null, tabName: randomName() }), events: [] };
        }
        case 'workflow.list': {
            return {
                reply: replyAction(action, { workflows: listWorkflowNames().map((workflowName) => ({ workflowName })) }),
                events: [],
            };
        }
        case 'workflow.create': {
            const payload = (action.payload ?? {}) as { workflowName?: string };
            const workflowName = (payload.workflowName || '').trim();
            if (!workflowName) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'workflowName is required');
            }
            const workflow = createWorkflowOnFs(workflowName);
            const workspace = workspaceRegistry.createWorkspace(workflowName, workflow);
            if (workspace.name !== workspace.workflow.name) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'workspace/workflow identity mismatch after create');
            }
            return { reply: replyAction(action, { workflowName, workspaceName: workspace.name, created: true }), events: [] };
        }
        case 'workflow.open': {
            const payload = (action.payload ?? {}) as { workflowName?: string };
            const workflowName = (payload.workflowName || '').trim();
            if (!workflowName) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'workflowName is required');
            }
            const workflow = loadWorkflowFromFs(workflowName);
            const workspace = workspaceRegistry.createWorkspace(workflowName, workflow);
            if (workspace.name !== workspace.workflow.name) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'workspace/workflow identity mismatch after open');
            }
            return { reply: replyAction(action, { workflowName, workspaceName: workspace.name, opened: true }), events: [] };
        }
        case 'workflow.rename': {
            const payload = (action.payload ?? {}) as { fromName?: string; toName?: string };
            const fromName = (payload.fromName || '').trim();
            const toName = (payload.toName || '').trim();
            if (!fromName || !toName) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'fromName and toName are required');
            }
            renameWorkflowOnFs(fromName, toName);
            const renamedWorkflow = loadWorkflowFromFs(toName);
            const workspace = workspaceRegistry.renameWorkspace(fromName, toName, renamedWorkflow);
            if (workspace.name !== workspace.workflow.name) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'workspace/workflow identity mismatch after rename');
            }
            return { reply: replyAction(action, { fromName, toName, workspaceName: workspace.name, renamed: true }), events: [] };
        }
        default:
            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    }
};
