import type { RecorderEvent } from '../capture/recorder';
import type { StepUnion } from '../../runner/steps/types';

export type RecordNormalizerInput = {
    event: RecorderEvent;
    tabName: string;
    workspaceName: string;
};

export type RecordNormalizerResult = {
    step: StepUnion | null;
};
