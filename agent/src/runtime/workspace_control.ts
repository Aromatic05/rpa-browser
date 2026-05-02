import crypto from 'node:crypto';
import type { Page } from 'playwright';
import { replyAction, type Action } from '../actions/action_protocol';
import { ActionError } from '../actions/failure';
import { ERROR_CODES } from '../actions/error_codes';
import type { RuntimeWorkspace, WorkspaceRegistry } from './workspace_registry';
import type { ControlPlaneResult } from './control';
import type { WorkflowControl } from '../workflow/control';
import type { RecordControl } from '../record/control';
import type { DslControl } from '../dsl/control';
import type { RunnerControl } from '../runner/control';

export type WorkspaceControlInput = {
    action: Action;
    workspace: RuntimeWorkspace;
    workspaceRegistry: WorkspaceRegistry;
};

export type WorkspaceControlServices = {
    pageRegistry: {
        getPage: (tabName: string, startUrl?: string) => Promise<Page>;
    };
    workflowControl: WorkflowControl;
    recordControl: RecordControl;
    dslControl: DslControl;
    runnerControl: RunnerControl;
};

export type WorkspaceControl = {
    handle: (action: Action, workspace: RuntimeWorkspace, workspaceRegistry: WorkspaceRegistry) => Promise<ControlPlaneResult>;
};

const requireTabName = (payload: Record<string, unknown>): string => {
    const tabName = typeof payload.tabName === 'string' ? payload.tabName.trim() : '';
    if (!tabName) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'tabName is required');
    }
    return tabName;
};

export const createWorkspaceControl = (services: WorkspaceControlServices): WorkspaceControl => ({
    handle: async (action, workspace, workspaceRegistry) => {
        if (action.type === 'workspace.setActive') {
            workspaceRegistry.setActiveWorkspace(workspace.name);
            return { reply: replyAction(action, { workspaceName: workspace.name }), events: [] };
        }

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
                const page = await services.pageRegistry.getPage(tabName, startUrl);
                workspace.tabRegistry.createTab({ tabName, page, url: page.url() });
                workspace.tabRegistry.setActiveTab(tabName);
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName }), events: [] };
            }

            if (action.type === 'tab.close') {
                const tabName = requireTabName(payload);
                const tab = workspace.tabRegistry.closeTab(tabName);
                if (tab?.page && !tab.page.isClosed()) {
                    await tab.page.close({ runBeforeUnload: true });
                }
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName }), events: [] };
            }

            if (action.type === 'tab.setActive') {
                const tabName = requireTabName(payload);
                workspace.tabRegistry.setActiveTab(tabName);
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName }), events: [] };
            }

            if (action.type === 'tab.opened') {
                const tabName = requireTabName(payload);
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const url = typeof payload.url === 'string' ? payload.url : '';
                const title = typeof payload.title === 'string' ? payload.title : '';
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                if (!workspace.tabRegistry.hasTab(tabName)) {
                    workspace.tabRegistry.createTab({ tabName, url, title, at });
                }
                workspace.tabRegistry.updateTab(tabName, { url, title, updatedAt: at });
                workspace.tabRegistry.setActiveTab(tabName);
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName, source }), events: [] };
            }

            if (action.type === 'tab.report') {
                const tabName = typeof payload.tabName === 'string' ? payload.tabName : '';
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const url = typeof payload.url === 'string' ? payload.url : undefined;
                const title = typeof payload.title === 'string' ? payload.title : undefined;
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                if (!tabName || !workspace.tabRegistry.hasTab(tabName)) {
                    return { reply: replyAction(action, { source, reportedUrl: url, reportedTitle: title, reportedAt: at, stale: true }), events: [] };
                }
                workspace.tabRegistry.updateTab(tabName, { url, title, updatedAt: at });
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName, source, reportedUrl: url, reportedTitle: title, reportedAt: at }), events: [] };
            }

            if (action.type === 'tab.closed') {
                const tabName = typeof payload.tabName === 'string' ? payload.tabName : '';
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                if (!tabName) {
                    return { reply: replyAction(action, { source, reportedAt: at }), events: [] };
                }
                workspace.tabRegistry.closeTab(tabName);
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName, source, reportedAt: at }), events: [] };
            }

            if (action.type === 'tab.ping') {
                const tabName = typeof payload.tabName === 'string' ? payload.tabName : '';
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const url = typeof payload.url === 'string' ? payload.url : undefined;
                const title = typeof payload.title === 'string' ? payload.title : undefined;
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                if (!tabName || !workspace.tabRegistry.hasTab(tabName)) {
                    return { reply: replyAction(action, { source, reportedAt: at, stale: true }), events: [] };
                }
                workspace.tabRegistry.updateTab(tabName, { url, title, updatedAt: at });
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName, source, reportedUrl: url, reportedTitle: title, reportedAt: at }), events: [] };
            }

            if (action.type === 'tab.reassign') {
                const tabName = requireTabName(payload);
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const windowId = typeof payload.windowId === 'number' ? payload.windowId : undefined;
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                if (!workspace.tabRegistry.hasTab(tabName)) {
                    workspace.tabRegistry.createTab({ tabName, at });
                }
                workspace.tabRegistry.setActiveTab(tabName);
                return {
                    reply: replyAction(action, {
                        workspaceName: workspace.name,
                        tabName,
                        source,
                        windowId,
                        reportedAt: at,
                    }),
                    events: [],
                };
            }

            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
        }

        if (action.type === 'workflow.status') {
            if (workspace.name !== workspace.workflow.name) {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'workspace/workflow identity mismatch');
            }
            const active = workspaceRegistry.getActiveWorkspace()?.name === workspace.name;
            return { reply: replyAction(action, { workspaceName: workspace.name, exists: true, active }), events: [] };
        }

        if (action.type === 'workspace.save' || action.type === 'workspace.restore') {
            return await services.workflowControl.handle({ action, workspace, workspaceRegistry });
        }

        if (action.type.startsWith('record.') || action.type.startsWith('play.')) {
            return await services.recordControl.handle({ action, workspace, workspaceRegistry });
        }

        if (action.type.startsWith('dsl.')) {
            return await services.dslControl.handle({ action, workspace, workspaceRegistry });
        }

        if (action.type.startsWith('task.run.') || action.type.startsWith('checkpoint.')) {
            return await services.runnerControl.handle({ action, workspace, workspaceRegistry });
        }

        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    },
});
