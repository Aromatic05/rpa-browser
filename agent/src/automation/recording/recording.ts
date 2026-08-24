import type { Page } from 'playwright';
import { installRecorder, type RecorderEvent } from './capture/recorder';
import type { StepName } from '../runner/steps/types';
import {
    appendWorkspaceRecordingEvent,
    appendWorkspaceRecordingStep,
    buildResolveFromEvent,
    createStep,
    enrichRecordedStep,
    toStep,
} from './pipeline/step';
import {
    cleanupRecording,
    clearCheckpointRecording,
    clearWorkspaceUnsavedRecording,
    createRecordingState,
    disableWorkspaceRecording as disableWorkspaceRecordingState,
    enableWorkspaceRecording,
    finishCheckpointRecording,
    getCheckpointRecordingSession,
    getRecordingBundle,
    getWorkspaceUnsavedRecordingBundle,
    getWorkspaceUnsavedToken,
    isWorkspaceRecordingEnabled,
    awaitWorkspaceRecordingEvents,
    resetWorkspaceUnsavedRecording,
    startCheckpointRecording,
    stopAcceptingWorkspaceRecordingEvents,
    trackWorkspaceRecordingEvent,
    type RecordingState,
} from './pipeline/state';
import {
    attachTabToRecordingManifest,
    getWorkspaceSnapshot,
    listWorkspaceRecordings,
    saveWorkspaceSnapshot,
    type RecordingManifest,
    type RecordingTabManifest,
    type SavedRecordingManifest,
    type SavedRecordingTabManifest,
    type WorkspaceRecordingSummary,
    type WorkspaceSavedSnapshot,
    type WorkspaceSavedTab,
} from './pipeline/manifest';
import { normalizeRecordingStepOrder } from './pipeline/order';
import { beginReplay, cancelReplay, endReplay } from './pipeline/replay_state';
import { awaitRecordingEnhancements as awaitEnhancementsInternal, awaitRecordingEnhancementsForToken, getRecordingEnhancements, setRecordedStepEnricherForTest, startRecordedStepEnrichment } from './enhancement/queue';
import { flushPendingFillEvents } from './pipeline/pending';
import { flushPendingChoiceEvents } from './pipeline/pending';

export type {
    RecordingManifest,
    RecordingTabManifest,
    SavedRecordingManifest,
    SavedRecordingTabManifest,
    WorkspaceSavedTab,
    WorkspaceSavedSnapshot,
    WorkspaceRecordingSummary,
    RecordingState,
};

type RecorderEventSink = (event: RecorderEvent, page: Page, tabName: string) => void | Promise<void>;
let recorderEventSink: RecorderEventSink | null = null;

export const setRecorderEventSink = (sink: RecorderEventSink | null): void => {
    recorderEventSink = sink;
};

export const awaitRecordingEnhancements = async (
    state: RecordingState,
    workspaceName: string,
): Promise<void> => {
    await awaitEnhancementsInternal(state, workspaceName, getWorkspaceUnsavedToken);
};

const flushWorkspacePendingRecordEvents = (
    state: RecordingState,
    workspaceName: string,
    tabName: string,
    page?: Page,
): void => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    const hooks = {
        toStep,
        enrichRecordedStep,
        startRecordedStepEnrichment: (input: {
            state: RecordingState;
            recordingToken: string;
            stepId: string;
            event: RecorderEvent;
            page?: Page;
            workspaceName: string;
            stepName: StepName;
            ts?: number;
            tabName?: string;
        }) => { startRecordedStepEnrichment(input); },
    };
    flushPendingChoiceEvents(state, token, {
        state,
        recordingToken: token,
        workspaceName,
        tabName,
        page,
        createStep,
        buildResolveFromEvent,
    }, hooks, { workspaceName, page, reason: 'save' });
    flushPendingFillEvents(state, token, undefined, hooks);
};

export const disableWorkspaceRecording = (state: RecordingState, workspaceName: string): void => {
    flushWorkspacePendingRecordEvents(state, workspaceName, '', undefined);
    disableWorkspaceRecordingState(state, workspaceName);
};

const navListenerPages = new WeakSet<Page>();
const lastMainFrameUrls = new WeakMap<Page, string>();
const isOrdinaryPageUrl = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://');

export const installNavigationRecorder = (
    state: RecordingState,
    workspaceName: string,
    page: Page,
    tabName: string,
    navDedupeWindowMs: number,
): void => {
    if (navListenerPages.has(page)) {return;}
    navListenerPages.add(page);
    lastMainFrameUrls.set(page, page.url());
    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) {return;}
        const url = frame.url();
        const previousUrl = lastMainFrameUrls.get(page) || '';
        lastMainFrameUrls.set(page, url);
        if (!isOrdinaryPageUrl(url)) {return;}
        if (!isWorkspaceRecordingEnabled(state, workspaceName)) {return;}
        if (previousUrl === url) {
            appendWorkspaceRecordingStep(
                state,
                workspaceName,
                tabName,
                {
                    id: crypto.randomUUID(),
                    name: 'browser.reload',
                    args: {},
                    meta: {
                        source: 'record',
                        ts: Date.now(),
                        workspaceName,
                        tabName,
                        urlAtRecord: url,
                    },
                },
                navDedupeWindowMs,
            );
            return;
        }
        const event: RecorderEvent = {
            recorderVersion: 'payload-v2',
            tabName,
            ts: Date.now(),
            url,
            pageTitle: '',
            viewport: undefined,
            type: 'navigate',
        };
        void appendWorkspaceRecordingEvent(state, workspaceName, tabName, event, navDedupeWindowMs, page);
    });
};

export const ensureRecorder = async (
    state: RecordingState,
    workspaceName: string,
    page: Page,
    tabName: string,
    navDedupeWindowMs: number,
): Promise<void> => {
    await installRecorder(page, tabName, (event) => {
        if (recorderEventSink) {
            return recorderEventSink(event, page, tabName);
        }
        void appendWorkspaceRecordingEvent(state, workspaceName, tabName, event, navDedupeWindowMs, page);
    });
    installNavigationRecorder(state, workspaceName, page, tabName, navDedupeWindowMs);
};

export {
    appendWorkspaceRecordingEvent,
    appendWorkspaceRecordingStep,
    attachTabToRecordingManifest,
    beginReplay,
    buildResolveFromEvent,
    cancelReplay,
    cleanupRecording,
    clearCheckpointRecording,
    clearWorkspaceUnsavedRecording,
    createRecordingState,
    createStep,
    enableWorkspaceRecording,
    endReplay,
    enrichRecordedStep,
    finishCheckpointRecording,
    flushWorkspacePendingRecordEvents,
    getCheckpointRecordingSession,
    getRecordingBundle,
    getRecordingEnhancements,
    getWorkspaceSnapshot,
    getWorkspaceUnsavedRecordingBundle,
    getWorkspaceUnsavedToken,
    isWorkspaceRecordingEnabled,
    awaitWorkspaceRecordingEvents,
    listWorkspaceRecordings,
    normalizeRecordingStepOrder,
    resetWorkspaceUnsavedRecording,
    saveWorkspaceSnapshot,
    startCheckpointRecording,
    stopAcceptingWorkspaceRecordingEvents,
    trackWorkspaceRecordingEvent,
    setRecordedStepEnricherForTest,
    startRecordedStepEnrichment,
    awaitRecordingEnhancementsForToken,
    toStep,
};
