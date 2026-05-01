import crypto from 'node:crypto';
import type { Action } from './action_protocol';
import { failedAction, replyAction } from './action_protocol';
import type { ActionHandler } from './execute';
import { ERROR_CODES } from './error_codes';
import { ACTION_TYPES } from './action_types';
import { getRecordingBundle, getWorkspaceSnapshot, saveWorkspaceSnapshot } from '../record/recording';

type WorkspaceCreatePayload = { workspaceName?: string };
type WorkspaceSetActivePayload = { workspaceName: string };
type WorkspaceSavePayload = { workspaceName?: string };
type WorkspaceRestorePayload = { workspaceName: string };
type TabListPayload = { workspaceName?: string };
type TabCreatePayload = { workspaceName?: string; startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' };
type TabClosePayload = { workspaceName?: string; tabName: string };
type TabSetActivePayload = { workspaceName?: string; tabName: string };
type TabOpenedPayload = { tabName?: string; workspaceName?: string; source?: string; url?: string; title?: string; at?: number };
type TabReportPayload = { tabName?: string; workspaceName?: string; source?: string; url?: string; title?: string; at?: number };
type TabClosedPayload = { tabName?: string; workspaceName?: string; source?: string; at?: number };
type TabPingPayload = { tabName?: string; workspaceName?: string; source?: string; url?: string; title?: string; at?: number };
type TabReassignPayload = { workspaceName: string; tabName?: string; source?: string; windowId?: number; at?: number };

const resolveWorkspaceName = (action: Action, payloadWorkspaceName?: string): string | null =>
    payloadWorkspaceName || action.workspaceName || null;

const randomName = () => crypto.randomUUID();

export const workspaceHandlers: Record<string, ActionHandler> = {
    [ACTION_TYPES.TAB_INIT]: async (_ctx, action) => {
        const payload = (action.payload ?? {}) as { workspaceName?: string };
        return replyAction(action, { workspaceName: payload.workspaceName || action.workspaceName || null, tabName: randomName() });
    },
    'workspace.list': async (ctx, action) => {
        const active = ctx.workspaceRegistry.getActiveWorkspace();
        return replyAction(action, {
            workspaces: ctx.workspaceRegistry.listWorkspaces().map((workspace) => ({
                workspaceName: workspace.name,
                activeTabName: workspace.tabRegistry.getActiveTab()?.name ?? null,
                tabCount: workspace.tabRegistry.listTabs().length,
                createdAt: workspace.createdAt,
                updatedAt: workspace.updatedAt,
            })),
            activeWorkspaceName: active?.name ?? null,
        });
    },
    'workspace.create': async (ctx, action) => {
        const payload = (action.payload ?? {}) as WorkspaceCreatePayload;
        const workspaceName = payload.workspaceName || randomName();
        const workspace = ctx.workspaceRegistry.createWorkspace(workspaceName);
        return replyAction(action, { workspaceName: workspace.name, tabName: null });
    },
    'workspace.setActive': async (ctx, action) => {
        const payload = (action.payload ?? {}) as WorkspaceSetActivePayload;
        ctx.workspaceRegistry.setActiveWorkspace(payload.workspaceName);
        return replyAction(action, { workspaceName: payload.workspaceName });
    },
    'workspace.save': async (ctx, action) => {
        const payload = (action.payload ?? {}) as WorkspaceSavePayload;
        const workspaceName = resolveWorkspaceName(action, payload.workspaceName);
        if (!workspaceName) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        const tabs = workspace.tabRegistry.listTabs();
        const bundle = getRecordingBundle(ctx.recordingState, '', { workspaceName: workspaceName });
        const snapshot = saveWorkspaceSnapshot(ctx.recordingState, {
            workspaceName: workspaceName,
            tabs: tabs.map((tab) => ({ tabName: tab.name, url: tab.url, title: tab.title, active: workspace.tabRegistry.getActiveTab()?.name === tab.name })),
            recordingToken: bundle.recordingToken,
            steps: bundle.steps,
            manifest: bundle.manifest,
            enrichments: bundle.enrichments,
        });
        return replyAction(action, { saved: true, workspaceName, savedAt: snapshot.savedAt, tabCount: snapshot.tabs.length, stepCount: snapshot.recording.steps.length });
    },
    'workspace.restore': async (ctx, action) => {
        const payload = (action.payload ?? {}) as WorkspaceRestorePayload;
        const sourceWorkspaceName = payload.workspaceName || action.workspaceName;
        if (!sourceWorkspaceName) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceName is required');}
        const snapshot = getWorkspaceSnapshot(ctx.recordingState, sourceWorkspaceName);
        if (!snapshot || snapshot.tabs.length === 0) {
            return failedAction(action, ERROR_CODES.ERR_WORKSPACE_SNAPSHOT_NOT_FOUND, 'no saved workspace snapshot to restore');
        }
        const targetWorkspaceName = randomName();
        const workspace = ctx.workspaceRegistry.createWorkspace(targetWorkspaceName);
        for (const tab of snapshot.tabs) {
            workspace.tabRegistry.createTab({ tabName: tab.tabName || randomName(), url: tab.url || '', title: tab.title || '' });
        }
        const activeTab = snapshot.tabs.find((item) => item.active) || snapshot.tabs[0];
        if (activeTab?.tabName && workspace.tabRegistry.hasTab(activeTab.tabName)) {
            workspace.tabRegistry.setActiveTab(activeTab.tabName);
        }
        return replyAction(action, { restored: true, sourceWorkspaceName, workspaceName: targetWorkspaceName, tabName: workspace.tabRegistry.getActiveTab()?.name ?? null });
    },
    'tab.list': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabListPayload;
        const workspaceName = resolveWorkspaceName(action, payload.workspaceName);
        if (!workspaceName) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        const active = workspace.tabRegistry.getActiveTab()?.name;
        return replyAction(action, {
            workspaceName,
            tabs: workspace.tabRegistry.listTabs().map((tab) => ({ tabName: tab.name, url: tab.url, title: tab.title, active: active === tab.name, createdAt: tab.createdAt, updatedAt: tab.updatedAt })),
        });
    },
    'tab.create': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabCreatePayload;
        const workspaceName = resolveWorkspaceName(action, payload.workspaceName);
        if (!workspaceName) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        const tabName = randomName();
        const page = await ctx.pageRegistry.getPage(tabName, payload.startUrl);
        workspace.tabRegistry.createTab({ tabName, page, url: page.url() });
        workspace.tabRegistry.setActiveTab(tabName);
        return replyAction(action, { workspaceName, tabName });
    },
    'tab.close': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabClosePayload;
        const workspaceName = resolveWorkspaceName(action, payload.workspaceName);
        if (!workspaceName) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        const tab = workspace.tabRegistry.closeTab(payload.tabName);
        if (tab?.page && !tab.page.isClosed()) {
            await tab.page.close({ runBeforeUnload: true });
        }
        return replyAction(action, { workspaceName, tabName: payload.tabName });
    },
    'tab.setActive': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabSetActivePayload;
        const workspaceName = resolveWorkspaceName(action, payload.workspaceName);
        if (!workspaceName) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');}
        workspace.tabRegistry.setActiveTab(payload.tabName);
        return replyAction(action, { workspaceName, tabName: payload.tabName });
    },
    'tab.opened': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabOpenedPayload;
        const workspaceName = resolveWorkspaceName(action, payload.workspaceName);
        if (!workspaceName || !payload.tabName) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceName/tabName is required');}
        const workspace = ctx.workspaceRegistry.createWorkspace(workspaceName);
        if (!workspace.tabRegistry.hasTab(payload.tabName)) {
            workspace.tabRegistry.createTab({ tabName: payload.tabName, url: payload.url || '', title: payload.title || '', at: payload.at });
        }
        workspace.tabRegistry.updateTab(payload.tabName, { url: payload.url, title: payload.title, updatedAt: payload.at });
        workspace.tabRegistry.setActiveTab(payload.tabName);
        return replyAction(action, { workspaceName, tabName: payload.tabName, source: payload.source || 'unknown' });
    },
    'tab.report': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabReportPayload;
        const workspaceName = resolveWorkspaceName(action, payload.workspaceName);
        if (!workspaceName || !payload.tabName) {
            return replyAction(action, { source: payload.source || 'unknown', reportedUrl: payload.url, reportedTitle: payload.title, reportedAt: payload.at, stale: true });
        }
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace || !workspace.tabRegistry.hasTab(payload.tabName)) {
            return replyAction(action, { source: payload.source || 'unknown', reportedUrl: payload.url, reportedTitle: payload.title, reportedAt: payload.at, stale: true });
        }
        workspace.tabRegistry.updateTab(payload.tabName, { url: payload.url, title: payload.title, updatedAt: payload.at });
        return replyAction(action, { workspaceName, tabName: payload.tabName, source: payload.source || 'unknown', reportedUrl: payload.url, reportedTitle: payload.title, reportedAt: payload.at });
    },
    'tab.closed': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabClosedPayload;
        const workspaceName = resolveWorkspaceName(action, payload.workspaceName);
        if (!workspaceName || !payload.tabName) {return replyAction(action, { source: payload.source || 'unknown', reportedAt: payload.at });}
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        workspace?.tabRegistry.closeTab(payload.tabName);
        return replyAction(action, { workspaceName, tabName: payload.tabName, source: payload.source || 'unknown', reportedAt: payload.at });
    },
    'tab.ping': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabPingPayload;
        const workspaceName = resolveWorkspaceName(action, payload.workspaceName);
        if (!workspaceName || !payload.tabName) {
            return replyAction(action, { source: payload.source || 'unknown', reportedAt: payload.at, stale: true });
        }
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace || !workspace.tabRegistry.hasTab(payload.tabName)) {
            return replyAction(action, { source: payload.source || 'unknown', reportedAt: payload.at, stale: true });
        }
        workspace.tabRegistry.updateTab(payload.tabName, { url: payload.url, title: payload.title, updatedAt: payload.at });
        return replyAction(action, { workspaceName, tabName: payload.tabName, source: payload.source || 'unknown', reportedUrl: payload.url, reportedTitle: payload.title, reportedAt: payload.at });
    },
    [ACTION_TYPES.TAB_REASSIGN]: async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabReassignPayload;
        if (!payload.workspaceName || !payload.tabName) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceName/tabName is required');
        }
        const workspace = ctx.workspaceRegistry.createWorkspace(payload.workspaceName);
        if (!workspace.tabRegistry.hasTab(payload.tabName)) {
            workspace.tabRegistry.createTab({ tabName: payload.tabName, at: payload.at });
        }
        workspace.tabRegistry.setActiveTab(payload.tabName);
        return replyAction(action, {
            workspaceName: payload.workspaceName,
            tabName: payload.tabName,
            source: payload.source || 'unknown',
            windowId: payload.windowId,
            reportedAt: payload.at,
        });
    },
};
