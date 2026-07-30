import type {Page} from 'playwright';
import {getLogger} from '../../logging/logger';
import type {RunStepsDeps} from '../../runner/run_steps_types';
import {ensurePageSessionForPage} from '../../runner/session/capture';
import type {PageSnapshotCapture} from '../../snapshot';
import type {StepEntityRulesControl} from '../../snapshot/rules/model';
import type {RecorderEvent} from '../capture/recorder';
import type {RecordingState} from './state';

export type RecordPageSnapshot = PageSnapshotCapture;

export type RecordingSnapshotPort = {
    markDirty: (page: Page, reason: 'interaction') => void;
    ensureFresh: (input: {
        workspaceName: string;
        page: Page;
        explicit?: boolean;
        entityRules?: StepEntityRulesControl;
    }) => Promise<RecordPageSnapshot>;
};

export const createRecordingSnapshotPort = (deps: RunStepsDeps): RecordingSnapshotPort => ({
    markDirty: (page, reason) => {
        deps.pageSession.markDirty(page, reason);
    },
    ensureFresh: async (input) => (
        await ensurePageSessionForPage(deps, input.workspaceName, input.page, {
            explicit: input.explicit,
            entityRules: input.entityRules,
        })
    ).capture,
});

const isPageLevelEvent = (event: RecorderEvent): boolean => event.type === 'navigate' || event.type === 'scroll';

const shouldUseSnapshotForEvent = (event: RecorderEvent): boolean => {
    if (isPageLevelEvent(event) || event.type === 'copy') {return false;}
    return true;
};

export const recordSnapshotId = (snapshot: RecordPageSnapshot): string => {
    const identity = snapshot.control.observation.identity;
    return `${identity.pageEpoch}:${identity.captureRevision}`;
};

export const resolveRecordSnapshotForEvent = async (input: {
    state: RecordingState;
    workspaceName: string;
    event: RecorderEvent;
    page?: Page;
}): Promise<RecordPageSnapshot | undefined> => {
    const recordLog = getLogger('record');
    const {event, page, state, workspaceName} = input;
    if (!shouldUseSnapshotForEvent(event)) {
        recordLog('record_snapshot_resolve', {
            result: 'skipped',
            eventType: event.type,
            selector: event.selector,
            workspaceName,
        });
        return undefined;
    }
    if (!page) {
        recordLog('record_snapshot_resolve', {
            result: 'failed',
            eventType: event.type,
            selector: event.selector,
            workspaceName,
            reason: 'missing_page',
        });
        return undefined;
    }
    try {
        const session = state.checkpointRecordings.get(workspaceName);
        const entityRules = session?.profileName
            ? {selection: 'explicit' as const, profiles: [session.profileName], strict: true}
            : undefined;
        const snapshot = await state.snapshotPort.ensureFresh({
            workspaceName,
            page,
            explicit: Boolean(entityRules),
            entityRules,
        });
        recordLog('record_snapshot_resolve', {
            result: 'page_session',
            eventType: event.type,
            selector: event.selector,
            workspaceName,
            snapshotId: recordSnapshotId(snapshot),
            pageUrl: safePageUrl(page),
        });
        return snapshot;
    } catch (error) {
        recordLog('record_snapshot_resolve', {
            result: 'failed',
            eventType: event.type,
            selector: event.selector,
            workspaceName,
            pageUrl: safePageUrl(page),
            reason: 'page_session_failed',
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
};

const safePageUrl = (page: Page): string => {
    try {
        return page.url();
    } catch {
        return '';
    }
};
