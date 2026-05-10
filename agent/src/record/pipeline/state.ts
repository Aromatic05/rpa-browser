import type { RecorderEvent } from '../capture/recorder';
import type { RecordSnapshotCacheEntry } from '../enhancement/build';
import type { RecordingEnhancementMap } from '../types';
import type { RecordingManifest, WorkspaceSavedSnapshot } from './manifest';
import { flushPendingFillEvents } from './pending';
import type { StepResolve } from '../../runner/steps/types';

export type PendingCheckboxGroupSession = {
    kind: 'checkbox_group';
    sessionKey: string;
    controlRootNodeId: string;
    controlRef: string;
    workspaceName: string;
    tabName: string;
    selector?: string;
    resolve?: StepResolve;
    values: string[];
    lastEvent: RecorderEvent;
    ts: number;
};

export type PendingCustomSelectSession = {
    kind: 'custom_select';
    sessionKey: string;
    controlRootNodeId: string;
    controlRef: string;
    workspaceName: string;
    tabName: string;
    selector?: string;
    resolve?: StepResolve;
    triggerEvent: RecorderEvent;
    ts: number;
};

export type PendingChoiceSession = PendingCheckboxGroupSession | PendingCustomSelectSession;

export type RecordingState = {
    recordingEnabled: Set<string>;
    recordings: Map<string, import('../../runner/steps/types').StepUnion[]>;
    recordingEnhancements: Map<string, RecordingEnhancementMap>;
    recordingManifests: Map<string, RecordingManifest>;
    workspaceUnsavedRecording: Map<string, string>;
    workspaceSnapshots: Map<string, WorkspaceSavedSnapshot>;
    lastNavigateTs: Map<string, number>;
    lastClickTs: Map<string, number>;
    lastScrollY: Map<string, number>;
    recordSnapshotCache: Map<string, RecordSnapshotCacheEntry>;
    pendingEnhancements: Map<string, Set<Promise<void>>>;
    replaying: Set<string>;
    replayCancel: Set<string>;
    pendingFillEvents: Map<string, Map<string, { event: RecorderEvent; tabName: string }>>;
    pendingChoiceEvents: Map<string, Map<string, PendingChoiceSession>>;
};

export const createRecordingState = (): RecordingState => ({
    recordingEnabled: new Set(),
    recordings: new Map(),
    recordingEnhancements: new Map(),
    recordingManifests: new Map(),
    workspaceUnsavedRecording: new Map(),
    workspaceSnapshots: new Map(),
    lastNavigateTs: new Map(),
    lastClickTs: new Map(),
    lastScrollY: new Map(),
    recordSnapshotCache: new Map(),
    pendingEnhancements: new Map(),
    replaying: new Set(),
    replayCancel: new Set(),
    pendingFillEvents: new Map(),
    pendingChoiceEvents: new Map(),
});

const unsavedRecordingToken = (workspaceName: string): string => `unsaved:${workspaceName}`;

export const getWorkspaceUnsavedToken = (state: RecordingState, workspaceName: string): string =>
    state.workspaceUnsavedRecording.get(workspaceName) || unsavedRecordingToken(workspaceName);

export const resetWorkspaceUnsavedRecording = (
    state: RecordingState,
    workspaceName: string,
    seed?: {
        entryTabRef?: string;
        activeTabRef?: string;
        entryUrl?: string;
        initialTabs?: RecordingManifest['initialTabs'];
    },
): string => {
    const token = unsavedRecordingToken(workspaceName);
    state.workspaceUnsavedRecording.set(workspaceName, token);
    state.recordings.set(token, []);
    state.recordingEnhancements.delete(token);
    state.recordingManifests.set(token, {
        recordingToken: token,
        workspaceName,
        entryTabRef: seed?.entryTabRef,
        activeTabRef: seed?.activeTabRef,
        entryUrl: seed?.entryUrl,
        initialTabs: seed?.initialTabs || [],
        startedAt: Date.now(),
        tabs: [],
    });
    state.lastNavigateTs.set(token, 0);
    state.lastClickTs.set(token, 0);
    state.lastScrollY.set(token, 0);
    state.recordSnapshotCache.delete(token);
    state.pendingEnhancements.delete(token);
    state.pendingFillEvents.delete(token);
    state.pendingChoiceEvents.delete(token);
    return token;
};

export const isWorkspaceRecordingEnabled = (
    state: RecordingState,
    workspaceName: string,
): boolean => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    return state.recordingEnabled.has(token);
};

export const enableWorkspaceRecording = (state: RecordingState, workspaceName: string): void => {
    state.recordingEnabled.add(getWorkspaceUnsavedToken(state, workspaceName));
};

export const disableWorkspaceRecording = (state: RecordingState, workspaceName: string): void => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    flushPendingFillEvents(state, token);
    state.pendingChoiceEvents.delete(token);
    state.recordingEnabled.delete(token);
};

export const clearWorkspaceUnsavedRecording = (state: RecordingState, workspaceName: string): void => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    state.workspaceUnsavedRecording.set(workspaceName, token);
    state.recordings.set(token, []);
    state.recordingEnhancements.delete(token);
    state.recordingManifests.delete(token);
    state.lastNavigateTs.set(token, 0);
    state.lastClickTs.set(token, 0);
    state.lastScrollY.set(token, 0);
    state.recordSnapshotCache.delete(token);
    state.pendingEnhancements.delete(token);
    state.pendingFillEvents.delete(token);
    state.pendingChoiceEvents.delete(token);
};

export const getWorkspaceUnsavedRecordingBundle = (
    state: RecordingState,
    workspaceName: string,
): {
    recordingToken: string;
    steps: import('../../runner/steps/types').StepUnion[];
    manifest: RecordingManifest | undefined;
    enrichments: RecordingEnhancementMap;
} => {
    const token = state.workspaceUnsavedRecording.get(workspaceName) || unsavedRecordingToken(workspaceName);
    return {
        recordingToken: token,
        steps: state.recordings.get(token) || [],
        manifest: state.recordingManifests.get(token),
        enrichments: state.recordingEnhancements.get(token) || {},
    };
};

export const cleanupRecording = (state: RecordingState, tabName: string): void => {
    state.replaying.delete(tabName);
    state.replayCancel.delete(tabName);
};
