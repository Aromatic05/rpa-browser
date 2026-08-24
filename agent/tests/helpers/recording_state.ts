import {
    createRecordingState,
    type RecordingState,
} from '../../src/automation/recording/recording';
import type {RecordingSnapshotPort} from '../../src/automation/recording/pipeline/snapshot';

export const unavailableRecordingSnapshotPort = (): RecordingSnapshotPort => ({
    markDirty: () => undefined,
    ensureFresh: async () => {
        throw new Error('recording snapshot access is not configured for this test');
    },
});

export const createTestRecordingState = (): RecordingState => createRecordingState({
    snapshotPort: unavailableRecordingSnapshotPort(),
});
