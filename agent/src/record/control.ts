import crypto from 'node:crypto';
import { replyAction, type Action } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ACTION_TYPES } from '../actions/action_types';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control';
import {
    beginReplay,
    cancelReplay,
    clearRecording,
    endReplay,
    ensureRecorder,
    getRecordingBundle,
    listWorkspaceRecordings,
    startRecording,
    stopRecording,
    type RecordingState,
} from './recording';
import { setRecorderRuntimeEnabled, type RecorderEvent } from './recorder';
import { ingestRecordPayload } from './ingest';
import { replayRecording, type ReplayEvent, type ReplayOptions } from './replay';
import type { StepUnion } from '../runner/steps/types';
import type { WorkflowDummy, WorkflowRecording } from '../workflow';

const RECORDING_DUMMY: WorkflowDummy = { kind: 'recording' };

export type RecordControlServices = {
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    emit?: (action: Action) => void;
};

export type RecordControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
};

const requireWorkspaceName = (action: Action, type: string): string => {
    const workspaceName = (action.workspaceName || '').trim();
    if (!workspaceName) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `workspaceName is required for ${type}`);
    }
    return workspaceName;
};

export const createRecordControl = (services: RecordControlServices): RecordControl => ({
    handle: async (input) => {
        const { action, workspace } = input;

        if (action.type === 'record.start') {
            const workspaceName = requireWorkspaceName(action, action.type);
            const boundTabs = workspace.tabRegistry.listTabs().filter((tab) => Boolean(tab.page));
            if (!boundTabs.length) {
                throw new ActionError(
                    ERROR_CODES.ERR_BAD_ARGS,
                    `record.start requires at least one bound page in workspace: ${workspaceName}`,
                );
            }
            const primary = boundTabs[0];
            const primaryPage = primary.page!;
            await startRecording(services.recordingState, primaryPage, primary.name, services.navDedupeWindowMs, {
                workspaceName,
                tabRef: primary.name,
                entryUrl: primaryPage.url(),
            });
            for (const tab of boundTabs) {
                if (!tab.page) {continue;}
                await ensureRecorder(services.recordingState, tab.page, tab.name, services.navDedupeWindowMs);
                await setRecorderRuntimeEnabled(tab.page, true);
            }
            return { reply: replyAction(action, { pageUrl: primaryPage.url() }), events: [] };
        }

        if (action.type === 'record.stop') {
            const workspaceName = requireWorkspaceName(action, action.type);
            const tabs = workspace.tabRegistry.listTabs();
            const firstBoundPage = tabs.find((tab) => Boolean(tab.page))?.page;
            stopRecording(services.recordingState, '', { workspaceName });
            for (const tab of tabs) {
                if (!tab.page) {continue;}
                await setRecorderRuntimeEnabled(tab.page, false);
            }
            return { reply: replyAction(action, { pageUrl: firstBoundPage?.url() || '' }), events: [] };
        }

        if (action.type === 'record.get') {
            const workspaceName = requireWorkspaceName(action, action.type);
            const bundle = getRecordingBundle(services.recordingState, '', { workspaceName });
            return {
                reply: replyAction(action, { steps: bundle.steps, manifest: bundle.manifest, enrichments: bundle.enrichments }),
                events: [],
            };
        }

        if (action.type === 'record.save') {
            const workspaceName = requireWorkspaceName(action, action.type);
            const payload = (action.payload || {}) as { recordingName?: string; includeStepResolve?: boolean };
            const workflow = workspace.workflow;
            const bundle = getRecordingBundle(services.recordingState, '', { workspaceName });
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
            return {
                reply: replyAction(action, { saved: true, recordingName, workspaceName, stepCount: bundle.steps.length }),
                events: [],
            };
        }

        if (action.type === 'record.load') {
            const workspaceName = requireWorkspaceName(action, action.type);
            const payload = (action.payload || {}) as { recordingName?: string };
            const workflow = workspace.workflow;
            const recordingName = (payload.recordingName || '').trim() || workflow.list(RECORDING_DUMMY)[0]?.name || '';
            if (!recordingName) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'record.load requires recordingName or existing records');
            }
            const loaded = workflow.get(recordingName, RECORDING_DUMMY);
            if (!loaded || loaded.kind !== 'recording') {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `recording not found: ${recordingName}`);
            }
            const recordingToken = crypto.randomUUID();
            const now = Date.now();
            const steps: StepUnion[] = loaded.steps.map((step) => ({
                id: step.id,
                name: step.name,
                args: step.args,
                meta: { source: 'record', ts: now, workspaceName },
            })) as StepUnion[];
            services.recordingState.recordings.set(recordingToken, steps);
            services.recordingState.recordingEnhancements.set(recordingToken, {});
            services.recordingState.recordingManifests.set(recordingToken, {
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
            services.recordingState.workspaceLatestRecording.set(workspaceName, recordingToken);
            return {
                reply: replyAction(action, { imported: true, recordingName, stepCount: steps.length, workspaceName, recordingToken }),
                events: [],
            };
        }

        if (action.type === 'record.clear') {
            const workspaceName = requireWorkspaceName(action, action.type);
            clearRecording(services.recordingState, '', { workspaceName });
            return { reply: replyAction(action, { cleared: true }), events: [] };
        }

        if (action.type === 'record.list') {
            const recordings = listWorkspaceRecordings(services.recordingState);
            return { reply: replyAction(action, { recordings }), events: [] };
        }

        if (action.type === 'play.stop') {
            const activeTab = workspace.tabRegistry.getActiveTab();
            if (!activeTab) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'active tab not found');
            }
            cancelReplay(services.recordingState, activeTab.name);
            return { reply: replyAction(action, { stopped: true }), events: [] };
        }

        if (action.type === 'play.start') {
            const payload = (action.payload || {}) as { stopOnError?: boolean };
            const currentTab = workspace.tabRegistry.getActiveTab();
            if (!currentTab) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'active tab not found');
            }
            const currentWorkspaceName = workspace.name;
            const bundle = getRecordingBundle(services.recordingState, currentTab.name, { workspaceName: currentWorkspaceName });
            const steps = bundle.steps;
            const stopOnError = payload.stopOnError ?? true;
            const replayWorkspaceName = bundle.manifest?.workspaceName || currentWorkspaceName;
            if (replayWorkspaceName !== currentWorkspaceName) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'recording workspace mismatch');
            }
            const initialTabName = currentTab.name;

            if (!currentTab.page) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `page not bound: ${currentWorkspaceName}/${initialTabName}`);
            }

            if (bundle.manifest?.entryUrl && currentTab.page.url() !== bundle.manifest.entryUrl) {
                try {
                    await currentTab.page.goto(bundle.manifest.entryUrl, { waitUntil: 'domcontentloaded' });
                } catch {}
            }

            beginReplay(services.recordingState, currentTab.name);
            const emitPlayEvent = (type: string, payloadData: Record<string, unknown>) => {
                services.emit?.({
                    v: 1,
                    id: crypto.randomUUID(),
                    type,
                    workspaceName: replayWorkspaceName,
                    payload: payloadData,
                    at: Date.now(),
                    traceId: action.traceId,
                });
            };

            const publishReplayEvent = (event: ReplayEvent) => {
                if (event.type === 'step.started') {
                    emitPlayEvent(ACTION_TYPES.PLAY_STEP_STARTED, { workspaceName: replayWorkspaceName, tabName: initialTabName, ...event });
                    return;
                }
                if (event.type === 'step.finished') {
                    emitPlayEvent(ACTION_TYPES.PLAY_STEP_FINISHED, { workspaceName: replayWorkspaceName, tabName: initialTabName, ...event });
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
                        replayOptions: services.replayOptions,
                        pageRegistry: {
                            listTabs: async () =>
                                workspace.tabRegistry.listTabs().map((tab) => ({
                                    tabName: tab.name,
                                    active: workspace.tabRegistry.getActiveTab()?.name === tab.name,
                                })),
                            resolveTabNameFromToken: (tabName: string) => tabName,
                            resolveTabNameFromRef: (tabRef: string) => tabRef || undefined,
                        },
                        isCanceled: () => services.recordingState.replayCancel.has(currentTab.name),
                        onEvent: publishReplayEvent,
                    });
                    if (replayed.error?.code === 'ERR_CANCELED') {
                        emitPlayEvent(ACTION_TYPES.PLAY_CANCELED, { workspaceName: replayWorkspaceName, tabName: initialTabName, results: replayed.results });
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
                    emitPlayEvent(ACTION_TYPES.PLAY_COMPLETED, { workspaceName: replayWorkspaceName, tabName: initialTabName, results: replayed.results });
                } catch (error) {
                    emitPlayEvent(ACTION_TYPES.PLAY_FAILED, {
                        workspaceName: replayWorkspaceName,
                        tabName: initialTabName,
                        code: ERROR_CODES.ERR_BAD_ARGS,
                        message: error instanceof Error ? error.message : String(error),
                    });
                } finally {
                    endReplay(services.recordingState, currentTab.name);
                }
            })();

            return {
                reply: replyAction(
                    action,
                    { started: true, workspaceName: replayWorkspaceName, tabName: initialTabName, stepCount: steps.length, stopOnError },
                    ACTION_TYPES.PLAY_STARTED,
                ),
                events: [],
            };
        }

        if (action.type === 'record.event') {
            const activeTab = workspace.tabRegistry.getActiveTab();
            const page = activeTab?.page || null;
            const tabName = activeTab?.name || '';
            if (!tabName) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'active tab not found');
            }
            const payload = action.payload as StepUnion | RecorderEvent | undefined;
            if (!payload) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'missing record.event payload');
            }
            const result = await ingestRecordPayload({
                state: services.recordingState,
                payload,
                page,
                tabName,
                workspaceName: workspace.name,
                navDedupeWindowMs: services.navDedupeWindowMs,
            });
            return { reply: replyAction(action, { accepted: result.accepted, mode: result.mode }), events: [] };
        }

        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    },
});
