/**
 * workspace action：提供 workspace/tab 的管理命令。
 */

import crypto from 'node:crypto';
import type { Action } from './action_protocol';
import { failedAction, replyAction } from './action_protocol';
import type { ActionContext, ActionHandler } from './execute';
import { ERROR_CODES } from './error_codes';
import { ACTION_TYPES } from './action_types';
import {
    ensureRecorder,
    getRecordingBundle,
    getWorkspaceSnapshot,
    recordStep,
    saveWorkspaceSnapshot,
} from '../record/recording';
import type { StepUnion } from '../runner/steps/types';
import { getLogger } from '../logging/logger';

type WorkspaceCreatePayload = { workspaceName?: string };
type WorkspaceSetActivePayload = { workspaceName: string };
type WorkspaceSavePayload = { workspaceName?: string };
type WorkspaceRestorePayload = { workspaceName: string };
type TabListPayload = { workspaceName?: string };
type TabCreatePayload = { workspaceName?: string; startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' };
type TabClosePayload = { workspaceName?: string; tabName: string };
type TabSetActivePayload = { workspaceName?: string; tabName: string };
type TabOpenedPayload = { source?: string; url?: string; title?: string; at?: number };
type TabReportPayload = { source?: string; url?: string; title?: string; at?: number };
type TabActivatedPayload = { source?: string; url?: string; at?: number };
type TabClosedPayload = { source?: string; at?: number };
type TabPingPayload = { source?: string; url?: string; title?: string; at?: number };
type TabReassignPayload = { workspaceName: string; tabName?: string; source?: string; windowId?: number; at?: number };

const actionLog = getLogger('action');

const logPageEvent = (event: string, payload: Record<string, unknown>) => {
    actionLog('[page]', event, payload);
};

const resolveSwitchTabIdArg = (step: StepUnion | undefined): string | null => {
    if (step?.name !== 'browser.switch_tab') {return null;}
    const args = step.args as Record<string, unknown>;
    return typeof args.tabId === 'string' ? args.tabId : null;
};

const resolveWorkspaceId = (
    ctx: ActionContext,
    action: Action,
    argWorkspaceId?: string,
) : string | null => {
    if (argWorkspaceId) {return argWorkspaceId;}
    if (action.workspaceName) {return action.workspaceName;}
    const active = ctx.pageRegistry.getActiveWorkspace();
    return active?.workspaceId ?? null;
};

const bringWorkspaceTabToFront = async (
    ctx: ActionContext,
    scope: { workspaceId: string; tabId?: string },
) => {
    try {
        const page = await ctx.pageRegistry.resolvePage(scope);
        await page.bringToFront();
    } catch {
        // ignore tab focus failures
    }
};

const ensureRecorderForTabIfRecording = async (
    ctx: ActionContext,
    params: {
        workspaceId: string;
        tabId: string;
        tabToken: string | null;
    },
) => {
    if (!params.tabToken) {return;}
    const recordingTokens = Array.from(ctx.recordingState.recordingEnabled);
    if (recordingTokens.length === 0) {return;}
    const shouldInstall =
        ctx.recordingState.recordingEnabled.has(params.tabToken) || recordingTokens.length === 1;
    if (!shouldInstall) {return;}
    try {
        const page = await ctx.pageRegistry.resolvePage({ workspaceId: params.workspaceId, tabId: params.tabId });
        await ensureRecorder(ctx.recordingState, page, params.tabToken, ctx.navDedupeWindowMs);
    } catch {
        // ignore recorder install failures for background lifecycle events
    }
};

export const workspaceHandlers: Record<string, ActionHandler> = {
    [ACTION_TYPES.TAB_INIT]: async (ctx, action) => {
        const tabToken = crypto.randomUUID();
        const payload = (action.payload ?? {}) as { source?: string; url?: string; at?: number; workspaceName?: string };
        const workspaceId =
            payload.workspaceName ||
            action.workspaceName ||
            ctx.pageRegistry?.getActiveWorkspace?.()?.workspaceId;
        if (typeof ctx.pageRegistry?.createPendingTokenClaim === 'function') {
            ctx.pageRegistry.createPendingTokenClaim({
                tabToken,
                workspaceId: workspaceId || undefined,
                source: payload.source || 'unknown',
                url: payload.url,
                createdAt: payload.at,
            });
        }
        return replyAction(action, { tabName: tabToken, workspaceName: workspaceId || null });
    },
    'workspace.list': async (ctx, action) => {
        const list = ctx.pageRegistry.listWorkspaces();
        const active = ctx.pageRegistry.getActiveWorkspace();
        return replyAction(action, { workspaces: list, activeWorkspaceName: active?.workspaceId ?? null });
    },
    'workspace.create': async (ctx, action) => {
        const payload = (action.payload ?? {}) as WorkspaceCreatePayload;
        if (payload.workspaceName) {
            const created = ctx.pageRegistry.createWorkspaceShell(payload.workspaceName);
            return replyAction(action, { workspaceName: created.workspaceId, tabName: null });
        }
        const created = await ctx.pageRegistry.createWorkspace();
        return replyAction(action, { workspaceName: created.workspaceId, tabName: created.tabId });
    },
    'workspace.setActive': async (ctx, action) => {
        const payload = (action.payload ?? {}) as WorkspaceSetActivePayload;
        ctx.pageRegistry.setActiveWorkspace(payload.workspaceName);
        await bringWorkspaceTabToFront(ctx, { workspaceId: payload.workspaceName });
        return replyAction(action, { workspaceName: payload.workspaceName });
    },
    'workspace.save': async (ctx, action) => {
        const payload = (action.payload ?? {}) as WorkspaceSavePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceName);
        if (!workspaceId) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        ctx.log('workspace.save.start', { workspaceId, tabToken: ctx.tabToken });
        const tabs = await ctx.pageRegistry.listTabs(workspaceId);
        const bundle = getRecordingBundle(ctx.recordingState, ctx.tabToken, { workspaceId });
        const recordingToken = bundle.recordingToken;
        const snapshot = saveWorkspaceSnapshot(ctx.recordingState, {
            workspaceId,
            tabs: tabs.map((tab) => ({
                tabId: tab.tabId,
                url: tab.url,
                title: tab.title,
                active: tab.active,
            })),
            recordingToken,
            steps: bundle.steps,
            manifest: bundle.manifest,
            enrichments: bundle.enrichments,
        });
        ctx.log('workspace.save.end', {
            workspaceName: workspaceId,
            recordingToken,
            tabCount: snapshot.tabs.length,
            stepCount: snapshot.recording.steps.length,
            savedAt: snapshot.savedAt,
        });
        logPageEvent('workspace.save', {
            workspaceName: workspaceId,
            recordingToken,
            tabCount: snapshot.tabs.length,
            stepCount: snapshot.recording.steps.length,
            savedAt: snapshot.savedAt,
        });
        return replyAction(action, {
            saved: true,
            workspaceName: workspaceId,
            recordingToken,
            savedAt: snapshot.savedAt,
            tabCount: snapshot.tabs.length,
            stepCount: snapshot.recording.steps.length,
        });
    },
    'workspace.restore': async (ctx, action) => {
        const payload = (action.payload ?? {}) as WorkspaceRestorePayload;
        const sourceWorkspaceName = payload.workspaceName || action.workspaceName;
        if (!sourceWorkspaceName) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceName is required');
        }
        ctx.log('workspace.restore.start', { sourceWorkspaceName, tabName: ctx.tabToken || null });

        const snapshot = getWorkspaceSnapshot(ctx.recordingState, sourceWorkspaceName);
        if (!snapshot || snapshot.tabs.length === 0) {
            return failedAction(action, ERROR_CODES.ERR_WORKSPACE_SNAPSHOT_NOT_FOUND, 'no saved workspace snapshot to restore');
        }

        const sourceTabs = snapshot.tabs;
        const created = await ctx.pageRegistry.createWorkspace();
        const targetWorkspaceId = created.workspaceId;
        const restoredTabs: Array<{ tabId: string; url: string; title: string; active: boolean; tabToken: string }> = [];

        const first = sourceTabs[0];
        const firstPage = await ctx.pageRegistry.resolvePage({
            workspaceId: targetWorkspaceId,
            tabId: created.tabId,
        });
        if (first.url) {
            await firstPage.goto(first.url, { waitUntil: 'domcontentloaded' });
        }
        restoredTabs.push({
            tabId: created.tabId,
            url: first.url || '',
            title: first.title || '',
            active: first.active,
            tabToken: ctx.pageRegistry.resolveTabToken({ workspaceId: targetWorkspaceId, tabId: created.tabId }),
        });

        for (let i = 1; i < sourceTabs.length; i += 1) {
            const tab = sourceTabs[i];
            const tabId = await ctx.pageRegistry.createTab(targetWorkspaceId);
            const page = await ctx.pageRegistry.resolvePage({ workspaceId: targetWorkspaceId, tabId });
            if (tab.url) {
                await page.goto(tab.url, { waitUntil: 'domcontentloaded' });
            }
            restoredTabs.push({
                tabId,
                url: tab.url || '',
                title: tab.title || '',
                active: tab.active,
                tabToken: ctx.pageRegistry.resolveTabToken({ workspaceId: targetWorkspaceId, tabId }),
            });
        }
        const activeTab = restoredTabs.find((tab) => tab.active) || restoredTabs[0];
        ctx.pageRegistry.setActiveWorkspace(targetWorkspaceId);
        ctx.pageRegistry.setActiveTab(targetWorkspaceId, activeTab.tabId);
        await bringWorkspaceTabToFront(ctx, { workspaceId: targetWorkspaceId, tabId: activeTab.tabId });

        let recordingToken: string | null = null;
        const sourceSteps = snapshot.recording.steps;
        if (sourceSteps.length > 0) {
            recordingToken = crypto.randomUUID();
            ctx.recordingState.recordings.set(recordingToken, [...sourceSteps]);
            ctx.recordingState.recordingEnhancements.set(recordingToken, {
                ...(snapshot.recording.enrichments ?? {}),
            });
        }

        if (recordingToken) {
            ctx.recordingState.workspaceLatestRecording.set(targetWorkspaceId, recordingToken);
            const entry = activeTab;
            ctx.recordingState.recordingManifests.set(recordingToken, {
                recordingToken,
                workspaceId: targetWorkspaceId,
                entryTabRef: entry.tabId,
                entryUrl: entry.url || snapshot.recording.manifest?.entryUrl,
                startedAt: snapshot.recording.manifest?.startedAt || Date.now(),
                tabs: restoredTabs.map((tab) => ({
                    tabToken: tab.tabToken,
                    tabRef: tab.tabId,
                    tabId: tab.tabId,
                    firstSeenUrl: tab.url,
                    lastSeenUrl: tab.url,
                    firstSeenAt: Date.now(),
                    lastSeenAt: Date.now(),
                })),
            });
        }

        const savedSnapshot = saveWorkspaceSnapshot(ctx.recordingState, {
            workspaceId: targetWorkspaceId,
            tabs: restoredTabs.map((tab) => ({
                tabId: tab.tabId,
                url: tab.url,
                title: tab.title,
                active: tab.active,
            })),
            recordingToken,
            steps: sourceSteps,
            manifest: recordingToken ? ctx.recordingState.recordingManifests.get(recordingToken) : undefined,
            enrichments: snapshot.recording.enrichments ?? undefined,
        });

        ctx.log('workspace.restore.end', {
            sourceWorkspaceName,
            workspaceName: targetWorkspaceId,
            recordingToken,
            tabCount: savedSnapshot.tabs.length,
            stepCount: savedSnapshot.recording.steps.length,
            restoredAt: Date.now(),
        });
        logPageEvent('workspace.restore', {
            sourceWorkspaceName,
            workspaceName: targetWorkspaceId,
            recordingToken: recordingToken || null,
            tabCount: savedSnapshot.tabs.length,
            stepCount: savedSnapshot.recording.steps.length,
            restoredAt: Date.now(),
        });

        return replyAction(action, {
            restored: true,
            sourceWorkspaceName,
            workspaceName: targetWorkspaceId,
            tabName: activeTab.tabId,
            recordingToken,
            tabCount: savedSnapshot.tabs.length,
            stepCount: savedSnapshot.recording.steps.length,
        });
    },
    'tab.list': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabListPayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceName);
        if (!workspaceId) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const tabs = await ctx.pageRegistry.listTabs(workspaceId);
        return replyAction(action, { workspaceName: workspaceId, tabs: tabs.map((tab) => ({ ...tab, tabName: tab.tabId })) });
    },
    'tab.create': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabCreatePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceName);
        if (!workspaceId) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const tabId = await ctx.pageRegistry.createTab(workspaceId);
        if (payload.startUrl) {
            const page = await ctx.pageRegistry.resolvePage({ workspaceId, tabId });
            await page.goto(payload.startUrl, { waitUntil: payload.waitUntil ?? 'domcontentloaded' });
            await page.bringToFront();
        }
        logPageEvent('tab.create', { workspaceId, tabId, startUrl: payload.startUrl });
        return replyAction(action, { workspaceName: workspaceId, tabName: tabId });
    },
    'tab.close': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabClosePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceName);
        if (!workspaceId) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        await ctx.pageRegistry.closeTab(workspaceId, payload.tabName);
        logPageEvent('tab.close', { workspaceName: workspaceId, tabName: payload.tabName });
        return replyAction(action, { workspaceName: workspaceId, tabName: payload.tabName });
    },
    'tab.setActive': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabSetActivePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceName);
        if (!workspaceId) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const sourceScope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        const targetTabToken = ctx.pageRegistry.resolveTabToken({ workspaceId, tabId: payload.tabName });
        const targetPage = await ctx.pageRegistry.resolvePage({ workspaceId, tabId: payload.tabName });
        const targetTabUrl = targetPage.url();
        ctx.pageRegistry.setActiveTab(workspaceId, payload.tabName);
        await bringWorkspaceTabToFront(ctx, { workspaceId, tabId: payload.tabName });
        const isCrossTab = sourceScope.workspaceId === workspaceId && sourceScope.tabId !== payload.tabName;
        const recordingTokens = Array.from(ctx.recordingState.recordingEnabled);
        if (isCrossTab && recordingTokens.length > 0) {
            const sourceRecording = ctx.recordingState.recordingEnabled.has(ctx.tabToken);
            const targetRecording = targetTabToken !== '' && ctx.recordingState.recordingEnabled.has(targetTabToken);
            const effectiveRecordingToken =
                (sourceRecording && ctx.tabToken) ||
                (targetRecording && targetTabToken) ||
                (recordingTokens.length === 1 ? recordingTokens[0] : null);
            if (effectiveRecordingToken) {
                const list = ctx.recordingState.recordings.get(effectiveRecordingToken) || [];
                const last = list[list.length - 1] as StepUnion | undefined;
                const duplicateSwitch =
                    last?.name === 'browser.switch_tab' && resolveSwitchTabIdArg(last) === payload.tabName;
                if (!duplicateSwitch) {
                    recordStep(
                        ctx.recordingState,
                        ctx.tabToken,
                        {
                            id: crypto.randomUUID(),
                            name: 'browser.switch_tab',
                            args: { tabId: payload.tabName, tabUrl: targetTabUrl, tabRef: payload.tabName },
                            meta: {
                                source: 'record',
                                ts: Date.now(),
                                workspaceId,
                                tabId: payload.tabName,
                                tabRef: payload.tabName,
                                tabToken: targetTabToken || undefined,
                                urlAtRecord: targetTabUrl,
                            },
                        } satisfies StepUnion,
                        ctx.navDedupeWindowMs,
                    );
                }
            }
        }
        await ensureRecorderForTabIfRecording(ctx, { workspaceId, tabId: payload.tabName, tabToken: targetTabToken });
        logPageEvent('tab.setActive', { workspaceName: workspaceId, tabName: payload.tabName });
        return replyAction(action, { workspaceName: workspaceId, tabName: payload.tabName });
    },
    'tab.opened': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabOpenedPayload;
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        ctx.pageRegistry.setActiveWorkspace(scope.workspaceId);
        ctx.pageRegistry.setActiveTab(scope.workspaceId, scope.tabId);
        ctx.log('tab.opened', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        });
        logPageEvent('tab.opened', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        });
        return replyAction(action, {
            workspaceName: scope.workspaceId,
            tabName: scope.tabId,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        });
    },
    'tab.report': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabReportPayload;
        const touched = ctx.pageRegistry.touchTabToken(ctx.tabToken, payload.at);
        if (!touched) {
            logPageEvent('tab.report', {
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedUrl: payload.url,
                reportedTitle: payload.title,
                reportedAt: payload.at,
                stale: true,
            });
            return replyAction(action, {
                source: payload.source || 'unknown',
                reportedUrl: payload.url,
                reportedTitle: payload.title,
                reportedAt: payload.at,
                stale: true,
            });
        }
        const output = {
            workspaceName: touched.workspaceId,
            tabName: touched.tabId,
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        };
        ctx.log('tab.report', output);
        logPageEvent('tab.report', output);
        return replyAction(action, output);
    },
    'tab.activated': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabActivatedPayload;
        const isReplayRunning = ctx.recordingState.replaying.size > 0;
        const isExtensionLifecycle = typeof payload.source === 'string' && payload.source.startsWith('extension.');
        if (isReplayRunning && isExtensionLifecycle) {
            logPageEvent('tab.activated.ignored', {
                tabToken: ctx.tabToken,
                source: payload.source,
                reportedUrl: payload.url,
                reportedAt: payload.at,
                reason: 'replay_in_progress',
            });
            return replyAction(action, {
                source: payload.source,
                reportedUrl: payload.url,
                reportedAt: payload.at,
                ignored: true,
                reason: 'replay_in_progress',
            });
        }
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        ctx.pageRegistry.setActiveWorkspace(scope.workspaceId);
        ctx.pageRegistry.setActiveTab(scope.workspaceId, scope.tabId);
        // If exactly one recording session is active, treat cross-tab activation
        // as an implicit switch step in that session.
        const recordingTokens = Array.from(ctx.recordingState.recordingEnabled);
        if (recordingTokens.length === 1) {
            const recordingToken = recordingTokens[0];
            try {
                const recordingScope = ctx.pageRegistry.resolveScopeFromToken(recordingToken);
                const isCrossTab =
                    recordingScope.workspaceId === scope.workspaceId && recordingScope.tabId !== scope.tabId;
                if (isCrossTab) {
                    await ensureRecorderForTabIfRecording(ctx, {
                        workspaceId: scope.workspaceId,
                        tabId: scope.tabId,
                        tabToken: ctx.tabToken,
                    });
                    const list = ctx.recordingState.recordings.get(recordingToken) || [];
                    const last = list[list.length - 1] as StepUnion | undefined;
                    const duplicateSwitch =
                        last?.name === 'browser.switch_tab' && resolveSwitchTabIdArg(last) === scope.tabId;
                    if (!duplicateSwitch) {
                        recordStep(
                            ctx.recordingState,
                            ctx.tabToken,
                            {
                                id: crypto.randomUUID(),
                                name: 'browser.switch_tab',
                                args: { tabId: scope.tabId, tabUrl: payload.url, tabRef: scope.tabId },
                                meta: {
                                    source: 'record',
                                    ts: payload.at || Date.now(),
                                    workspaceId: scope.workspaceId,
                                    tabId: scope.tabId,
                                    tabRef: scope.tabId,
                                    tabToken: ctx.tabToken,
                                    urlAtRecord: payload.url,
                                },
                            } satisfies StepUnion,
                            ctx.navDedupeWindowMs,
                        );
                    }
                }
            } catch {
                // ignore unresolved recording scope
            }
        }
        ctx.log('tab.activated', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedAt: payload.at,
        });
        logPageEvent('tab.activated', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedAt: payload.at,
        });
        return replyAction(action, {
            workspaceName: scope.workspaceId,
            tabName: scope.tabId,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedAt: payload.at,
        });
    },
    'tab.closed': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabClosedPayload;
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        ctx.log('tab.closed', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            source: payload.source || 'unknown',
            reportedAt: payload.at,
        });
        logPageEvent('tab.closed', {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            source: payload.source || 'unknown',
            reportedAt: payload.at,
        });
        return replyAction(action, {
            workspaceName: scope.workspaceId,
            tabName: scope.tabId,
            source: payload.source || 'unknown',
            reportedAt: payload.at,
        });
    },
    'tab.ping': async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabPingPayload;
        const touched = ctx.pageRegistry.touchTabToken(ctx.tabToken, payload.at);
        if (!touched) {
            logPageEvent('tab.ping', {
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
            return replyAction(action, {
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
        }
        const output = {
            workspaceName: touched.workspaceId,
            tabName: touched.tabId,
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        };
        ctx.log('tab.ping', output);
        logPageEvent('tab.ping', output);
        return replyAction(action, output);
    },
    [ACTION_TYPES.TAB_REASSIGN]: async (ctx, action) => {
        const payload = (action.payload ?? {}) as TabReassignPayload;
        if (!payload.workspaceName) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceName is required');
        }
        const moved = ctx.pageRegistry.moveTokenToWorkspace(ctx.tabToken, payload.workspaceName);
        if (!moved) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'failed to reassign tab workspace');
        }
        ctx.pageRegistry.setActiveWorkspace(moved.workspaceId);
        ctx.pageRegistry.setActiveTab(moved.workspaceId, moved.tabId);
        const output = {
            workspaceName: moved.workspaceId,
            tabName: moved.tabId,
            source: payload.source || 'unknown',
            windowId: payload.windowId,
            reportedAt: payload.at,
        };
        ctx.log('tab.reassign', output);
        logPageEvent('tab.reassign', output);
        return replyAction(action, output);
    },
};
