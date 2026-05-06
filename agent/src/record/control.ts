import crypto from 'node:crypto';
import { replyAction, type Action } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ACTION_TYPES } from '../actions/action_types';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import { enterWorkspaceState, getWorkspaceState, leaveWorkspaceState, requireWorkspaceState } from '../runtime/workspace/workspace';
import {
    beginReplay,
    cancelReplay,
    clearWorkspaceUnsavedRecording,
    disableWorkspaceRecording,
    enableWorkspaceRecording,
    endReplay,
    ensureRecorder,
    getWorkspaceUnsavedRecordingBundle,
    resetWorkspaceUnsavedRecording,
    type RecordingState,
} from './recording';
import { setRecorderRuntimeEnabled, type RecorderEvent } from './recorder';
import { ingestRecordPayload } from './ingest';
import { replayRecording, type ReplayEvent, type ReplayOptions } from './replay';
import type { StepResolve, StepUnion } from '../runner/steps/types';
import type { WorkflowDummy, WorkflowRecording } from '../workflow';
import type { ExecutionBindings } from '../runtime/execution/bindings';
import type { PageRegistry } from '../runtime/browser/page_registry';
import type { Logger } from '../logging/logger';

const RECORDING_DUMMY: WorkflowDummy = { kind: 'recording' };

export type RecordControlServices = {
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    runtime: ExecutionBindings;
    pageRegistry: PageRegistry;
    emit?: (action: Action) => void;
    log: Logger | ((...args: unknown[]) => void);
};

const logWarning = (log: RecordControlServices['log'], ...args: unknown[]) => {
    if (typeof log === 'function' && 'warning' in log && typeof (log as Logger).warning === 'function') {
        (log as Logger).warning(...args);
        return;
    }
    if (typeof log === 'function') {
        log(...args);
    }
};

const logError = (log: RecordControlServices['log'], ...args: unknown[]) => {
    if (typeof log === 'function' && 'error' in log && typeof (log as Logger).error === 'function') {
        (log as Logger).error(...args);
        return;
    }
    if (typeof log === 'function') {
        log(...args);
    }
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

const toSavedRecordingList = (workspace: WorkspaceRouterInput['workspace']) =>
    workspace.workflow
        .list(RECORDING_DUMMY)
        .map((item) => {
            const loaded = workspace.workflow.get(item.name, RECORDING_DUMMY);
            const steps = loaded && loaded.kind === 'recording' ? loaded.steps : [];
            return { recordingName: item.name, stepCount: steps.length };
        });

export const createRecordControl = (services: RecordControlServices): RecordControl => ({
    handle: async (input) => {
        const { action, workspace } = input;

        if (action.type === 'record.start') {
            requireWorkspaceState(workspace, 'idle', action.type);
            const workspaceName = requireWorkspaceName(action, action.type);
            const tabs = workspace.tabs.listTabs();
            const activeTab = workspace.tabs.getActiveTab();
            if (!activeTab) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'active tab not found');
            }
            const binding = await services.runtime.ensureExecutableTab({
                workspace,
                pageRegistry: services.pageRegistry,
                tabName: activeTab.name,
            });
            const executableTabs = workspace.tabs.listTabs().filter((tab) => Boolean(tab.page) && !tab.page?.isClosed());
            if (!executableTabs.length) {
                throw new ActionError(
                    ERROR_CODES.ERR_BAD_ARGS,
                    `record.start requires at least one bound page in workspace: ${workspaceName}`,
                );
            }
            const primaryPage = binding.page;
            resetWorkspaceUnsavedRecording(services.recordingState, workspaceName, {
                entryTabRef: activeTab.name,
                activeTabRef: activeTab.name,
                entryUrl: primaryPage.url(),
                initialTabs: workspace.tabs.listTabs().map((tab) => ({
                    tabName: tab.name,
                    tabRef: tab.name,
                    url: tab.url,
                    title: tab.title,
                    active: tab.name === activeTab.name,
                })),
            });
            enterWorkspaceState(workspace, 'recording', action.type);
            enableWorkspaceRecording(services.recordingState, workspaceName);
            for (const tab of executableTabs) {
                if (!tab.page) {continue;}
                await ensureRecorder(services.recordingState, workspaceName, tab.page, tab.name, services.navDedupeWindowMs);
                await setRecorderRuntimeEnabled(tab.page, true);
            }
            return { reply: replyAction(action, { pageUrl: primaryPage.url() }), events: [] };
        }

        if (action.type === 'record.stop') {
            requireWorkspaceState(workspace, 'recording', action.type);
            const workspaceName = requireWorkspaceName(action, action.type);
            const tabs = workspace.tabs.listTabs();
            const firstBoundPage = tabs.find((tab) => Boolean(tab.page))?.page;
            disableWorkspaceRecording(services.recordingState, workspaceName);
            leaveWorkspaceState(workspace, 'recording', action.type);
            for (const tab of tabs) {
                if (!tab.page) {continue;}
                await setRecorderRuntimeEnabled(tab.page, false);
            }
            return { reply: replyAction(action, { pageUrl: firstBoundPage?.url() || '' }), events: [] };
        }

        if (action.type === 'record.get') {
            const workspaceName = requireWorkspaceName(action, action.type);
            const bundle = getWorkspaceUnsavedRecordingBundle(services.recordingState, workspaceName);
            return {
                reply: replyAction(action, {
                    steps: bundle.steps,
                    manifest: bundle.manifest,
                    enrichments: bundle.enrichments,
                    unsaved: { stepCount: bundle.steps.length },
                }),
                events: [],
            };
        }

        if (action.type === 'record.save') {
            requireWorkspaceState(workspace, 'idle', action.type);
            const workspaceName = requireWorkspaceName(action, action.type);
            const payload = (action.payload || {}) as { recordingName?: string; includeStepResolve?: boolean };
            const workflow = workspace.workflow;
            const bundle = getWorkspaceUnsavedRecordingBundle(services.recordingState, workspaceName);
            if (!bundle.steps.length) {
                throw new ActionError(ERROR_CODES.ERR_RECORDING_EMPTY, 'unsaved recording is empty');
            }
            const recordingName = (payload.recordingName || '').trim() || `recording-${Date.now()}`;
            const stepResolves: Record<string, StepResolve> = {};
            if (payload.includeStepResolve === true) {
                for (const step of bundle.steps) {
                    if (step.resolve) {
                        stepResolves[step.id] = step.resolve;
                    }
                }
            }
            if (!bundle.manifest?.activeTabRef) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'recording manifest missing activeTabRef');
            }
            const artifact: WorkflowRecording = {
                kind: 'recording',
                name: recordingName,
                recording: {
                    version: 1,
                    recordingName,
                    workspaceName,
                    activeTabRef: bundle.manifest.activeTabRef,
                    initialTabs: bundle.manifest.initialTabs || [],
                    entryUrl: bundle.manifest?.entryUrl,
                    tabs: (bundle.manifest?.tabs || []).map((item) => ({
                        tabName: item.tabName || item.tabRef,
                        url: item.lastSeenUrl || item.firstSeenUrl,
                    })),
                    createdAt: Date.now(),
                    stepCount: bundle.steps.length,
                },
                steps: bundle.steps,
                stepResolves,
            };
            workflow.save(artifact);
            return {
                reply: replyAction(action, { saved: true, recordingName, workspaceName, stepCount: bundle.steps.length }),
                events: [],
            };
        }

        if (action.type === 'record.load') {
            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, 'record.load is unsupported');
        }

        if (action.type === 'record.clear') {
            requireWorkspaceState(workspace, 'idle', action.type);
            const workspaceName = requireWorkspaceName(action, action.type);
            clearWorkspaceUnsavedRecording(services.recordingState, workspaceName);
            return { reply: replyAction(action, { cleared: true }), events: [] };
        }

        if (action.type === 'record.list') {
            const workspaceName = requireWorkspaceName(action, action.type);
            const unsaved = getWorkspaceUnsavedRecordingBundle(services.recordingState, workspaceName);
            const recordings = toSavedRecordingList(workspace);
            return { reply: replyAction(action, { recordings, unsaved: { stepCount: unsaved.steps.length } }), events: [] };
        }

        if (action.type === 'play.stop') {
            requireWorkspaceState(workspace, 'playing', action.type);
            const activeTab = workspace.tabs.getActiveTab();
            if (!activeTab) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'active tab not found');
            }
            cancelReplay(services.recordingState, activeTab.name);
            leaveWorkspaceState(workspace, 'playing', action.type);
            return { reply: replyAction(action, { stopped: true }), events: [] };
        }

        if (action.type === 'play.start') {
            requireWorkspaceState(workspace, 'idle', action.type);
            const payload = (action.payload || {}) as { stopOnError?: boolean; recordingName?: string };
            const currentTab = workspace.tabs.getActiveTab();
            if (!currentTab) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'active tab not found');
            }
            const currentWorkspaceName = workspace.name;
            const sourceRecordingName = (payload.recordingName || '').trim();
            const stopOnError = payload.stopOnError ?? true;

            const bundle = (() => {
                if (!sourceRecordingName) {
                    return getWorkspaceUnsavedRecordingBundle(services.recordingState, currentWorkspaceName);
                }
                const loaded = workspace.workflow.get(sourceRecordingName, RECORDING_DUMMY);
                if (!loaded || loaded.kind !== 'recording') {
                    throw new ActionError(ERROR_CODES.ERR_RECORDING_NOT_FOUND, `recording not found: ${sourceRecordingName}`);
                }
                if (!loaded.recording.activeTabRef) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `recording missing activeTabRef: ${sourceRecordingName}`);
                }
                if (!Array.isArray(loaded.recording.initialTabs)) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, `recording missing initialTabs: ${sourceRecordingName}`);
                }
                return {
                    recordingToken: `saved:${sourceRecordingName}`,
                    steps: loaded.steps,
                    manifest: {
                        recordingToken: `saved:${sourceRecordingName}`,
                        workspaceName: currentWorkspaceName,
                        activeTabRef: loaded.recording.activeTabRef,
                        entryUrl: loaded.recording.entryUrl,
                        initialTabs: loaded.recording.initialTabs,
                        startedAt: loaded.recording.createdAt || Date.now(),
                        tabs: loaded.recording.tabs.map((tab) => ({
                            tabName: tab.tabName,
                            tabRef: tab.tabName,
                            firstSeenUrl: tab.url,
                            lastSeenUrl: tab.url,
                            firstSeenAt: Date.now(),
                            lastSeenAt: Date.now(),
                        })),
                    },
                    enrichments: {},
                };
            })();

            if (!bundle.steps.length) {
                throw new ActionError(ERROR_CODES.ERR_RECORDING_EMPTY, 'recording is empty');
            }

            const replayWorkspaceName = currentWorkspaceName;
            const initialTabName = currentTab.name;
            const initialBinding = await services.runtime.ensureExecutableTab({
                workspace,
                pageRegistry: services.pageRegistry,
                tabName: initialTabName,
                urlHint: bundle.manifest?.entryUrl,
            });

            if (bundle.manifest?.entryUrl && initialBinding.page.url() !== bundle.manifest.entryUrl) {
                try {
                    await initialBinding.page.goto(bundle.manifest.entryUrl, { waitUntil: 'domcontentloaded' });
                } catch {}
            }

            enterWorkspaceState(workspace, 'playing', action.type);
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
                        steps: bundle.steps,
                        enrichments: bundle.enrichments,
                        recordingManifest: bundle.manifest,
                        stopOnError,
                        replayOptions: services.replayOptions,
                        workspace,
                        runtime: services.runtime,
                        pageRegistry: services.pageRegistry,
                        isCanceled: () => services.recordingState.replayCancel.has(currentTab.name),
                        onEvent: publishReplayEvent,
                    });
                    if (replayed.error?.code === 'ERR_CANCELED') {
                        logWarning(services.log, '[RPA:play]', 'replay canceled', {
                            workspaceName: replayWorkspaceName,
                            tabName: initialTabName,
                            reason: replayed.error?.message || 'canceled',
                        });
                        emitPlayEvent(ACTION_TYPES.PLAY_CANCELED, { workspaceName: replayWorkspaceName, tabName: initialTabName, results: replayed.results });
                        return;
                    }
                    if (!replayed.ok && stopOnError) {
                        const firstFailed = replayed.results.find((item) => !item.ok);
                        const failedStep = bundle.steps.find((step) => step.id === firstFailed?.stepId);
                        logError(services.log, '[RPA:play]', 'replay failed', {
                            workspaceName: replayWorkspaceName,
                            tabName: initialTabName,
                            stepId: firstFailed?.stepId,
                            stepName: failedStep?.name,
                            message: firstFailed?.error?.message || replayed.error?.message || 'replay failed',
                            error: firstFailed?.error || replayed.error,
                        });
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
                    const message = error instanceof Error ? error.message : String(error);
                    logError(services.log, '[RPA:play]', 'replay crashed', {
                        workspaceName: replayWorkspaceName,
                        tabName: initialTabName,
                        message,
                    });
                    emitPlayEvent(ACTION_TYPES.PLAY_FAILED, {
                        workspaceName: replayWorkspaceName,
                        tabName: initialTabName,
                        code: ERROR_CODES.ERR_BAD_ARGS,
                        message,
                    });
                } finally {
                    endReplay(services.recordingState, currentTab.name);
                    if (getWorkspaceState(workspace) === 'playing') {
                        leaveWorkspaceState(workspace, 'playing', action.type);
                    }
                }
            })();

            return {
                reply: replyAction(
                    action,
                    {
                        started: true,
                        workspaceName: replayWorkspaceName,
                        tabName: initialTabName,
                        stepCount: bundle.steps.length,
                        stopOnError,
                        source: sourceRecordingName || 'unsaved',
                    },
                    ACTION_TYPES.PLAY_STARTED,
                ),
                events: [],
            };
        }

        if (action.type === 'record.event') {
            const activeTab = workspace.tabs.getActiveTab();
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
