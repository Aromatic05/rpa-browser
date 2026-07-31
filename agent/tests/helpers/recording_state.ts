import {
    createRecordingState,
    type RecordingState,
} from '../../src/record/recording';
import type {RecordingSnapshotPort} from '../../src/record/pipeline/snapshot';

export const unavailableRecordingSnapshotPort = (): RecordingSnapshotPort => ({
    markDirty: () => undefined,
    ensureFresh: async () => {
        throw new Error('recording snapshot access is not configured for this test');
    },
});

export const createTestRecordingState = (): RecordingState => createRecordingState({
    snapshotPort: unavailableRecordingSnapshotPort(),
});
