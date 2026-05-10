import type { RecordingState } from './state';

export const beginReplay = (state: RecordingState, tabName: string): void => {
    state.replaying.add(tabName);
    state.replayCancel.delete(tabName);
};

export const endReplay = (state: RecordingState, tabName: string): void => {
    state.replaying.delete(tabName);
    state.replayCancel.delete(tabName);
};

export const cancelReplay = (state: RecordingState, tabName: string): void => {
    state.replayCancel.add(tabName);
};
