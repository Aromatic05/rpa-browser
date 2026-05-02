/**
 * recording action：record / play 相关动作。
 */

import crypto from 'node:crypto';
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
import { setRecorderRuntimeEnabled, type RecorderEvent } from '../record/recorder';
import { replayRecording, type ReplayEvent } from '../play/replay';
import { ensureWorkflowOnFs, type WorkflowDummy, type WorkflowRecording } from '../workflow';

const RECORDING_DUMMY: WorkflowDummy = { kind: 'recording' };

export const recordingHandlers: Record<string, ActionHandler> = {
    'record.start': async (ctx, action) => {
        const workspaceName = (action.workspaceName || '').trim();
        if (!workspaceName) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceName is required for record.start');
        }
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, `workspace not found: ${workspaceName}`);
        }
        const boundTabs = workspace.tabRegistry.listTabs().filter((tab) => Boolean(tab.page));
        if (!boundTabs.length) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, `record.start requires at least one bound page in workspace: ${workspaceName}`);
        }
        const primary = boundTabs[0];
        const primaryPage = primary.page!;
        await startRecording(ctx.recordingState, primaryPage, primary.name, ctx.navDedupeWindowMs, {
            workspaceName,
            tabRef: primary.name,
            entryUrl: primaryPage.url(),
        });
        for (const tab of boundTabs) {
            const page = tab.page;
            if (!page) {continue;}
            await ensureRecorder(ctx.recordingState, page, tab.name, ctx.navDedupeWindowMs);
            await setRecorderRuntimeEnabled(page, true);
        }
        return replyAction(action, { pageUrl: primaryPage.url() });
    },
    'record.stop': async (ctx, action) => {
        const workspaceName = action.workspaceName;
        stopRecording(ctx.recordingState, ctx.resolveTab().name, { workspaceName });
        try {
            await setRecorderRuntimeEnabled(ctx.resolvePage(), false);
        } catch {
            // ignore unavailable page in pageless mode
        }
        if (workspaceName && ctx.workspaceRegistry.hasWorkspace(workspaceName)) {
            try {
                const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
                const tabs = workspace?.tabRegistry.listTabs() || [];
                for (const tab of tabs) {
                    try {
                        if (!tab.page) {continue;}
                        const page = tab.page;
                        await setRecorderRuntimeEnabled(page, false);
                    } catch {
                        // ignore tabs without live page binding
                    }
                }
            } catch {
                // ignore workspace listing failures
            }
        }
        let pageUrl = '';
        try {
            pageUrl = ctx.resolvePage().url();
        } catch {
            // pageless mode: no concrete page target
        }
        return replyAction(action, { pageUrl });
    },
    'record.get': async (ctx, action) => {
        const workspaceName = action.workspaceName;
        const bundle = getRecordingBundle(ctx.recordingState, ctx.resolveTab().name, workspaceName ? { workspaceName } : undefined);
        return replyAction(action, { steps: bundle.steps, manifest: bundle.manifest, enrichments: bundle.enrichments });
    },
    'record.save': async (ctx, action) => {
        const workspaceName = action.workspaceName;
        if (!workspaceName) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceName is required for record.save');
        }
        const payload = (action.payload || {}) as { recordingName?: string; includeStepResolve?: boolean };
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName)
            || ctx.workspaceRegistry.createWorkspace(workspaceName, ensureWorkflowOnFs(workspaceName));
        const workflow = workspace.workflow;
        const bundle = getRecordingBundle(ctx.recordingState, ctx.resolveTab().name, workspaceName ? { workspaceName } : undefined);
        const recordingName = (payload.recordingName || '').trim() || `recording-${Date.now()}`;
        const artifact: WorkflowRecording = {
            kind: 'recording',
            name: recordingName,
            recording: {
                version: 1,
                recordingName,
                workspaceName,
                entryUrl: bundle.manifest?.entryUrl,
                tabs: (bundle.manifest?.tabs || []).map((item) => ({
                    tabName: item.tabName || item.tabRef,
                    url: item.lastSeenUrl || item.firstSeenUrl,
                })),
                createdAt: Date.now(),
                stepCount: bundle.steps.length,
            },
            steps: bundle.steps,
            stepResolves: payload.includeStepResolve === true ? {} : {},
        };
        workflow.save(artifact);
        return replyAction(action, {
            saved: true,
            recordingName,
            workspaceName,
            stepCount: bundle.steps.length,
        });
    },
    'record.load': async (ctx, action) => {
        const workspaceName = action.workspaceName;
        if (!workspaceName) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceName is required for record.load');
        }
        const payload = (action.payload || {}) as { recordingName?: string };
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, `workspace not found: ${workspaceName}`);
        }
        const workflow = workspace.workflow;
        const recordingName = (payload.recordingName || '').trim() || workflow.list(RECORDING_DUMMY)[0]?.name || '';
        if (!recordingName) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'record.load requires recordingName or existing records');
        }
        const loaded = workflow.get(recordingName, RECORDING_DUMMY);
        if (!loaded || loaded.kind !== 'recording') {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, `recording not found: ${recordingName}`);
        }
        const recordingToken = crypto.randomUUID();
        const now = Date.now();
        const steps: StepUnion[] = loaded.steps.map((step) => ({
            id: step.id,
            name: step.name,
            args: step.args,
            meta: { source: 'record', ts: now, workspaceName },
        })) as StepUnion[];
        ctx.recordingState.recordings.set(recordingToken, steps);
        ctx.recordingState.recordingEnhancements.set(recordingToken, {});
        ctx.recordingState.recordingManifests.set(recordingToken, {
            recordingToken,
            workspaceName,
            entryUrl: typeof loaded.recording.entryUrl === 'string' ? loaded.recording.entryUrl : undefined,
            startedAt: now,
            tabs: (Array.isArray(loaded.recording.tabs) ? loaded.recording.tabs : []).map((tab) => ({
                tabName: tab.tabName || 'main',
                tabRef: tab.tabName || 'main',
                firstSeenUrl: tab.url,
                lastSeenUrl: tab.url,
                firstSeenAt: now,
                lastSeenAt: now,
            })),
        });
        ctx.recordingState.workspaceLatestRecording.set(workspaceName, recordingToken);
        return replyAction(action, {
            imported: true,
            recordingName,
            stepCount: steps.length,
            workspaceName,
            recordingToken,
        });
    },
    'record.clear': async (ctx, action) => {
        const workspaceName = action.workspaceName;
        clearRecording(ctx.recordingState, ctx.resolveTab().name, workspaceName ? { workspaceName } : undefined);
        return replyAction(action, { cleared: true });
    },
    'record.list': async (ctx, action) => {
        const recordings = listWorkspaceRecordings(ctx.recordingState);
        return replyAction(action, { recordings });
    },
    'play.stop': async (ctx, action) => {
        cancelReplay(ctx.recordingState, ctx.resolveTab().name);
        return replyAction(action, { stopped: true });
    },
    'play.start': async (ctx, action) => {
        const payload = (action.payload || {}) as { stopOnError?: boolean };
        const currentTab = ctx.resolveTab();
        const currentWorkspaceName = action.workspaceName || ctx.workspace?.name || '';
        const bundle = getRecordingBundle(ctx.recordingState, currentTab.name, { workspaceName: currentWorkspaceName });
        const steps = bundle.steps;
        const stopOnError = payload.stopOnError ?? true;
        const recordedWorkspaceName = bundle.manifest?.workspaceName;
        const existingWorkspaceNames = new Set(ctx.workspaceRegistry.listWorkspaces().map((ws) => ws.name));
        if (recordedWorkspaceName && !existingWorkspaceNames.has(recordedWorkspaceName)) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'recording workspace not found');
        }
        const replayWorkspaceName = recordedWorkspaceName || currentWorkspaceName;
        // Prefer the currently targeted tab when scope is valid in the same workspace.
        // Only create a new tab if we must switch workspace and no tab is available there.
        let initialTabName = currentWorkspaceName === replayWorkspaceName ? currentTab.name : '';
        if (!initialTabName) {
            const targetWs = ctx.workspaceRegistry.getWorkspace(replayWorkspaceName);
            initialTabName = targetWs?.tabRegistry.getActiveTab()?.name || '';
        }
        if (!initialTabName) {
            initialTabName = crypto.randomUUID();
            const page = await ctx.pageRegistry.getPage(initialTabName);
            const targetWs = ctx.workspaceRegistry.createWorkspace(replayWorkspaceName, ensureWorkflowOnFs(replayWorkspaceName));
            targetWs.tabRegistry.createTab({ tabName: initialTabName, page, url: page.url() });
            targetWs.tabRegistry.setActiveTab(initialTabName);
        }
        // Never reuse recorded tab token; bind replay to the current runtime tab token.
        if (bundle.manifest?.entryUrl) {
            try {
                const targetWorkspace = ctx.workspaceRegistry.getWorkspace(replayWorkspaceName);
                const page = targetWorkspace?.tabRegistry.getTab(initialTabName)?.page;
                if (!page) {throw new Error('page not bound');}
                if (page.url() !== bundle.manifest.entryUrl) {
                    await page.goto(bundle.manifest.entryUrl, { waitUntil: 'domcontentloaded' });
                }
            } catch {
                // ignore preflight navigation failures, replay steps will surface deterministic errors later.
            }
        }
        beginReplay(ctx.recordingState, currentTab.name);
        const emitPlayEvent = (type: string, payload: Record<string, unknown>) => {
            ctx.emit?.({
                v: 1,
                id: crypto.randomUUID(),
                type,
                workspaceName: replayWorkspaceName,
                payload,
                at: Date.now(),
                traceId: action.traceId,
            });
        };

        const publishReplayEvent = (event: ReplayEvent) => {
            if (event.type === 'step.started') {
                emitPlayEvent(ACTION_TYPES.PLAY_STEP_STARTED, {
                    workspaceName: replayWorkspaceName,
                    tabName: initialTabName,
                    ...event,
                });
                return;
            }
            if (event.type === 'step.finished') {
                emitPlayEvent(ACTION_TYPES.PLAY_STEP_FINISHED, {
                    workspaceName: replayWorkspaceName,
                    tabName: initialTabName,
                    ...event,
                });
                return;
            }
            emitPlayEvent(ACTION_TYPES.PLAY_PROGRESS, {
                workspaceName: replayWorkspaceName,
                tabName: initialTabName,
                completed: event.completed,
                total: event.total,
            });
        };

        void (async () => {
            try {
                const replayed = await replayRecording({
                    workspaceName: replayWorkspaceName,
                    initialTabName,
                    steps,
                    enrichments: bundle.enrichments,
                    recordingManifest: bundle.manifest,
                    stopOnError,
                    replayOptions: ctx.replayOptions,
                    pageRegistry: {
                        listTabs: async (workspaceName: string) =>
                            (ctx.workspaceRegistry.getWorkspace(workspaceName)?.tabRegistry.listTabs() || []).map((tab) => ({
                                tabName: tab.name,
                                active: ctx.workspaceRegistry.getWorkspace(workspaceName)?.tabRegistry.getActiveTab()?.name === tab.name,
                            })),
                        resolveTabNameFromToken: (tabName: string) => tabName,
                        resolveTabNameFromRef: (tabRef: string) => {
                            return tabRef || undefined;
                        },
                    },
                    isCanceled: () => ctx.recordingState.replayCancel.has(currentTab.name),
                    onEvent: publishReplayEvent,
                });
                if (replayed.error?.code === 'ERR_CANCELED') {
                    emitPlayEvent(ACTION_TYPES.PLAY_CANCELED, {
                        workspaceName: replayWorkspaceName,
                        tabName: initialTabName,
                        results: replayed.results,
                    });
                    return;
                }
                if (!replayed.ok && stopOnError) {
                    const firstFailed = replayed.results.find((item) => !item.ok);
                    emitPlayEvent(ACTION_TYPES.PLAY_FAILED, {
                        workspaceName: replayWorkspaceName,
                        tabName: initialTabName,
                        code: ERROR_CODES.ERR_ASSERTION_FAILED,
                        message: firstFailed?.error?.message || replayed.error?.message || 'replay failed',
                        details: { results: replayed.results, failed: firstFailed?.error || replayed.error },
                    });
                    return;
                }
                emitPlayEvent(ACTION_TYPES.PLAY_COMPLETED, {
                    workspaceName: replayWorkspaceName,
                    tabName: initialTabName,
                    results: replayed.results,
                });
            } catch (error) {
                emitPlayEvent(ACTION_TYPES.PLAY_FAILED, {
                    workspaceName: replayWorkspaceName,
                    tabName: initialTabName,
                    code: ERROR_CODES.ERR_BAD_ARGS,
                    message: error instanceof Error ? error.message : String(error),
                });
            } finally {
                endReplay(ctx.recordingState, currentTab.name);
            }
        })();

        return replyAction(
            action,
            {
                started: true,
                workspaceName: replayWorkspaceName,
                tabName: initialTabName,
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
            await recordEvent(ctx.recordingState, payload, ctx.navDedupeWindowMs, ctx.resolvePage());
            return replyAction(action, { accepted: true, mode: 'raw-event' });
        }

        const step = payload;
        const token = ctx.resolveTab().name;
        const workspaceName = action.workspaceName || ctx.workspace?.name || '';
        let currentUrl: string;
        try {
            currentUrl = ctx.resolvePage().url();
        } catch {
            currentUrl = '';
        }
        const normalizedStep: StepUnion = {
            ...step,
            meta: {
                ...step.meta,
                source: step.meta?.source ?? 'record',
                ts: step.meta?.ts ?? Date.now(),
                workspaceName,
                tabName: token,
                tabRef: step.meta?.tabRef || token,
                urlAtRecord: step.meta?.urlAtRecord || currentUrl || undefined,
            },
        };
        recordStep(ctx.recordingState, token, normalizedStep, ctx.navDedupeWindowMs);
        return replyAction(action, { accepted: true });
    },
};

const isRawRecorderEventPayload = (payload: StepUnion | RecorderEvent): payload is RecorderEvent => {
    const maybe = payload as Partial<RecorderEvent>;
    return typeof maybe.type === 'string' && typeof maybe.tabName === 'string' && typeof maybe.ts === 'number';
};
