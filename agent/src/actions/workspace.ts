/**
 * workspace action：提供 workspace/tab 的管理命令。
 */

import crypto from 'node:crypto';
import type { Action, ActionScope } from './action_protocol';
import { makeErr, makeOk } from './action_protocol';
import type { ActionHandler } from './execute';
import { ERROR_CODES } from './error_codes';
import {
    ensureRecorder,
    getRecordingBundle,
    getWorkspaceSnapshot,
    recordStep,
    saveWorkspaceSnapshot,
} from '../record/recording';
import type { StepUnion } from '../runner/steps/types';

type WorkspaceCreatePayload = { startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' };
type WorkspaceSetActivePayload = { workspaceId: string };
type WorkspaceSavePayload = { workspaceId?: string };
type WorkspaceRestorePayload = { workspaceId: string };
type TabListPayload = { workspaceId?: string };
type TabCreatePayload = { workspaceId?: string; startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' };
type TabClosePayload = { workspaceId?: string; tabId: string };
type TabSetActivePayload = { workspaceId?: string; tabId: string };
type TabOpenedPayload = { source?: string; url?: string; title?: string; at?: number };
type TabActivatedPayload = { source?: string; url?: string; at?: number };
type TabClosedPayload = { source?: string; at?: number };
type TabPingPayload = { source?: string; url?: string; title?: string; at?: number };

const logPageEvent = (event: string, payload: Record<string, unknown>) => {
    // Lifecycle logs must always be visible in terminal for debugging/state tracking.
    console.log('[page]', event, payload);
};

const resolveWorkspaceId = (
    ctx: { pageRegistry: any },
    action: { scope?: ActionScope },
    argWorkspaceId?: string,
) => {
    if (argWorkspaceId) return argWorkspaceId;
    if (action.scope?.workspaceId) return action.scope.workspaceId;
    const active = ctx.pageRegistry.getActiveWorkspace?.();
    return active?.id || null;
};

const bringWorkspaceTabToFront = async (
    ctx: { pageRegistry: any },
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
    ctx: {
        pageRegistry: any;
        recordingState?: any;
        navDedupeWindowMs: number;
    },
    params: {
        workspaceId: string;
        tabId: string;
        tabToken: string | null;
    },
) => {
    if (!ctx.recordingState || !params.tabToken) return;
    const recordingTokens = Array.from(ctx.recordingState.recordingEnabled || []);
    if (recordingTokens.length === 0) return;
    const shouldInstall =
        ctx.recordingState.recordingEnabled.has(params.tabToken) || recordingTokens.length === 1;
    if (!shouldInstall) return;
    try {
        const page = await ctx.pageRegistry.resolvePage({ workspaceId: params.workspaceId, tabId: params.tabId });
        await ensureRecorder(ctx.recordingState, page, params.tabToken, ctx.navDedupeWindowMs);
    } catch {
        // ignore recorder install failures for background lifecycle events
    }
};

export const workspaceHandlers: Record<string, ActionHandler> = {
    'workspace.list': async (ctx, _action) => {
        const list = ctx.pageRegistry.listWorkspaces();
        const active = ctx.pageRegistry.getActiveWorkspace?.();
        return makeOk({ workspaces: list, activeWorkspaceId: active?.id || null });
    },
    'workspace.create': async (ctx, action) => {
        const payload = (action.payload || {}) as WorkspaceCreatePayload;
        const created = await ctx.pageRegistry.createWorkspace();
        const createdTabToken = ctx.pageRegistry.resolveTabToken({
            workspaceId: created.workspaceId,
            tabId: created.tabId,
        });
        const startUrl = payload.startUrl;
        if (startUrl) {
            try {
                const page = await ctx.pageRegistry.resolvePage({
                    workspaceId: created.workspaceId,
                    tabId: created.tabId,
                });
                await page.goto(startUrl, {
                    waitUntil: payload.waitUntil || 'domcontentloaded',
                });
                await page.bringToFront();
            } catch (error) {
                return makeErr(
                    ERROR_CODES.ERR_ASSERTION_FAILED,
                    'workspace.create startUrl navigation failed',
                    {
                        workspaceId: created.workspaceId,
                        tabId: created.tabId,
                        startUrl,
                        message: error instanceof Error ? error.message : String(error),
                    },
                );
            }
        }
        return makeOk({ workspaceId: created.workspaceId, tabId: created.tabId, tabToken: createdTabToken });
    },
    'workspace.setActive': async (ctx, action) => {
        const payload = (action.payload || {}) as WorkspaceSetActivePayload;
        ctx.pageRegistry.setActiveWorkspace(payload.workspaceId);
        await bringWorkspaceTabToFront(ctx, { workspaceId: payload.workspaceId });
        return makeOk({ workspaceId: payload.workspaceId });
    },
    'workspace.save': async (ctx, action) => {
        const payload = (action.payload || {}) as WorkspaceSavePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        ctx.log('workspace.save.start', { workspaceId, tabToken: ctx.tabToken });
        const tabs = await ctx.pageRegistry.listTabs(workspaceId);
        const bundle = getRecordingBundle(ctx.recordingState, ctx.tabToken, { workspaceId });
        const recordingToken = bundle.recordingToken || null;
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
        });
        ctx.log('workspace.save.end', {
            workspaceId,
            recordingToken,
            tabCount: snapshot.tabs.length,
            stepCount: snapshot.recording.steps.length,
            savedAt: snapshot.savedAt,
        });
        logPageEvent('workspace.save', {
            workspaceId,
            recordingToken,
            tabCount: snapshot.tabs.length,
            stepCount: snapshot.recording.steps.length,
            savedAt: snapshot.savedAt,
        });
        return makeOk({
            saved: true,
            workspaceId,
            recordingToken,
            savedAt: snapshot.savedAt,
            tabCount: snapshot.tabs.length,
            stepCount: snapshot.recording.steps.length,
        });
    },
    'workspace.restore': async (ctx, action) => {
        const payload = (action.payload || {}) as WorkspaceRestorePayload;
        const sourceWorkspaceId = payload.workspaceId || action.scope?.workspaceId;
        if (!sourceWorkspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspaceId is required');
        }
        ctx.log('workspace.restore.start', { sourceWorkspaceId, tabToken: ctx.tabToken });

        const snapshot = getWorkspaceSnapshot(ctx.recordingState, sourceWorkspaceId);
        const fallbackRecordingToken = ctx.recordingState.workspaceLatestRecording.get(sourceWorkspaceId) || null;
        const fallbackManifest = fallbackRecordingToken
            ? ctx.recordingState.recordingManifests.get(fallbackRecordingToken)
            : undefined;
        const fallbackSteps = fallbackRecordingToken
            ? ctx.recordingState.recordings.get(fallbackRecordingToken) || []
            : [];

        const sourceTabs =
            snapshot?.tabs?.length
                ? snapshot.tabs
                : (fallbackManifest?.tabs || []).map((tab) => ({
                      tabId: tab.tabId || tab.tabRef,
                      url: tab.lastSeenUrl || tab.firstSeenUrl || '',
                      title: '',
                      active: tab.tabRef === fallbackManifest?.entryTabRef,
                  }));

        if (!sourceTabs.length && !fallbackManifest?.entryUrl) {
            return makeErr(ERROR_CODES.ERR_WORKSPACE_SNAPSHOT_NOT_FOUND, 'no saved workspace snapshot to restore');
        }

        try {
            const created = await ctx.pageRegistry.createWorkspace();
            const targetWorkspaceId = created.workspaceId;
            const restoredTabs: Array<{ tabId: string; url: string; title: string; active: boolean; tabToken: string }> = [];

            const first = sourceTabs[0] || {
                tabId: created.tabId,
                url: fallbackManifest?.entryUrl || '',
                title: '',
                active: true,
            };
            try {
                const firstPage = await ctx.pageRegistry.resolvePage({
                    workspaceId: targetWorkspaceId,
                    tabId: created.tabId,
                });
                if (first.url) {
                    await firstPage.goto(first.url, { waitUntil: 'domcontentloaded' });
                }
            } catch {
                // keep default page when restore navigation fails
            }
            restoredTabs.push({
                tabId: created.tabId,
                url: first.url || '',
                title: first.title || '',
                active: first.active !== false,
                tabToken: ctx.pageRegistry.resolveTabToken({ workspaceId: targetWorkspaceId, tabId: created.tabId }),
            });

            for (let i = 1; i < sourceTabs.length; i += 1) {
                const tab = sourceTabs[i];
                const tabId = await ctx.pageRegistry.createTab(targetWorkspaceId);
                try {
                    const page = await ctx.pageRegistry.resolvePage({ workspaceId: targetWorkspaceId, tabId });
                    if (tab.url) {
                        await page.goto(tab.url, { waitUntil: 'domcontentloaded' });
                    }
                } catch {
                    // ignore per-tab navigation failures
                }
                restoredTabs.push({
                    tabId,
                    url: tab.url || '',
                    title: tab.title || '',
                    active: !!tab.active,
                    tabToken: ctx.pageRegistry.resolveTabToken({ workspaceId: targetWorkspaceId, tabId }),
                });
            }

            const activeTab = restoredTabs.find((tab) => tab.active) || restoredTabs[0];
            ctx.pageRegistry.setActiveWorkspace(targetWorkspaceId);
            if (activeTab) {
                ctx.pageRegistry.setActiveTab(targetWorkspaceId, activeTab.tabId);
                await bringWorkspaceTabToFront(ctx, { workspaceId: targetWorkspaceId, tabId: activeTab.tabId });
            }

            let recordingToken = snapshot?.recording.recordingToken || fallbackRecordingToken;
            const sourceSteps = snapshot?.recording.steps || fallbackSteps;
            if ((!recordingToken || !ctx.recordingState.recordings.has(recordingToken)) && sourceSteps.length > 0) {
                recordingToken = crypto.randomUUID();
                ctx.recordingState.recordings.set(recordingToken, sourceSteps as StepUnion[]);
            }

            if (recordingToken) {
                ctx.recordingState.workspaceLatestRecording.set(targetWorkspaceId, recordingToken);
                const existingManifest = ctx.recordingState.recordingManifests.get(recordingToken);
                if (existingManifest) {
                    existingManifest.workspaceId = targetWorkspaceId;
                } else {
                    const entry = activeTab || restoredTabs[0];
                    ctx.recordingState.recordingManifests.set(recordingToken, {
                        recordingToken,
                        workspaceId: targetWorkspaceId,
                        entryTabRef: entry?.tabId,
                        entryUrl: entry?.url || fallbackManifest?.entryUrl,
                        startedAt: snapshot?.recording.manifest?.startedAt || fallbackManifest?.startedAt || Date.now(),
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
            }

            const savedSnapshot = saveWorkspaceSnapshot(ctx.recordingState, {
                workspaceId: targetWorkspaceId,
                tabs: restoredTabs.map((tab) => ({
                    tabId: tab.tabId,
                    url: tab.url,
                    title: tab.title,
                    active: tab.active,
                })),
                recordingToken: recordingToken || null,
                steps: sourceSteps as StepUnion[],
                manifest: recordingToken ? ctx.recordingState.recordingManifests.get(recordingToken) : undefined,
            });

            ctx.log('workspace.restore.end', {
                sourceWorkspaceId,
                workspaceId: targetWorkspaceId,
                recordingToken: recordingToken || null,
                tabCount: savedSnapshot.tabs.length,
                stepCount: savedSnapshot.recording.steps.length,
                restoredAt: Date.now(),
            });
            logPageEvent('workspace.restore', {
                sourceWorkspaceId,
                workspaceId: targetWorkspaceId,
                recordingToken: recordingToken || null,
                tabCount: savedSnapshot.tabs.length,
                stepCount: savedSnapshot.recording.steps.length,
                restoredAt: Date.now(),
            });
            return makeOk({
                restored: true,
                sourceWorkspaceId,
                workspaceId: targetWorkspaceId,
                tabId: activeTab?.tabId || created.tabId,
                tabToken: activeTab
                    ? ctx.pageRegistry.resolveTabToken({ workspaceId: targetWorkspaceId, tabId: activeTab.tabId })
                    : ctx.pageRegistry.resolveTabToken({ workspaceId: targetWorkspaceId, tabId: created.tabId }),
                recordingToken: recordingToken || null,
                tabCount: savedSnapshot.tabs.length,
                stepCount: savedSnapshot.recording.steps.length,
            });
        } catch (error) {
            return makeErr(
                ERROR_CODES.ERR_WORKSPACE_RESTORE_FAILED,
                error instanceof Error ? error.message : String(error),
            );
        }
    },
    'tab.list': async (ctx, action) => {
        const payload = (action.payload || {}) as TabListPayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const tabs = await ctx.pageRegistry.listTabs(workspaceId);
        return makeOk({ workspaceId, tabs });
    },
    'tab.create': async (ctx, action) => {
        const payload = (action.payload || {}) as TabCreatePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const tabId = await ctx.pageRegistry.createTab(workspaceId);
        const createdTabToken = ctx.pageRegistry.resolveTabToken({ workspaceId, tabId });
        if (payload.startUrl) {
            try {
                const page = await ctx.pageRegistry.resolvePage({ workspaceId, tabId });
                await page.goto(payload.startUrl, { waitUntil: payload.waitUntil || 'domcontentloaded' });
                await page.bringToFront();
            } catch (error) {
                return makeErr(
                    ERROR_CODES.ERR_ASSERTION_FAILED,
                    'tab.create startUrl navigation failed',
                    {
                        workspaceId,
                        tabId,
                        tabToken: createdTabToken,
                        startUrl: payload.startUrl,
                        message: error instanceof Error ? error.message : String(error),
                    },
                );
            }
        }
        logPageEvent('tab.create', { workspaceId, tabId, tabToken: createdTabToken, startUrl: payload.startUrl });
        return makeOk({ workspaceId, tabId, tabToken: createdTabToken });
    },
    'tab.close': async (ctx, action) => {
        const payload = (action.payload || {}) as TabClosePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        await ctx.pageRegistry.closeTab(workspaceId, payload.tabId);
        logPageEvent('tab.close', { workspaceId, tabId: payload.tabId });
        return makeOk({ workspaceId, tabId: payload.tabId });
    },
    'tab.setActive': async (ctx, action) => {
        const payload = (action.payload || {}) as TabSetActivePayload;
        const workspaceId = resolveWorkspaceId(ctx, action, payload.workspaceId);
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'workspace not found');
        }
        const sourceScope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        let targetTabToken: string | null = null;
        let targetTabUrl: string | undefined;
        try {
            targetTabToken = ctx.pageRegistry.resolveTabToken({ workspaceId, tabId: payload.tabId });
            const targetPage = await ctx.pageRegistry.resolvePage({ workspaceId, tabId: payload.tabId });
            targetTabUrl = targetPage.url();
        } catch {
            targetTabToken = null;
            targetTabUrl = undefined;
        }
        ctx.pageRegistry.setActiveTab(workspaceId, payload.tabId);
        await bringWorkspaceTabToFront(ctx, { workspaceId, tabId: payload.tabId });
        const isCrossTab = sourceScope.workspaceId === workspaceId && sourceScope.tabId !== payload.tabId;
        const recordingTokens = Array.from(ctx.recordingState?.recordingEnabled || []);
        if (isCrossTab && recordingTokens.length > 0 && ctx.recordingState) {
            const sourceRecording = ctx.recordingState.recordingEnabled.has(ctx.tabToken);
            const targetRecording = !!targetTabToken && ctx.recordingState.recordingEnabled.has(targetTabToken);
            const effectiveRecordingToken =
                (sourceRecording && ctx.tabToken) ||
                (targetRecording && targetTabToken) ||
                (recordingTokens.length === 1 ? recordingTokens[0] : null);
            if (effectiveRecordingToken) {
                const list = ctx.recordingState.recordings.get(effectiveRecordingToken) || [];
                const last = list[list.length - 1] as StepUnion | undefined;
                const duplicateSwitch =
                    last?.name === 'browser.switch_tab' && String((last.args as any)?.tab_id || '') === payload.tabId;
                if (!duplicateSwitch) {
                    recordStep(
                        ctx.recordingState,
                        ctx.tabToken,
                        {
                            id: crypto.randomUUID(),
                            name: 'browser.switch_tab',
                            args: { tab_id: payload.tabId, tab_url: targetTabUrl, tab_ref: payload.tabId },
                            meta: {
                                source: 'record',
                                ts: Date.now(),
                                workspaceId,
                                tabId: payload.tabId,
                                tabRef: payload.tabId,
                                tabToken: targetTabToken || undefined,
                                urlAtRecord: targetTabUrl,
                            },
                        } satisfies StepUnion,
                        ctx.navDedupeWindowMs,
                    );
                }
            }
        }
        await ensureRecorderForTabIfRecording(ctx, { workspaceId, tabId: payload.tabId, tabToken: targetTabToken });
        logPageEvent('tab.setActive', { workspaceId, tabId: payload.tabId });
        return makeOk({ workspaceId, tabId: payload.tabId });
    },
    'tab.opened': async (ctx, action) => {
        const payload = (action.payload || {}) as TabOpenedPayload;
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
        return makeOk({
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        });
    },
    'tab.activated': async (ctx, action) => {
        const payload = (action.payload || {}) as TabActivatedPayload;
        const isReplayRunning = (ctx.recordingState?.replaying?.size || 0) > 0;
        const isExtensionLifecycle = typeof payload.source === 'string' && payload.source.startsWith('extension.');
        if (isReplayRunning && isExtensionLifecycle) {
            logPageEvent('tab.activated.ignored', {
                tabToken: ctx.tabToken,
                source: payload.source,
                reportedUrl: payload.url,
                reportedAt: payload.at,
                reason: 'replay_in_progress',
            });
            return makeOk({
                tabToken: ctx.tabToken,
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
        const recordingTokens = Array.from(ctx.recordingState?.recordingEnabled || []);
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
                    const list = ctx.recordingState?.recordings.get(recordingToken) || [];
                    const last = list[list.length - 1] as StepUnion | undefined;
                    const duplicateSwitch =
                        last?.name === 'browser.switch_tab' && String((last.args as any)?.tab_id || '') === scope.tabId;
                    if (!duplicateSwitch && ctx.recordingState) {
                        recordStep(
                            ctx.recordingState,
                            ctx.tabToken,
                            {
                                id: crypto.randomUUID(),
                                name: 'browser.switch_tab',
                                args: { tab_id: scope.tabId, tab_url: payload.url, tab_ref: scope.tabId },
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
        return makeOk({
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken: ctx.tabToken,
            pageUrl: ctx.page.url(),
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedAt: payload.at,
        });
    },
    'tab.closed': async (ctx, action) => {
        const payload = (action.payload || {}) as TabClosedPayload;
        try {
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
            return makeOk({
                workspaceId: scope.workspaceId,
                tabId: scope.tabId,
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
            });
        } catch {
            ctx.log('tab.closed', {
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
            logPageEvent('tab.closed', {
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
            return makeOk({
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
        }
    },
    'tab.ping': async (ctx, action) => {
        const payload = (action.payload || {}) as TabPingPayload;
        const touched = ctx.pageRegistry.touchTabToken?.(ctx.tabToken, payload.at);
        if (!touched) {
            logPageEvent('tab.ping', {
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
            return makeOk({
                tabToken: ctx.tabToken,
                source: payload.source || 'unknown',
                reportedAt: payload.at,
                stale: true,
            });
        }
        const output = {
            workspaceId: touched.workspaceId,
            tabId: touched.tabId,
            tabToken: ctx.tabToken,
            source: payload.source || 'unknown',
            reportedUrl: payload.url,
            reportedTitle: payload.title,
            reportedAt: payload.at,
        };
        ctx.log('tab.ping', output);
        logPageEvent('tab.ping', output);
        return makeOk(output);
    },
};
