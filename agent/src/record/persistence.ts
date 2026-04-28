import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { RecordingManifest, RecordingState, WorkspaceSavedSnapshot } from './recording';
import type { StepUnion } from '../runner/steps/types';
import type { RecordingEnhancementMap } from './types';
import type { StepFile, StepResolveFile } from '../runner/serialization/types';

type PersistedRecordingBundle = {
    recordingToken: string;
    steps: StepUnion[];
    manifest?: RecordingManifest;
    enrichments?: RecordingEnhancementMap;
};

type PersistedRecordingStateV1 = {
    version: 1;
    savedAt: number;
    bundles: PersistedRecordingBundle[];
    workspaceLatestRecording: Record<string, string>;
    workspaceSnapshots: Record<string, WorkspaceSavedSnapshot>;
};

const toPersistedState = (state: RecordingState): PersistedRecordingStateV1 => {
    const bundles: PersistedRecordingBundle[] = [];
    for (const [recordingToken, steps] of state.recordings.entries()) {
        bundles.push({
            recordingToken,
            steps,
            manifest: state.recordingManifests.get(recordingToken),
            enrichments: state.recordingEnhancements.get(recordingToken) || {},
        });
    }
    return {
        version: 1,
        savedAt: Date.now(),
        bundles,
        workspaceLatestRecording: Object.fromEntries(state.workspaceLatestRecording.entries()),
        workspaceSnapshots: Object.fromEntries(state.workspaceSnapshots.entries()),
    };
};

const hydrateState = (state: RecordingState, persisted: PersistedRecordingStateV1): void => {
    state.recordings.clear();
    state.recordingEnhancements.clear();
    state.recordingManifests.clear();
    state.workspaceLatestRecording.clear();
    state.workspaceSnapshots.clear();

    for (const bundle of persisted.bundles) {
        state.recordings.set(bundle.recordingToken, Array.isArray(bundle.steps) ? bundle.steps : []);
        state.recordingEnhancements.set(bundle.recordingToken, bundle.enrichments || {});
        if (bundle.manifest) {
            state.recordingManifests.set(bundle.recordingToken, bundle.manifest);
        }
    }

    for (const [workspaceId, recordingToken] of Object.entries(persisted.workspaceLatestRecording)) {
        if (
            typeof workspaceId === 'string' &&
            typeof recordingToken === 'string' &&
            recordingToken.length > 0 &&
            state.recordings.has(recordingToken)
        ) {
            state.workspaceLatestRecording.set(workspaceId, recordingToken);
        }
    }

    for (const [workspaceId, snapshot] of Object.entries(persisted.workspaceSnapshots)) {
        if (!workspaceId || typeof snapshot !== 'object') {continue;}
        if (!Array.isArray(snapshot.tabs)) {continue;}
        if (!Array.isArray(snapshot.recording.steps)) {continue;}
        state.workspaceSnapshots.set(workspaceId, snapshot);
    }
};

export const loadRecordingStateFromFile = async (state: RecordingState, filePath: string): Promise<boolean> => {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (
            !parsed ||
            typeof parsed !== 'object' ||
            !('bundles' in parsed) ||
            !Array.isArray((parsed as { bundles?: unknown }).bundles)
        ) {
            return false;
        }
        hydrateState(state, parsed as PersistedRecordingStateV1);
        return true;
    } catch {
        return false;
    }
};

export const saveRecordingStateToFile = async (state: RecordingState, filePath: string): Promise<void> => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    const body = JSON.stringify(toPersistedState(state), null, 2);
    await fs.writeFile(tmpPath, body, 'utf8');
    await fs.rename(tmpPath, filePath);
};

export const startRecordingStateAutoSave = (
    state: RecordingState,
    filePath: string,
    opts?: { intervalMs?: number; onError?: (error: unknown) => void },
) : { flush: () => Promise<void>; stop: () => void } => {
    const intervalMs = opts?.intervalMs && opts.intervalMs > 0 ? Math.floor(opts.intervalMs) : 1500;
    let lastSnapshot = '';
    let writing = false;

    const flushIfChanged = async () => {
        if (writing) {return;}
        const snapshot = JSON.stringify(toPersistedState(state));
        if (snapshot === lastSnapshot) {return;}
        writing = true;
        try {
            await saveRecordingStateToFile(state, filePath);
            lastSnapshot = snapshot;
        } catch (error) {
            opts?.onError?.(error);
        } finally {
            writing = false;
        }
    };

    const timer = setInterval(() => {
        void flushIfChanged();
    }, intervalMs);
    timer.unref();

    return {
        flush: flushIfChanged,
        stop: () => { clearInterval(timer); },
    };
};

export type SaveWorkflowRecordingArtifactsOptions = {
    rootDir: string;
    scene: string;
    recordingName: string;
    workspaceId?: string;
    entryUrl?: string;
    tabs?: Array<{ tabId: string; url?: string }>;
    steps: StepUnion[];
    stepResolves?: Record<string, unknown>;
};

const toRecordingManifestFile = (opts: SaveWorkflowRecordingArtifactsOptions) => ({
    version: 1,
    recordingName: opts.recordingName,
    workspaceId: opts.workspaceId || '',
    entryUrl: opts.entryUrl || '',
    tabs: opts.tabs || [],
    createdAt: Date.now(),
    stepCount: opts.steps.length,
});

export const saveWorkflowRecordingArtifacts = async (opts: SaveWorkflowRecordingArtifactsOptions): Promise<string> => {
    const recordsDir = path.resolve(opts.rootDir, 'workflows', opts.scene, 'records', opts.recordingName);
    await fs.mkdir(recordsDir, { recursive: true });

    const stepsFile: StepFile = {
        version: 1,
        steps: opts.steps.map((step) => ({
            id: step.id,
            name: step.name,
            args: step.args,
        })) as StepFile['steps'],
    };
    const resolvesFile: StepResolveFile = {
        version: 1,
        resolves: (opts.stepResolves || {}) as StepResolveFile['resolves'],
    };
    await fs.writeFile(path.join(recordsDir, 'steps.yaml'), YAML.stringify(stepsFile), 'utf8');
    await fs.writeFile(path.join(recordsDir, 'step_resolve.yaml'), YAML.stringify(resolvesFile), 'utf8');
    await fs.writeFile(path.join(recordsDir, 'manifest.yaml'), YAML.stringify(toRecordingManifestFile(opts)), 'utf8');
    return recordsDir;
};

export const resolveWorkflowRecordingDir = async (
    rootDir: string,
    scene: string,
    recordingName: string,
): Promise<string> => {
    const recordsDir = path.resolve(rootDir, 'workflows', scene, 'records', recordingName);
    try {
        const stat = await fs.stat(recordsDir);
        if (stat.isDirectory()) {
            return recordsDir;
        }
    } catch {}

    const legacyDir = path.resolve(rootDir, 'workflows', scene, 'steps', recordingName);
    try {
        const stat = await fs.stat(legacyDir);
        if (stat.isDirectory()) {
            return legacyDir;
        }
    } catch {}

    throw new Error(`workflow recording not found: scene=${scene} recording=${recordingName}`);
};
