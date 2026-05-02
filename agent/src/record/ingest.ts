import type { Page } from 'playwright';
import { recordEvent, type RecordingState } from './recording';
import type { RecorderEvent } from './recorder';

export type RecorderIngestResult = {
    accepted: boolean;
    reason?: 'recording_not_enabled';
};

const resolveEnabledToken = (state: RecordingState, tabName: string): string | null => {
    if (state.recordingEnabled.has(tabName)) {
        return tabName;
    }
    if (state.recordingEnabled.size === 1) {
        return Array.from(state.recordingEnabled)[0];
    }
    return null;
};

export const ingestRecorderEvent = async (input: {
    state: RecordingState;
    event: RecorderEvent;
    page: Page;
    tabName: string;
    navDedupeWindowMs: number;
}): Promise<RecorderIngestResult> => {
    const effectiveToken = resolveEnabledToken(input.state, input.tabName);
    if (!effectiveToken) {
        return { accepted: false, reason: 'recording_not_enabled' };
    }

    const event = effectiveToken === input.tabName ? input.event : { ...input.event, tabName: effectiveToken };
    await recordEvent(input.state, event, input.navDedupeWindowMs, input.page);
    return { accepted: true };
};
