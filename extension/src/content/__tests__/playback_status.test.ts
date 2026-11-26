import test from 'node:test';
import assert from 'node:assert/strict';
import type {Action} from '../../shared/types.js';
import {updatePlaybackStatus} from '../playback_status.js';

const event = (type: string, replayId: string, payload: Record<string, unknown> = {}): Action =>
    ({v: 1, id: type, type, payload: {replayId, ...payload}});

test('late start acknowledgement preserves terminal state and old events do not overwrite the next run', () => {
    const failed = updatePlaybackStatus(undefined, event('play.failed', 'a', {
        details: {failed: {code: 'ERR_REPLAY_TAB_NOT_BOUND'}},
        failedStep: {index: 1, name: 'browser.click'},
    }));
    const late = updatePlaybackStatus(failed, event('play.started', 'a', {stepCount: 3}));
    assert.equal(late?.phase, 'failed');
    assert.equal(late?.total, 3);
    assert.equal(late?.failure?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
    assert.deepEqual(late?.failure?.step, {index: 1, name: 'browser.click'});
    const next = updatePlaybackStatus(late, event('play.started', 'b', {stepCount: 2}));
    assert.equal(next?.phase, 'running');
    assert.equal(next?.failure, undefined);
    assert.equal(updatePlaybackStatus(next, event('play.failed', 'a')), next);

    const initializing = updatePlaybackStatus(next, event('play.progress', 'c', {completed: 0, total: 1}));
    const setupFailed = updatePlaybackStatus(initializing, event('play.failed', 'c', {code: 'ERR_REPLAY_TAB_INIT_FAILED'}));
    const setupAcknowledged = updatePlaybackStatus(setupFailed, event('play.started', 'c', {stepCount: 1}));
    assert.equal(setupAcknowledged?.phase, 'failed');
    assert.equal(setupAcknowledged?.failure?.code, 'ERR_REPLAY_TAB_INIT_FAILED');
});

test('completed playback retains failed steps and start errors do not overwrite an active run', () => {
    const running = updatePlaybackStatus(undefined, event('play.started', 'a', {stepCount: 3}));
    const refusal: Action = {v: 1, id: 'busy', type: 'play.start.failed', payload: {code: 'ERR_BAD_STATE'}};
    assert.equal(updatePlaybackStatus(running, refusal, 'play.start'), running);
    assert.equal(updatePlaybackStatus(undefined, refusal, 'play.start')?.phase, 'start-failed');
    const step = updatePlaybackStatus(running, event('play.step.finished', 'a', {
        index: 0, stepName: 'browser.fill', ok: false, error: {code: 'ERR_STALE', message: 'raw input value'},
    }));
    const done = updatePlaybackStatus(step, event('play.completed', 'a', {results: [{}, {}, {}]}));
    assert.equal(done?.phase, 'completed');
    assert.equal(done?.completed, 3);
    assert.equal(done?.failure?.step?.name, 'browser.fill');
    assert.equal(done?.failure?.code, 'ERR_STALE');
    assert.doesNotMatch(JSON.stringify(done), /raw input value/);
});
