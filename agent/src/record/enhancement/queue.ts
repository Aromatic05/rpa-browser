import type { Page } from 'playwright';
import { getLogger } from '../../logging/logger';
import type { StepName } from '../../runner/steps/types';
import { enrichRecordedStepWithSnapshot, type RecordSnapshotCacheEntry } from './build';
import type { RecorderEvent } from '../capture/recorder';
import type { RecordingState } from '../pipeline/state';
import type { RecordedStepEnhancement, RecordingEnhancementMap } from '../types';

type RecordedStepEnricher = typeof enrichRecordedStepWithSnapshot;
let recordedStepEnricher: RecordedStepEnricher = enrichRecordedStepWithSnapshot;

export const setRecordedStepEnricherForTest = (enricher: RecordedStepEnricher | null): void => {
    recordedStepEnricher = enricher || enrichRecordedStepWithSnapshot;
};

export const setStepEnhancement = (
    state: RecordingState,
    recordingToken: string,
    stepId: string,
    enhancement: RecordedStepEnhancement,
) => {
    const current = state.recordingEnhancements.get(recordingToken) || {};
    current[stepId] = enhancement;
    state.recordingEnhancements.set(recordingToken, current);
};

export const getRecordingEnhancements = (state: RecordingState, recordingToken: string): RecordingEnhancementMap => {
    return state.recordingEnhancements.get(recordingToken) || {};
};

const getPendingEnhancementSet = (state: RecordingState, recordingToken: string): Set<Promise<void>> => {
    let set = state.pendingEnhancements.get(recordingToken);
    if (!set) {
        set = new Set();
        state.pendingEnhancements.set(recordingToken, set);
    }
    return set;
};

type StartRecordedStepEnrichmentInput = {
    state: RecordingState;
    recordingToken: string;
    stepId: string;
    event: RecorderEvent;
    page?: Page;
    snapshotCache: Map<string, RecordSnapshotCacheEntry>;
    cacheKey: string;
    workspaceName: string;
    stepName: StepName;
    ts?: number;
    tabName?: string;
};

export const startRecordedStepEnrichment = (input: StartRecordedStepEnrichmentInput): void => {
    const recordLog = getLogger('record');
    const pending = getPendingEnhancementSet(input.state, input.recordingToken);
    const promise = (async () => {
        const enriched = await recordedStepEnricher({
            event: input.event,
            page: input.page,
            snapshotCache: input.snapshotCache,
            cacheKey: input.cacheKey,
        });
        setStepEnhancement(input.state, input.recordingToken, input.stepId, enriched);
        recordLog('enrichment_done', {
            stepId: input.stepId,
            stepName: input.stepName,
            ts: input.ts,
            tabName: input.tabName,
            workspaceName: input.workspaceName,
        });
    })()
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            recordLog('enrichment_failed', {
                stepId: input.stepId,
                stepName: input.stepName,
                ts: input.ts,
                tabName: input.tabName,
                workspaceName: input.workspaceName,
                message,
            });
        })
        .finally(() => {
            pending.delete(promise);
            if (!pending.size) {
                input.state.pendingEnhancements.delete(input.recordingToken);
            }
        });
    pending.add(promise);
};

export const awaitRecordingEnhancements = async (
    state: RecordingState,
    workspaceName: string,
    getWorkspaceUnsavedToken: (state: RecordingState, workspaceName: string) => string,
): Promise<void> => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    const pending = state.pendingEnhancements.get(token);
    if (!pending || !pending.size) {return;}
    await Promise.allSettled(Array.from(pending));
};
