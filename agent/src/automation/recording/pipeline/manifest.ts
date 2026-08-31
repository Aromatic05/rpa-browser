import type { StepUnion } from '../../runner/steps/types';
import type { RecordingEnhancementMap } from '../types';
import type { RecordingState } from './state';

export type RecordingTabManifest = {
    tabName: string;
    tabRef: string;
    firstSeenUrl?: string;
    lastSeenUrl?: string;
    firstSeenAt: number;
    lastSeenAt: number;
};

export type RecordingManifest = {
    recordingToken: string;
    workspaceName?: string;
    entryTabRef?: string;
    activeTabRef?: string;
    entryUrl?: string;
    initialTabs: Array<{
        tabName: string;
        tabRef: string;
        url: string;
        title: string;
        active: boolean;
    }>;
    startedAt: number;
    tabs: RecordingTabManifest[];
};

export type SavedRecordingTabManifest = {
    tabName: string;
    tabRef: string;
    firstSeenUrl?: string;
    lastSeenUrl?: string;
    firstSeenAt: number;
    lastSeenAt: number;
};
export type SavedRecordingManifest = Omit<RecordingManifest, 'tabs'> & {
    tabs: SavedRecordingTabManifest[];
};

export type WorkspaceSavedTab = {
    tabName: string;
    url: string;
    title: string;
    active: boolean;
};

export type WorkspaceSavedSnapshot = {
    workspaceName: string;
    savedAt: number;
    tabs: WorkspaceSavedTab[];
    recording: {
        recordingToken: string | null;
        manifest?: SavedRecordingManifest;
        steps: StepUnion[];
        enrichments?: RecordingEnhancementMap;
    };
};

export const ensureManifest = (
    recordingManifests: Map<string, RecordingManifest>,
    recordingToken: string,
    seed?: { workspaceName?: string; entryTabRef?: string; entryUrl?: string },
): RecordingManifest => {
    let manifest = recordingManifests.get(recordingToken);
    if (!manifest) {
        manifest = {
            recordingToken,
            workspaceName: seed?.workspaceName,
            entryTabRef: seed?.entryTabRef,
            initialTabs: [],
            entryUrl: seed?.entryUrl,
            startedAt: Date.now(),
            tabs: [],
        };
        recordingManifests.set(recordingToken, manifest);
        return manifest;
    }
    if (!manifest.workspaceName && seed?.workspaceName) {manifest.workspaceName = seed.workspaceName;}
    if (!manifest.entryTabRef && seed?.entryTabRef) {manifest.entryTabRef = seed.entryTabRef;}
    if (!manifest.entryUrl && seed?.entryUrl) {manifest.entryUrl = seed.entryUrl;}
    return manifest;
};

export const ensureTabInManifest = (
    manifest: RecordingManifest,
    tabName: string,
    seed?: { tabRef?: string; url?: string; at?: number },
): RecordingTabManifest => {
    const now = seed?.at || Date.now();
    let tab = manifest.tabs.find((item) => item.tabName === tabName);
    if (!tab) {
        tab = {
            tabName,
            tabRef: seed?.tabRef || tabName,
            firstSeenUrl: seed?.url,
            lastSeenUrl: seed?.url,
            firstSeenAt: now,
            lastSeenAt: now,
        };
        manifest.tabs.push(tab);
        return tab;
    }
    if (!tab.tabRef && seed?.tabRef) {tab.tabRef = seed.tabRef;}
    if (seed?.url) {
        if (!tab.firstSeenUrl) {tab.firstSeenUrl = seed.url;}
        tab.lastSeenUrl = seed.url;
    }
    tab.lastSeenAt = now;
    return tab;
};

export const attachTabToRecordingManifest = (
    state: RecordingState,
    workspaceName: string,
    tabName: string,
    seed?: { tabRef?: string; url?: string; at?: number },
): void => {
    const recordingToken = state.workspaceUnsavedRecording.get(workspaceName) || `unsaved:${workspaceName}`;
    const manifest = ensureManifest(state.recordingManifests, recordingToken, { workspaceName });
    ensureTabInManifest(manifest, tabName, seed);
};

const sanitizeSavedManifest = (manifest?: RecordingManifest): SavedRecordingManifest | undefined => {
    if (!manifest) {return undefined;}
    return {
        ...manifest,
        tabs: manifest.tabs.map((tab) => ({
            tabRef: tab.tabRef,
            tabName: tab.tabName,
            firstSeenUrl: tab.firstSeenUrl,
            lastSeenUrl: tab.lastSeenUrl,
            firstSeenAt: tab.firstSeenAt,
            lastSeenAt: tab.lastSeenAt,
        })),
    };
};

const sanitizeSavedStep = (step: StepUnion): StepUnion => {
    if (!step.meta) {return { ...step };}
    return {
        ...step,
        meta: { ...step.meta },
    };
};

export const saveWorkspaceSnapshot = (
    workspaceSnapshots: Map<string, WorkspaceSavedSnapshot>,
    payload: {
        workspaceName: string;
        tabs: WorkspaceSavedTab[];
        recordingToken: string | null;
        steps: StepUnion[];
        manifest?: RecordingManifest;
        enrichments?: RecordingEnhancementMap;
    },
): WorkspaceSavedSnapshot => {
    const snapshot: WorkspaceSavedSnapshot = {
        workspaceName: payload.workspaceName,
        savedAt: Date.now(),
        tabs: payload.tabs.map((tab) => ({
            tabName: tab.tabName,
            url: tab.url,
            title: tab.title,
            active: tab.active,
        })),
        recording: {
            recordingToken: payload.recordingToken,
            manifest: sanitizeSavedManifest(payload.manifest),
            steps: payload.steps.map(sanitizeSavedStep),
            enrichments: payload.enrichments,
        },
    };
    workspaceSnapshots.set(payload.workspaceName, snapshot);
    return snapshot;
};

export const getWorkspaceSnapshot = (workspaceSnapshots: Map<string, WorkspaceSavedSnapshot>, workspaceName: string): WorkspaceSavedSnapshot | undefined => {
    return workspaceSnapshots.get(workspaceName);
};

export type WorkspaceRecordingSummary = {
    workspaceName: string;
    recordingToken: string;
    stepCount: number;
    entryUrl?: string;
    startedAt: number;
    updatedAt: number;
};

export const listWorkspaceRecordings = (workspaceSnapshots: Map<string, WorkspaceSavedSnapshot>): WorkspaceRecordingSummary[] => {
    const summaries: WorkspaceRecordingSummary[] = [];
    for (const snapshot of workspaceSnapshots.values()) {
        summaries.push({
            workspaceName: snapshot.workspaceName,
            recordingToken: snapshot.recording.recordingToken || snapshot.workspaceName,
            stepCount: snapshot.recording.steps.length,
            entryUrl: snapshot.recording.manifest?.entryUrl,
            startedAt: snapshot.recording.manifest?.startedAt || snapshot.savedAt,
            updatedAt: snapshot.savedAt,
        });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
};
