import crypto from 'node:crypto';
import { replyAction, type Action } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import { copyWorkflowOnFs, createWorkflowOnFs, deleteWorkflowFromFs, listWorkflowNames, loadWorkflowFromFs, renameWorkflowAfterPreparationOnFs } from '../workflow';
import { getLogger } from '../logging/logger';
import type { RuntimeWorkspace, WorkspaceRegistry } from './workspace/registry';
import {requireWorkspaceState} from './workspace/workspace';

export type ControlPlaneResult = { reply: Action; events: Action[] };

export type RuntimeControlInput = {
    action: Action;
    workspaceRegistry: WorkspaceRegistry;
};

const randomName = () => crypto.randomUUID();

const stopWorkspaceRuntime = async (workspace: RuntimeWorkspace): Promise<void> => {
    let firstError: unknown;
    try {
        await workspace.mcp.stop();
    } catch (error) {
        firstError = error;
    }
    try {
        await workspace.runner.stop();
    } catch (error) {
        firstError = firstError || error;
    }
    try {
        await workspace.browserSession.stop();
    } catch (error) {
        firstError = firstError || error;
    }
    if (firstError) {throw firstError;}
};
const toWorkspaceSummary = (workspace: RuntimeWorkspace) => ({
    workspaceName: workspace.name,
    activeTabName: workspace.tabs.getActiveTab()?.name ?? null,
    tabCount: workspace.tabs.listTabs().length,
    browserSession: {
        status: workspace.browserSession.status,
        wsPort: workspace.browserSession.wsPort,
        cdpPort: workspace.browserSession.cdpPort,
        userDataDir: workspace.browserSession.userDataDir,
    },
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
});

export const handleRuntimeControlAction = async (input: RuntimeControlInput): Promise<ControlPlaneResult> => {
    const { action, workspaceRegistry } = input;

    switch (action.type) {
        case 'workspace.list': {
            const active = workspaceRegistry.getActiveWorkspace();
            return {
                reply: replyAction(action, {
                    workspaces: workspaceRegistry.listWorkspaces().map((workspace) => toWorkspaceSummary(workspace)),
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
        case 'workspace.setActive': {
            const payload = (action.payload ?? {}) as { workspaceName?: string };
            const targetName = (payload.workspaceName || '').trim();
            if (!targetName) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'workspaceName is required');
            }
            const target = workspaceRegistry.getWorkspace(targetName);
            if (!target) {
                throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `workspace not found: ${targetName}`);
            }
            workspaceRegistry.setActiveWorkspace(targetName);
            target.browserSession.emit(action);
            return { reply: replyAction(action, { workspaceName: targetName }), events: [] };
        }
        case 'workspace.close': {
            const payload = (action.payload ?? {}) as { workspaceName?: string };
            const targetName = (payload.workspaceName || '').trim();
            if (!targetName) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'workspaceName is required');
            }
            const target = workspaceRegistry.getWorkspace(targetName);
            if (!target) {
                throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `workspace not found: ${targetName}`);
            }
            requireWorkspaceState(target, 'idle', action.type);
            await stopWorkspaceRuntime(target);
            workspaceRegistry.removeWorkspace(targetName);
            return { reply: replyAction(action, { workspaceName: targetName, closed: true }), events: [] };
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
            workspaceRegistry.setActiveWorkspace(workspace.name);
            await workspace.browserSession.start();
            const hasLiveTab = workspace.tabs.listTabs().some((tab) =>
                tab.page !== null && !tab.page.isClosed());
            if (!hasLiveTab) {
                const tabName = crypto.randomUUID();
                workspace.tabs.createTab({ tabName });
                await workspace.tabs.createTabPage(tabName, { startUrl: 'about:blank', newWindow: true });
            }
            const event: Action = {
                v: 1,
                id: crypto.randomUUID(),
                type: 'workspace.changed',
                workspaceName: workspace.name,
                payload: { workspaceName: workspace.name, activeWorkspaceName: workspace.name, sourceType: action.type },
                at: Date.now(),
                traceId: action.traceId,
            };
            return { reply: replyAction(action, { workflowName, workspaceName: workspace.name, opened: true }), events: [event] };
        }
        case 'workflow.rename': {
            const payload = (action.payload ?? {}) as { fromName?: string; toName?: string };
            const fromName = (payload.fromName || '').trim();
            const toName = (payload.toName || '').trim();
            if (!fromName || !toName) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'fromName and toName are required');
            }
            const currentWorkspace = workspaceRegistry.getWorkspace(fromName);
            if (currentWorkspace) {requireWorkspaceState(currentWorkspace, 'idle', action.type);}
            await renameWorkflowAfterPreparationOnFs(fromName, toName, async () => {
                if (currentWorkspace) {
                    await stopWorkspaceRuntime(currentWorkspace);
                }
            });
            const renamedWorkflow = loadWorkflowFromFs(toName);
            const workspace = workspaceRegistry.renameWorkspace(fromName, toName, renamedWorkflow);
            if (workspace.name !== workspace.workflow.name) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'workspace/workflow identity mismatch after rename');
            }
            return { reply: replyAction(action, { fromName, toName, workspaceName: workspace.name, renamed: true }), events: [] };
        }
        case 'workflow.saveAs': {
            const payload = (action.payload ?? {}) as { sourceName?: string; targetName?: string };
            const sourceName = (payload.sourceName || '').trim();
            const targetName = (payload.targetName || '').trim();
            if (!sourceName || !targetName) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'sourceName and targetName are required');
            }
            if (sourceName === targetName) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'targetName must differ from sourceName');
            }
            if (!listWorkflowNames().includes(sourceName)) {
                throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `workflow not found: ${sourceName}`);
            }
            if (listWorkflowNames().includes(targetName)) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, `workflow already exists: ${targetName}`);
            }
            copyWorkflowOnFs(sourceName, targetName);
            const targetWorkflow = loadWorkflowFromFs(targetName);
            const targetWorkspace = workspaceRegistry.createWorkspace(targetName, targetWorkflow);
            workspaceRegistry.setActiveWorkspace(targetName);
            const event: Action = {
                v: 1,
                id: crypto.randomUUID(),
                type: 'workspace.changed',
                payload: { workspaceName: targetName, activeWorkspaceName: targetName },
                at: Date.now(),
                traceId: action.traceId,
            };
            return {
                reply: replyAction(action, { sourceName, targetName, workspaceName: targetWorkspace.name, savedAs: true }),
                events: [event],
            };
        }
        case 'workflow.resetDefault': {
            const currentDefault = workspaceRegistry.getWorkspace('default');
            if (currentDefault) {
                requireWorkspaceState(currentDefault, 'idle', action.type);
                await stopWorkspaceRuntime(currentDefault);
            }
            deleteWorkflowFromFs('default');
            const workflow = createWorkflowOnFs('default');
            workspaceRegistry.removeWorkspace('default');
            const workspace = workspaceRegistry.createWorkspace('default', workflow);
            workspaceRegistry.setActiveWorkspace('default');
            const event: Action = {
                v: 1,
                id: crypto.randomUUID(),
                type: 'workspace.changed',
                payload: { workspaceName: 'default', activeWorkspaceName: 'default' },
                at: Date.now(),
                traceId: action.traceId,
            };
            return {
                reply: replyAction(action, { workspace: toWorkspaceSummary(workspace), activeWorkspaceName: 'default', reset: true }),
                events: [event],
            };
        }
        case 'log.ext': {
            const payload = (action.payload ?? {}) as { entries?: Array<{ scope: string; level: string; ts: number; args: unknown[] }> };
            const entries = Array.isArray(payload.entries) ? payload.entries : [];
            const extLog = getLogger('ext');
            for (const entry of entries) {
                const level = (entry.level === 'error' || entry.level === 'warning') ? entry.level : 'info';
                extLog[level](`[ext:${entry.scope || '?'}]`, ...(Array.isArray(entry.args) ? entry.args : []));
            }
            return { reply: replyAction(action, { accepted: entries.length }), events: [] };
        }
        default:
            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    }
};
