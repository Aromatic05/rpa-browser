import crypto from 'node:crypto';
import type { Page } from 'playwright';
import type { Action } from '../../actions/action_protocol';
import { ACTION_TYPES } from '../../actions/action_types';
import type { ExecutionBindings } from '../execution/bindings';
import type { WorkspaceRegistry } from '../workspace_registry';
import type { PageRegistry } from './page_registry';
import type { RecordingState } from '../../record/recording';
import type { Workflow } from '../../workflow';

export type RuntimeLifecycleDeps = {
    workspaceRegistry: WorkspaceRegistry;
    runtimeRegistry: ExecutionBindings;
    recordingState: RecordingState;
    navDedupeWindowMs: number;
    pingTimeoutMs: number;
    pingWatchdogIntervalMs: number;
    emit: (action: Action) => void;
    ensureWorkflow: (workspaceName: string) => Workflow;
    ensureRecorder: (state: RecordingState, page: Page, tabName: string, navDedupeWindowMs: number) => Promise<void>;
    setRecorderRuntimeEnabled: (page: Page, enabled: boolean) => Promise<void>;
    getWorkspaceActiveRecordingToken: (state: RecordingState, workspaceName: string) => string | null;
    attachTabToRecordingManifest: (
        state: RecordingState,
        recordingToken: string,
        tabName: string,
        input?: { tabRef?: string; url?: string },
    ) => void;
    cleanupRecording: (state: RecordingState, tabName: string) => void;
};

export type RuntimeLifecycle = {
    onPageBound: (page: Page, bindingName: string) => void;
    onBindingClosed: (bindingName: string) => void;
    startWatchdog: (pageRegistry: PageRegistry) => void;
    stopWatchdog: () => void;
    findWorkspaceNameByTabName: (tabName: string) => string | null;
};

export const createRuntimeLifecycle = (deps: RuntimeLifecycleDeps): RuntimeLifecycle => {
    const staleNotifiedTabs = new Set<string>();
    let watchdogTimer: NodeJS.Timeout | null = null;

    const findWorkspaceNameByTabName = (tabName: string): string | null => {
        for (const workspace of deps.workspaceRegistry.listWorkspaces()) {
            if (workspace.tabRegistry.hasTab(tabName)) {
                return workspace.name;
            }
        }
        return null;
    };

    const resolveWorkspaceForBinding = (bindingName: string) => {
        const workspaceName = findWorkspaceNameByTabName(bindingName)
            || deps.workspaceRegistry.getActiveWorkspace()?.name
            || 'default';
        return {
            workspaceName,
            workspace: deps.workspaceRegistry.createWorkspace(workspaceName, deps.ensureWorkflow(workspaceName)),
        };
    };

    const emitWorkspaceSync = (reason: string, payload: Record<string, unknown>) => {
        deps.emit({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.WORKSPACE_SYNC,
            payload: { reason, ...payload },
            at: Date.now(),
        });
    };

    const onPageBound = (page: Page, bindingName: string) => {
        const { workspaceName, workspace } = resolveWorkspaceForBinding(bindingName);
        if (!workspace.tabRegistry.hasTab(bindingName)) {
            workspace.tabRegistry.createTab({ tabName: bindingName, page, url: page.url() });
        } else {
            workspace.tabRegistry.bindPage(bindingName, page);
        }
        workspace.tabRegistry.setActiveTab(bindingName);
        deps.runtimeRegistry.bindPage({ workspaceName, tabName: bindingName, page });

        const activeRecordingToken = deps.getWorkspaceActiveRecordingToken(deps.recordingState, workspaceName);
        if (activeRecordingToken) {
            deps.attachTabToRecordingManifest(deps.recordingState, activeRecordingToken, bindingName, {
                tabRef: bindingName,
                url: page.url(),
            });
            void deps.ensureRecorder(deps.recordingState, page, bindingName, deps.navDedupeWindowMs);
            void deps.setRecorderRuntimeEnabled(page, true);
        }

        deps.emit({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.TAB_BOUND,
            payload: { workspaceName, tabName: bindingName, url: page.url() },
            workspaceName,
            at: Date.now(),
        });
    };

    const onBindingClosed = (bindingName: string) => {
        staleNotifiedTabs.delete(bindingName);
        deps.cleanupRecording(deps.recordingState, bindingName);
    };

    const startWatchdog = (pageRegistry: PageRegistry) => {
        if (watchdogTimer) {return;}
        watchdogTimer = setInterval(() => {
            const staleTabs = pageRegistry.listStaleBindings(deps.pingTimeoutMs, Date.now());
            for (const stale of staleTabs) {
                if (staleNotifiedTabs.has(stale.bindingName)) {continue;}
                staleNotifiedTabs.add(stale.bindingName);
                const workspaceName = findWorkspaceNameByTabName(stale.bindingName);
                emitWorkspaceSync('ping-timeout', {
                    workspaceName,
                    tabName: stale.bindingName,
                    lastSeenAt: stale.lastSeenAt,
                });
                void pageRegistry.closePage(stale.bindingName);
            }
        }, deps.pingWatchdogIntervalMs);
    };

    const stopWatchdog = () => {
        if (!watchdogTimer) {return;}
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    };

    return {
        onPageBound,
        onBindingClosed,
        startWatchdog,
        stopWatchdog,
        findWorkspaceNameByTabName,
    };
};
