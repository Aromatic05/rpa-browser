import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSelectOption} from '../../../src/record/normalizer/select_option';
import type {NormalizeContext} from '../../../src/record/normalizer/types';
import {createTestRecordingState} from '../../helpers/recording_state';
import type {RecorderEvent} from '../../../src/record/capture/recorder';

const triggerEvent: RecorderEvent = {
    tabName: 'tab-1',
    ts: 1,
    type: 'click',
    selector: '#status-trigger',
    a11yHint: {role: 'combobox', name: 'Status'},
};

const optionEvent: RecorderEvent = {
    tabName: 'tab-1',
    ts: 2,
    type: 'click',
    selector: '#open-option',
    a11yHint: {role: 'option', name: 'Open', text: 'Open'},
};

test('one recorder event resolves its canonical snapshot at most once', async () => {
    const state = createTestRecordingState();
    state.pendingChoiceEvents.set('recording-1', new Map([[
        'pending-select',
        {
            kind: 'custom_select',
            source: 'bound_trigger',
            sessionKey: 'pending-select',
            controlRootNodeId: 'control:status',
            controlRef: 'control:status',
            workspaceName: 'ws-1',
            tabName: 'tab-1',
            selector: '#status-trigger',
            triggerEvent,
            ts: 1,
        },
    ]]));
    let snapshotResolutionCount = 0;
    const resolveSnapshot = async () => {
        snapshotResolutionCount += 1;
        return undefined;
    };
        const context: NormalizeContext = {
            state,
            recordingToken: 'recording-1',
            workspaceName: 'ws-1',
            tabName: 'tab-1',
            createStep: ((name, args, ts, metaExtra, resolve) => ({
                id: `step-${ts}`,
                name,
                args,
                resolve,
                meta: {source: 'record', ts, ...metaExtra},
            })) as NormalizeContext['createStep'],
            buildResolveFromEvent: () => undefined,
            resolveSnapshot,
        };
        const result = await normalizeSelectOption(context, optionEvent);
        assert.equal(result.status, 'handled');
        assert.equal(snapshotResolutionCount, 1);
});
