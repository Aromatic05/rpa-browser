import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRunnerConfig } from '../../src/config/loader';
import { initLogger } from '../../src/logging/logger';
import { resolveRecordSnapshotForEvent } from '../../src/record/pipeline/snapshot';
import {
    appendWorkspaceRecordingEvent,
    awaitRecordingEnhancements,
    createRecordingState,
    enableWorkspaceRecording,
    resetWorkspaceUnsavedRecording,
    setRecordedStepEnricherForTest,
} from '../../src/record/recording';

test('resolveRecordSnapshotForEvent logs missing_page and capture_failed diagnostics', async () => {
    const config = loadRunnerConfig({ configPath: '__non_exist__.json' });
    config.observability.recordConsoleEnabled = true;
    config.observability.recordFileEnabled = false;
    config.observability.consoleLogLevel = 'info';
    initLogger(config);

    const logs: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        logs.push(args);
    };

    try {
        await resolveRecordSnapshotForEvent({
            event: { tabName: 'tab-a', ts: 1, type: 'click', selector: '#a' },
            page: undefined,
            snapshotCache: new Map(),
            cacheKey: 'unsaved:ws-1::tab-a',
        });

        await resolveRecordSnapshotForEvent({
            event: { tabName: 'tab-a', ts: 2, type: 'click', selector: '#a' },
            page: {} as any,
            snapshotCache: new Map(),
            cacheKey: 'unsaved:ws-1::tab-a',
        });
    } finally {
        console.warn = originalWarn;
    }

    const payloads = logs
        .filter((entry) => entry[1] === 'record_snapshot_resolve')
        .map((entry) => entry[2] as Record<string, unknown>);

    const missingPage = payloads.find((item) => item.reason === 'missing_page');
    assert.ok(missingPage);
    assert.equal(missingPage.result, 'failed');

    const captureFailed = payloads.find((item) => item.reason === 'capture_failed');
    assert.ok(captureFailed);
    assert.equal(captureFailed.result, 'failed');
    assert.equal(typeof captureFailed.errorName, 'string');
    assert.equal(typeof captureFailed.errorMessage, 'string');
});

test('appendWorkspaceRecordingEvent passes tab-scoped snapshot cache key into enrichment', async () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');

    const cacheKeys: string[] = [];
    setRecordedStepEnricherForTest(async ({ cacheKey, event }) => {
        cacheKeys.push(cacheKey);
        return { version: 1, eventType: event.type };
    });

    try {
        await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
            tabName: 'tab-a',
            ts: 100,
            type: 'click',
            selector: '#a',
        }, 1200);
        await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-b', {
            tabName: 'tab-b',
            ts: 200,
            type: 'click',
            selector: '#b',
        }, 1200);
        await awaitRecordingEnhancements(state, 'ws-1');
    } finally {
        setRecordedStepEnricherForTest(null);
    }

    assert.equal(cacheKeys.length >= 2, true);
    assert.equal(cacheKeys.includes('unsaved:ws-1::tab-a'), true);
    assert.equal(cacheKeys.includes('unsaved:ws-1::tab-b'), true);
});
