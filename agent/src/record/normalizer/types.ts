import type { Page } from 'playwright';
import type { RecorderEvent } from '../capture/recorder';
import type { RecordSnapshotCacheEntry } from '../pipeline/snapshot';
import type { RecordingState } from '../pipeline/state';
import type { SnapshotResult } from '../../runner/steps/executors/snapshot/core/types';
import type {
    Step,
    StepArgsMap,
    StepMeta,
    StepName,
    StepResolve,
    StepUnion,
} from '../../runner/steps/types';

export type NormalizeContext = {
    state: RecordingState;
    recordingToken: string;
    workspaceName: string;
    tabName: string;
    page?: Page;
    snapshotCache: Map<string, RecordSnapshotCacheEntry>;
    cacheKey: string;
    createStep: <TName extends StepName>(
        name: TName,
        args: StepArgsMap[TName],
        ts: number,
        metaExtra?: Partial<Pick<StepMeta, 'workspaceName' | 'tabName' | 'urlAtRecord'>>,
        resolve?: StepResolve,
    ) => Step<TName>;
    buildResolveFromEvent: (event: RecorderEvent) => StepResolve | undefined;
};

export type NormalizePassResult = {
    status: 'pass';
};

export type NormalizeHandledResult = {
    status: 'handled';
    step: StepUnion;
    enhancementEvent: RecorderEvent;
    continueCurrentEvent?: boolean;
};

export type NormalizePendingResult = {
    status: 'pending';
};

export type RecordNormalizerResult =
    | NormalizePassResult
    | NormalizeHandledResult
    | NormalizePendingResult;

export type NormalizeSnapshotResult = SnapshotResult | undefined;
