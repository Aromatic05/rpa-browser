import crypto from 'node:crypto';
import { replyAction } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import {
    getRecordingBundle,
    getWorkspaceSnapshot,
    saveWorkspaceSnapshot,
    type RecordingState,
} from '../record/recording';
import { ensureWorkflowOnFs } from '../workflow';

export type WorkflowControlServices = {
    recordingState: RecordingState;
};

export type WorkflowControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
};

export const createWorkflowControl = (services: WorkflowControlServices): WorkflowControl => ({
    handle: async (input) => {
        const { action, workspace } = input;

        if (action.type === 'workspace.save') {
            const tabs = workspace.tabRegistry.listTabs();
            const bundle = getRecordingBundle(services.recordingState, '', { workspaceName: workspace.name });
            const snapshot = saveWorkspaceSnapshot(services.recordingState, {
                workspaceName: workspace.name,
                tabs: tabs.map((tab) => ({
                    tabName: tab.name,
                    url: tab.url,
                    title: tab.title,
                    active: workspace.tabRegistry.getActiveTab()?.name === tab.name,
                })),
                recordingToken: bundle.recordingToken,
                steps: bundle.steps,
                manifest: bundle.manifest,
                enrichments: bundle.enrichments,
            });
            return {
                reply: replyAction(action, {
                    saved: true,
                    workspaceName: workspace.name,
                    savedAt: snapshot.savedAt,
                    tabCount: snapshot.tabs.length,
                    stepCount: snapshot.recording.steps.length,
                }),
                events: [],
            };
        }

        if (action.type === 'workspace.restore') {
            const snapshot = getWorkspaceSnapshot(services.recordingState, workspace.name);
            if (!snapshot || snapshot.tabs.length === 0) {
                throw new ActionError(ERROR_CODES.ERR_WORKSPACE_SNAPSHOT_NOT_FOUND, 'no saved workspace snapshot to restore');
            }

            const targetWorkspaceName = crypto.randomUUID();
            const targetWorkspace = input.workspaceRegistry.createWorkspace(
                targetWorkspaceName,
                ensureWorkflowOnFs(targetWorkspaceName),
            );

            for (const tab of snapshot.tabs) {
                targetWorkspace.tabRegistry.createTab({
                    tabName: tab.tabName || crypto.randomUUID(),
                    url: tab.url || '',
                    title: tab.title || '',
                });
            }

            const activeTab = snapshot.tabs.find((item) => item.active) || snapshot.tabs[0];
            if (activeTab?.tabName && targetWorkspace.tabRegistry.hasTab(activeTab.tabName)) {
                targetWorkspace.tabRegistry.setActiveTab(activeTab.tabName);
            }

            return {
                reply: replyAction(action, {
                    restored: true,
                    sourceWorkspaceName: workspace.name,
                    workspaceName: targetWorkspaceName,
                    tabName: targetWorkspace.tabRegistry.getActiveTab()?.name ?? null,
                }),
                events: [],
            };
        }

        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    },
});
