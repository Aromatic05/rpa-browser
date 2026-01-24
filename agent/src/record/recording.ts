import type { Page } from 'playwright';
import { installRecorder, type RecordedEvent } from './recorder';

export type RecordingState = {
    recordingEnabled: Set<string>;
    recordings: Map<string, RecordedEvent[]>;
    lastNavigateTs: Map<string, number>;
    lastClickTs: Map<string, number>;
    replaying: Set<string>;
    replayCancel: Set<string>;
};

export const createRecordingState = (): RecordingState => ({
    recordingEnabled: new Set(),
    recordings: new Map(),
    lastNavigateTs: new Map(),
    lastClickTs: new Map(),
    replaying: new Set(),
    replayCancel: new Set(),
});

export const recordEvent = (
    state: RecordingState,
    event: RecordedEvent,
    navDedupeWindowMs: number,
) => {
    const tabToken = event.tabToken;
    if (!tabToken || !state.recordingEnabled.has(tabToken)) return;
    if (state.replaying.has(tabToken)) return;

    if (event.type === 'click') {
        state.lastClickTs.set(tabToken, event.ts);
    }

    if (event.type === 'navigate') {
        const last = state.lastNavigateTs.get(tabToken) || 0;
        if (event.ts - last < navDedupeWindowMs) {
            return;
        }
        state.lastNavigateTs.set(tabToken, event.ts);
    }

    if (event.value && event.value !== '***') {
        const value = event.value.trim();
        if (value.length > 200) {
            event.value = '***';
        } else if (value.length > 80) {
            event.value = value.slice(0, 80);
        } else {
            event.value = value;
        }
    }

    const list = state.recordings.get(tabToken) || [];
    list.push(event);
    state.recordings.set(tabToken, list);
    console.log('[RPA:agent]', 'record', {
        tabToken,
        type: event.type,
        url: event.url,
        selector: event.selector,
    });
};

const navListenerPages = new WeakSet<Page>();

export const installNavigationRecorder = (
    state: RecordingState,
    page: Page,
    tabToken: string,
    navDedupeWindowMs: number,
) => {
    if (navListenerPages.has(page)) return;
    navListenerPages.add(page);
    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        if (!state.recordingEnabled.has(tabToken)) return;
        const lastClick = state.lastClickTs.get(tabToken) || 0;
        const source = Date.now() - lastClick < navDedupeWindowMs ? 'click' : 'direct';
        recordEvent(
            state,
            {
                tabToken,
                ts: Date.now(),
                type: 'navigate',
                url: frame.url(),
                source,
            },
            navDedupeWindowMs,
        );
    });
};

export const ensureRecorder = async (
    state: RecordingState,
    page: Page,
    tabToken: string,
    navDedupeWindowMs: number,
) => {
    await installRecorder(page, (event) => recordEvent(state, event, navDedupeWindowMs));
    installNavigationRecorder(state, page, tabToken, navDedupeWindowMs);
};

export const startRecording = async (
    state: RecordingState,
    page: Page,
    tabToken: string,
    navDedupeWindowMs: number,
) => {
    state.recordingEnabled.add(tabToken);
    if (!state.recordings.has(tabToken)) {
        state.recordings.set(tabToken, []);
    }
    state.lastNavigateTs.set(tabToken, 0);
    state.lastClickTs.set(tabToken, 0);
    await ensureRecorder(state, page, tabToken, navDedupeWindowMs);
};

export const stopRecording = (state: RecordingState, tabToken: string) => {
    state.recordingEnabled.delete(tabToken);
    state.lastNavigateTs.delete(tabToken);
    state.lastClickTs.delete(tabToken);
};

export const beginReplay = (state: RecordingState, tabToken: string) => {
    state.replaying.add(tabToken);
    state.replayCancel.delete(tabToken);
};

export const endReplay = (state: RecordingState, tabToken: string) => {
    state.replaying.delete(tabToken);
    state.replayCancel.delete(tabToken);
};

export const cancelReplay = (state: RecordingState, tabToken: string) => {
    state.replayCancel.add(tabToken);
};

export const getRecording = (state: RecordingState, tabToken: string) =>
    state.recordings.get(tabToken) || [];

export const clearRecording = (state: RecordingState, tabToken: string) => {
    state.recordings.set(tabToken, []);
};

export const cleanupRecording = (state: RecordingState, tabToken: string) => {
    state.recordingEnabled.delete(tabToken);
    state.recordings.delete(tabToken);
    state.lastNavigateTs.delete(tabToken);
    state.lastClickTs.delete(tabToken);
    state.replaying.delete(tabToken);
    state.replayCancel.delete(tabToken);
};
