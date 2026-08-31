import crypto from 'node:crypto';
import { replyAction, type Action } from '../../interface/actions/action_protocol';
import { ActionError } from '../../interface/actions/results';
import { ACTION_TYPES } from '../../interface/actions/action_types';
import { ERROR_CODES } from '../../interface/actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import { acquireWorkspaceExecution, enterWorkspaceState, getWorkspaceState, leaveWorkspaceState, requireWorkspaceState } from '../runtime/workspace/workspace';
import {
    awaitRecordingEnhancements,
    awaitWorkspaceRecordingEvents,
    beginReplay,
    cancelReplay,
    clearCheckpointRecording,
    clearWorkspaceUnsavedRecording,
    enableWorkspaceRecording,
    finishCheckpointRecording,
    flushWorkspacePendingRecordEvents,
    endReplay,
    ensureRecorder,
    getCheckpointRecordingSession,
    getRecordingBundle,
    getWorkspaceUnsavedRecordingBundle,
    isWorkspaceRecordingEnabled,
    normalizeRecordingStepOrder,
    resetWorkspaceUnsavedRecording,
    startCheckpointRecording,
    stopAcceptingWorkspaceRecordingEvents,
    trackWorkspaceRecordingEvent,
    type RecordingState,
} from './recording';
import { setRecorderRuntimeEnabled, type RecorderEvent } from './capture/recorder';
import { ingestRecordPayload } from './pipeline/input';
import {disableWorkspaceRecording as disableWorkspaceRecordingState} from './pipeline/state';
import { replayRecording, type ReplayEvent, type ReplayOptions } from './replay';
import type { StepResolve, StepUnion } from '../runner/steps/types';
import type { WorkflowDummy, WorkflowRecording } from '../workflow';
import {
    buildRecordedCheckpoint,
    checkpointEntityRuleOptions,
    checkpointStepSummary,
    requireCheckpointEntityRuleOption,
} from './checkpoint_recording';
import { persistRecordedStep } from './checkpoint/common';
import type { ExecutionBindings } from '../runtime/execution/bindings';
import type { PageRegistry } from '../runtime/browser/page_registry';
import type { Logger } from '../../platform/logging/logger';
import { getLogger } from '../../platform/logging/logger';

const RECORDING_DUMMY: WorkflowDummy = { kind: 'recording' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export type RecordControlServices = {
    recordingState: RecordingState;
    replayOptions: ReplayOptions;
    navDedupeWindowMs: number;
    runtime: ExecutionBindings;
    pageRegistry: PageRegistry;
    emit?: (action: Action) => void;
    log: Logger | ((...args: unknown[]) => void);
};

const logWarning = (log: RecordControlServices['log'], ...args: unknown[]): void => {
    if ('warning' in log && typeof log.warning === 'function') {
        log.warning(...args);
        return;
    }
    log(...args);
};

const logError = (log: RecordControlServices['log'], ...args: unknown[]): void => {
    if ('error' in log && typeof log.error === 'function') {
        log.error(...args);
        return;
    }
    log(...args);
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
            const steps = loaded?.kind === 'recording' ? loaded.steps : [];
            return { recordingName: item.name, stepCount: steps.length };
        });

const listExecutableTabs = (workspace: WorkspaceRouterInput['workspace']) =>
    workspace.tabs.listTabs().filter((tab) => Boolean(tab.page) && !tab.page?.isClosed());

const setRecorderRuntimeForTabs = async (
    tabs: ReturnType<typeof listExecutableTabs>,
    enabled: boolean,
): Promise<void> => {
    await Promise.allSettled(tabs.map(async (tab) => {
        if (!tab.page || tab.page.isClosed()) {return;}
        await setRecorderRuntimeEnabled(tab.page, enabled);
    }));
};

const quiesceRecordingCapture = async (
    services: RecordControlServices,
    workspace: WorkspaceRouterInput['workspace'],
    actionType: string,
): Promise<{pageUrl: string}> => {
    const activeTab = workspace.tabs.getActiveTab();
    const tabs = listExecutableTabs(workspace);
    stopAcceptingWorkspaceRecordingEvents(services.recordingState, workspace.name);
    await setRecorderRuntimeForTabs(tabs, false);
    await awaitWorkspaceRecordingEvents(services.recordingState, workspace.name);
    try {
        flushWorkspacePendingRecordEvents(
            services.recordingState,
            workspace.name,
            activeTab?.name || '',
            activeTab?.page || undefined,
        );
    } catch (error) {
        logWarning(services.log, 'record.stop.flush_failed', {
            workspaceName: workspace.name,
            message: error instanceof Error ? error.message : String(error),
        });
    }
    disableWorkspaceRecordingState(services.recordingState, workspace.name);
    await awaitRecordingEnhancements(services.recordingState, workspace.name);
    leaveWorkspaceState(workspace, 'recording', actionType);
    return {pageUrl: activeTab?.page?.url() || ''};
};

const startRecordingCapture = async (
    services: RecordControlServices,
    workspace: WorkspaceRouterInput['workspace'],
    actionType: string,
): Promise<{pageUrl: string}> => {
    const tabs = listExecutableTabs(workspace);
    enterWorkspaceState(workspace, 'recording', actionType);
    enableWorkspaceRecording(services.recordingState, workspace.name);
    try {
        for (const tab of tabs) {
            if (!tab.page) {continue;}
            await ensureRecorder(services.recordingState, workspace.name, tab.page, tab.name, services.navDedupeWindowMs);
            await setRecorderRuntimeEnabled(tab.page, true);
        }
    } catch (error) {
        await quiesceRecordingCapture(services, workspace, actionType);
        throw error;
    }
    return {pageUrl: workspace.tabs.getActiveTab()?.page?.url() || ''};
};

const stopRecordingCapture = async (
    services: RecordControlServices,
    workspace: WorkspaceRouterInput['workspace'],
    actionType: string,
): Promise<{pageUrl: string}> => {
    return await quiesceRecordingCapture(services, workspace, actionType);
};

export const createRecordControl = (services: RecordControlServices): RecordControl => {
    let activeReplay: {tabName: string; completion: Promise<void>; owner: symbol} | null = null;
    return {
    handle: async (input) => {
        const { action, workspace } = input;

        if (action.type === 'checkpoint.record.start') {
            requireWorkspaceState(workspace, 'idle', action.type);
            const workspaceName = requireWorkspaceName(action, action.type);
            if (getCheckpointRecordingSession(services.recordingState, workspaceName)) {
                throw new ActionError(ERROR_CODES.ERR_BAD_STATE, '已有检查点录制等待保存或取消');
            }
            const activeTab = workspace.tabs.getActiveTab();
            if (!activeTab) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'active tab not found');}
            const checkpointPayload = isRecord(action.payload) ? action.payload : {};
            const requestedKind = checkpointPayload.kind === 'recovery' ? 'recovery' : 'procedure';
            let binding!: Awaited<ReturnType<ExecutionBindings['awaitExecutableTab']>>;
            let entityOption!: ReturnType<typeof requireCheckpointEntityRuleOption>;
            const releaseStartupExecution = acquireWorkspaceExecution(workspace, action.type);
            try {
                binding = await services.runtime.awaitExecutableTab({
                    workspace,
                    pageRegistry: services.pageRegistry,
                    tabName: activeTab.name,
                    timeoutMs: 1500,
                });
                entityOption = requireCheckpointEntityRuleOption(
                    workspace,
                    binding.page.url(),
                    checkpointPayload,
                );
                if (!listExecutableTabs(workspace).length) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, '当前没有可录制的页面');
                }
            } finally {
                releaseStartupExecution();
            }
            startCheckpointRecording(services.recordingState, workspaceName, {
                entryTabRef: activeTab.name,
                activeTabRef: activeTab.name,
                entryUrl: binding.page.url(),
                initialTabs: workspace.tabs.listTabs().map((tab) => ({
                    tabName: tab.name,
                    tabRef: tab.name,
                    url: tab.url,
                    title: tab.title,
                    active: tab.name === activeTab.name,
                })),
                kind: requestedKind,
                profileName: entityOption.profileName,
                businessTag: entityOption.businessTag,
                entityKind: entityOption.entityKind,
            });
            try {
                const started = await startRecordingCapture(services, workspace, action.type);
                return {
                    reply: replyAction(action, {
                        status: 'recording',
                        stepCount: 0,
                        pageUrl: started.pageUrl,
                        kind: requestedKind,
                        entityRule: entityOption,
                    }),
                    events: [],
                };
            } catch (error) {
                clearCheckpointRecording(services.recordingState, workspaceName);
                throw error;
            }
        }

        if (action.type === 'checkpoint.record.stop') {
            requireWorkspaceState(workspace, 'recording', action.type);
            const workspaceName = requireWorkspaceName(action, action.type);
            const session = getCheckpointRecordingSession(services.recordingState, workspaceName);
            if (session?.status !== 'recording') {
                throw new ActionError(ERROR_CODES.ERR_BAD_STATE, '没有正在录制的检查点');
            }
            await stopRecordingCapture(services, workspace, action.type);
            const recordedBundle = getRecordingBundle(services.recordingState, session.token);
            const ordered = normalizeRecordingStepOrder(
                recordedBundle.steps,
                services.navDedupeWindowMs,
            );
            services.recordingState.recordings.set(session.token, ordered);
            finishCheckpointRecording(services.recordingState, workspaceName);
            return {
                reply: replyAction(action, {
                    status: 'review',
                    stepCount: ordered.length,
                    steps: checkpointStepSummary(ordered, recordedBundle.enrichments),
                    entityRules: checkpointEntityRuleOptions(workspace, recordedBundle.manifest?.entryUrl || workspace.tabs.getActiveTab()?.page?.url() || ''),
                    kind: session.kind,
                    entityRule: session.profileName ? {
                        profileName: session.profileName,
                        businessTag: session.businessTag,
                        entityKind: session.entityKind,
                    } : null,
                }),
                events: [],
            };
        }

        if (action.type === 'checkpoint.record.get') {
            const workspaceName = requireWorkspaceName(action, action.type);
            const session = getCheckpointRecordingSession(services.recordingState, workspaceName);
            if (!session) {
                const pageUrl = workspace.tabs.getActiveTab()?.page?.url() || '';
                return {reply: replyAction(action, {
                    status: 'idle',
                    stepCount: 0,
                    steps: [],
                    entityRules: checkpointEntityRuleOptions(workspace, pageUrl),
                }), events: []};
            }
            const bundle = getRecordingBundle(services.recordingState, session.token);
            return {
                reply: replyAction(action, {
                    status: session.status,
                    stepCount: bundle.steps.length,
                    steps: checkpointStepSummary(bundle.steps, bundle.enrichments),
                    entityRules: checkpointEntityRuleOptions(workspace, bundle.manifest?.entryUrl || ''),
                    kind: session.kind,
                    entityRule: session.profileName ? {
                        profileName: session.profileName,
                        businessTag: session.businessTag,
                        entityKind: session.entityKind,
                    } : null,
                }),
                events: [],
            };
        }

        if (action.type === 'checkpoint.record.cancel') {
            const workspaceName = requireWorkspaceName(action, action.type);
            const session = getCheckpointRecordingSession(services.recordingState, workspaceName);
            if (!session) {
                return {reply: replyAction(action, {canceled: true}), events: []};
            }
            if (session.status === 'recording') {
                requireWorkspaceState(workspace, 'recording', action.type);
                await stopRecordingCapture(services, workspace, action.type);
                finishCheckpointRecording(services.recordingState, workspaceName);
            }
            clearCheckpointRecording(services.recordingState, workspaceName);
            return {reply: replyAction(action, {canceled: true}), events: []};
        }

        if (action.type === 'checkpoint.record.save') {
            requireWorkspaceState(workspace, 'idle', action.type);
            const workspaceName = requireWorkspaceName(action, action.type);
            const session = getCheckpointRecordingSession(services.recordingState, workspaceName);
            if (session?.status !== 'review') {
                throw new ActionError(ERROR_CODES.ERR_BAD_STATE, '请先完成检查点录制');
            }
            const bundle = getRecordingBundle(services.recordingState, session.token);
            const artifact = buildRecordedCheckpoint(
                workspace,
                bundle.steps,
                bundle.enrichments,
                {
                    ...(action.payload || {}),
                    kind: session.kind,
                    profileName: session.profileName,
                    businessTag: session.businessTag,
                    entityKind: session.entityKind,
                },
            );
            const saved = workspace.workflow.save(artifact);
            if (saved.kind !== 'checkpoint') {
                throw new ActionError(ERROR_CODES.ERR_INTERNAL, '保存检查点失败');
            }
            clearCheckpointRecording(services.recordingState, workspaceName);
            return {
                reply: replyAction(action, {
                    saved: true,
                    checkpointId: saved.name,
                    name: saved.checkpoint.name,
                    stepCount: bundle.steps.length,
                }),
                events: [],
            };
        }

        if (action.type === 'record.start') {
            requireWorkspaceState(workspace, 'idle', action.type);
            const workspaceName = requireWorkspaceName(action, action.type);
            const activeTab = workspace.tabs.getActiveTab();
            if (!activeTab) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'active tab not found');}
            let binding!: Awaited<ReturnType<ExecutionBindings['awaitExecutableTab']>>;
            const releaseStartupExecution = acquireWorkspaceExecution(workspace, action.type);
            try {
                binding = await services.runtime.awaitExecutableTab({
                    workspace,
                    pageRegistry: services.pageRegistry,
                    tabName: activeTab.name,
                    timeoutMs: 1500,
                });
                if (!listExecutableTabs(workspace).length) {
                    throw new ActionError(
                        ERROR_CODES.ERR_BAD_ARGS,
                        `record.start requires at least one bound page in workspace: ${workspaceName}`,
                    );
                }
            } finally {
                releaseStartupExecution();
            }
            resetWorkspaceUnsavedRecording(services.recordingState, workspaceName, {
                entryTabRef: activeTab.name,
                activeTabRef: activeTab.name,
                entryUrl: binding.page.url(),
                initialTabs: workspace.tabs.listTabs().map((tab) => ({
                    tabName: tab.name,
                    tabRef: tab.name,
                    url: tab.url,
                    title: tab.title,
                    active: tab.name === activeTab.name,
                })),
            });
            const started = await startRecordingCapture(services, workspace, action.type);
            return {reply: replyAction(action, {pageUrl: started.pageUrl}), events: []};
        }

        if (action.type === 'record.stop') {
            requireWorkspaceState(workspace, 'recording', action.type);
            requireWorkspaceName(action, action.type);
            const stopped = await stopRecordingCapture(services, workspace, action.type);
            return {reply: replyAction(action, {pageUrl: stopped.pageUrl}), events: []};
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
            const recordLog = getLogger('record');
            const token = services.recordingState.workspaceUnsavedRecording.get(workspaceName) || `unsaved:${workspaceName}`;
            const activeTabName = workspace.tabs.getActiveTab()?.name || '';
            flushWorkspacePendingRecordEvents(services.recordingState, workspaceName, activeTabName);
            const pendingCount = services.recordingState.pendingEnhancements.get(token)?.size || 0;
            recordLog('save_wait_enrichment', { workspaceName, pendingCount });
            await awaitRecordingEnhancements(services.recordingState, workspaceName);
            const bundle = getWorkspaceUnsavedRecordingBundle(services.recordingState, workspaceName);
            if (!bundle.steps.length) {
                throw new ActionError(ERROR_CODES.ERR_RECORDING_EMPTY, 'unsaved recording is empty');
            }
            const recordingName = (payload.recordingName || '').trim() || `recording-${Date.now()}`;
            const orderedSteps = normalizeRecordingStepOrder(bundle.steps, services.navDedupeWindowMs);
            services.recordingState.recordings.set(token, orderedSteps);
            const stepResolves: Record<string, StepResolve> = {};
            const persistedSteps = payload.includeStepResolve === true
                ? orderedSteps.map((step, index) => persistRecordedStep(step, index, bundle.enrichments, stepResolves))
                : orderedSteps.map((step, index) => persistRecordedStep(step, index, {}, stepResolves));
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
                    initialTabs: bundle.manifest.initialTabs,
                    entryUrl: bundle.manifest.entryUrl,
                    tabs: bundle.manifest.tabs.map((item) => ({
                        tabName: item.tabName,
                        url: item.lastSeenUrl || item.firstSeenUrl,
                    })),
                    createdAt: Date.now(),
                    stepCount: orderedSteps.length,
                },
                steps: persistedSteps,
                stepResolves,
            };
            workflow.save(artifact);
            return {
                reply: replyAction(action, { saved: true, recordingName, workspaceName, stepCount: orderedSteps.length }),
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
            const replay = activeReplay;
            if (!replay) {
                throw new ActionError(ERROR_CODES.ERR_BAD_STATE, 'playback session is not active');
            }
            cancelReplay(services.recordingState, replay.tabName);
            await replay.completion;
            if (getWorkspaceState(workspace) === 'playing') {
                leaveWorkspaceState(workspace, 'playing', action.type);
            }
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

            const bundle: ReturnType<typeof getWorkspaceUnsavedRecordingBundle> & { stepResolves?: Record<string, StepResolve> } = (() => {
                if (!sourceRecordingName) {
                    return { ...getWorkspaceUnsavedRecordingBundle(services.recordingState, currentWorkspaceName), stepResolves: {} };
                }
                const loaded = workspace.workflow.get(sourceRecordingName, RECORDING_DUMMY);
                if (loaded?.kind !== 'recording') {
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
                    stepResolves: loaded.stepResolves,
                };
            })();

            if (!bundle.steps.length) {
                throw new ActionError(ERROR_CODES.ERR_RECORDING_EMPTY, 'recording is empty');
            }

            const replayWorkspaceName = currentWorkspaceName;
            const initialTabName = currentTab.name;
            const releaseStartupExecution = acquireWorkspaceExecution(workspace, action.type);
            try {
                const initialBinding = await services.runtime.awaitExecutableTab({
                    workspace,
                    pageRegistry: services.pageRegistry,
                    tabName: initialTabName,
                    timeoutMs: 1500,
                });

                if (bundle.manifest?.entryUrl && initialBinding.page.url() !== bundle.manifest.entryUrl) {
                    try {
                        await initialBinding.page.goto(bundle.manifest.entryUrl, { waitUntil: 'domcontentloaded' });
                    } catch {
                        // Replay continues from the current page when entry navigation fails.
                    }
                }
            } finally {
                releaseStartupExecution();
            }

            enterWorkspaceState(workspace, 'playing', action.type);
            beginReplay(services.recordingState, initialTabName);
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

            const replayOwner = Symbol(`play:${replayWorkspaceName}:${initialTabName}`);
            const replayTask = (async () => {
                try {
                    const replayed = await replayRecording({
                        workspaceName: replayWorkspaceName,
                        initialTabName,
                        steps: bundle.steps,
                        enrichments: bundle.enrichments,
                        stepResolves: bundle.stepResolves,
                        recordingManifest: bundle.manifest,
                        stopOnError,
                        replayOptions: services.replayOptions,
                        workspace,
                        runtime: services.runtime,
                        pageRegistry: services.pageRegistry,
                        isCanceled: () => services.recordingState.replayCancel.has(initialTabName),
                        onEvent: publishReplayEvent,
                    });
                    if (replayed.error?.code === 'ERR_CANCELED') {
                        logWarning(services.log, '[RPA:play]', 'replay canceled', {
                            workspaceName: replayWorkspaceName,
                            tabName: initialTabName,
                            reason: replayed.error.message || 'canceled',
                        });
                        emitPlayEvent(ACTION_TYPES.PLAY_CANCELED, { workspaceName: replayWorkspaceName, tabName: initialTabName, results: replayed.results });
                        return;
                    }
                    if (!replayed.ok && stopOnError) {
                        const firstFailed = replayed.results.find((item) => !item.ok);
                        const failedStep = bundle.steps.find((step) => step.id === firstFailed?.stepId);
                        const failureDetails = isRecord(firstFailed?.error?.details)
                            ? firstFailed.error.details
                            : {};
                        logError(services.log, '[RPA:play]', 'replay failed', {
                            workspaceName: replayWorkspaceName,
                            tabName: initialTabName,
                            stepId: firstFailed?.stepId,
                            stepName: failedStep?.name,
                            confidence: failureDetails.confidence,
                            chosenPath: failureDetails.chosenPath,
                            failedPath: failureDetails.failedPath,
                            failedReason: failureDetails.failedReason,
                            finalSelector: failureDetails.finalSelector,
                            snapshotRequired: failureDetails.snapshotRequired,
                            snapshotRefreshed: failureDetails.snapshotRefreshed,
                            snapshotRefreshReason: failureDetails.snapshotRefreshReason,
                            snapshotId: failureDetails.snapshotId,
                            snapshotUrl: failureDetails.snapshotUrl,
                            attempts: failureDetails.attempts,
                            warnings: failureDetails.warnings,
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
                    endReplay(services.recordingState, initialTabName);
                    if (activeReplay?.owner === replayOwner) {
                        activeReplay = null;
                    }
                    if (getWorkspaceState(workspace) === 'playing') {
                        leaveWorkspaceState(workspace, 'playing', action.type);
                    }
                }
            })();
            activeReplay = {tabName: initialTabName, completion: replayTask, owner: replayOwner};
            void replayTask;

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
            return await trackWorkspaceRecordingEvent(services.recordingState, workspace.name, async () => {
            const recordLog = getLogger('record');
            const activeTab = workspace.tabs.getActiveTab();
            const fallbackTabName = activeTab?.name || '';
            if (!fallbackTabName) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'active tab not found');
            }
            const payload = action.payload as StepUnion | RecorderEvent | undefined;
            if (!payload) {
                throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'missing record.event payload');
            }
            const sourceTabName = typeof (payload as RecorderEvent).tabName === 'string'
                ? ((payload as RecorderEvent).tabName || '').trim()
                : '';
            const sourceTab = sourceTabName ? workspace.tabs.getTab(sourceTabName) : null;
            const targetTab = sourceTab || activeTab;
            const tabName = targetTab?.name || fallbackTabName;
            let page = targetTab?.page || null;
            if (isWorkspaceRecordingEnabled(services.recordingState, workspace.name) && !page) {
                try {
                    const binding = await services.runtime.awaitExecutableTab({
                        workspace,
                        pageRegistry: services.pageRegistry,
                        tabName,
                        timeoutMs: 1500,
                    });
                    page = binding.page;
                } catch (error) {
                    recordLog('record_event_ensure_page_failed', {
                        workspaceName: workspace.name,
                        tabName,
                        sourceTabName,
                        message: error instanceof Error ? error.message : String(error),
                        details: error && typeof error === 'object' && 'details' in error ? (error as { details?: unknown }).details : undefined,
                    });
                }
            }
            recordLog('record_event_context', {
                workspaceName: workspace.name,
                fallbackTabName,
                sourceTabName,
                resolvedTabName: tabName,
                hasPage: Boolean(page),
                activeHasPage: Boolean(activeTab?.page),
                sourceHasPage: Boolean(sourceTab?.page),
            });
            const result = await ingestRecordPayload({
                state: services.recordingState,
                payload,
                page,
                tabName,
                currentUrl: activeTab?.url,
                workspaceName: workspace.name,
                navDedupeWindowMs: services.navDedupeWindowMs,
            });
            return { reply: replyAction(action, { accepted: result.accepted, mode: result.mode }), events: [] };
            });
        }

        throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
    },
    };
};
