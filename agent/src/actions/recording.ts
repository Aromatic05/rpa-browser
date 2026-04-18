/**
 * recording action：record / play 相关动作。
 */

import crypto from 'node:crypto';
import type { Action } from './action_protocol';
import { failedAction, replyAction } from './action_protocol';
import type { ActionHandler } from './execute';
import { ACTION_TYPES } from './action_types';
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
    recordEvent,
    listWorkspaceRecordings,
} from '../record/recording';
import { ERROR_CODES } from './error_codes';
import type { StepUnion } from '../runner/steps/types';
import type { RecorderEvent } from '../record/recorder';
import { replayRecording, type ReplayEvent } from '../play/replay';

export const recordingHandlers: Record<string, ActionHandler> = {
    'record.start': async (ctx, action) => {
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        await startRecording(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs, {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            entryUrl: ctx.page.url(),
        });
        await ensureRecorder(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs);
        return replyAction(action, { pageUrl: ctx.page.url() });
    },
    'record.stop': async (ctx, action) => {
        stopRecording(ctx.recordingState, ctx.tabToken);
        return replyAction(action, { pageUrl: ctx.page.url() });
    },
    'record.get': async (ctx, action) => {
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        const bundle = getRecordingBundle(ctx.recordingState, ctx.tabToken, { workspaceId: scope.workspaceId });
        return replyAction(action, { steps: bundle.steps, manifest: bundle.manifest, enrichments: bundle.enrichments });
    },
    'record.clear': async (ctx, action) => {
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        clearRecording(ctx.recordingState, ctx.tabToken, { workspaceId: scope.workspaceId });
        return replyAction(action, { cleared: true });
    },
    'record.list': async (ctx, action) => {
        const recordings = listWorkspaceRecordings(ctx.recordingState);
        return replyAction(action, { recordings });
    },
    'play.stop': async (ctx, action) => {
        cancelReplay(ctx.recordingState, ctx.tabToken);
        return replyAction(action, { stopped: true });
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
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'recording workspace not found');
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
        const emitPlayEvent = (type: string, payload: Record<string, unknown>) => {
            ctx.emit?.({
                v: 1,
                id: crypto.randomUUID(),
                type,
                tabToken: ctx.tabToken,
                scope: { workspaceId: replayWorkspaceId, tabId: initialTabId, tabToken: ctx.tabToken },
                payload,
                at: Date.now(),
                traceId: action.traceId,
            });
        };

        const publishReplayEvent = (event: ReplayEvent) => {
            if (event.type === 'step.started') {
                emitPlayEvent(ACTION_TYPES.PLAY_STEP_STARTED, {
                    workspaceId: replayWorkspaceId,
                    tabId: initialTabId,
                    ...event,
                });
                return;
            }
            if (event.type === 'step.finished') {
                emitPlayEvent(ACTION_TYPES.PLAY_STEP_FINISHED, {
                    workspaceId: replayWorkspaceId,
                    tabId: initialTabId,
                    ...event,
                });
                return;
            }
            emitPlayEvent(ACTION_TYPES.PLAY_PROGRESS, {
                workspaceId: replayWorkspaceId,
                tabId: initialTabId,
                completed: event.completed,
                total: event.total,
            });
        };

        void (async () => {
            try {
                const replayed = await replayRecording({
                    workspaceId: replayWorkspaceId,
                    initialTabId,
                    initialTabToken,
                    steps,
                    enrichments: bundle.enrichments,
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
                    onEvent: publishReplayEvent,
                });
                if (replayed.error?.code === 'ERR_CANCELED') {
                    emitPlayEvent(ACTION_TYPES.PLAY_CANCELED, {
                        workspaceId: replayWorkspaceId,
                        tabId: initialTabId,
                        results: replayed.results,
                    });
                    return;
                }
                if (!replayed.ok && stopOnError) {
                    const firstFailed = replayed.results.find((item) => !item.ok);
                    emitPlayEvent(ACTION_TYPES.PLAY_FAILED, {
                        workspaceId: replayWorkspaceId,
                        tabId: initialTabId,
                        code: ERROR_CODES.ERR_ASSERTION_FAILED,
                        message: firstFailed?.error?.message || replayed.error?.message || 'replay failed',
                        details: { results: replayed.results, failed: firstFailed?.error || replayed.error },
                    });
                    return;
                }
                emitPlayEvent(ACTION_TYPES.PLAY_COMPLETED, {
                    workspaceId: replayWorkspaceId,
                    tabId: initialTabId,
                    results: replayed.results,
                });
            } catch (error) {
                emitPlayEvent(ACTION_TYPES.PLAY_FAILED, {
                    workspaceId: replayWorkspaceId,
                    tabId: initialTabId,
                    code: ERROR_CODES.ERR_BAD_ARGS,
                    message: error instanceof Error ? error.message : String(error),
                });
            } finally {
                endReplay(ctx.recordingState, ctx.tabToken);
            }
        })();

        return replyAction(
            action,
            {
                started: true,
                workspaceId: replayWorkspaceId,
                tabId: initialTabId,
                tabToken: initialTabToken,
                stepCount: steps.length,
                stopOnError,
            },
            ACTION_TYPES.PLAY_STARTED,
        );
    },
    'record.event': async (ctx, action) => {
        const payload = action.payload as StepUnion | RecorderEvent | undefined;
        if (!payload) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'missing record.event payload');
        }

        if (isRawRecorderEventPayload(payload)) {
            await recordEvent(ctx.recordingState, payload, ctx.navDedupeWindowMs, ctx.page);
            return replyAction(action, { accepted: true, mode: 'raw-event' });
        }

        const step = payload;
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
        return replyAction(action, { accepted: true });
    },
};

const isRawRecorderEventPayload = (payload: StepUnion | RecorderEvent): payload is RecorderEvent => {
    const maybe = payload as Partial<RecorderEvent>;
    return typeof maybe.type === 'string' && typeof maybe.tabToken === 'string' && typeof maybe.ts === 'number';
};
