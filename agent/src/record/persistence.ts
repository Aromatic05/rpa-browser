import fs from 'node:fs/promises';
import path from 'node:path';
import type { RecordingManifest, RecordingState, WorkspaceSavedSnapshot } from './recording';
import type { StepUnion } from '../runner/steps/types';

type PersistedRecordingBundle = {
    recordingToken: string;
    steps: StepUnion[];
    manifest?: RecordingManifest;
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

const hydrateState = (state: RecordingState, persisted: PersistedRecordingStateV1) => {
    state.recordings.clear();
    state.recordingManifests.clear();
    state.workspaceLatestRecording.clear();
    state.workspaceSnapshots.clear();

    for (const bundle of persisted.bundles) {
        state.recordings.set(bundle.recordingToken, Array.isArray(bundle.steps) ? bundle.steps : []);
        if (bundle.manifest) {
            state.recordingManifests.set(bundle.recordingToken, bundle.manifest);
        }
    }

    for (const [workspaceId, recordingToken] of Object.entries(persisted.workspaceLatestRecording || {})) {
        if (typeof workspaceId === 'string' && typeof recordingToken === 'string' && recordingToken.length > 0) {
            state.workspaceLatestRecording.set(workspaceId, recordingToken);
        }
    }

    for (const [workspaceId, snapshot] of Object.entries(persisted.workspaceSnapshots || {})) {
        if (!workspaceId || !snapshot || typeof snapshot !== 'object') continue;
        state.workspaceSnapshots.set(workspaceId, snapshot);
    }
};

export const loadRecordingStateFromFile = async (state: RecordingState, filePath: string) => {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedRecordingStateV1;
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.bundles)) {
            return false;
        }
        hydrateState(state, parsed);
        return true;
    } catch {
        return false;
    }
};

export const saveRecordingStateToFile = async (state: RecordingState, filePath: string) => {
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
) => {
    const intervalMs = opts?.intervalMs && opts.intervalMs > 0 ? Math.floor(opts.intervalMs) : 1500;
    let lastSnapshot = '';
    let writing = false;

    const flushIfChanged = async () => {
        if (writing) return;
        const snapshot = JSON.stringify(toPersistedState(state));
        if (snapshot === lastSnapshot) return;
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
    timer.unref?.();

    return {
        flush: flushIfChanged,
        stop: () => clearInterval(timer),
    };
};
