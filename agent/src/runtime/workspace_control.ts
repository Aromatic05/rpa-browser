import crypto from 'node:crypto';
import { replyAction, type Action } from '../actions/action_protocol';
import { ActionError } from '../actions/failure';
import { ERROR_CODES } from '../actions/error_codes';
import type { RuntimeWorkspace } from './workspace_registry';
import { handleRecordControlAction } from '../record/control';
import { handleWorkflowControlAction } from '../workflow/control';
import { handleDslControlAction } from '../dsl/control';
import { handleRunnerControlAction } from '../runner/control';
import type { ControlPlaneResult } from './control';

export type WorkspaceControlInput = {
    action: Action;
    workspace: RuntimeWorkspace;
    workspaceRegistry: any;
    pageRegistry: any;
    recordingState: any;
    log: (...args: unknown[]) => void;
    replayOptions: any;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
    runStepsDeps?: any;
};

export const handleWorkspaceControlAction = async (input: WorkspaceControlInput): Promise<ControlPlaneResult> => {
    const { action, workspace } = input;

    if (action.type.startsWith('tab.')) {
        const payload = (action.payload ?? {}) as Record<string, unknown>;
        if (action.type === 'tab.list') {
            const active = workspace.tabRegistry.getActiveTab()?.name;
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    tabs: workspace.tabRegistry.listTabs().map((tab) => ({
                        tabName: tab.name,
                        url: tab.url,
                        title: tab.title,
                        active: active === tab.name,
                        createdAt: tab.createdAt,
                        updatedAt: tab.updatedAt,
                    })),
                }),
                events: [],
            };
        }
        if (action.type === 'tab.create') {
            const tabName = crypto.randomUUID();
            const startUrl = typeof payload.startUrl === 'string' ? payload.startUrl : undefined;
            const page = await input.pageRegistry.getPage(tabName, startUrl);
            workspace.tabRegistry.createTab({ tabName, page, url: page.url() });
            workspace.tabRegistry.setActiveTab(tabName);
            return { reply: replyAction(action, { workspaceName: workspace.name, tabName }), events: [] };
        }
        if (action.type === 'tab.close') {
            const tabName = typeof payload.tabName === 'string' ? payload.tabName : '';
            if (!tabName) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'tabName is required');}
            const tab = workspace.tabRegistry.closeTab(tabName);
            if (tab?.page && !tab.page.isClosed()) {
                await tab.page.close({ runBeforeUnload: true });
            }
            return { reply: replyAction(action, { workspaceName: workspace.name, tabName }), events: [] };
        }
        if (action.type === 'tab.setActive') {
            const tabName = typeof payload.tabName === 'string' ? payload.tabName : '';
            if (!tabName) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'tabName is required');}
            workspace.tabRegistry.setActiveTab(tabName);
            return { reply: replyAction(action, { workspaceName: workspace.name, tabName }), events: [] };
        }
        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    }

    if (action.type.startsWith('record.') || action.type.startsWith('play.')) {
        return await handleRecordControlAction(input);
    }

    if (action.type === 'workspace.save' || action.type === 'workspace.restore') {
        return await handleWorkflowControlAction(input);
    }

    if (action.type.startsWith('dsl.')) {
        return await handleDslControlAction(input);
    }

    if (action.type.startsWith('task.run.') || action.type.startsWith('checkpoint.')) {
        return await handleRunnerControlAction(input);
    }

    if (action.type === 'workflow.status') {
        const active = input.workspaceRegistry.getActiveWorkspace()?.name === workspace.name;
        return { reply: replyAction(action, { workspaceName: workspace.name, exists: true, active }), events: [] };
    }

    if (action.type === 'workspace.setActive') {
        input.workspaceRegistry.setActiveWorkspace(workspace.name);
        return { reply: replyAction(action, { workspaceName: workspace.name }), events: [] };
    }

    throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
};
