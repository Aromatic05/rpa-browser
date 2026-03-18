/**
 * recording action：record / play 相关动作。
 */

import type { Action } from './action_protocol';
import { makeErr, makeOk } from './action_protocol';
import type { ActionHandler } from './execute';
import {
    startRecording,
    stopRecording,
    getRecordingBundle,
    clearRecording,
    ensureRecorder,
    beginReplay,
    endReplay,
    cancelReplay,
    recordStep,
    listWorkspaceRecordings,
} from '../record/recording';
import { ERROR_CODES } from './error_codes';
import type { StepUnion } from '../runner/steps/types';
import { replayRecording } from '../play/replay';

export const recordingHandlers: Record<string, ActionHandler> = {
    'record.start': async (ctx, _action) => {
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        await startRecording(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs, {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            entryUrl: ctx.page.url(),
        });
        await ensureRecorder(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs);
        return makeOk({ pageUrl: ctx.page.url() });
    },
    'record.stop': async (ctx, _action) => {
        stopRecording(ctx.recordingState, ctx.tabToken);
        return makeOk({ pageUrl: ctx.page.url() });
    },
    'record.get': async (ctx, _action) => {
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        const bundle = getRecordingBundle(ctx.recordingState, ctx.tabToken, { workspaceId: scope.workspaceId });
        return makeOk({ steps: bundle.steps, manifest: bundle.manifest });
    },
    'record.clear': async (ctx, _action) => {
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        clearRecording(ctx.recordingState, ctx.tabToken, { workspaceId: scope.workspaceId });
        return makeOk({ cleared: true });
    },
    'record.list': async (ctx, _action) => {
        const recordings = listWorkspaceRecordings(ctx.recordingState);
        return makeOk({ recordings });
    },
    'play.stop': async (ctx, _action) => {
        cancelReplay(ctx.recordingState, ctx.tabToken);
        return makeOk({ stopped: true });
    },
    'play.start': async (ctx, action) => {
        const payload = (action.payload || {}) as { stopOnError?: boolean };
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        const bundle = getRecordingBundle(ctx.recordingState, ctx.tabToken, { workspaceId: scope.workspaceId });
        const steps = bundle.steps;
        const stopOnError = payload.stopOnError ?? true;
        const recordedWorkspaceId = bundle.manifest?.workspaceId;
        const existingWorkspaceIds = new Set(ctx.pageRegistry.listWorkspaces().map((ws) => ws.workspaceId));
        if (recordedWorkspaceId && !existingWorkspaceIds.has(recordedWorkspaceId)) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'recording workspace not found');
        }
        const replayWorkspaceId = recordedWorkspaceId || scope.workspaceId;
        // Prefer the currently targeted tab when scope is valid in the same workspace.
        // Only create a new tab if we must switch workspace and no tab is available there.
        let initialTabId = scope.workspaceId === replayWorkspaceId ? scope.tabId : '';
        if (!initialTabId) {
            const targetWs = ctx.pageRegistry.listWorkspaces().find((ws) => ws.workspaceId === replayWorkspaceId);
            initialTabId = targetWs?.activeTabId || '';
        }
        if (!initialTabId) {
            initialTabId = await ctx.pageRegistry.createTab(replayWorkspaceId);
        }
        // Never reuse recorded tab token; bind replay to the current runtime tab token.
        if (bundle.manifest?.entryUrl) {
            try {
                const page = await ctx.pageRegistry.resolvePage({ workspaceId: replayWorkspaceId, tabId: initialTabId });
                if (page.url() !== bundle.manifest.entryUrl) {
                    await page.goto(bundle.manifest.entryUrl, { waitUntil: 'domcontentloaded' });
                }
            } catch {
                // ignore preflight navigation failures, replay steps will surface deterministic errors later.
            }
        }
        ctx.pageRegistry.setActiveWorkspace(replayWorkspaceId);
        ctx.pageRegistry.setActiveTab(replayWorkspaceId, initialTabId);
        const initialTabToken = ctx.pageRegistry.resolveTabToken({ workspaceId: replayWorkspaceId, tabId: initialTabId });
        beginReplay(ctx.recordingState, ctx.tabToken);
        try {
            const replayed = await replayRecording({
                workspaceId: replayWorkspaceId,
                initialTabId,
                initialTabToken,
                steps,
                recordingManifest: bundle.manifest,
                stopOnError,
                replayOptions: ctx.replayOptions,
                pageRegistry: {
                    listTabs: (workspaceId: string) => ctx.pageRegistry.listTabs(workspaceId),
                    resolveTabIdFromToken: (tabToken: string) => {
                        try {
                            return ctx.pageRegistry.resolveScopeFromToken(tabToken).tabId;
                        } catch {
                            return undefined;
                        }
                    },
                    resolveTabIdFromRef: (tabRef: string) => {
                        return tabRef || undefined;
                    },
                },
                isCanceled: () => ctx.recordingState.replayCancel.has(ctx.tabToken),
            });
            if (replayed.error?.code === 'ERR_CANCELED') {
                return makeOk({ stopped: true, canceled: true, results: replayed.results });
            }
            if (!replayed.ok && stopOnError) {
                const firstFailed = replayed.results.find((item) => !item.ok);
                return makeErr(
                    ERROR_CODES.ERR_ASSERTION_FAILED,
                    firstFailed?.error?.message || replayed.error?.message || 'replay failed',
                    { results: replayed.results, failed: firstFailed?.error || replayed.error },
                );
            }
            return makeOk({ results: replayed.results });
        } finally {
            endReplay(ctx.recordingState, ctx.tabToken);
        }
    },
    'record.event': async (ctx, action) => {
        const step = action.payload as StepUnion | undefined;
        if (!step) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing record.event payload');
        }
        const token = action.scope?.tabToken || action.tabToken || ctx.tabToken;
        const scope = ctx.pageRegistry.resolveScopeFromToken(token);
        let currentUrl = '';
        try {
            const targetPage = await ctx.pageRegistry.resolvePage({ workspaceId: scope.workspaceId, tabId: scope.tabId });
            currentUrl = targetPage.url();
        } catch {
            currentUrl = '';
        }
        const normalizedStep: StepUnion = {
            ...step,
            meta: {
                ...step.meta,
                source: step.meta?.source ?? 'record',
                ts: step.meta?.ts ?? Date.now(),
                workspaceId: scope.workspaceId,
                tabId: scope.tabId,
                tabToken: token,
                tabRef: step.meta?.tabRef || scope.tabId,
                urlAtRecord: step.meta?.urlAtRecord || currentUrl || undefined,
            },
        };
        recordStep(ctx.recordingState, token, normalizedStep, ctx.navDedupeWindowMs);
        return makeOk({ accepted: true });
    },
};
